// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Chat stream DLP role-bypass gating (DLP_FEATURES_SPEC §2.2, 260829-n95).
 *
 * Pins the streaming-path half of the bypass contract. The shared
 * handleChatStream core (JWT route + internal widget route) runs the DLP
 * progressive flush INLINE (Phase 100 Pitfall 4) — separate from the plugin
 * path. When the acting user's roles intersect DLP_BYPASS_ROLES:
 *   - the streaming output passes through UNREDACTED (raw tokens, raw tail),
 *   - NO dlp.output_match / dlp.rag_context_match events fire,
 *   - ONE dlp.bypassed event carries the matched roles (+ source tag).
 * The widget path resolves roles from the widget service account
 * (req.user from apiKeyMiddleware — the widget bypass applies to
 * service-account roles per spec §2.2).
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
  getSetting: jest.fn().mockResolvedValue({ value: "false" }),
}));
// Mock the dlp plugin module: keep the REAL scan/bypass logic
// (scanContent/progressiveDLPFlush come from dlpFilter and run unmocked via
// chat.ts inline), but neutralize the per-chat match buffer helpers the
// route imports. resolveDlpBypassRoles/getDlpBypassRoutes run for real so
// the bypass actually gates the inline block end-to-end.
jest.mock("../filters/plugins/dlp", () => {
  const actual = jest.requireActual("../filters/plugins/dlp");
  return {
    ...actual,
    getAndClearDlpMatches: jest.fn().mockReturnValue([]),
    addDlpMatches: jest.fn(),
  };
});
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
  generateBatchedTitleTagsAndFollowUps: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../routes/push", () => {
  const express = jest.requireActual("express");
  return { __esModule: true, default: express.Router(), sendPushNotification: jest.fn().mockResolvedValue(undefined) };
});

// Separate mock users per auth surface — the JWT route acts as the admin
// user, the internal widget route acts as the widget service account
// (seedServiceAccount). Both injected by the mocked middleware below.
let jwtUser: Record<string, unknown> = { roles: [] };
let apiKeyUser: Record<string, unknown> = { roles: [] };

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) { _res.status(401).json({ error: "Authentication required" }); return; }
    req.userId = "admin-001";
    req.user = jwtUser;
    next();
  },
  apiKeyMiddleware: (req: any, _res: any, next: any) => {
    req.userId = "service-account-001";
    req.user = apiKeyUser;
    next();
  },
}));
jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireProjectAccess: () => (_req: any, _res: any, next: any) => next(),
  requireWorkspaceAccess: (_req: any, _res: any, next: any) => next(),
}));

import http from "http";
import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { runAgentStreaming } from "../agent/orchestrator";
import { logEvent } from "../services/eventLogService";
import { getSetting } from "../services/systemConfigService";
import { generateTestToken } from "./helpers/mockAuth";
import { registerFilter } from "../filters/filterRegistry";
import { dlpPlugin } from "../filters/plugins/dlp";

const app = createApp();

// The filter registry is populated by initFilters() at real server boot only
// (createApp() deliberately skips it for supertest). Register the dlp plugin
// manually so the BYPASS tests exercise the inlet via the real chain too.
registerFilter(dlpPlugin);

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000020";
const CHAT_ID = "00000000-0000-0000-0000-000000000002";

const PII_ANSWER =
  "Contact support at ops@example.com for access. " +
  "This chunk is intentionally long enough that the email sits fully inside the first flushed safe prefix of the progressive DLP buffer, well past the 64-char holdback tail that stays unscanned until end of stream.";

function mockStream() {
  (runAgentStreaming as jest.Mock).mockImplementation(
    async (_p: unknown, onToken: (t: string) => void) => {
      onToken(PII_ANSWER);
      return {
        response: PII_ANSWER, sources: [], toolCalls: [], iterations: 1,
        tokenUsage: null, providerType: "ollama", resolvedModel: "gemma:latest",
      };
    },
  );
}

function setConfig(dlpEnabled: string, bypassRoles: string) {
  (getSetting as jest.Mock).mockImplementation(async (key: string) => ({
    value:
      key === "DLP_ENABLED" ? dlpEnabled :
      key === "DLP_BYPASS_ROLES" ? bypassRoles :
      "false",
  }));
}

function seedPrismaForStream() {
  (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null });
  (prisma.chat.create as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null });
  (prisma.chatMessage.create as jest.Mock).mockResolvedValue({ id: "assistant-msg-1" });
  (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([]);
}

function postSSE(path: string, token: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1", port, path, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${token}` },
        },
        (res) => { res.setEncoding("utf8"); let data = ""; res.on("data", (c) => { data += c; }); res.on("end", () => { server.close(); resolve(data); }); },
      );
      req.on("error", (err) => { server.close(); reject(err); });
      req.write(payload); req.end();
    });
    server.on("error", reject);
  });
}

