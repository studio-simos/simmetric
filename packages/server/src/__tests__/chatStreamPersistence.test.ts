// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Chat stream — assistant message persistence (truncation regression).
 *
 * Regression guard for the DLP tail-holdback bug: the streaming route used to
 * persist `content: finalResponse` where `finalResponse` is only the final
 * DLP tail-holdback flush (~64 char) instead of the full redacted answer
 * (`fullResponse`). On chat reload the assistant message appeared truncated to
 * its last ~64 characters ("rifica che i file pertinenti..." = tail of the
 * full "Non ho trovato informazioni... Verifica...").
 *
 * The test drives `onToken` with a >64-char response and asserts
 * `chatMessage.create` is called with the FULL content, not the ~64-char tail.
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
  getSetting: jest.fn().mockResolvedValue({ value: "false" }), // DLP disabled
}));
jest.mock("../services/dlpFilter", () => {
  // Real scanContent/progressiveDLPFlush — the accumulation test below needs
  // genuine PII pattern detection. Only the multibyte/PII-free fixture text
  // relies on the mocked path staying inert.
  const actual = jest.requireActual("../services/dlpFilter");
  return { ...actual };
});
jest.mock("../filters/plugins/dlp", () => {
  // 260829-n95: keep the REAL bypass readers (getDlpBypassRoles is called
  // inline by handleChatStream) — the default mock resolves DLP_BYPASS_ROLES
  // to "false"→[] (safe-parse fallback) so the gate stays open (scan runs)
  // for these accumulation tests.
  const actual = jest.requireActual("../filters/plugins/dlp");
  return {
    ...actual,
    getAndClearDlpMatches: jest.fn().mockReturnValue([]),
  };
});
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/wikiLinkService", () => ({
  resolveWikilinks: jest.fn().mockResolvedValue([]),
  extractWikilinkSlugs: jest.fn().mockReturnValue([]),
}));
jest.mock("../services/wikiLinkService", () => ({
  resolveWikilinks: jest.fn().mockResolvedValue([]),
  extractWikilinkSlugs: jest.fn().mockReturnValue([]),
}));
jest.mock("../services/widgetAnalyticsService", () => ({ recordWidgetEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../routes/push", () => {
  const express = jest.requireActual("express");
  return { __esModule: true, default: express.Router(), sendPushNotification: jest.fn().mockResolvedValue(undefined) };
});
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) { _res.status(401).json({ error: "Authentication required" }); return; }
    req.userId = "admin-001"; next();
  },
  apiKeyMiddleware: (_req: any, res: any) => res.status(401).json({ error: "Missing API key" }),
}));
jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireProjectAccess: () => (_req: any, _res: any, next: any) => next(),
  requireWorkspaceAccess: (_req: any, _res: any, next: any) => next(),
}));

import http from "http";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { runAgentStreaming } from "../agent/orchestrator";
import { logEvent } from "../services/eventLogService";
import { getAndClearDlpMatches } from "../filters/plugins/dlp";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000020";
const CHAT_ID = "00000000-0000-0000-0000-000000000002";

// A plain alphanumeric response well over the 64-char DLP holdback, with NO
// PII patterns (no email/sk-/credit-card) so progressiveDLPFlush passes it
// through unredacted — the assertion is then a clean full-vs-tail comparison.
const FULL_ANSWER =
  "Non ho trovato informazioni su questo argomento nei documenti del workspace. " +
  "Verifica che i file pertinenti siano stati caricati e indicizzati correttamente. " +
  "Puoi riprovare con una query piu specifica."; // ~165 chars

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

function seedPrismaForStream() {
  (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null });
  (prisma.chat.create as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null });
  (prisma.chatMessage.create as jest.Mock).mockResolvedValue({ id: "assistant-msg-1" });
  (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([]);
}

