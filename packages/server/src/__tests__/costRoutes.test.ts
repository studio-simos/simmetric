// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 203 (MCC-02, 203-02 Tasks 1+3) — workspace + system cost endpoints.
 *
 * GET /:workspaceId/chats/:chatId/cost — per-chat per-currency totals +
 * per-message breakdown, member-gated (requireWorkspaceAccess — the
 * chatTokens.ts:153 idiom).
 * GET /:workspaceId/cost/today — today's per-currency totals.
 * GET /api/system/analytics/cost + /cost-by-model — admin-gated per-currency.
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const { prisma } = createMockPrisma();
  (prisma as any).workspaceTokenUsage = {
    ...(prisma as any).workspaceTokenUsage,
    findMany: jest.fn(),
    groupBy: jest.fn(),
  };
  return { __esModule: true, default: prisma };
});

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.userId = "u-admin";
    next();
  },
}));

jest.mock("../middleware/tenantContext", () => ({
  tenantContextMiddleware: (req: any, _res: any, next: any) => {
    req.organizationId = "org-default";
    next();
  },
}));

jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (req: any, res: any, next: any) => {
    if ((globalThis as any).__noAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  },
}));

jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (req: any, res: any, next: any) => {
    if ((globalThis as any).__noAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  },
  requireWorkspaceAccess: (req: any, res: any, next: any) => {
    if ((globalThis as any).__notMember) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    next();
  },
}));

import express from "express";
import request from "supertest";
import prisma from "../utils/prisma";
import costRoutes from "../routes/chatCost";
import analyticsRoutes from "../routes/analytics";

function costApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/workspaces", costRoutes);
  return app;
}

function analyticsApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/system/analytics", analyticsRoutes);
  return app;
}

const ROWS = [
  {
    workspaceId: "ws-1",
    chatId: "c-1",
    model: "m",
    promptTokens: 100,
    completionTokens: 50,
    promptCost: "0.00015",
    completionCost: "0.0003",
    totalCost: "0.00045",
    currency: "USD",
    createdAt: new Date("2026-09-24T10:00:00Z"),
  },
  {
    workspaceId: "ws-1",
    chatId: "c-1",
    model: "m2",
    promptTokens: 200,
    completionTokens: 100,
    promptCost: null,
    completionCost: null,
    totalCost: null,
    currency: null,
    createdAt: new Date("2026-09-24T11:00:00Z"),
  },
];

beforeEach(() => {
  (globalThis as any).__noAdmin = false;
  (globalThis as any).__notMember = false;
  (prisma.workspaceTokenUsage.findMany as jest.Mock).mockReset();
  (prisma.workspaceTokenUsage.groupBy as jest.Mock).mockReset();
});

describe("GET /:workspaceId/chats/:chatId/cost (MCC-02, D5)", () => {
  it("returns per-currency totals + per-message breakdown for a member", async () => {
    (prisma.workspaceTokenUsage.findMany as jest.Mock).mockResolvedValue(ROWS);
    const res = await request(costApp()).get("/api/workspaces/ws-1/chats/c-1/cost");
    expect(res.status).toBe(200);
    expect(res.body.totalByCurrency.USD).toBeCloseTo(0.00045, 8);
    expect(res.body.breakdown).toHaveLength(2);
    expect(res.body.breakdown[1].totalCost).toBeNull(); // N/A row (D2)
    expect(Object.keys(res.body.totalByCurrency)).toEqual(["USD"]); // no cross-currency sum (D3)
  });

  it("403 for a non-member (requireWorkspaceAccess gate)", async () => {
    (globalThis as any).__notMember = true;
    const res = await request(costApp()).get("/api/workspaces/ws-1/chats/c-1/cost");
    expect(res.status).toBe(403);
  });
});

describe("GET /:workspaceId/cost/today (MCC-02, D5)", () => {
  it("returns today's per-currency totals for a member", async () => {
    (prisma.workspaceTokenUsage.findMany as jest.Mock).mockResolvedValue(ROWS);
    const res = await request(costApp()).get("/api/workspaces/ws-1/cost/today");
    expect(res.status).toBe(200);
    expect(res.body.totalByCurrency.USD).toBeCloseTo(0.00045, 8);
  });
});

describe("system analytics cost endpoints (admin-gated, per-currency — D8)", () => {
  it("GET /cost?days=30 → per-currency daily aggregates", async () => {
    (prisma.workspaceTokenUsage.findMany as jest.Mock).mockResolvedValue([
      { promptCost: "5", completionCost: "8", totalCost: "13", currency: "USD", createdAt: new Date("2026-09-24T10:00:00Z") },
    ]);
    const res = await request(analyticsApp()).get("/api/system/analytics/cost?days=30");
    expect(res.status).toBe(200);
    expect(res.body.totalByCurrency.USD).toBeCloseTo(13, 6);
  });

  it("GET /api/system/analytics/cost-by-model → per-model per-currency rows", async () => {
    (prisma.workspaceTokenUsage.groupBy as jest.Mock).mockResolvedValue([
      { model: "m", currency: "USD", _sum: { promptCost: 2, completionCost: 3, totalCost: 5 } },
    ]);
    const res = await request(analyticsApp()).get("/api/system/analytics/cost-by-model");
    expect(res.status).toBe(200);
    expect(res.body.byModel).toHaveLength(1);
    expect(res.body.byModel[0].model).toBe("m");
    expect(res.body.byModel[0].totalCost).toBe(5);
  });

  it("403 without admin (router-level gate preserved)", async () => {
    (globalThis as any).__noAdmin = true;
    const res = await request(analyticsApp()).get("/api/system/analytics/cost?days=30");
    expect(res.status).toBe(403);
  });
});