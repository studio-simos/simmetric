// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive-Chat RAG Linking — PATCH /archive endpoint tests.
 * Covers ARCH-LINK-01 (link/unlink persist), ARCH-LINK-02 (IDOR 404 + 403),
 * D-12 (audit logEvent chat.archive.linked/unlinked).
 *
 * Pattern mirrors chatModel.test.ts (supertest + mocked Prisma + mocked auth/rbac).
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

// Configurable auth mock — tests can switch the active user via setTestUser().
// NOTE: currentTestUser lives INSIDE the auth factory to avoid TDZ under @swc/jest.
jest.mock("../middleware/auth", () => {
  let currentTestUser: {
    id: string;
    roles: Array<{ role: { name: string; permissions: Array<{ permissionName: string }> } }>;
  } = {
    id: "admin-001",
    roles: [{
      role: {
        name: "admin",
        permissions: [
          { permissionName: "chat:read" },
          { permissionName: "chat:write" },
          { permissionName: "archive:read" },
        ],
      },
    }],
  };
  return {
    authMiddleware: (req: any, res: any, next: any) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.userId = currentTestUser.id;
      req.user = currentTestUser;
      next();
    },
    apiKeyMiddleware: (req: any, res: any, next: any) => {
      res.status(401).json({ error: "Missing API key" });
    },
    __setTestUser: (user: typeof currentTestUser) => {
      currentTestUser = user;
    },
  };
});

export function setTestUser(user: {
  id: string;
  roles: Array<{ role: { name: string; permissions: Array<{ permissionName: string }> } }>;
}) {
  require("../middleware/auth").__setTestUser(user);
}

// Realistic requirePermission mock — inspects req.user.permissions (matches rbac.ts semantics).
jest.mock("../middleware/rbac", () => ({
  requirePermission: (permission: string) => (req: any, res: any, next: any) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const perms: string[] = [];
    for (const ur of req.user.roles || []) {
      for (const p of ur.role?.permissions || []) {
        perms.push(p.permissionName);
      }
    }
    // "admin" role bypasses (mirrors isAdmin check in real rbac.ts)
    const isAdmin = (req.user.roles || []).some((ur: any) => ur.role?.name === "admin");
    if (isAdmin || perms.includes(permission)) {
      return next();
    }
    res.status(403).json({ error: "Insufficient permissions" });
  },
  requireAdmin: (req: any, res: any, next: any) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const isAdmin = (req.user.roles || []).some((ur: any) => ur.role?.name === "admin");
    if (!isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  },
  requireProjectAccess: (req: any, res: any, next: any) => next(),
  requireWorkspaceAccess: (req: any, res: any, next: any) => next(),
}));

// logEvent mock — tests assert audit calls. Exposed via require after jest.mock.
jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn(),
  getEventLogs: jest.fn(),
}));
const logEventMock = require("../services/eventLogService").logEvent as jest.Mock;

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

function auth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const WS_ID = "00000000-0000-0000-0000-000000000010";
const CHAT_ID = "00000000-0000-0000-0000-000000000001";
const ARCHIVE_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab";
const OTHER_WS_ARCHIVE_ID = "b2c3d4e5-f6a7-4b8c-9d0e-123456789abc";
const NONEXISTENT_CHAT_ID = "00000000-0000-0000-0000-000000000099";

