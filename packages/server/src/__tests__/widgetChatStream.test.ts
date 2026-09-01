// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget chat stream — internal API integration test (260809-tuw).
 *
 * Pins the new POST /api/internal/widget/chat/stream endpoint (widget
 * service → server, API-key auth) end to end without a real DB or LLM:
 *
 *   - apiKeyMiddleware auth (401 without X-Api-Key)
 *   - body validation (400), X-Widget-Id header requirement (400)
 *   - widget resolution + whitelist IDOR (404 unknown/inactive, 404 empty
 *     whitelist, client-supplied workspaceId ignored)
 *   - SSE happy path (token/status/done) driven via mocked runAgentStreaming
 *   - ragContext / disableRagSearch passthrough (composed schema must not
 *     strip them)
 *   - widget analytics headers (X-Widget-Id / X-Widget-Session-Id)
 *   - chatId continuation scoped to the whitelisted workspace
 *
 * The acting user is the widget-service account (req.userId from the mocked
 * apiKeyMiddleware) — chat persistence, DLP logging and analytics keep
 * working for anonymous widget sessions.
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

// Mock the orchestrator — we drive the token/status/thinking callbacks from the test.
jest.mock("../agent/orchestrator", () => ({
  runAgent: jest.fn(),
  runAgentStreaming: jest.fn(),
}));

jest.mock("../agent/builtinSkills", () => ({}));
jest.mock("../services/templateService", () => ({
  seedTemplates: jest.fn(),
  resolveSystemPrompt: jest.fn(),
  resolveSkills: jest.fn(),
  getTemplateForWorkspace: jest.fn(),
}));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn().mockResolvedValue({ value: "false" }), // DLP disabled
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/wikiLinkService", () => ({
  resolveWikilinks: jest.fn().mockResolvedValue([]),
  extractWikilinkSlugs: jest.fn().mockReturnValue([]),
}));
jest.mock("../services/widgetAnalyticsService", () => ({ recordWidgetEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/postProcessingService", () => ({
  generateAutoTitle: jest.fn().mockResolvedValue(undefined),
  generateTagsAndFollowUps: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
}));
jest.mock("../routes/push", () => {
  const express = jest.requireActual("express");
  return {
    __esModule: true,
    default: express.Router(),
    sendPushNotification: jest.fn().mockResolvedValue(undefined),
  };
});

// Mock apiKeyMiddleware: accept requests with X-Api-Key (widget-service
// account as the acting user), reject without — mirrors internalWidget.test.ts.
jest.mock("../middleware/auth", () => ({
  authMiddleware: (_req: any, res: any, next: any) => next(),
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

jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireProjectAccess: () => (_req: any, _res: any, next: any) => next(),
  requireWorkspaceAccess: (_req: any, _res: any, next: any) => next(),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { runAgentStreaming } from "../agent/orchestrator";
import { recordWidgetEvent } from "../services/widgetAnalyticsService";
import { getSetting } from "../services/systemConfigService";
import { logEvent } from "../services/eventLogService";

const app = createApp();

const WIDGET_ID = "widget-001";
const SESSION_ID = "session-001";
const WORKSPACE_ID = "workspace-001";
// Version-4 UUID (zod's z.string().uuid() rejects all-zero version bits)
const CHAT_ID = "00000000-0000-4000-8000-000000000001";

const mockWidget = {
  id: WIDGET_ID,
  isActive: true,
  deletedAt: null,
  workspaces: [{ workspaceId: WORKSPACE_ID }],
};

const mockMultiWsWidget = {
  ...mockWidget,
  id: "widget-002",
  workspaces: [
    { workspaceId: WORKSPACE_ID },
    { workspaceId: "workspace-002" },
  ],
};

// 260809-uxk T3: widget bound to a knowledge archive — the DB row carries
// archiveId (version-4 UUID — zod's z.string().uuid() rejects all-zero bits).
const ARCHIVE_ID = "00000000-0000-4000-8000-0000000000aa";
const mockWidgetWithArchive = {
  ...mockWidget,
  archiveId: ARCHIVE_ID,
};

function mockAgentResult() {
  return {
    response: "Here is the answer.",
    sources: [],
    toolCalls: [],
    iterations: 1,
    tokenUsage: null,
    providerType: "ollama",
    resolvedModel: "gemma:latest",
  };
}

function seedPrismaForStream() {
  (prisma.chat.findFirst as jest.Mock).mockResolvedValue({
    id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null,
  });
  // 260809-uxk T3: the created row echoes the archiveId from the create data
  // (real DB behavior — runAgentStreaming reads chat.archiveId from the row).
  (prisma.chat.create as jest.Mock).mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null,
    ...(data.archiveId ? { archiveId: data.archiveId } : {}),
  }));
  (prisma.chatMessage.create as jest.Mock).mockResolvedValue({ id: "assistant-msg-1" });
  (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([]);
}

function streamHeaders() {
  return {
    "X-Api-Key": "sk-test-key",
    "X-Widget-Id": WIDGET_ID,
    "X-Widget-Session-Id": SESSION_ID,
  };
}

describe("POST /api/internal/widget/chat/stream — auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without X-Api-Key (apiKeyMiddleware rejects)", async () => {
    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set("X-Widget-Id", WIDGET_ID)
      .send({ message: "hi" });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing api key/i);
  });
});

