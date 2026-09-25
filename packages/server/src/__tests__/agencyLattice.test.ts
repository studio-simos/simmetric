// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 206 (AGENCY-03, Plan 04 Task 2 / VALIDATION W0) — the delegation
 * lattice escalation matrix. THE security anchor of the lattice: any grant
 * outside (sponsor's effective ∖ DELEGATION_DENYLIST) is refused, and
 * possession alone is never enough (Pitfall 4).
 */

jest.mock("../utils/prisma", () => {
  const makePrisma = () => ({
    $transaction: jest.fn(),
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userSponsorship: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    organizationMember: { findFirst: jest.fn(), create: jest.fn() },
    role: { findFirst: jest.fn(), findUnique: jest.fn() },
    userRole: { create: jest.fn() },
    userPermissionOverride: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
  });
  const instance = makePrisma();
  return { __esModule: true, default: instance };
});

jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn(async () => undefined) }));

let AUTH_USER_PAYLOAD: unknown = null;
jest.mock("../services/authService", () => ({
  verifyToken: jest.fn((token: string) => JSON.parse(Buffer.from(token, "base64").toString("utf8"))),
  generateToken: jest.fn((userId: string) => Buffer.from(JSON.stringify({ userId })).toString("base64")),
  getCachedUserWithRoles: jest.fn(async () => AUTH_USER_PAYLOAD),
  getUserWithRoles: jest.fn(),
  invalidateAuthCache: jest.fn(async () => undefined),
}));
jest.mock("../services/tokenRevocation", () => ({ isTokenRevoked: jest.fn(async () => false) }));
jest.mock("../services/apiKeyService", () => ({ validateApiKey: jest.fn() }));

import express from "express";
import request from "supertest";
import * as authService from "../services/authService";
import { logEvent } from "../services/eventLogService";
import prisma from "../utils/prisma";
import agencyRoutes from "../routes/agency";

const AGENCY_ID = "user-agency-lattice";
const SUB_ID = "user-sub-lattice";
const p = prisma as unknown as Record<string, any>;

const agencyPayload = {
  id: AGENCY_ID,
  roles: [
    {
      role: {
        permissions: [
          { permissionName: "agency:users:manage" },
          { permissionName: "chat:write" },
          { permissionName: "workspace:read" },
          { permissionName: "document:write" },
        ],
      },
    },
  ],
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/agency", agencyRoutes);
  return app;
}

function tokenFor(userId: string) {
  return Buffer.from(JSON.stringify({ userId })).toString("base64");
}

beforeEach(() => {
  jest.resetAllMocks();
  // resetAllMocks wipes factory impls — rebind the auth-chain mocks.
  (authService.verifyToken as jest.Mock).mockImplementation((token: string) =>
    JSON.parse(Buffer.from(token, "base64").toString("utf8")),
  );
  (authService.getCachedUserWithRoles as jest.Mock).mockImplementation(async () => AUTH_USER_PAYLOAD);
  (authService.invalidateAuthCache as jest.Mock).mockImplementation(async () => undefined);
  (logEvent as jest.Mock).mockImplementation(async () => undefined);
  (p.$transaction as jest.Mock).mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(p));
  AUTH_USER_PAYLOAD = agencyPayload;
  (p.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: "org-lattice",
    roleInOrg: "member",
  });
  (p.userSponsorship.findFirst as jest.Mock).mockImplementation(async (args: any) => {
    // Sponsorship scoping: the sub-user id "user-sub-lattice" is owned.
    if (args?.where?.subUserId === "user-sub-lattice" && args?.where?.sponsorId === AGENCY_ID) {
      return { id: "sp-1", subUserId: "user-sub-lattice", sponsorId: AGENCY_ID };
    }
    // validateGrantSet's actor-is-subuser guard: the AGENCY has no sponsor row.
    if (args?.where?.subUserId === AGENCY_ID) return null;
    return null;
  });
  (p.userPermissionOverride.findMany as jest.Mock).mockResolvedValue([
    { permissionName: "chat:read" },
  ]);
  // validateGrantSet/listDelegatablePermissions actor fetch
  (p.user.findUnique as jest.Mock).mockResolvedValue(agencyPayload);
  (p.userPermissionOverride.create as jest.Mock).mockResolvedValue({});
  (p.userPermissionOverride.deleteMany as jest.Mock).mockResolvedValue({});
});

