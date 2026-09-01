// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Internal Widget API tests — internal endpoints for widget service
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
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../services/hybridSearchService", () => ({
  // Phase 93-02: the live widget RAG path now calls hybridSearchWithRerank,
  // which handles single-vs-multi-WS branching internally. Tests assert
  // against the wrapper (one mock) instead of hybridSearch/multiWorkspaceHybridSearch separately.
  hybridSearchWithRerank: jest.fn(),
}));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

// Mock apiKeyMiddleware: accept requests with X-Api-Key header, reject without
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

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { hybridSearchWithRerank } from "../services/hybridSearchService";
import { isFeatureEnabled } from "../services/licenseService";

const app = createApp();

// 151-02 (Task 7): the internal widget router is gated by
// requireFeature("widget_enabled") (mounted after apiKeyMiddleware). The
// licenseService mock defaults isFeatureEnabled to false (Community), so every
// test that reaches a route handler must flip the flag ON by default. The NEW
// Community-402 tests below flip it OFF explicitly. jest.clearAllMocks() in
// the describe-level beforeEach clears call history but NOT the default
// implementation, so this mockReturnValue survives.
beforeEach(() => {
  (isFeatureEnabled as jest.Mock).mockReturnValue(true);
});

const mockWidget = {
  id: "widget-001",
  name: "Test Widget",
  welcomeMessage: "Hello!",
  fallbackMessage: "Sorry, I can't help with that.",
  position: "bottom-right",
  isActive: true,
  primaryColor: "#4c6ef5",
  botName: "AI Assistant",
  logoUrl: null,
  avatarUrl: null,
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
  workspaces: [{ workspaceId: "workspace-001" }],
  // Localization blobs + fallbackLocale (D-04, Phase 126) — exact values pinned
  // by the drift-guard describe block below.
  localizedTexts: { en: { welcomeMessage: "Hello!" } },
  suggestedQuestions: { en: ["What is X?"] },
  credits: { enabled: true, label: "Powered by", url: "https://example.com" },
  fallbackLocale: "en",
  // 260809-uxk T3: archiveId binding — null here (unbound); the config test
  // below asserts the null pass-through and a bound variant.
  archiveId: null,
};

// 260809-uxk T3: archive-bound widget variant for the config emission test.
const ARCHIVE_ID = "00000000-0000-4000-8000-0000000000aa";
const mockWidgetWithArchive = {
  ...mockWidget,
  archiveId: ARCHIVE_ID,
};

const mockMultiWsWidget = {
  ...mockWidget,
  id: "widget-002",
  workspaces: [
    { workspaceId: "workspace-001" },
    { workspaceId: "workspace-002" },
  ],
};

const mockSession = {
  id: "session-001",
  widgetId: "widget-001",
  sessionToken: "a".repeat(64),
  ipAddress: "127.0.0.1",
  messageCount: 5,
  conversationCount: 2,
  lastMessageAt: new Date("2025-06-01T12:00:00Z"),
  lastResetAt: new Date("2025-06-01T00:00:00Z"),
  createdAt: new Date("2025-06-01"),
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h in future
};

// ─── Authentication ──────────────────────────────────────────────

describe("Internal Widget API - Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/api/internal/widget/widget-001/config");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing api key/i);
  });
});

// ─── GET /:id/config ──────────────────────────────────────────────

describe("GET /api/internal/widget/:id/config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns widget config when found", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("widget-001");
    expect(res.body.workspaceId).toBe("workspace-001");
    expect(res.body.name).toBe("Test Widget");
  });

  it("returns 404 when widget not found", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get("/api/internal/widget/nonexistent/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 404 when widget has no linked workspaces", async () => {
    const widgetNoWorkspaces = {
      ...mockWidget,
      workspaces: [],
    };
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(widgetNoWorkspaces);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no linked workspaces/i);
  });
});

// ─── POST /session ────────────────────────────────────────────────

