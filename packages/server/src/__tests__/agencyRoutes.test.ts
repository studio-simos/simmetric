// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 206 (AGENCY-01/04, Plan 02 Task 4 / VALIDATION W0) — agency route
 * unit matrix on the heavy-mock idiom (mcpRoutes.test.ts pattern): the
 * prisma singleton is jest.mocked, the auth chain runs REAL (verifyToken →
 * getCachedUserWithRoles → mocked prisma; no Redis in unit env), and the
 * tenant context resolves through the mocked membership lookup.
 *
 * Pins:
 * 1. create → 201 with the transactional shape (D-01/D-02/D-20)
 * 2. ceiling breach → 409 { error, quota: "users" } (D-11/D-12)
 * 3. actor-is-subuser → 403 (D-03 structural guard)
 * 4. list returns ONLY the actor's sub-users (Pitfall 7)
 * 5. GET foreign id → 404 (never 403 — D-04/SC-1)
 * 6. caller without agency:users:manage → 403 (D-07)
 * 7. admin passes the gate via isAdmin
 * 8. admin ceiling edit (users route) + cache invalidation (D-11)
 */

jest.mock("../utils/prisma", () => {
  const makePrisma = () => {
    const prisma: Record<string, any> = {
      $transaction: jest.fn(),
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      userSponsorship: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
      },
      organizationMember: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      role: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      userRole: {
        create: jest.fn(),
      },
    };
    // tx === the same mock object (transaction passthrough).
    prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(prisma));
    return prisma;
  };
  const instance = makePrisma();
  return { __esModule: true, default: instance };
});

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn(async () => undefined),
}));

// Full authService mock (apiKeyMiddlewareCap pattern): the real module pulls
// redisService (ioredis) into the import graph — unit harness must not touch
// network. verifyToken/generateToken round-trip through a base64 JSON token;
// getCachedUserWithRoles returns the CURRENT test's user payload.
let AUTH_USER_PAYLOAD: unknown = null;
jest.mock("../services/authService", () => ({
  verifyToken: jest.fn((token: string) =>
    JSON.parse(Buffer.from(token, "base64").toString("utf8")),
  ),
  generateToken: jest.fn((userId: string) =>
    Buffer.from(JSON.stringify({ userId })).toString("base64"),
  ),
  getCachedUserWithRoles: jest.fn(async () => AUTH_USER_PAYLOAD),
  getUserWithRoles: jest.fn(),
  invalidateAuthCache: jest.fn(async () => undefined),
}));

jest.mock("../services/tokenRevocation", () => ({
  isTokenRevoked: jest.fn(async () => false),
}));

jest.mock("../services/apiKeyService", () => ({
  validateApiKey: jest.fn(),
}));

import request from "supertest";
import { generateToken, invalidateAuthCache } from "../services/authService";
import prisma from "../utils/prisma";
import * as authService from "../services/authService";
import { isTokenRevoked } from "../services/tokenRevocation";
import { logEvent } from "../services/eventLogService";
import express from "express";
import agencyRoutes from "../routes/agency";
import userRoutes from "../routes/users";

/** supertest requires an Express APP, not a bare Router (router.handle
 * throws 'argument callback is required' without a finalizer). */
function makeApp(prefix: string, router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use(prefix, router);
  return app;
}

const ORG_ID = "org-206-unit-1";
const SPONSOR_ID = "user-sponsor-1";
const CLOUD_ROLE_ID = "role-utente-cloud";

const actorRolesPayload = {
  id: SPONSOR_ID,
  maxSponsoredUsers: 2,
  roles: [
    {
      role: {
        id: "role-web-agency",
        name: "Web Agency",
        isDefault: false,
        permissions: [{ permissionName: "agency:users:manage" }, { permissionName: "chat:write" }],
      },
    },
  ],
};

const plainUserRolesPayload = {
  id: "user-plain-1",
  roles: [
    {
      role: {
        name: "user",
        isDefault: true,
        permissions: [{ permissionName: "chat:write" }],
      },
    },
  ],
};

const adminRolesPayload = {
  id: "user-admin-1",
  roles: [
    {
      role: {
        name: "admin",
        isDefault: true,
        permissions: [{ permissionName: "admin:settings" }, { permissionName: "agency:users:manage" }],
      },
    },
  ],
};

const p = prisma as unknown as Record<string, any>;

function mockActorUser(payload: unknown) {
  AUTH_USER_PAYLOAD = payload;
}