describe("PUT /api/agency/users/:id/permissions — escalation matrix (AGENCY-03 D-08)", () => {
  it("accepts a valid subset the agency possesses (grants written, full-replace)", async () => {
    const res = await request(makeApp())
      .put("/api/agency/users/user-sub-lattice/permissions")
      .set("Authorization", `Bearer ${Buffer.from(JSON.stringify({ userId: AGENCY_ID })).toString("base64")}`)
      .send({ permissions: ["chat:write", "workspace:read"] });
    expect(res.status).toBe(200);
    // chat:read existed → replaced; the removed row delete + adds happen
    expect(p.userPermissionOverride.deleteMany).toHaveBeenCalledTimes(1);
    expect(p.userPermissionOverride.create).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenCalledWith(
      "user",
      "user-sub-lattice",
      "subuser.permissions.updated",
      AGENCY_ID,
      { count: 2 },
    );
  });

  it("denies admin:* grants with 403 (denylist prefix rule)", async () => {
    const res = await request(makeApp())
      .put("/api/agency/users/user-sub-lattice/permissions")
      .set("Authorization", `Bearer ${Buffer.from(JSON.stringify({ userId: AGENCY_ID })).toString("base64")}`)
      .send({ permissions: ["admin:users"] });
    expect(res.status).toBe(403);
  });

  it("denies agency:users:manage even though the agency POSSESSES it (Pitfall 4: possession is not enough)", async () => {
    const res = await request(makeApp())
      .put("/api/agency/users/user-sub-lattice/permissions")
      .set("Authorization", `Bearer ${Buffer.from(JSON.stringify({ userId: AGENCY_ID })).toString("base64")}`)
      .send({ permissions: ["agency:users:manage"] });
    expect(res.status).toBe(403);
  });

  it("denies connector:manage (not possessed AND denylisted) → 403", async () => {
    const res = await request(makeApp())
      .put("/api/agency/users/user-sub-lattice/permissions")
      .set("Authorization", `Bearer ${Buffer.from(JSON.stringify({ userId: AGENCY_ID })).toString("base64")}`)
      .send({ permissions: ["connector:manage"] });
    expect(res.status).toBe(403);
  });

  it("denies a non-denylisted permission the agency does NOT possess (subset rule)", async () => {
    const res = await request(makeApp())
      .put("/api/agency/users/user-sub-lattice/permissions")
      .set("Authorization", `Bearer ${Buffer.from(JSON.stringify({ userId: AGENCY_ID })).toString("base64")}`)
      .send({ permissions: ["backup:job:write"] });
    expect(res.status).toBe(403);
  });

  it("returns 400 for an unknown permission name", async () => {
    const res = await request(makeApp())
      .put("/api/agency/users/user-sub-lattice/permissions")
      .set("Authorization", `Bearer ${Buffer.from(JSON.stringify({ userId: AGENCY_ID })).toString("base64")}`)
      .send({ permissions: ["not:a:permission"] });
    expect(res.status).toBe(400);
  });

  it("404 on a sub-user the agency does not own (sponsorship scoping)", async () => {
    const res = await request(makeApp())
      .put("/api/agency/users/foreign-sub/permissions")
      .set("Authorization", `Bearer ${Buffer.from(JSON.stringify({ userId: AGENCY_ID })).toString("base64")}`)
      .send({ permissions: [] });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/agency/delegatable-permissions (D-10 picker source)", () => {
  it("excludes every denylist entry from the picker list", async () => {
    const res = await request(makeApp())
      .get("/api/agency/delegatable-permissions")
      .set("Authorization", `Bearer ${Buffer.from(JSON.stringify({ userId: AGENCY_ID })).toString("base64")}`);
    expect(res.status).toBe(200);
    const permissions = res.body.permissions as string[];
    expect(permissions).not.toContain("agency:users:manage");
    expect(permissions).not.toContain("admin:settings");
    expect(permissions).toContain("chat:write");
  });
});

describe("override composition (D-09)", () => {
  it("delegated grants compose into the effective set via getEffectivePermissions", async () => {
    const { getEffectivePermissions } = await import("../utils/auth");
    const user = {
      roles: [
        { role: { permissions: [{ permissionName: "chat:read" }] } },
      ],
      permissionOverrides: [{ permissionName: "connector:view" }],
    };
    const effective = getEffectivePermissions(user);
    expect(effective).toEqual(expect.arrayContaining(["chat:read", "connector:view"]));
  });
});