describe("POST /api/internal/widget/chat/stream — validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 400 with details for an invalid body (no message)", async () => {
    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 when X-Widget-Id header is missing", async () => {
    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set("X-Api-Key", "sk-test-key")
      .send({ message: "hi" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("X-Widget-Id header is required");
  });
});

describe("POST /api/internal/widget/chat/stream — widget resolution (IDOR)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 404 for an unknown/inactive widget", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Widget not found or inactive");
    expect(prisma.widget.findFirst).toHaveBeenCalledWith({
      where: { id: WIDGET_ID, deletedAt: null, isActive: true },
      include: { workspaces: { select: { workspaceId: true } } },
    });
  });

  it("returns 404 for a widget with an empty workspaces whitelist", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({ ...mockWidget, workspaces: [] });

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Widget has no linked workspaces");
  });
});

describe("POST /api/internal/widget/chat/stream — SSE happy path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedPrismaForStream();
  });

  it("streams token/status/done SSE events and persists user + assistant messages", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(
      async (
        _p: unknown,
        onToken: (t: string) => void,
        onStatus: (s: string) => void,
        _g: unknown,
        _e: unknown,
        _onPlan: unknown,
        onThinking?: (t: string) => void,
      ) => {
        onToken("Hello");
        onStatus("Searching documents...");
        if (onThinking) onThinking("secret reasoning");
        return mockAgentResult();
      },
    );

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("event: token");
    expect(res.text).toContain("event: status");
    expect(res.text).toContain("event: done");
    expect(res.text).toContain(`"chatId":"${CHAT_ID}"`);
    // Thinking is emitted ONLY with include_thinking=true (Pitfall 4) — the
    // widget never sends it, so no `event: thinking` may reach the proxy.
    expect(res.text).not.toContain("event: thinking");

    // User + assistant messages persisted under the widget-service account flow
    const createCalls = (prisma.chatMessage.create as jest.Mock).mock.calls;
    expect(createCalls.some((c) => c[0].data.role === "user" && c[0].data.content === "hi")).toBe(true);
    expect(createCalls.some((c) => c[0].data.role === "assistant")).toBe(true);
  });

  it("resolves the workspace from the whitelist — client-supplied workspaceId is ignored (IDOR pin)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi", workspaceId: "attacker-controlled-workspace" });

    expect(res.status).toBe(200);

    // runAgentStreaming receives the whitelisted workspace, never the body field
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.workspaceId).toBe(WORKSPACE_ID);

    // prisma.chat.create receives the whitelisted workspace too
    const createCall = (prisma.chat.create as jest.Mock).mock.calls[0];
    expect(createCall[0].data.workspaceId).toBe(WORKSPACE_ID);
  });

  it("passes ragContext and disableRagSearch through to runAgentStreaming", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi", ragContext: "[Source: doc1.pdf]\nRAG content", disableRagSearch: true });

    expect(res.status).toBe(200);

    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.ragContext).toBe("[Source: doc1.pdf]\nRAG content");
    expect(params.disableRagSearch).toBe(true);
  });

  it("passes locale through to runAgentStreaming (G-131-19 — composed body must not strip it)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "Ciao", locale: "it" });

    expect(res.status).toBe(200);

    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.locale).toBe("it");
  });

  it("omits locale from runAgentStreaming params when the body has none (additive)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);

    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.locale).toBeUndefined();
  });

  it("rejects an unknown locale (xx) — enum whitelist is the prompt-injection defense", async () => {
    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi", locale: "xx" });

    expect(res.status).toBe(400);
  });

  it("records widget analytics with X-Widget-Id and X-Widget-Session-Id headers", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(recordWidgetEvent).toHaveBeenCalledWith(
      expect.objectContaining({ widgetId: WIDGET_ID, sessionId: SESSION_ID, query: "hi" }),
    );
  });

  it("scopes chatId continuation to the whitelisted workspace", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "continue", chatId: CHAT_ID });

    expect(res.status).toBe(200);
    expect(prisma.chat.findFirst).toHaveBeenCalledWith({
      where: { id: CHAT_ID, workspaceId: WORKSPACE_ID },
    });
  });

  it("uses the primary whitelisted workspace when the widget has multiple workspaces", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockMultiWsWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set({ ...streamHeaders(), "X-Widget-Id": "widget-002" })
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.workspaceId).toBe(WORKSPACE_ID);
  });
});