beforeEach(() => {
  jest.resetAllMocks();
  // resetAllMocks wipes factory-set implementations — rebind the auth-chain
  // mocks so the REAL authMiddleware runs end-to-end on mocked data.
  (authService.verifyToken as jest.Mock).mockImplementation((token: string) =>
    JSON.parse(Buffer.from(token, "base64").toString("utf8")),
  );
  (authService.generateToken as jest.Mock).mockImplementation((userId: string) =>
    Buffer.from(JSON.stringify({ userId })).toString("base64"),
  );
  (authService.getCachedUserWithRoles as jest.Mock).mockImplementation(async () => AUTH_USER_PAYLOAD);
  (isTokenRevoked as jest.Mock).mockImplementation(async () => false);
  // The route chains logEvent(...).catch() — it must return a promise.
  (logEvent as jest.Mock).mockImplementation(async () => undefined);
  (authService.invalidateAuthCache as jest.Mock).mockImplementation(async () => undefined);
  // Rebind $transaction after resetAll (the hoisted factory implementation is wiped).
  (p.$transaction as jest.Mock).mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(p));
  AUTH_USER_PAYLOAD = null;
  // Tenant context membership lookup (every request).
  (p.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: ORG_ID,
    roleInOrg: "member",
  });
});

describe("POST /api/agency/users (AGENCY-01/04)", () => {
  it("creates a sub-user: 201 + transactional rows + logEvent (D-01/D-02/D-20)", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    (p.user.findUnique as jest.Mock).mockResolvedValue({ id: SPONSOR_ID, maxSponsoredUsers: 2 });
    (p.userSponsorship.findFirst as jest.Mock).mockResolvedValue(null); // actor-is-subuser guard
    (p.userSponsorship.count as jest.Mock).mockResolvedValue(1);
    (p.role.findFirst as jest.Mock).mockResolvedValue({ id: CLOUD_ROLE_ID, name: "Utente Cloud" });
    (p.user.findFirst as jest.Mock).mockResolvedValue(null); // dup check
    (p.user.create as jest.Mock).mockResolvedValue({
      id: "sub-user-1",
      username: "mario.rossi",
      email: "mario@example.com",
      mustChangePassword: true,
    });

    const token = generateToken(SPONSOR_ID);
    const res = await request(makeApp("/api/agency", agencyRoutes))
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "mario.rossi", email: "mario@example.com" });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ id: "sub-user-1", username: "mario.rossi" });
    expect(res.body.generatedPassword).toBeDefined(); // D-06: temp password once
    expect(p.organizationMember.create).toHaveBeenCalledWith({
      data: { organizationId: ORG_ID, userId: "sub-user-1", roleInOrg: "member" },
    });
    expect(p.userRole.create).toHaveBeenCalledWith({
      data: { userId: "sub-user-1", roleId: CLOUD_ROLE_ID, assignedVia: "agency" },
    });
    expect(p.userSponsorship.create).toHaveBeenCalledWith({
      data: { sponsorId: SPONSOR_ID, subUserId: "sub-user-1" },
    });
    expect(logEvent).toHaveBeenCalledWith("user", "sub-user-1", "subuser.created", SPONSOR_ID, expect.anything());
  });

  it("returns 409 { error, quota: 'users' } when the ceiling is reached (D-11/D-12)", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    const token = generateToken(SPONSOR_ID);
    (p.user.findUnique as jest.Mock).mockResolvedValue({ id: SPONSOR_ID, maxSponsoredUsers: 2 });
    (p.userSponsorship.findFirst as jest.Mock).mockResolvedValue(null);
    (p.userSponsorship.count as jest.Mock).mockResolvedValue(2);
    // plan 04: the breach arm fires INSIDE the transaction — the role lookup
    // precedes it, so the fixture must provide the Utente Cloud role.
    (p.role.findFirst as jest.Mock).mockResolvedValue({ id: "role-cloud", name: "Utente Cloud" });

    const res = await request(makeApp("/api/agency", agencyRoutes))
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "second.user", email: "s@example.com" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "User ceiling reached", quota: "users" });
  });

  it("treats a NULL ceiling as 0 — fail-closed (D-11)", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    const token = generateToken(SPONSOR_ID);
    (p.user.findUnique as jest.Mock).mockResolvedValue({ id: SPONSOR_ID, maxSponsoredUsers: null });
    (p.role.findFirst as jest.Mock).mockResolvedValue({ id: CLOUD_ROLE_ID, name: "Utente Cloud" });
    (p.userSponsorship.findFirst as jest.Mock).mockResolvedValue(null);
    (p.userSponsorship.count as jest.Mock).mockResolvedValue(0);

    const res = await request(makeApp("/api/agency", agencyRoutes))
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "mario.rossi", email: "mario@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.quota).toBe("users");
  });

  it("refuses an actor who is themselves a sub-user (D-03 structural guard)", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    const token = generateToken(SPONSOR_ID);
    (p.user.findUnique as jest.Mock).mockResolvedValueOnce(actorRolesPayload);
    (p.userSponsorship.findFirst as jest.Mock).mockResolvedValue({ id: "someone-else-sponsors-me" });

    const res = await request(makeApp("/api/agency", agencyRoutes))
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "mario.rossi", email: "mario@example.com" });

    expect(res.status).toBe(403);
  });

  it("returns 403 for a caller without agency:users:manage (D-07)", async () => {
    AUTH_USER_PAYLOAD = plainUserRolesPayload;
    const token = generateToken(plainUserRolesPayload.id);
    (p.user.findUnique as jest.Mock).mockResolvedValue(plainUserRolesPayload);

    const res = await request(makeApp("/api/agency", agencyRoutes))
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "mario.rossi", email: "mario@example.com" });

    expect(res.status).toBe(403);
  });

  it("lets an admin pass the permission gate (isAdmin bypass)", async () => {
    AUTH_USER_PAYLOAD = adminRolesPayload;
    const token = generateToken(adminRolesPayload.id);
    (p.user.findUnique as jest.Mock).mockResolvedValue({ id: adminRolesPayload.id, maxSponsoredUsers: 2 });
    (p.userSponsorship.findFirst as jest.Mock).mockResolvedValue(null);
    (p.userSponsorship.count as jest.Mock).mockResolvedValue(0);
    (p.role.findFirst as jest.Mock).mockResolvedValue({ id: CLOUD_ROLE_ID, name: "Utente Cloud" });
    (p.user.findFirst as jest.Mock).mockResolvedValue(null);
    (p.user.create as jest.Mock).mockResolvedValue({
      id: "sub-user-9",
      username: "admin.made",
      email: "am@example.com",
      mustChangePassword: true,
    });

    const res = await request(makeApp("/api/agency", agencyRoutes))
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "admin.made", email: "am@example.com" });

    expect(res.status).toBe(201);
  });

  it("returns 400 on an invalid body (safeParse shape)", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    const token = generateToken(SPONSOR_ID);
    (p.user.findUnique as jest.Mock).mockResolvedValue(actorRolesPayload);
    const res = await request(makeApp("/api/agency", agencyRoutes))
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "AB", email: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.details).toBeDefined();
  });
});

