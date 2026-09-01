// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Chat Organization integration tests — folders, pins, move, export
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    withSoftDelete: (where: object) => where,
  };
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
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
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
          permissions: [{ permissionName: "admin:settings" }],
        },
      }],
    };
    next();
  },
  apiKeyMiddleware: (req: any, res: any, next: any) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      res.status(401).json({ error: "Missing API key" });
      return;
    }
    req.userId = "service-account-001";
    req.user = { id: "service-account-001", username: "widget-service", roles: [] };
    next();
  },
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const mockFolder = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  name: "Support",
  workspaceId: "ws-1",
  deletedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

const mockChat = {
  id: "550e8400-e29b-41d4-a716-446655440002",
  name: "Test Chat",
  workspaceId: "ws-1",
  folderId: null,
  providerId: null,
  model: null,
  deletedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

const mockMessage = {
  id: "550e8400-e29b-41d4-a716-446655440003",
  chatId: "550e8400-e29b-41d4-a716-446655440002",
  role: "user",
  content: "Hello",
  metadata: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

// ─── Chat Organization API ──────────────────────────────────────────

describe("Chat Organization API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Folders ────────────────────────────────────────────────────────

  describe("GET /api/workspaces/:workspaceId/folders", () => {
    it("returns 200 with folder array", async () => {
      (prisma.chatFolder.findMany as jest.Mock).mockResolvedValue([mockFolder]);

      const res = await request(app)
        .get("/api/workspaces/ws-1/folders")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("Support");
    });
  });

  describe("POST /api/workspaces/:workspaceId/folders", () => {
    it("creates a folder and returns 201", async () => {
      (prisma.chatFolder.create as jest.Mock).mockImplementation(({ data }: any) => ({
        ...mockFolder,
        ...data,
      }));

      const res = await request(app)
        .post("/api/workspaces/ws-1/folders")
        .set(adminAuth())
        .send({ name: "Support" });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Support");
    });

    it("returns 400 with invalid name", async () => {
      const res = await request(app)
        .post("/api/workspaces/ws-1/folders")
        .set(adminAuth())
        .send({ name: "" });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/workspaces/:workspaceId/folders/:folderId", () => {
    it("returns 200 and unassigns chats when cascade=false", async () => {
      (prisma.chatFolder.findFirst as jest.Mock).mockResolvedValue(mockFolder);
      (prisma.$transaction as jest.Mock).mockResolvedValue([{ count: 2 }, mockFolder]);

      const res = await request(app)
        .delete("/api/workspaces/ws-1/folders/550e8400-e29b-41d4-a716-446655440001?cascade=false")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/deleted/i);
    });

    it("returns 200 and soft-deletes chats when cascade=true", async () => {
      (prisma.chatFolder.findFirst as jest.Mock).mockResolvedValue(mockFolder);
      (prisma.$transaction as jest.Mock).mockResolvedValue([{ count: 2 }, mockFolder]);

      const res = await request(app)
        .delete("/api/workspaces/ws-1/folders/550e8400-e29b-41d4-a716-446655440001?cascade=true")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.cascade).toBe(true);
    });

    it("returns 500 when transaction fails", async () => {
      (prisma.$transaction as jest.Mock).mockRejectedValue(new Error("Record not found"));

      const res = await request(app)
        .delete("/api/workspaces/ws-1/folders/550e8400-e29b-41d4-a716-446655440001")
        .set(adminAuth());

      expect(res.status).toBe(500);
    });
  });

  // ─── Chat List with Pins ────────────────────────────────────────────

  describe("GET /api/workspaces/:workspaceId/chats", () => {
    it("returns chats with isPinned and messageCount", async () => {
      (prisma.chat.findMany as jest.Mock).mockResolvedValue([
        {
          ...mockChat,
          pins: [],
          _count: { messages: 3 },
        },
      ]);

      const res = await request(app)
        .get("/api/workspaces/ws-1/chats")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body[0].isPinned).toBe(false);
      expect(res.body[0].messageCount).toBe(3);
    });
  });

  // ─── Pin / Unpin ────────────────────────────────────────────────────

  describe("POST /api/workspaces/:workspaceId/chats/:chatId/pin", () => {
    it("returns { pinned: true }", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(mockChat);
      (prisma.chatPin.create as jest.Mock).mockResolvedValue({ userId: "admin-001", chatId: "550e8400-e29b-41d4-a716-446655440002" });

      const res = await request(app)
        .post("/api/workspaces/ws-1/chats/550e8400-e29b-41d4-a716-446655440002/pin")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.pinned).toBe(true);
    });

    it("returns 404 when chat not found", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/workspaces/ws-1/chats/nonexistent/pin")
        .set(adminAuth());

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/workspaces/:workspaceId/chats/:chatId/pin", () => {
    it("returns { pinned: false }", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(mockChat);
      (prisma.chatPin.delete as jest.Mock).mockResolvedValue({ userId: "admin-001", chatId: "550e8400-e29b-41d4-a716-446655440002" });

      const res = await request(app)
        .delete("/api/workspaces/ws-1/chats/550e8400-e29b-41d4-a716-446655440002/pin")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.pinned).toBe(false);
    });
  });

  // ─── Move Chat ──────────────────────────────────────────────────────

  describe("PUT /api/workspaces/:workspaceId/chats/:chatId/move", () => {
    it("moves chat to folder and returns updated chat", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(mockChat);
      (prisma.chatFolder.findFirst as jest.Mock).mockResolvedValue(mockFolder);
      (prisma.chat.update as jest.Mock).mockResolvedValue({ ...mockChat, folderId: "550e8400-e29b-41d4-a716-446655440001" });

      const res = await request(app)
        .put("/api/workspaces/ws-1/chats/550e8400-e29b-41d4-a716-446655440002/move")
        .set(adminAuth())
        .send({ folderId: "550e8400-e29b-41d4-a716-446655440001" });

      expect(res.status).toBe(200);
      expect(res.body.folderId).toBe("550e8400-e29b-41d4-a716-446655440001");
    });

    it("returns 404 when chat not found", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .put("/api/workspaces/ws-1/chats/nonexistent/move")
        .set(adminAuth())
        .send({ folderId: "550e8400-e29b-41d4-a716-446655440001" });

      expect(res.status).toBe(404);
    });

    it("returns 404 when target folder not found", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(mockChat);
      (prisma.chatFolder.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .put("/api/workspaces/ws-1/chats/550e8400-e29b-41d4-a716-446655440002/move")
        .set(adminAuth())
        .send({ folderId: "550e8400-e29b-41d4-a716-446655440001" });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/folder not found/i);
    });

    it("allows moving chat out of folder with null folderId", async () => {
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ ...mockChat, folderId: "550e8400-e29b-41d4-a716-446655440001" });
      (prisma.chat.update as jest.Mock).mockResolvedValue({ ...mockChat, folderId: null });

      const res = await request(app)
        .put("/api/workspaces/ws-1/chats/550e8400-e29b-41d4-a716-446655440002/move")
        .set(adminAuth())
        .send({ folderId: null });

      expect(res.status).toBe(200);
      expect(res.body.folderId).toBeNull();
    });
  });

  // ─── Export Chat ────────────────────────────────────────────────────

  describe("GET /api/workspaces/:workspaceId/chats/:chatId/export", () => {
    it("returns JSON export with messages array", async () => {
      (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ name: "Test Workspace" });
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue({
        ...mockChat,
        messages: [mockMessage],
      });

      const res = await request(app)
        .get("/api/workspaces/ws-1/chats/550e8400-e29b-41d4-a716-446655440002/export")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.chats[0].id).toBe("550e8400-e29b-41d4-a716-446655440002");
      expect(res.body.chats[0].title).toBe("Test Chat");
      expect(res.body.chats[0].messages).toHaveLength(1);
      expect(res.body.chats[0].messages[0].role).toBe("user");
      expect(res.body.chats[0].messages[0].content).toBe("Hello");
    });

    it("returns 404 when chat not found", async () => {
      (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ name: "Test Workspace" });
      (prisma.chat.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get("/api/workspaces/ws-1/chats/nonexistent/export")
        .set(adminAuth());

      expect(res.status).toBe(404);
    });
  });

  // ─── Authentication ─────────────────────────────────────────────────

  describe("Authentication", () => {
    it("returns 401 for unauthenticated folder list", async () => {
      const res = await request(app).get("/api/workspaces/ws-1/folders");
      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated move request", async () => {
      const res = await request(app)
        .put("/api/workspaces/ws-1/chats/550e8400-e29b-41d4-a716-446655440002/move")
        .send({ folderId: "550e8400-e29b-41d4-a716-446655440001" });

      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated export request", async () => {
      const res = await request(app).get("/api/workspaces/ws-1/chats/550e8400-e29b-41d4-a716-446655440002/export");
      expect(res.status).toBe(401);
    });
  });
});