// 260809-uxk T3 — archiveId binding (D-08 wiki_query): a widget whose DB row
// carries archiveId must create the Chat with that binding AND pass it to
// runAgentStreaming (the orchestrator's wiki_query FTS/RAG binding). The
// value comes from the DB row resolved via X-Widget-Id — NEVER client-supplied.
describe("POST /api/internal/widget/chat/stream — archiveId binding (260809-uxk)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedPrismaForStream();
  });

  it("widget with archiveId → chat.create data.archiveId + runAgentStreaming params.archiveId", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidgetWithArchive);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);

    // Chat created with the archiveId binding from the DB row
    const createCall = (prisma.chat.create as jest.Mock).mock.calls[0];
    expect(createCall[0].data.archiveId).toBe(ARCHIVE_ID);

    // runAgentStreaming receives the binding → wiki_query finds archive content
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.archiveId).toBe(ARCHIVE_ID);
  });

  it("widget WITHOUT archiveId → chat.create data has no archiveId key and runAgentStreaming receives undefined", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);

    // No archiveId key in the create data (truthy-only spread)
    const createCall = (prisma.chat.create as jest.Mock).mock.calls[0];
    expect(createCall[0].data.archiveId).toBeUndefined();

    // JWT-route behavior unchanged: undefined archiveId
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.archiveId).toBeUndefined();
  });

  it("a client-supplied archiveId in the body is ignored (IDOR-safe — DB row wins)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi", archiveId: "00000000-0000-4000-8000-0000000000bb" });

    expect(res.status).toBe(200);
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    // Body archiveId stripped by the composed schema → undefined from the DB row
    expect(params.archiveId).toBeUndefined();
  });
});

