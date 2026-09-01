// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget session-IDOR cross-workspace 404 indistinguishability — COV-01.
 *
 * Pins the widget-session PATCH /session/:token/chat/archive route's 404-not-403
 * status mapping for the two not-found branches of `linkArchive`:
 *   - `archive_not_found`  (soft-deleted / never-existed archive)
 *   - `chat_not_found`     (cross-workspace chat — chat.workspaceId != session-bound WS)
 *
 * D-04: both branches MUST return HTTP 404 with shape-equal bodies
 * (single `error` key, no archiveId/exists/workspaceId metadata) so a caller
 * cannot distinguish "archive exists but inaccessible" from "archive does not
 * exist" (existence-hide policy, chatArchiveService.ts:10).
 *
 * This is a pure coverage test for the WIDGET-API-KEY session path — the JWT
 * path is covered by chatArchive.test.ts (80-02) and the happy-path widget
 * delegation by widgetArchive.test.ts. `linkArchive` is mocked as jest.fn()
 * because its internal IDOR/audit are already covered in chatArchive.test.ts;
 * here we assert the ROUTE's HTTP-status mapping for the widget-session path.
 *
 * Harness mirrors widgetArchive.test.ts:1-80 verbatim.
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

// Mock apiKeyMiddleware: accept X-Api-Key header, populate req.userId (mirrors widgetArchive.test.ts harness)
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

// THE KEY MOCK: linkArchive is jest.fn() — this test asserts the ROUTE's status
// mapping, not the service's internal IDOR (already covered in chatArchive.test.ts).
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
// chatId is validated by widgetLinkArchiveBody (z.string().uuid()) — must be a
// valid UUID v4 (Zod's .uuid() enforces the version-4 nibble).
const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVE_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab";
const VALID_TOKEN = "a".repeat(64);
const API_KEY = "sk-test-key";

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

/**
 * Shared request builder — reaches the linkArchive seam by passing session,
 * widget, and chat-IDOR lookups, then delegates to the mocked linkArchive.
 * The caller controls linkArchiveMock's resolved value to exercise each
 * not-found branch of the route's status mapping.
 */
async function sendArchivePatch() {
  (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(mockSession);
  (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
  (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WS_ID });
  return request(app)
    .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
    .set("X-Api-Key", API_KEY)
    .send({ chatId: CHAT_ID, archiveId: ARCHIVE_ID });
}

describe("COV-01: Widget session-IDOR cross-workspace 404 indistinguishability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    linkArchiveMock.mockReset();
  });

  // Case 1: deleted / inaccessible archive → 404 (archive_not_found branch)
  it("linkArchive returns archive_not_found → HTTP 404 with single-key {error} body (no metadata leak)", async () => {
    linkArchiveMock.mockResolvedValue({ error: "archive_not_found" });

    const res = await sendArchivePatch();

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(500);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(Object.keys(res.body).length).toBe(1);
    // Delegation happened — the route forwards to linkArchive before mapping status
    expect(linkArchiveMock).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      archiveId: ARCHIVE_ID,
      workspaceId: WS_ID,
      userId: null,
    });
  });

  // Case 2: cross-workspace chat → 404 (chat_not_found branch — foreign workspace)
  it("linkArchive returns chat_not_found (cross-workspace chat) → HTTP 404 with single-key {error} body", async () => {
    linkArchiveMock.mockResolvedValue({ error: "chat_not_found" });

    const res = await sendArchivePatch();

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(500);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(Object.keys(res.body).length).toBe(1);
    expect(linkArchiveMock).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      archiveId: ARCHIVE_ID,
      workspaceId: WS_ID,
      userId: null,
    });
  });

  // Case 3: indistinguishability — both not-found branches return the same
  // status (404) and the same body key set (["error"] only). Per D-04 /
  // Claude's Discretion we assert SHAPE equality, NOT deep message equality —
  // the route emits "Chat not found" vs "Archive not found" and changing that
  // is out of scope. The point is that no archiveId/exists/workspaceId field
  // leaks to let a caller distinguish the two branches.
  it("the two 404 bodies are shape-indistinguishable (same status, same key set)", async () => {
    linkArchiveMock.mockResolvedValue({ error: "archive_not_found" });
    const resA = await sendArchivePatch();

    linkArchiveMock.mockReset();
    linkArchiveMock.mockResolvedValue({ error: "chat_not_found" });
    const resB = await sendArchivePatch();

    // Same status
    expect(resA.status).toBe(404);
    expect(resB.status).toBe(404);
    expect(resA.status).toBe(resB.status);
    // Same body key set — only `error`, no archive-existence metadata leak
    expect(Object.keys(resA.body)).toEqual(["error"]);
    expect(Object.keys(resB.body)).toEqual(["error"]);
    expect(Object.keys(resA.body)).toEqual(Object.keys(resB.body));
    // No leak fields present in either body
    expect(resA.body).not.toHaveProperty("archiveId");
    expect(resA.body).not.toHaveProperty("exists");
    expect(resA.body).not.toHaveProperty("workspaceId");
    expect(resB.body).not.toHaveProperty("archiveId");
    expect(resB.body).not.toHaveProperty("exists");
    expect(resB.body).not.toHaveProperty("workspaceId");
  });

  // Case 4: apiKeyMiddleware sanity — the route is mounted under apiKeyMiddleware
  it("missing X-Api-Key → 401 { error: 'Missing API key' } (route is under apiKeyMiddleware)", async () => {
    const res = await request(app)
      .patch(`/api/internal/widget/session/${VALID_TOKEN}/chat/archive`)
      .send({ chatId: CHAT_ID, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing api key/i);
    // linkArchive must NOT be called when auth fails
    expect(linkArchiveMock).not.toHaveBeenCalled();
  });
});