describe("GET /api/agency/users (AGENCY-01 scoping)", () => {
  it("returns ONLY the actor's sub-users (Pitfall 7)", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    const token = generateToken(SPONSOR_ID);
    (p.user.findUnique as jest.Mock).mockResolvedValue(actorRolesPayload);
    (p.userSponsorship.findMany as jest.Mock).mockResolvedValue([
      {
        subUser: {
          id: "s1",
          username: "s1",
          email: "s1@x.y",
          disabledAt: null,
          mustChangePassword: true,
          createdAt: new Date(),
          // Owner UAT: current grants ride the list (picker pre-select).
          permissionOverrides: [{ permissionName: "chat:write" }],
        },
      },
    ]);
    const res = await request(makeApp("/api/agency", agencyRoutes)).get("/api/agency/users").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].id).toBe("s1");
    // Owner UAT: current grants ride the list (picker pre-select on reopen)
    expect(res.body.users[0].permissions).toEqual(["chat:write"]);
  });
});

describe("GET /api/agency/users/:id (D-04 404-hide)", () => {
  it("returns 404 for a foreign sub-user id (never 403)", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    const token = generateToken(SPONSOR_ID);
    (p.user.findUnique as jest.Mock).mockResolvedValue(actorRolesPayload);
    (p.userSponsorship.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(makeApp("/api/agency", agencyRoutes)).get("/api/agency/users/foreign-id").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 200 for an owned sub-user", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    const token = generateToken(SPONSOR_ID);
    (p.user.findUnique as jest.Mock).mockResolvedValue(actorRolesPayload);
    (p.userSponsorship.findFirst as jest.Mock).mockResolvedValue({
      subUser: { id: "s1", username: "s1", email: "s1@x.y", disabledAt: null, mustChangePassword: false, createdAt: new Date() },
    });
    const res = await request(makeApp("/api/agency", agencyRoutes)).get("/api/agency/users/s1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe("s1");
  });
});

describe("PUT /api/users/:id ceiling (AGENCY-04 D-11)", () => {
  it("admin sets the ceiling; cache invalidated", async () => {
    AUTH_USER_PAYLOAD = adminRolesPayload;
    const token = generateToken(adminRolesPayload.id);
    (p.user.findUnique as jest.Mock).mockResolvedValue(adminRolesPayload);
    (p.user.update as jest.Mock).mockResolvedValue({ ...adminRolesPayload, id: adminRolesPayload.id });
    (p.user.findFirst as jest.Mock).mockResolvedValue(null);
    const router = makeApp("/api/users", userRoutes);
    const res = await request(router)
      .patch(`/api/users/${SPONSOR_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ maxSponsoredUsers: 5 });
    expect(res.status).toBe(200);
    expect(p.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ maxSponsoredUsers: 5 }) }));
    expect(invalidateAuthCache).toHaveBeenCalledWith(SPONSOR_ID);
  });

  it("non-admin attempting a ceiling edit → 403 (admin-only arm)", async () => {
    AUTH_USER_PAYLOAD = actorRolesPayload;
    const token = generateToken(SPONSOR_ID);
    (p.user.findUnique as jest.Mock).mockResolvedValue(actorRolesPayload);
    const router = makeApp("/api/users", userRoutes);
    const res = await request(router)
      .patch(`/api/users/${SPONSOR_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ maxSponsoredUsers: 99 });
    expect(res.status).toBe(403);
  });
});
