// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget Archive-Chat Linking — PATCH /session/:token/chat/archive (Widget API-key variant).
 * Covers D-10 (widget API shared with JWT path), ARCH-LINK-02 (widget-side
 * session-IDOR + cross-workspace archive IDOR), anonymous audit (userId=null).
 *
 * Pattern mirrors internalWidget.test.ts (supertest + apiKeyMiddleware harness)
 * and chatArchive.test.ts (logEvent / linkArchive delegation). The shared
 * linkArchive service is mocked as jest.fn() — its internal IDOR/audit are
 * tested in chatArchive.test.ts (80-02). Here we assert the route delegates
 * correctly with userId=null and the widget-side session-IDOR holds.
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
jest.mock("../services/hybridSearchService", () => ({
  hybridSearch: jest.fn(),
  multiWorkspaceHybridSearch: jest.fn(),
}));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

// Mock apiKeyMiddleware: accept X-Api-Key header (mirrors internalWidget.test.ts harness)
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid authorization header" });
      return;
    }
    req.userId = "test-user";
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

// Mock the shared linkArchive service — the route MUST delegate to it (D-10).
const linkArchiveMock = jest.fn();
jest.mock("../services/chatArchiveService", () => ({
  linkArchive: (...args: any[]) => linkArchiveMock(...args),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";

const app = createApp();

const WIDGET_ID = "widget-001";
const WS_ID = "00000000-0000-0000-0000-000000000010";
const WS_ID_2 = "00000000-0000-0000-0000-000000000020";
// chatId is validated by widgetLinkArchiveBody (z.string().uuid()) — must be a
// valid UUID v4 (Zod's .uuid() enforces the version-4 nibble). workspaceId is
// NOT body-validated (resolved from DB), so it can stay all-zeros.
const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVE_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab";
const OTHER_WS_ARCHIVE_ID = "b2c3d4e5-f6a7-4b8c-9d0e-123456789abc";

const VALID_TOKEN = "a".repeat(64);

const mockSession = {
  id: "session-001",
  widgetId: WIDGET_ID,
  sessionToken: VALID_TOKEN,
  ipAddress: "127.0.0.1",
  messageCount: 5,
  conversationCount: 2,
  lastMessageAt: new Date("2025-06-01T12:00:00Z"),
  lastResetAt: new Date("2025-06-01T00:00:00Z"),
  createdAt: new Date("2025-06-01"),
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h in future
};

const mockWidget = {
  id: WIDGET_ID,
  name: "Test Widget",
  isActive: true,
  deletedAt: null,
  workspaces: [{ workspaceId: WS_ID }],
};

const mockMultiWsWidget = {
  ...mockWidget,
  workspaces: [{ workspaceId: WS_ID }, { workspaceId: WS_ID_2 }],
};

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

const API_KEY = "sk-test-key";

describe("Widget PATCH /api/internal/widget/session/:token/chat/archive (D-10 widget API-key path)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    linkArchiveMock.mockReset();
  });

  // ARCH-LINK-01 widget — link
  it("widget PATCH /archive links archive: valid session, whitelisted workspace, archiveId in same workspace → 200, full Chat with archiveId set", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(mockSession);
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WS_ID });
    linkArchiveMock.mockResolvedValue({ chat: { ...mockChat, archiveId: ARCHIVE_ID } });

    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ chatId: CHAT_ID, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(res.body.archiveId).toBe(ARCHIVE_ID);
    expect(res.body.id).toBe(CHAT_ID);
    // Delegation: linkArchive called with userId=null (anonymous widget session)
    expect(linkArchiveMock).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      archiveId: ARCHIVE_ID,
      workspaceId: WS_ID,
      userId: null,
    });
  });

  // ARCH-LINK-01 widget — unlink
  it("widget PATCH /archive unlinks: archiveId=null → 200, Chat.archiveId === null", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(mockSession);
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WS_ID });
    linkArchiveMock.mockResolvedValue({ chat: { ...mockChat, archiveId: null } });

    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ chatId: CHAT_ID, archiveId: null });

    expect(res.status).toBe(200);
    expect(res.body.archiveId).toBeNull();
    expect(linkArchiveMock).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      archiveId: null,
      workspaceId: WS_ID,
      userId: null,
    });
  });

  // ARCH-LINK-02 widget — session-IDOR: chat in non-whitelisted workspace → 404 hide existence
  it("widget PATCH /archive session-IDOR → 404: widget NOT whitelisted for the chat's workspace, chat.findFirst returns null", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(mockSession);
    // widget only whitelisted for WS_ID, but chat belongs to WS_ID_2 (not whitelisted)
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ chatId: CHAT_ID, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/chat not found/i);
    // Must NOT delegate to linkArchive on session-IDOR failure
    expect(linkArchiveMock).not.toHaveBeenCalled();
  });

  // T-80-07 — invalid token → 401
  it("widget PATCH /archive invalid token → 401: token not in DB", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/internal/widget/session/${"b".repeat(64)}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ chatId: CHAT_ID, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or expired session/i);
    expect(linkArchiveMock).not.toHaveBeenCalled();
  });

  // T-80-07 — expired token → 401
  it("widget PATCH /archive expired token → 401: session.expiresAt in the past", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue({
      ...mockSession,
      expiresAt: new Date("2020-01-01"),
    });

    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ chatId: CHAT_ID, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or expired session/i);
    expect(linkArchiveMock).not.toHaveBeenCalled();
  });

  // ARCH-LINK-02 widget — cross-workspace archive → 404 via shared linkArchive service
  it("widget PATCH /archive cross-workspace archive → 404: chat in WS_ID, archiveId in WS_ID_2 (both whitelisted), linkArchive returns archive_not_found", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(mockSession);
    // widget whitelisted for both WS_ID and WS_ID_2, so session-IDOR passes (chat in WS_ID)
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockMultiWsWidget);
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WS_ID });
    // linkArchive service catches the cross-workspace archive IDOR
    linkArchiveMock.mockResolvedValue({ error: "archive_not_found" });

    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ chatId: CHAT_ID, archiveId: OTHER_WS_ARCHIVE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/archive not found/i);
    // Delegation still happened (service does the archive IDOR check)
    expect(linkArchiveMock).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      archiveId: OTHER_WS_ARCHIVE_ID,
      workspaceId: WS_ID,
      userId: null,
    });
  });

  // 400 invalid UUID
  it("widget PATCH /archive invalid UUID → 400: archiveId='not-a-uuid'", async () => {
    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ chatId: CHAT_ID, archiveId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid request body/i);
    expect(res.body.details).toBeDefined();
  });

  // 400 missing chatId
  it("widget PATCH /archive missing chatId → 400: body without chatId", async () => {
    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ archiveId: ARCHIVE_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid request body/i);
  });

  // D-12 widget — anonymous audit userId=null (assert route passes null to service)
  it("widget PATCH /archive emits audit with userId=null: route calls linkArchive with userId=null (anonymous widget session)", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(mockSession);
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WS_ID });
    linkArchiveMock.mockResolvedValue({ chat: { ...mockChat, archiveId: ARCHIVE_ID } });

    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .set("X-Api-Key", API_KEY)
      .send({ chatId: CHAT_ID, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    // The route passes userId=null to linkArchive; the service then calls
    // logEvent("chat", chatId, "chat.archive.linked", null, {...}) — anonymous audit.
    expect(linkArchiveMock).toHaveBeenCalledTimes(1);
    const call = linkArchiveMock.mock.calls[0][0];
    expect(call.userId).toBeNull();
    expect(call.chatId).toBe(CHAT_ID);
    expect(call.workspaceId).toBe(WS_ID);
    expect(call.archiveId).toBe(ARCHIVE_ID);
  });
});