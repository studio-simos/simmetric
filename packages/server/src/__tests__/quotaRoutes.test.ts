// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 207 (Plan 02 Task 2 / VALIDATION W0) — quota routes battery:
 * admin resets any target, sponsor resets own sub-user, cross-sponsor 404,
 * storage reset rejected (D-12), usage read payload contract.
 */

jest.mock("../utils/prisma", () => {
  const makePrisma = () => ({
    $transaction: jest.fn(),
    user: { findUnique: jest.fn(), update: jest.fn() },
    quotaReset: { findFirst: jest.fn(), create: jest.fn() },
    userSponsorship: { findFirst: jest.fn() },
    organizationMember: { findFirst: jest.fn() },
    uploadDraft: { aggregate: jest.fn(), findMany: jest.fn() },
    document: { aggregate: jest.fn() },
    workspaceTokenUsage: { aggregate: jest.fn() },
  });
  return { __esModule: true, default: makePrisma() };
});

jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn(async () => undefined) }));

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(async (key: string) => ({ key, value: "0", readOnly: false })),
}));

jest.mock("../services/tokenRevocation", () => ({ isTokenRevoked: jest.fn(async () => false) }));
jest.mock("../services/redisService", () => ({ getRedis: jest.fn(async () => null) }));

let AUTH_USER_PAYLOAD: unknown = null;
jest.mock("../services/authService", () => ({
  verifyToken: jest.fn((token: string) => JSON.parse(Buffer.from(token, "base64").toString("utf8"))),
  generateToken: jest.fn((userId: string) => Buffer.from(JSON.stringify({ userId })).toString("base64")),
  getCachedUserWithRoles: jest.fn(async () => AUTH_USER_PAYLOAD),
  getUserWithRoles: jest.fn(),
  invalidateAuthCache: jest.fn(async () => undefined),
}));

jest.mock("../utils/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import request from "supertest";
import express, { type Express } from "express";
import prisma from "../utils/prisma";
import { resetTokenQuota, QuotaError } from "../services/quotaService";
import quotaRoutes from "../routes/quota";

const mockedPrisma = jest.mocked(prisma);
jest.mocked(resetTokenQuota);

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/quota", quotaRoutes);
  // 1:1 QuotaError mapping (the same arm routes/chat.ts uses).
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof QuotaError) {
      res.status(err.status).json(err.payload);
      return;
    }
    res.status(500).json({ error: "Internal" });
  });
  return app;
}

const ADMIN_TOKEN = Buffer.from(JSON.stringify({ userId: "admin-1" })).toString("base64");
const SPONSOR_TOKEN = Buffer.from(JSON.stringify({ userId: "sponsor-1" })).toString("base64");
const OTHER_TOKEN = Buffer.from(JSON.stringify({ userId: "other-1" })).toString("base64");

function setAuthPayload(user: unknown) {
  AUTH_USER_PAYLOAD = user;
}

const adminUser = {
  id: "admin-1",
  username: "admin",
  roles: [{ role: { permissions: [{ permissionName: "admin:settings" }, { permissionName: "agency:users:manage" }] } }],
};
const sponsorUser = {
  id: "sponsor-1",
  username: "agency",
  roles: [{ role: { permissions: [{ permissionName: "agency:users:manage" }] } }],
};

beforeEach(() => {
  jest.clearAllMocks();
  // Tenant middleware fail-closed arm: resolve a membership for the actor.
  mockedPrisma.organizationMember.findFirst.mockResolvedValue({
    organizationId: "org-1",
    roleInOrg: "member",
  } as never);
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) =>
    await (fn as (t: unknown) => Promise<unknown>)({
      quotaReset: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    }),
  );
  mockedPrisma.user.findUnique.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000001",
    disabledAt: null,
    resetAnchorDate: new Date("2026-08-01T00:00:00Z"),
  } as never);
  mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({ _sum: { totalTokens: 42 } } as never);
  mockedPrisma.quotaReset.findFirst.mockResolvedValue(null as never);
  mockedPrisma.uploadDraft.aggregate.mockResolvedValue({ _sum: { fileSize: 0 } } as never);
  mockedPrisma.uploadDraft.findMany.mockResolvedValue([] as never);
  mockedPrisma.document.aggregate.mockResolvedValue({ _sum: { fileSize: 0 } } as never);
});

