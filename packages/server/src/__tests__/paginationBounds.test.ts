// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 155 / Plan 02 — CSW-06 pagination bounds (TDD).
 *
 * Covers the three unbounded findMany query patterns bounded by this plan:
 *  - push.ts /test broadcast → batched (BATCH_SIZE=100, take+skip loop)
 *  - analytics.ts /models + /top-users → time-range where + take:10000
 *  - archivePageService.getPages → optional take param (default 500)
 *
 * Tests mock prisma (and web-push for the push route) so they run without a
 * live DB. They assert the *query shape* (take/skip/where) and the *result
 * accounting* (succeeded/failed counts, no silent truncation), not the push
 * payload itself.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const base = createMockPrisma().prisma;
  // pushSubscription is not in the shared mock factory — add it here.
  (base as any).pushSubscription = {
    findMany: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  };
  return { __esModule: true, default: base };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    // push.ts initVapid reads these; empty → auto-generate path (no real keys).
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
    VAPID_SUBJECT: "mailto:admin@test.local",
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => ({}));
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({
  initPostgreSQLFTS: jest.fn(),
  MULTI_CONFIG_TSVECTOR:
    "to_tsvector('english', t)",
}));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/archiveIndexService", () => ({ generateIndexFile: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      _res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    req.user = {
      id: "admin-001",
      roles: [{ role: { name: "admin", permissions: [{ permissionName: "system:admin" }] } }],
    };
    next();
  },
  apiKeyMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/rbac", () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireProjectAccess: () => (_req: any, _res: any, next: any) => next(),
  requireWorkspaceAccess: () => (_req: any, _res: any, next: any) => next(),
}));

// NOTE: do NOT mock ../middleware/license — the real module defines
// requireFeatureLimit (imported by routes/projects.ts at load time). Mocking
// it partially would drop requireFeatureLimit and crash createApp(). The
// licenseService mock above is enough to satisfy the real middleware.

// web-push mock — record sendNotification calls; default success.
jest.mock("web-push", () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    generateVAPIDKeys: jest.fn(() => ({ publicKey: "pk", privateKey: "sk" })),
    sendNotification: jest.fn().mockResolvedValue({ statusCode: 201 }),
  },
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import webpush from "web-push";
import { getPages } from "../services/archivePageService";

const app = createApp();

// Build N fake push subscriptions.
function makeSubs(n: number): Array<{ id: string; endpoint: string; keys: string; userId: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `sub-${i}`,
    endpoint: `https://push.example.com/${i}`,
    keys: JSON.stringify({ p256dh: "k1", auth: "k2" }),
    userId: "admin-001",
  }));
}

describe("CSW-06 — push /test broadcast is batched (BATCH_SIZE=100)", () => {
  const sendMock = webpush.sendNotification as jest.Mock;

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ statusCode: 201 });
    (prisma.pushSubscription.findMany as jest.Mock).mockReset();
    (prisma.workspaceTokenUsage.findMany as jest.Mock).mockReset();
  });

  it("broadcasts to ALL subscriptions across batches of 100 (no silent truncation)", async () => {
    // 250 subs → 3 batches (100, 100, 50). Drive the batched loop by returning
    // each batch by index, then an empty array to terminate.
    const batches = [makeSubs(100), makeSubs(100), makeSubs(50), []];
    let callIdx = 0;
    (prisma.pushSubscription.findMany as jest.Mock).mockImplementation((args: any) => {
      const batch = batches[callIdx] ?? [];
      callIdx++;
      // Assert the loop passes take + skip in the expected cadence.
      if (callIdx <= 3) {
        expect(args).toEqual(expect.objectContaining({ take: 100, skip: (callIdx - 1) * 100 }));
      }
      return Promise.resolve(batch);
    });

    const res = await request(app)
      .post("/api/system/push/test")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    // 250 total sends attempted (no truncation), all succeed.
    expect(sendMock).toHaveBeenCalledTimes(250);
    expect(res.body.succeeded).toBe(250);
    expect(res.body.failed).toBe(0);
  });

  it("with 0 subscriptions returns {succeeded:0, failed:0} (empty batch loop terminates)", async () => {
    (prisma.pushSubscription.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post("/api/system/push/test")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    expect(sendMock).not.toHaveBeenCalled();
    expect(res.body.succeeded).toBe(0);
    expect(res.body.failed).toBe(0);
  });

  it("counts rejected sends as failed across batches", async () => {
    // 1 batch of 2: first succeeds, second rejected.
    const batch = makeSubs(2);
    (prisma.pushSubscription.findMany as jest.Mock)
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([]);
    sendMock
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(new Error("410 Gone"));

    const res = await request(app)
      .post("/api/system/push/test")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
  });
});