describe("chat/stream — DLP role bypass (260829-n95)", () => {
  const token = generateTestToken("admin-001");

  beforeEach(() => {
    jest.clearAllMocks();
    seedPrismaForStream();
    jwtUser = {
      id: "admin-001",
      roles: [{ role: { name: "admin", permissions: [] } }],
    };
    apiKeyUser = {
      id: "service-account-001",
      roles: [{ role: { name: "widget_service", permissions: [] } }],
    };
  });

  it("JWT user with bypass role → tokens streamed UNREDACTED + dlp.bypassed logged, no output_match", async () => {
    setConfig("true", '["admin"]');
    mockStream();

    const text = await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, { message: "hello" });

    // Raw token reached the wire — NOT redacted
    expect(text).toContain("ops@example.com");
    // dlp.bypassed fired exactly once with the intersected roles; no scanning events
    const bypass = (logEvent as jest.Mock).mock.calls.filter((c) => c[2] === "dlp.bypassed");
    await new Promise((r) => setTimeout(r, 0)); // flush the fire-and-forget audit write
    expect(bypass).toHaveLength(1);
    expect(bypass[0][3]).toBe("admin-001");
    expect(bypass[0][4]).toMatchObject({ roles: ["admin"], source: "chat" });
    expect((logEvent as jest.Mock).mock.calls.some((c) => c[2] === "dlp.output_match")).toBe(false);
    expect((logEvent as jest.Mock).mock.calls.some((c) => c[2] === "dlp.rag_context_match")).toBe(false);
    // Assistant persisted UNREDACTED
    const calls = (prisma.chatMessage.create as jest.Mock).mock.calls as Array<Array<{ data: { role: string; content: string } }>>;
    const assistantCall = calls.find((c) => c[0]?.data?.role === "assistant")?.[0];
    expect(assistantCall!.data.content).toContain("ops@example.com");
  });

  it("JWT user WITHOUT bypass role → redaction unchanged (email redacted in tokens)", async () => {
    setConfig("true", '["other_role"]');
    mockStream();

    const text = await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, { message: "hello" });

    expect(text).not.toContain("ops@example.com");
    expect(text).toContain("[REDACTED]");
    const outputMatch = (logEvent as jest.Mock).mock.calls.filter((c) => c[0] === "dlp" && c[2] === "dlp.output_match");
    expect(outputMatch).toHaveLength(1);
    expect(outputMatch[0][4]).toMatchObject({ source: "chat", matchTypes: ["email"] });
  });

  it("ragContext PII scan is skipped for bypassed users (no dlp.rag_context_match)", async () => {
    setConfig("true", '["admin"]');
    (runAgentStreaming as jest.Mock).mockImplementation(async () => ({
      response: "x", sources: [], toolCalls: [], iterations: 1,
      tokenUsage: null, providerType: "ollama", resolvedModel: "gemma:latest",
    }));

    await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, {
      message: "hello",
      ragContext: "Reach the owner at owner@example.com for details.",
    });

    expect((logEvent as jest.Mock).mock.calls.some((c) => c[2] === "dlp.rag_context_match")).toBe(false);
  });

  // Widget path: the internal widget route funnels into the SAME
  // handleChatStream core with the widget SERVICE ACCOUNT as the acting
  // user (apiKeyMiddleware). Bypass evaluates the SERVICE ACCOUNT's roles.
  describe("widget service-account path (260829-ms8 core reuse)", () => {
    function postWidgetSSE(body: unknown): Promise<string> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
          const { port } = server.address() as { port: number };
          const payload = JSON.stringify(body);
          const req = http.request(
            {
              host: "127.0.0.1", port, path: "/api/internal/widget/chat/stream", method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                "X-Api-Key": "sk-test-widget",
                "X-Widget-Id": "widget-001",
              },
            },
            (res) => { res.setEncoding("utf8"); let data = ""; res.on("data", (c) => { data += c; }); res.on("end", () => { server.close(); resolve(data); }); },
          );
          req.on("error", (err) => { server.close(); reject(err); });
          req.write(payload); req.end();
        });
        server.on("error", reject);
      });
    }

    beforeEach(() => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
        id: "widget-001", isActive: true, deletedAt: null,
        workspaces: [{ workspaceId: WORKSPACE_ID }],
      });
    });

    it("service account with bypass role → widget stream UNREDACTED + dlp.bypassed with widget source", async () => {
      setConfig("true", '["widget_service"]');
      mockStream();

      const text = await postWidgetSSE({ message: "hi" });

      expect(text).toContain("ops@example.com");
      const bypass = (logEvent as jest.Mock).mock.calls.filter((c) => c[2] === "dlp.bypassed");
      await new Promise((r) => setTimeout(r, 0)); // flush fire-and-forget audit write
      expect(bypass).toHaveLength(1);
      expect(bypass[0][3]).toBe("service-account-001");
      expect(bypass[0][4]).toMatchObject({ roles: ["widget_service"], source: "widget" });
      expect((logEvent as jest.Mock).mock.calls.some((c) => c[2] === "dlp.output_match")).toBe(false);
    });

    it("service account NOT in bypass list → widget stream stays redacted", async () => {
      setConfig("true", '["admin"]');
      mockStream();

      const text = await postWidgetSSE({ message: "hi" });

      expect(text).not.toContain("ops@example.com");
      expect(text).toContain("[REDACTED]");
      expect((logEvent as jest.Mock).mock.calls.some((c) => c[2] === "dlp.bypassed")).toBe(false);
      const outputMatch = (logEvent as jest.Mock).mock.calls.filter((c) => c[0] === "dlp" && c[2] === "dlp.output_match");
      expect(outputMatch).toHaveLength(1);
      expect(outputMatch[0][4]).toMatchObject({ source: "widget" });
    });
  });
});