describe("POST /api/quota/:userId/reset (D-09 gate + D-02 anchor)", () => {
  it("admin resets any target → 200 anchor (manual, history untouched)", async () => {
    setAuthPayload(adminUser);
    const res = await request(buildApp())
      .post("/api/quota/00000000-0000-4000-8000-000000000001/reset")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ kind: "tokens" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, kind: "tokens" });
    expect(res.body.at).toEqual(expect.any(String));
  });

  it("sponsor resets own sub-user → 200 (sponsorship AND-merge resolves)", async () => {
    setAuthPayload(sponsorUser);
    mockedPrisma.userSponsorship.findFirst.mockResolvedValue({ sponsorId: "sponsor-1", subUserId: "00000000-0000-4000-8000-000000000001" } as never);
    const res = await request(buildApp())
      .post("/api/quota/00000000-0000-4000-8000-000000000001/reset")
      .set("Authorization", `Bearer ${SPONSOR_TOKEN}`)
      .send({ kind: "tokens" });
    expect(res.status).toBe(200);
    expect(mockedPrisma.userSponsorship.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sponsorId: "sponsor-1", subUserId: "00000000-0000-4000-8000-000000000001" }) }),
    );
  });

  it("sponsor resetting an UNRELATED user → 404, never 403 (D-04 idiom)", async () => {
    setAuthPayload(sponsorUser);
    mockedPrisma.userSponsorship.findFirst.mockResolvedValue(null as never);
    const res = await request(buildApp())
      .post("/api/quota/00000000-0000-4000-8000-000000000001/reset")
      .set("Authorization", `Bearer ${SPONSOR_TOKEN}`)
      .send({ kind: "tokens" });
    expect(res.status).toBe(404);
  });

  it("unauthenticated → 401", async () => {
    setAuthPayload(adminUser);
    const res = await request(buildApp()).post("/api/quota/00000000-0000-4000-8000-000000000001/reset").send({ kind: "tokens" });
    expect(res.status).toBe(401);
  });

  it("storage reset attempt → 400 with the D-12 explanation", async () => {
    setAuthPayload(adminUser);
    const res = await request(buildApp())
      .post("/api/quota/00000000-0000-4000-8000-000000000001/reset")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ kind: "storage" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/storage/i);
  });

  it("unknown target → 404", async () => {
    setAuthPayload(adminUser);
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null as never);
    const res = await request(buildApp())
      .post("/api/quota/99999999-9999-4999-8999-999999999999/reset")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ kind: "tokens" });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/quota/:userId (admin column write — Rule 1 gap fill)", () => {
  it("admin writes quota columns → 200 with the updated read", async () => {
    setAuthPayload(adminUser);
    mockedPrisma.user.update.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000001" } as never);
    const res = await request(buildApp())
      .put("/api/quota/00000000-0000-4000-8000-000000000001")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tokenQuotaLimit: 123, storageQuotaGb: 2.5, tokenQuotaUnlimited: false, storageQuotaUnlimited: false, resetAnchorDate: null });
    expect(res.status).toBe(200);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenQuotaLimit: 123, storageQuotaGb: 2.5 }),
      }),
    );
    expect(res.body.tokens).toBeDefined();
    expect(res.body.storage).toBeDefined();
  });

  it("sponsor (non-admin) → 403 via requireAdmin", async () => {
    setAuthPayload(sponsorUser);
    const res = await request(buildApp())
      .put("/api/quota/00000000-0000-4000-8000-000000000001")
      .set("Authorization", `Bearer ${SPONSOR_TOKEN}`)
      .send({ tokenQuotaLimit: 1, storageQuotaGb: 1, tokenQuotaUnlimited: false, storageQuotaUnlimited: false, resetAnchorDate: null });
    expect(res.status).toBe(403);
  });

  it("malformed body → 400 field errors", async () => {
    setAuthPayload(adminUser);
    const res = await request(buildApp())
      .put("/api/quota/00000000-0000-4000-8000-000000000001")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tokenQuotaLimit: -5 });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/quota/:userId (usage read contract)", () => {
  it("returns the token block with resolved chain + the wired storage block (Plan 03)", async () => {
    setAuthPayload(adminUser);
    // Override quota with an anchor set → nextResetAt computed.
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      tokenQuotaLimit: 500000,
      tokenQuotaUnlimited: false,
      disabledAt: null,
      resetAnchorDate: new Date("2026-08-01T00:00:00Z"),
    } as never);
    const res = await request(buildApp())
      .get("/api/quota/00000000-0000-4000-8000-000000000001")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.tokens).toMatchObject({
      limit: 500000,
      used: 42, // from the beforeEach aggregate mock — the read returns real window usage
      source: "override",
      // start 2026-08-01 + 55d elapsed → k=1 boundary passed (Aug 31) → next = Sep 30
      nextResetAt: new Date("2026-09-30T00:00:00Z").toISOString(),
    });
    expect(res.body.storage).toEqual({ limitGb: null, usedBytes: 0, source: "unset" });
  });

  it("sponsor view of own sub-user → 200; unrelated → 404", async () => {
    setAuthPayload(sponsorUser);
    mockedPrisma.userSponsorship.findFirst.mockResolvedValueOnce({ sponsorId: "sponsor-1" } as never);
    const ok = await request(buildApp()).get("/api/quota/00000000-0000-4000-8000-000000000001").set("Authorization", `Bearer ${SPONSOR_TOKEN}`);
    expect(ok.status).toBe(200);

    mockedPrisma.userSponsorship.findFirst.mockResolvedValueOnce(null as never);
    const miss = await request(buildApp()).get("/api/quota/00000000-0000-4000-8000-000000000001").set("Authorization", `Bearer ${OTHER_TOKEN}`);
    expect(miss.status).toBe(404);
  });
});