describe("chat/stream — assistant message persistence (truncation regression)", () => {
  const token = generateTestToken("admin-001");

  beforeEach(() => {
    jest.clearAllMocks();
    seedPrismaForStream();
  });

  it("persists the FULL assistant response, not the DLP tail-holdback (~64 char)", async () => {
    // Drive onToken token-by-token so the progressive DLP flush accumulates
    // the full answer into fullResponse. The final held-back tail (~64 char)
    // is flushed inside the route after runAgentStreaming returns.
    (runAgentStreaming as jest.Mock).mockImplementation(
      async (_p: unknown, onToken: (t: string) => void) => {
        // Emit the answer in small chunks to mimic real streaming.
        for (let i = 0; i < FULL_ANSWER.length; i += 13) {
          onToken(FULL_ANSWER.slice(i, i + 13));
        }
        return {
          response: FULL_ANSWER, sources: [], toolCalls: [], iterations: 1,
          tokenUsage: null, providerType: "ollama", resolvedModel: "gemma:latest",
        };
      },
    );

    const text = await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, { message: "summarize" });

    // The route creates the user message first, then the assistant message —
    // pick the assistant one. mock.calls entries are arg-arrays: [{ data: {...} }].
    const calls = (prisma.chatMessage.create as jest.Mock).mock.calls as Array<Array<{ data: { role: string; content: string } }>>;
    const assistantCall = calls.find((c) => c[0]?.data?.role === "assistant")?.[0];
    expect(assistantCall).toBeDefined();
    // The persisted content must be the FULL answer, not its last ~64 chars.
    expect(assistantCall!.data.content).toBe(FULL_ANSWER);
    // Explicit guard against the regression: content must be longer than the
    // 64-char holdback tail (the bug saved ~64 chars).
    expect(assistantCall!.data.content.length).toBeGreaterThan(64);
  });

  // quick 260829-m6p: dlp.output_match must carry the matches from the WHOLE
  // run, not just the last tail scan. Regression: the event derived matchTypes
  // from finalScan (the last chunk) only — when an early chunk contained PII
  // but the last chunk was clean, the event stored matchTypes: [] and the DLP
  // audit panel showed "Nessun dettaglio disponibile per questo evento."
  // despite the row having a match-type badge.
  it("dlp.output_match accumulates matches from ALL flushes (early chunk matches, clean tail)", async () => {
    (jest.requireMock("../services/systemConfigService").getSetting as jest.Mock).mockImplementation(
      async (key: string) => ({ value: key === "DLP_ENABLED" ? "true" : "false" }),
    );
    (runAgentStreaming as jest.Mock).mockImplementation(
      async (_p: unknown, onToken: (t: string) => void) => {
        // First chunk is long enough that the FIRST flush (safe_end =
        // buffer.length - 64) already contains the whole email — the email
        // ends well before the holdback boundary, so progressiveDLPFlush
        // scans it and matches. Subsequent chunks + tail are clean, so
        // finalScan alone would yield [] matchTypes (the old bug).
        onToken(
          "Contact support at ops@example.com for access. " +
            "This initial chunk is intentionally long enough that the email above sits fully inside the first flushed safe prefix of the progressive DLP buffer, past the 64-char holdback tail that stays unscanned until end of stream.",
        );
        for (let i = 0; i < 90; i += 10) {
          onToken("plain tail text without any PII content here ");
        }
        return {
          response: "x", sources: [], toolCalls: [], iterations: 1,
          tokenUsage: null, providerType: "ollama", resolvedModel: "gemma:latest",
        };
      },
    );

    await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, { message: "hello" });

    const dlpEvents = (logEvent as jest.Mock).mock.calls.filter(
      (c) => c[0] === "dlp" && c[2] === "dlp.output_match",
    );
    expect(dlpEvents).toHaveLength(1);
    const meta = dlpEvents[0][4] as { matchTypes: string[]; matches?: Array<{ type: string; text: string }> };
    expect(meta.matchTypes).toEqual(["email"]);
    expect(meta.matches).toEqual([{ type: "email", text: "ops@example.com" }]);
  });

  it("does NOT write dlp.output_match when no chunk matched (DLP enabled, clean stream)", async () => {
    (jest.requireMock("../services/systemConfigService").getSetting as jest.Mock).mockImplementation(
      async (key: string) => ({ value: key === "DLP_ENABLED" ? "true" : "false" }),
    );
    (runAgentStreaming as jest.Mock).mockImplementation(
      async (_p: unknown, onToken: (t: string) => void) => {
        onToken("Clean answer with no sensitive data at all. ");
        onToken("Another clean sentence.");
        return {
          response: "x", sources: [], toolCalls: [], iterations: 1,
          tokenUsage: null, providerType: "ollama", resolvedModel: "gemma:latest",
        };
      },
    );

    await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, { message: "hello" });

    expect(getAndClearDlpMatches).toHaveBeenCalled();
    const dlpEvents = (logEvent as jest.Mock).mock.calls.filter(
      (c) => c[0] === "dlp" && c[2] === "dlp.output_match",
    );
    expect(dlpEvents).toHaveLength(0);
  });
});