describe("POST /api/internal/widget/session", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates session with 256-bit hex token (64-char hex)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widgetSession.create as jest.Mock).mockImplementation(({ data }: any) => ({
      id: "session-new",
      widgetId: data.widgetId,
      sessionToken: data.sessionToken,
      expiresAt: data.expiresAt,
    }));

    const res = await request(app)
      .post("/api/internal/widget/session")
      .set("X-Api-Key", "sk-test-key")
      .send({ widgetId: "widget-001", ipAddress: "127.0.0.1" });

    expect(res.status).toBe(201);
    expect(res.body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.widgetId).toBe("widget-001");
  });

  it("returns 400 when widgetId is missing", async () => {
    const res = await request(app)
      .post("/api/internal/widget/session")
      .set("X-Api-Key", "sk-test-key")
      .send({});

    expect(res.status).toBe(400);
  });
});

// ─── GET /session/:token ──────────────────────────────────────────

describe("GET /api/internal/widget/session/:token", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns session data when valid", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(mockSession);

    const res = await request(app)
      .get(`/api/internal/widget/session/${mockSession.sessionToken}`)
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("session-001");
    expect(res.body.hourlyRemaining).toBe(15); // 20 - 5
    expect(res.body.dailyRemaining).toBe(3); // 5 - 2
  });

  it("returns 401 when session expired", async () => {
    const expiredSession = {
      ...mockSession,
      expiresAt: new Date("2020-01-01"), // in the past
    };
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(expiredSession);

    const res = await request(app)
      .get(`/api/internal/widget/session/${mockSession.sessionToken}`)
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });
});

// ─── PATCH /session/:token/increment ─────────────────────────────

describe("PATCH /api/internal/widget/session/:token/increment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("increments messageCount", async () => {
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(mockSession);
    (prisma.widgetSession.update as jest.Mock).mockResolvedValue({
      ...mockSession,
      messageCount: 6,
    });

    const res = await request(app)
      .patch(`/api/internal/widget/session/${mockSession.sessionToken}/increment`)
      .set("X-Api-Key", "sk-test-key")
      .send({ field: "messageCount" });

    expect(res.status).toBe(200);
    expect(res.body.messageCount).toBe(6);
    expect(res.body.hourlyRemaining).toBe(14); // 20 - 6
  });

  it("returns 429 when message limit reached (>= 20)", async () => {
    const limitedSession = {
      ...mockSession,
      messageCount: 20,
    };
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(limitedSession);

    const res = await request(app)
      .patch(`/api/internal/widget/session/${mockSession.sessionToken}/increment`)
      .set("X-Api-Key", "sk-test-key")
      .send({ field: "messageCount" });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("returns 429 when conversation limit reached (>= 5)", async () => {
    const limitedSession = {
      ...mockSession,
      conversationCount: 5,
    };
    (prisma.widgetSession.findUnique as jest.Mock).mockResolvedValue(limitedSession);

    const res = await request(app)
      .patch(`/api/internal/widget/session/${mockSession.sessionToken}/increment`)
      .set("X-Api-Key", "sk-test-key")
      .send({ field: "conversationCount" });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("returns 400 for invalid field", async () => {
    const res = await request(app)
      .patch(`/api/internal/widget/session/${mockSession.sessionToken}/increment`)
      .set("X-Api-Key", "sk-test-key")
      .send({ field: "invalidField" });

    expect(res.status).toBe(400);
  });
});

// ─── Extended GET /:id/config (workspaceIds) ──────────────────────

describe("GET /api/internal/widget/:id/config - extended with workspaceIds", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns workspaceIds array with all linked workspace IDs", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockMultiWsWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-002/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.workspaceIds).toEqual(["workspace-001", "workspace-002"]);
  });

  it("returns workspaceId (first workspace) for backward compat", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockMultiWsWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-002/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.workspaceId).toBe("workspace-001");
  });

  it("returns workspaceIds with single workspace", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.workspaceIds).toEqual(["workspace-001"]);
    expect(res.body.workspaceId).toBe("workspace-001");
  });

  it("returns 404 when widget has no linked workspaces (empty workspaceIds)", async () => {
    const widgetNoWorkspaces = {
      ...mockWidget,
      workspaces: [],
    };
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(widgetNoWorkspaces);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no linked workspaces/i);
  });
});

// ─── GET /:id/config - raw localization blobs (D-01, Phase 126) ────────