const mockChat = {
  id: CHAT_ID,
  workspaceId: WS_ID,
  name: "Test Chat",
  archiveId: null,
  providerId: null,
  model: "gemma4:latest",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const mockArchive = {
  id: ARCHIVE_ID,
  workspaceId: WS_ID,
  name: "Main Archive",
  deletedAt: null,
};

describe("PATCH /api/workspaces/:workspaceId/chats/:chatId/archive (Archive-Chat Linking)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default user has chat:write + archive:read
    setTestUser({
      id: "admin-001",
      roles: [{
        role: {
          name: "admin",
          permissions: [
            { permissionName: "chat:read" },
            { permissionName: "chat:write" },
            { permissionName: "archive:read" },
          ],
        },
      }],
    });
  });

  // ARCH-LINK-01 — link
  it("PATCH /archive links archive: valid same-workspace archiveId → 200, full Chat entity with archiveId set", async () => {
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue(mockChat);
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.chat.update as jest.Mock).mockResolvedValue({ ...mockChat, archiveId: ARCHIVE_ID });

    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${CHAT_ID}/archive`)
      .set(auth())
      .send({ archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(res.body.archiveId).toBe(ARCHIVE_ID);
    expect(res.body.id).toBe(CHAT_ID);
    // IDOR: chat scoped to workspace
    expect(prisma.chat.findFirst).toHaveBeenCalledWith({
      where: { id: CHAT_ID, workspaceId: WS_ID },
    });
    // Archives are GLOBAL (no workspaceId on Archive model) — the lookup only
    // filters by id + soft-delete. The chat-side IDOR (chat.workspaceId) above
    // is the access boundary.
    expect(prisma.archive.findFirst).toHaveBeenCalledWith({
      where: { id: ARCHIVE_ID, deletedAt: null },
    });
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: CHAT_ID },
      data: { archiveId: ARCHIVE_ID },
    });
  });

  // ARCH-LINK-01 — unlink
  it("PATCH /archive unlinks: archiveId=null → 200, Chat.archiveId === null, no archive lookup", async () => {
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ ...mockChat, archiveId: ARCHIVE_ID });
    (prisma.chat.update as jest.Mock).mockResolvedValue({ ...mockChat, archiveId: null });

    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${CHAT_ID}/archive`)
      .set(auth())
      .send({ archiveId: null });

    expect(res.status).toBe(200);
    expect(res.body.archiveId).toBeNull();
    // unlink must NOT perform an archive lookup
    expect(prisma.archive.findFirst).not.toHaveBeenCalled();
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: CHAT_ID },
      data: { archiveId: null },
    });
  });

  // ARCH-LINK-02 — non-existent / soft-deleted archive → 404 hide existence.
  // Archives are global (no workspaceId), so there is no cross-workspace
  // scoping; the IDOR boundary is the chat-side check (chat.workspaceId).
  // A non-existent or soft-deleted archiveId still yields archive_not_found
  // → 404, hiding archive existence from the caller.
  it("PATCH /archive IDOR: non-existent / soft-deleted archiveId → 404 Archive not found", async () => {
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue(mockChat);
    // archive.findFirst returns null because the archive does not exist or is
    // soft-deleted (not because it "belongs to another workspace").
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${CHAT_ID}/archive`)
      .set(auth())
      .send({ archiveId: OTHER_WS_ARCHIVE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Archive not found");
    // Must NOT update the chat on not-found failure
    expect(prisma.chat.update).not.toHaveBeenCalled();
  });

  // ARCH-LINK-02 — missing chat:write → 403
  it("PATCH /archive missing chat:write → 403 Insufficient permissions", async () => {
    setTestUser({
      id: "user-no-chatwrite",
      roles: [{
        role: {
          name: "user",
          permissions: [
            { permissionName: "chat:read" },
            { permissionName: "archive:read" },
            // NO chat:write
          ],
        },
      }],
    });

    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${CHAT_ID}/archive`)
      .set(auth())
      .send({ archiveId: ARCHIVE_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Insufficient permissions");
    // Middleware must short-circuit before any Prisma call
    expect(prisma.chat.findFirst).not.toHaveBeenCalled();
    expect(prisma.chat.update).not.toHaveBeenCalled();
  });

  // 404 chat not found
  it("PATCH /archive non-existent chat → 404 Chat not found", async () => {
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${NONEXISTENT_CHAT_ID}/archive`)
      .set(auth())
      .send({ archiveId: ARCHIVE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Chat not found");
    expect(prisma.archive.findFirst).not.toHaveBeenCalled();
    expect(prisma.chat.update).not.toHaveBeenCalled();
  });

  // 400 invalid UUID
  it("PATCH /archive invalid UUID → 400 Invalid request body with details", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${CHAT_ID}/archive`)
      .set(auth())
      .send({ archiveId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  // D-12 — audit linked
  it("PATCH /archive emits chat.archive.linked eventLog on successful link", async () => {
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue(mockChat);
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.chat.update as jest.Mock).mockResolvedValue({ ...mockChat, archiveId: ARCHIVE_ID });

    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${CHAT_ID}/archive`)
      .set(auth())
      .send({ archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(logEventMock).toHaveBeenCalledWith(
      "chat",
      CHAT_ID,
      "chat.archive.linked",
      "admin-001",
      { workspaceId: WS_ID, archiveId: ARCHIVE_ID },
    );
  });

  // D-12 — audit unlinked
  it("PATCH /archive emits chat.archive.unlinked eventLog on unlink", async () => {
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ ...mockChat, archiveId: ARCHIVE_ID });
    (prisma.chat.update as jest.Mock).mockResolvedValue({ ...mockChat, archiveId: null });

    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${CHAT_ID}/archive`)
      .set(auth())
      .send({ archiveId: null });

    expect(res.status).toBe(200);
    expect(logEventMock).toHaveBeenCalledWith(
      "chat",
      CHAT_ID,
      "chat.archive.unlinked",
      "admin-001",
      { workspaceId: WS_ID, archiveId: null },
    );
  });

  // 400 missing archiveId field
  it("PATCH /archive missing archiveId field → 400 (linkArchiveSchema requires archiveId, NOT optional)", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/chats/${CHAT_ID}/archive`)
      .set(auth())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });
});