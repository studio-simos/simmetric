// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 206 (AGENCY-04, Plan 04 Task 3 / VALIDATION W0) — ceiling enforcement
 * battery: fail-closed NULL ceiling, structured breach shape, remaining
 * allowance read, in-transaction TOCTOU re-check.
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
    role: { findFirst: jest.fn() },
    userRole: { create: jest.fn() },
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

const AGENCY_ID = "user-agency-ceiling";
const p = prisma as unknown as Record<string, any>;

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
  AUTH_USER_PAYLOAD = { id: AGENCY_ID, roles: [{ role: { permissions: [{ permissionName: "agency:users:manage" }] } }] };
  (p.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: "org-ceiling",
    roleInOrg: "member",
  });
  (p.userSponsorship.findFirst as jest.Mock).mockResolvedValue(null);
  (p.userSponsorship.count as jest.Mock).mockResolvedValue(0);
  (p.userSponsorship.findMany as jest.Mock).mockResolvedValue([]);
  (p.role.findFirst as jest.Mock).mockResolvedValue({ id: "role-cloud", name: "Utente Cloud" });
  (p.user.findFirst as jest.Mock).mockResolvedValue(null);
  (p.user.create as jest.Mock).mockResolvedValue({
    id: "sub-new",
    username: "sub.new",
    email: "sub@example.test",
    mustChangePassword: true,
  });
});

describe("GET /api/agency/ceiling (D-11 remaining allowance)", () => {
  it("returns max/active/remaining for the actor", async () => {
    (p.user.findUnique as jest.Mock).mockResolvedValue({ maxSponsoredUsers: 5 });
    (p.userSponsorship.count as jest.Mock).mockResolvedValue(2);
    const res = await request(makeApp())
      .get("/api/agency/ceiling")
      .set("Authorization", `Bearer ${tokenFor(AGENCY_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ maxSponsoredUsers: 5, active: 2, remaining: 3 });
  });

  it("NULL ceiling resolves to 0 (fail-closed remaining)", async () => {
    (p.user.findUnique as jest.Mock).mockResolvedValue({ maxSponsoredUsers: null });
    (p.userSponsorship.count as jest.Mock).mockResolvedValue(0);
    const res = await request(makeApp())
      .get("/api/agency/ceiling")
      .set("Authorization", `Bearer ${tokenFor(AGENCY_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ maxSponsoredUsers: 0, active: 0, remaining: 0 });
  });
});

describe("ceiling enforcement at create (AGENCY-04 D-12/D-13, Pitfall 9)", () => {
  it("breach inside the transaction → 409 { error, quota: 'users' }", async () => {
    // The in-transaction re-check: count returns 2 with ceiling 2 → breach.
    (p.user.findUnique as jest.Mock).mockResolvedValue({ id: AGENCY_ID, maxSponsoredUsers: 2 });
    (p.userSponsorship.count as jest.Mock).mockResolvedValue(2);
    const res = await request(makeApp())
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${tokenFor(AGENCY_ID)}`)
      .send({ username: "another.sub", email: "another@example.test" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "User ceiling reached", quota: "users" });
  });

  it("admin creation bypasses the ceiling (admin is terminal — isAdmin gate)", async () => {
    AUTH_USER_PAYLOAD = { id: "admin-bypass", roles: [{ role: { permissions: [{ permissionName: "admin:settings" }, { permissionName: "agency:users:manage" }] } }] };
    (p.user.findUnique as jest.Mock).mockResolvedValue({
      id: "admin-bypass",
      maxSponsoredUsers: null,
      roles: [{ role: { permissions: [{ permissionName: "admin:settings" }, { permissionName: "agency:users:manage" }] } }],
    });
    (p.userSponsorship.count as jest.Mock).mockResolvedValue(0);
    const res = await request(makeApp())
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${tokenFor("admin-bypass")}`)
      .send({ username: "admin.made.sub", email: "ams@example.test" });
    expect(res.status).toBe(201);
  });
});