describe("GET /api/internal/widget/:id/config - raw localization blobs (D-01, Phase 126)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("emits the four new raw fields with exact values", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.localizedTexts).toEqual({ en: { welcomeMessage: "Hello!" } });
    expect(res.body.suggestedQuestions).toEqual({ en: ["What is X?"] });
    expect(res.body.credits).toEqual({ enabled: true, label: "Powered by", url: "https://example.com" });
    expect(res.body.fallbackLocale).toBe("en");
  });

  it("passes null blobs through as null (not omitted)", async () => {
    // Explicit nulls are mandatory — omitting the fields would produce
    // undefined and res.json would DROP the keys (RESEARCH Common Pitfall 1).
    const widgetNullBlobs = { ...mockWidget, localizedTexts: null, suggestedQuestions: null, credits: null };
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(widgetNullBlobs);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.localizedTexts).toBeNull();
    expect(res.body.suggestedQuestions).toBeNull();
    expect(res.body.credits).toBeNull();
  });

  it("defaults fallbackLocale to en when DB value is null", async () => {
    const widgetNoLocale = { ...mockWidget, fallbackLocale: null };
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(widgetNoLocale);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.fallbackLocale).toBe("en");
  });

  it("emits whiteLabel false with the license mock (D-03, CRD-02)", async () => {
    // The config response must carry the license-derived flag, never
    // client-supplied. 151-02 (Task 7): the router gate checks
    // widget_enabled — keep THAT flag on (or the request 402s) while
    // white_label is off, exactly mirroring a real license payload.
    (isFeatureEnabled as jest.Mock).mockImplementation(
      (flag: string) => flag === "widget_enabled",
    );
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.whiteLabel).toBe(false);
  });

  it("emits whiteLabel true when the white_label license feature is enabled (D-03, CRD-02)", async () => {
    (isFeatureEnabled as jest.Mock).mockReturnValueOnce(true);
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.whiteLabel).toBe(true);
  });

  // 260809-uxk T3 — archiveId config emission: the widget config API carries
  // the archive binding (null when unbound) so the widget client knows the
  // bound archive for chat; the value is server-derived from the DB row.
  it("emits archiveId from the widget row when bound (260809-uxk)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidgetWithArchive);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.archiveId).toBe(ARCHIVE_ID);
  });

  it("emits archiveId null when the widget is unbound (260809-uxk)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    // Explicit null (not omitted) — mirrors the other nullable pass-throughs
    expect(res.body.archiveId).toBeNull();
  });
});

// ─── POST /search ─────────────────────────────────────────────────

