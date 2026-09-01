// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Token aggregation endpoint tests (Feature 2: Token Counter).
 * GET /api/workspaces/:workspaceId/chats/:chatId/tokens
 * GET /api/workspaces/:workspaceId/tokens/today
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "enterprise", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "enterprise", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => true),
  getFeatureLimit: jest.fn(() => Infinity),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    req.user = { id: "admin-001", roles: [{ role: { name: "admin", permissions: [] } }] };
    next();
  },
  apiKeyMiddleware: (_req: any, res: any) => res.status(401).json({ error: "Missing API key" }),
}));

jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireProjectAccess: (_req: any, _res: any, next: any) => next(),
  requireWorkspaceAccess: (_req: any, _res: any, next: any) => next(),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000010";
const CHAT_ID = "00000000-0000-0000-0000-000000000001";

describe("Token aggregation endpoints", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/workspaces/:workspaceId/chats/:chatId/tokens", () => {
    it("aggregates token usage from message metadata", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID });
      (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([
        {
          id: "msg-1",
          role: "assistant",
          metadata: JSON.stringify({ tokenUsage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 } }),
        },
        {
          id: "msg-2",
          role: "assistant",
          metadata: JSON.stringify({ tokenUsage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 } }),
        },
        { id: "msg-3", role: "user", metadata: null },
      ]);

      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}/chats/${CHAT_ID}/tokens`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.totalInput).toBe(170);
      expect(res.body.totalOutput).toBe(110);
      expect(res.body.total).toBe(280);
      expect(res.body.perMessage).toHaveLength(2);
      expect(res.body.perMessage[0]).toEqual({ id: "msg-1", role: "assistant", input: 120, output: 80, total: 200 });
    });

    it("returns 404 when chat does not exist", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}/chats/${CHAT_ID}/tokens`)
        .set(adminAuth());

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Chat not found");
    });

    it("returns zero totals when no messages carry token usage", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID });
      (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([
        { id: "msg-1", role: "user", metadata: null },
      ]);

      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}/chats/${CHAT_ID}/tokens`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.totalInput).toBe(0);
      expect(res.body.totalOutput).toBe(0);
      expect(res.body.total).toBe(0);
      expect(res.body.perMessage).toEqual([]);
    });

    it("skips messages with corrupt metadata JSON without crashing", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID });
      (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([
        { id: "bad", role: "assistant", metadata: "{not valid json" },
        {
          id: "good",
          role: "assistant",
          metadata: JSON.stringify({ tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
        },
      ]);

      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}/chats/${CHAT_ID}/tokens`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(15);
      expect(res.body.perMessage).toHaveLength(1);
    });

    it("requires authentication", async () => {
      const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/chats/${CHAT_ID}/tokens`);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/workspaces/:workspaceId/tokens/today", () => {
    it("aggregates today's workspace token usage for the authenticated user", async () => {
      (prisma.workspaceTokenUsage.aggregate as jest.Mock).mockResolvedValue({
        _sum: { promptTokens: 500, completionTokens: 300, totalTokens: 800 },
      });

      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}/tokens/today`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.totalInput).toBe(500);
      expect(res.body.totalOutput).toBe(300);
      expect(res.body.total).toBe(800);
      expect(res.body.since).toBeDefined();
      const call = (prisma.workspaceTokenUsage.aggregate as jest.Mock).mock.calls[0][0];
      expect(call.where.workspaceId).toBe(WORKSPACE_ID);
      expect(call.where.userId).toBe("admin-001");
      expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    });

    it("returns zeros when no usage recorded today", async () => {
      (prisma.workspaceTokenUsage.aggregate as jest.Mock).mockResolvedValue({
        _sum: { promptTokens: null, completionTokens: null, totalTokens: null },
      });

      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}/tokens/today`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.totalInput).toBe(0);
      expect(res.body.totalOutput).toBe(0);
      expect(res.body.total).toBe(0);
    });

    it("requires authentication", async () => {
      const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/tokens/today`);
      expect(res.status).toBe(401);
    });
  });
});