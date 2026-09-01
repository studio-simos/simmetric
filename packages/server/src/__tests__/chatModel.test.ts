// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Chat model selection endpoint tests — PATCH chat model, GET chats with model fields
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
    req.user = {
      id: "admin-001",
      roles: [{
        role: {
          name: "admin",
          permissions: [
            { permissionName: "chat:read" },
            { permissionName: "chat:write" },
          ],
        },
      }],
    };
    next();
  },
  apiKeyMiddleware: (req: any, res: any, next: any) => {
    res.status(401).json({ error: "Missing API key" });
  },
}));

jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (req: any, res: any, next: any) => next(),
  requireAdmin: (req: any, res: any, next: any) => next(),
  requireProjectAccess: (req: any, res: any, next: any) => next(),
  requireWorkspaceAccess: (req: any, res: any, next: any) => next(),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const mockChat = {
  id: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000010",
  providerId: null,
  model: "gemma4:latest",
  name: "Test Chat",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const PROVIDER_ID = "550e8400-e29b-41d4-a716-446655440100";

describe("Chat Model Selection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("PATCH /api/workspaces/:workspaceId/chats/:chatId/model", () => {
    it("updates chat with a specific provider and model", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(mockChat);
      (prisma.chat.update as jest.Mock).mockResolvedValue({
        ...mockChat,
        providerId: PROVIDER_ID,
        model: "gpt-4",
      });

      const res = await request(app)
        .patch(`/api/workspaces/${mockChat.workspaceId}/chats/${mockChat.id}/model`)
        .set(adminAuth())
        .send({ providerId: PROVIDER_ID, model: "gpt-4" });

      expect(res.status).toBe(200);
      expect(res.body.providerId).toBe(PROVIDER_ID);
      expect(res.body.model).toBe("gpt-4");
      expect(prisma.chat.findFirst).toHaveBeenCalledWith({
        where: { id: mockChat.id, workspaceId: mockChat.workspaceId },
      });
      expect(prisma.chat.update).toHaveBeenCalledWith({
        where: { id: mockChat.id },
        data: { providerId: PROVIDER_ID, model: "gpt-4" },
      });
    });

    it("clears the provider override by setting providerId to null", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue({
        ...mockChat,
        providerId: PROVIDER_ID,
        model: "gpt-4",
      });
      (prisma.chat.update as jest.Mock).mockResolvedValue({
        ...mockChat,
        providerId: null,
        model: null,
      });

      const res = await request(app)
        .patch(`/api/workspaces/${mockChat.workspaceId}/chats/${mockChat.id}/model`)
        .set(adminAuth())
        .send({ providerId: null, model: null });

      expect(res.status).toBe(200);
      expect(res.body.providerId).toBeNull();
      expect(res.body.model).toBeNull();
      expect(prisma.chat.update).toHaveBeenCalledWith({
        where: { id: mockChat.id },
        data: { providerId: null, model: null },
      });
    });

    it("updates only the model without changing providerId", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue({
        ...mockChat,
        providerId: PROVIDER_ID,
        model: "gpt-4",
      });
      (prisma.chat.update as jest.Mock).mockResolvedValue({
        ...mockChat,
        providerId: PROVIDER_ID,
        model: "gpt-4o",
      });

      const res = await request(app)
        .patch(`/api/workspaces/${mockChat.workspaceId}/chats/${mockChat.id}/model`)
        .set(adminAuth())
        .send({ model: "gpt-4o" });

      expect(res.status).toBe(200);
      expect(res.body.model).toBe("gpt-4o");
      expect(prisma.chat.update).toHaveBeenCalledWith({
        where: { id: mockChat.id },
        data: { model: "gpt-4o" },
      });
    });

    it("returns 404 when chat does not exist", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .patch(`/api/workspaces/${mockChat.workspaceId}/chats/99999999-0000-0000-0000-000000000999/model`)
        .set(adminAuth())
        .send({ providerId: PROVIDER_ID, model: "gpt-4" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Chat not found");
    });

    it("returns 401 without authentication", async () => {
      const res = await request(app)
        .patch(`/api/workspaces/${mockChat.workspaceId}/chats/${mockChat.id}/model`)
        .send({ providerId: PROVIDER_ID, model: "gpt-4" });

      expect(res.status).toBe(401);
    });

    it("rejects invalid providerId format (not UUID)", async () => {
      const res = await request(app)
        .patch(`/api/workspaces/${mockChat.workspaceId}/chats/${mockChat.id}/model`)
        .set(adminAuth())
        .send({ providerId: "not-a-uuid", model: "gpt-4" });

      // Zod validation returns 400 for invalid UUID format
      expect(res.status).toBe(400);
    });

    it("handles database errors gracefully", async () => {
      (prisma.chat.findFirst as jest.Mock).mockRejectedValue(new Error("DB connection lost"));

      const res = await request(app)
        .patch(`/api/workspaces/${mockChat.workspaceId}/chats/${mockChat.id}/model`)
        .set(adminAuth())
        .send({ providerId: PROVIDER_ID, model: "gpt-4" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("DB connection lost");
    });
  });

  describe("GET /api/workspaces/:workspaceId/chats", () => {
    it("returns chats including providerId and model fields", async () => {
      (prisma.chat.findMany as jest.Mock).mockResolvedValue([
        { ...mockChat, providerId: PROVIDER_ID, model: "gpt-4", _count: { messages: 0 }, pins: [] },
        { ...mockChat, id: "00000000-0000-0000-0000-000000000002", providerId: null, model: "gemma4:latest", _count: { messages: 0 }, pins: [] },
      ]);

      const res = await request(app)
        .get(`/api/workspaces/${mockChat.workspaceId}/chats`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].providerId).toBe(PROVIDER_ID);
      expect(res.body[0].model).toBe("gpt-4");
      expect(res.body[1].providerId).toBeNull();
    });

    it("returns empty array when workspace has no chats", async () => {
      (prisma.chat.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/workspaces/${mockChat.workspaceId}/chats`)
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});