describe("POST /api/internal/widget/search", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns search results for widget linked to single workspace", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
      ...mockWidget,
      workspaces: [{ workspaceId: "workspace-001" }],
    });
    (hybridSearchWithRerank as jest.Mock).mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        documentName: "Test Doc",
        chunkText: "Test content",
        score: 0.05,
        source: "both",
        metadata: { sourceWorkspaceId: "workspace-001" },
      },
    ]);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].chunkId).toBe("chunk-1");
    // Phase 93-02: the wrapper handles single-vs-multi branching internally.
    // The caller passes the full workspaceIds array; the wrapper decides.
    expect(hybridSearchWithRerank).toHaveBeenCalledWith("test query", ["workspace-001"], 10);
  });

  it("returns search results for widget linked to multiple workspaces", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockMultiWsWidget);
    (hybridSearchWithRerank as jest.Mock).mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        documentName: "Test Doc",
        chunkText: "Test content",
        score: 0.05,
        source: "both",
        metadata: { sourceWorkspaceId: "workspace-001" },
      },
    ]);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    // Phase 93-02: the wrapper handles single-vs-multi branching internally.
    expect(hybridSearchWithRerank).toHaveBeenCalledWith(
      "test query",
      ["workspace-001", "workspace-002"],
      10
    );
  });

  it("returns 400 when query is missing", async () => {
    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 400 when widgetId is missing", async () => {
    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns empty results for widget with no linked workspaces", async () => {
    const widgetNoWorkspaces = {
      ...mockWidget,
      workspaces: [],
    };
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(widgetNoWorkspaces);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    // Phase 93-02: no workspaces → wrapper not called (route short-circuits before).
    expect(hybridSearchWithRerank).not.toHaveBeenCalled();
  });

  it("returns 404 for non-existent widgetId", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("resolves workspaceIds ONLY from the widget's DB whitelist (IDOR prevention)", async () => {
    // Widget A is linked to workspace-001 and workspace-002
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockMultiWsWidget);
    (hybridSearchWithRerank as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
        // Client tries to send workspaceIds but server ignores them
        workspaceIds: ["workspace-003", "workspace-004"],
      });

    expect(res.status).toBe(200);
    // Server should use widget's DB workspaces, NOT client-provided ones
    expect(hybridSearchWithRerank).toHaveBeenCalledWith(
      "test query",
      ["workspace-001", "workspace-002"], // DB-resolved, not client-provided
      10
    );
  });

  // 131-07 (G-131-19): the bound archive participates in the widget pre-search.
  // The archive pseudo-workspace ("archive:<id>") joins the workspace whitelist
  // — server-side resolution from the DB row keeps the archive out of client
  // control (T-131-17, same IDOR pattern as the workspace whitelist).
  it("appends the bound archive pseudo-workspace to the pre-search (G-131-19)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidgetWithArchive);
    (hybridSearchWithRerank as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
      });

    expect(res.status).toBe(200);
    expect(hybridSearchWithRerank).toHaveBeenCalledWith(
      "test query",
      ["workspace-001", `archive:${ARCHIVE_ID}`],
      10
    );
  });

  it("keeps the exact current call when the widget has no bound archive (null archiveId)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (hybridSearchWithRerank as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
      });

    expect(res.status).toBe(200);
    expect(hybridSearchWithRerank).toHaveBeenCalledWith("test query", ["workspace-001"], 10);
  });

  // 131-07 (G-131-19) Test 2b — the early-return bypass regression test: a
  // widget with a bound archive but ZERO linked workspaces must STILL search
  // the archive. The empty-workspaces early-return must not short-circuit the
  // archive search (archive-only widget).
  it("searches the archive for an archive-only widget (zero linked workspaces) — early-return bypass fixed (G-131-19)", async () => {
    const archiveOnlyWidget = {
      ...mockWidgetWithArchive,
      workspaces: [],
    };
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(archiveOnlyWidget);
    (hybridSearchWithRerank as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({
        query: "test query",
        widgetId: "550e8400-e29b-41d4-a716-446655440000",
      });

    expect(res.status).toBe(200);
    expect(hybridSearchWithRerank).toHaveBeenCalledWith(
      "test query",
      [`archive:${ARCHIVE_ID}`],
      10
    );
  });
});

// ─── 151-02 (Task 7): Community tier disables the widget runtime ─────────────

describe("Internal Widget API — Community tier (widget_enabled=false, 151-02 Task 7)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The default beforeEach above flips isFeatureEnabled(true) — Community
    // tests explicitly flip it OFF (the mock default is false; this makes the
    // intent explicit and immune to the global default changing).
    (isFeatureEnabled as jest.Mock).mockReturnValue(false);
  });

  it("GET /config → 402 { error, feature: widget_enabled, tier: community }", async () => {
    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("This feature requires an Enterprise license");
    expect(res.body.feature).toBe("widget_enabled");
    expect(res.body.tier).toBe("community");
    // The route handler must NOT run (no DB lookup in Community).
    expect(prisma.widget.findFirst).not.toHaveBeenCalled();
  });

  it("POST /session → 402 (Community) — the runtime widget cannot mint sessions", async () => {
    const res = await request(app)
      .post("/api/internal/widget/session")
      .set("X-Api-Key", "sk-test-key")
      .send({ widgetId: "widget-001" });

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe("widget_enabled");
    expect(res.body.tier).toBe("community");
    expect(prisma.widgetSession.create).not.toHaveBeenCalled();
  });

  it("POST /chat/stream → 402 (Community) — no SSE, no agent work", async () => {
    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set("X-Api-Key", "sk-test-key")
      .send({ message: "hello", widgetId: "widget-001" });

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe("widget_enabled");
    expect(res.body.tier).toBe("community");
  });

  it("POST /search → 402 (Community)", async () => {
    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-test-key")
      .send({ query: "test", widgetId: "widget-001" });

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe("widget_enabled");
    expect(hybridSearchWithRerank).not.toHaveBeenCalled();
  });

  it("with the flag enabled → normal behavior is restored (GET /config 200)", async () => {
    (isFeatureEnabled as jest.Mock).mockReturnValue(true);
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("widget-001");
  });

  it("auth still precedes the license gate — no API key → 401, not 402", async () => {
    const res = await request(app)
      .get("/api/internal/widget/widget-001/config");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing api key/i);
  });
});