// 260831-hgy — per-widget response model pin. A widget whose DB row carries
// responseProviderId/responseModel must serve its chats with EXACTLY that
// provider/model (chat.create + runAgentStreaming); a widget without the pin
// behaves byte-identically to today (no providerId/model reach the agent);
// client-supplied model fields are stripped (tamper pin — the model is
// assigned ONLY from the DB row resolved via X-Widget-Id).
describe("POST /api/internal/widget/chat/stream — response model pin (260831-hgy)", () => {
  const PROVIDER_ID = "00000000-0000-4000-8000-0000000000cc";
  const MODEL_NAME = "qwen2.5:7b";

  // Widget fixture with the pin set — both columns populated.
  const mockWidgetWithModel = {
    ...mockWidget,
    responseProviderId: PROVIDER_ID,
    responseModel: MODEL_NAME,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    seedPrismaForStream();
  });

  it("(a) widget with responseProviderId+responseModel → runAgentStreaming receives exactly those values", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidgetWithModel);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.providerId).toBe(PROVIDER_ID);
    expect(params.model).toBe(MODEL_NAME);
  });

  it("(d) widget-configured model reaches chat.create data (widget chats record the serving model)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidgetWithModel);
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    const createCall = (prisma.chat.create as jest.Mock).mock.calls[0];
    expect(createCall[0].data.providerId).toBe(PROVIDER_ID);
    expect(createCall[0].data.model).toBe(MODEL_NAME);
  });

  it("(b) legacy widget (both null) → runAgentStreaming called WITHOUT providerId/model (byte-identical)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
      ...mockWidget,
      responseProviderId: null,
      responseModel: null,
    });
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.providerId).toBeUndefined();
    expect(params.model).toBeUndefined();

    // chat.create data omits both keys too (truthy-only spread)
    const createCall = (prisma.chat.create as jest.Mock).mock.calls[0];
    expect(createCall[0].data.providerId).toBeUndefined();
    expect(createCall[0].data.model).toBeUndefined();
  });

  it("(c) tamper pin — client-supplied providerId/model are stripped when the widget config is unset", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
      ...mockWidget,
      responseProviderId: null,
      responseModel: null,
    });
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      // Attacker tries to steer the serving model via the body — the proxy
      // builds a fresh body from schema fields, and the composed body schema
      // strips unknown keys; the visitor can never influence the model.
      .send({ message: "hi", providerId: "attacker-provider", model: "attacker-model" });

    expect(res.status).toBe(200);
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.providerId).toBeUndefined();
    expect(params.model).toBeUndefined();
  });

  it("a half-set pin (provider only) still threads the provider; model falls through to the chain", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
      ...mockWidget,
      responseProviderId: PROVIDER_ID,
      responseModel: null,
    });
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    expect(params.providerId).toBe(PROVIDER_ID);
    // No widget model and no chat model (seeded chat row has model: null)
    expect(params.model).toBeUndefined();
  });

  it("widget pin wins over the chat record's stored model (pin sits BEFORE chat.model in the chain)", async () => {
    // Existing chat row carrying a stored model (Chat.model schema default)
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidgetWithModel);
    (prisma.chat.findFirst as jest.Mock).mockResolvedValue({
      id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: "old-provider", model: "old-model",
    });
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "continue", chatId: CHAT_ID });

    expect(res.status).toBe(200);
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0];
    // Widget config > chat record — a pinned widget overrides continuation
    expect(params.providerId).toBe(PROVIDER_ID);
    expect(params.model).toBe(MODEL_NAME);
  });
});

// 260829-ms8 (DLP_FEATURES_SPEC §2.1) — DLP audit source tagging on the
// widget path. The widget route funnels into the shared handleChatStream
// core, so with DLP_ENABLED=true the run must produce dlp.* events tagged
// source: "widget" (derived from the X-Widget-Id header inside the core —
// the widget proxy always sends it, the JWT route never does). Pins both
// the streaming output event and the rag_context scan event.
describe("POST /api/internal/widget/chat/stream — DLP source tag (260829-ms8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedPrismaForStream();
    (getSetting as jest.Mock).mockImplementation(
      async (key: string) => ({ value: key === "DLP_ENABLED" ? "true" : "false" }),
    );
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
  });

  it("dlp.output_match on the widget stream carries source: 'widget'", async () => {
    (runAgentStreaming as jest.Mock).mockImplementation(
      async (_p: unknown, onToken: (t: string) => void) => {
        // One long chunk so the email sits past the 64-char DLP holdback and
        // is caught by the progressive flush + final tail scan.
        onToken(
          "The contact for this account is user@example.com and the response continues well past the tail-holdback boundary so the match is captured.",
        );
        return mockAgentResult();
      },
    );

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    const dlpEvents = (logEvent as jest.Mock).mock.calls.filter(
      (c) => c[0] === "dlp" && c[2] === "dlp.output_match",
    );
    expect(dlpEvents).toHaveLength(1);
    expect(dlpEvents[0][3]).toBe("service-account-001"); // widget-service account
    const meta = dlpEvents[0][4] as Record<string, unknown>;
    expect(meta.source).toBe("widget");
    expect(meta.matchTypes).toContain("email");
  });

  it("dlp.rag_context_match with ragContext PII carries source: 'widget'", async () => {
    (runAgentStreaming as jest.Mock).mockImplementation(async () => mockAgentResult());

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set(streamHeaders())
      .send({ message: "hi", ragContext: "[Source: doc.pdf]\nReach the owner at owner@example.com for details." });

    expect(res.status).toBe(200);
    const ragEvents = (logEvent as jest.Mock).mock.calls.filter(
      (c) => c[0] === "dlp" && c[2] === "dlp.rag_context_match",
    );
    expect(ragEvents).toHaveLength(1);
    const meta = ragEvents[0][4] as Record<string, unknown>;
    expect(meta.source).toBe("widget");
    expect(meta.matchTypes).toContain("email");
  });
});