describe("CSW-06 — analytics /models + /top-users bounded by time-range where + take:10000", () => {
  beforeEach(() => {
    (prisma.workspaceTokenUsage.findMany as jest.Mock).mockReset();
  });

  it("/models with no days param queries last 30 days, capped at take:10000", async () => {
    (prisma.workspaceTokenUsage.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await request(app)
      .get("/api/system/analytics/models")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    const call = (prisma.workspaceTokenUsage.findMany as jest.Mock).mock.calls[0][0];
    expect(call).toHaveProperty("take", 10000);
    expect(call.where).toEqual(expect.objectContaining({ createdAt: { gte: expect.any(Date) } }));
    // 30-day default: the `since` Date is ~30 days before now.
    const since = call.where.createdAt.gte as Date;
    const daysBack = Math.round((Date.now() - since.getTime()) / (1000 * 60 * 60 * 24));
    expect(daysBack).toBeGreaterThanOrEqual(29);
    expect(daysBack).toBeLessThanOrEqual(31);
  });

  it("/models with ?days=7 queries last 7 days", async () => {
    (prisma.workspaceTokenUsage.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await request(app)
      .get("/api/system/analytics/models?days=7")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    const call = (prisma.workspaceTokenUsage.findMany as jest.Mock).mock.calls[0][0];
    expect(call).toHaveProperty("take", 10000);
    const since = call.where.createdAt.gte as Date;
    const daysBack = Math.round((Date.now() - since.getTime()) / (1000 * 60 * 60 * 24));
    expect(daysBack).toBeGreaterThanOrEqual(6);
    expect(daysBack).toBeLessThanOrEqual(8);
  });

  it("/top-users with no days param queries last 30 days, capped at take:10000", async () => {
    (prisma.workspaceTokenUsage.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await request(app)
      .get("/api/system/analytics/top-users")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    const call = (prisma.workspaceTokenUsage.findMany as jest.Mock).mock.calls[0][0];
    expect(call).toHaveProperty("take", 10000);
    expect(call.where).toEqual(expect.objectContaining({ createdAt: { gte: expect.any(Date) } }));
    const since = call.where.createdAt.gte as Date;
    const daysBack = Math.round((Date.now() - since.getTime()) / (1000 * 60 * 60 * 24));
    expect(daysBack).toBeGreaterThanOrEqual(29);
    expect(daysBack).toBeLessThanOrEqual(31);
  });
});

describe("CSW-06 — archivePageService.getPages take param (default 500)", () => {
  beforeEach(() => {
    (prisma.archivePage.findMany as jest.Mock).mockReset();
  });

  it("getPages(archiveId) with no take arg passes take:500 to findMany", async () => {
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);
    await getPages("arch-1");
    expect(prisma.archivePage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 })
    );
  });

  it("getPages(archiveId, category, 50) passes take:50 (explicit override)", async () => {
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);
    await getPages("arch-1", "entities", 50);
    expect(prisma.archivePage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, where: expect.objectContaining({ category: "entities" }) })
    );
  });
});