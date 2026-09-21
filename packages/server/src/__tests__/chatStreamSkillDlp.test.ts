// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Chat handlers × skills — explicit skillCall resolution + DLP masking
 * (Phase 190, SKIL-04 / D-13; SC-2 matrix row owned here per the
 * later-landing-feature rule).
 *
 * Mirrors chatStreamPersistence.test.ts's supertest SSE skeleton (mock set,
 * generateTestToken, postSSE helper) with the REAL dlpFilter left unmocked —
 * the behavioral pin is that skillCall params are masked through the genuine
 * scanContentAsync BEFORE template compilation (D-13 ordering):
 *   - DLP_ENABLED "true"  → compiled prompt carries the redaction marker,
 *                           NEVER the raw PII param (masked params ride
 *                           params.skillCall.params too);
 *   - DLP_ENABLED "false" → masking skipped, the RAW param compiles verbatim
 *                           (the DLP-off twin);
 *   - unresolvable slug   → SSE error event carrying the slug, ZERO agent
 *                           invocation (T-190-15 IDOR guard, D-09
 *                           explicit-invocation arm — never a 500, never
 *                           silent);
 *   - non-stream twin     → the same resolve→mask→compile ordering on the
 *                           non-streaming handler, 400 { error } on an
 *                           unresolvable slug.
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
// REAL dlpFilter — jest.requireActual idiom (the suite must prove the genuine
// scanContentAsync masks skillCall params, not a test double). The mock
// prisma's dlpPattern.findMany is unarranged → the DB-backed pattern read
// throws → scanContentAsync falls back to the built-in pattern set (email
// pattern matches the fixture param) — the production graceful-degradation
// path, deterministic in unit tests.
jest.mock("../services/dlpFilter", () => {
  const actual = jest.requireActual("../services/dlpFilter");
  return { ...actual };
});
jest.mock("../filters/plugins/dlp", () => {
  // Real bypass readers (getDlpBypassRoles runs inline in handleChatStream);
  // neutralize the per-chat match buffer helpers the route imports.
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
  requireWorkspaceWriteAccess: () => (_req: any, _res: any, next: any) => next(),
  requireWorkspaceRead: () => (_req: any, _res: any, next: any) => next(),
}));

import http from "http";
import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { runAgent, runAgentStreaming } from "../agent/orchestrator";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000020";
const CHAT_ID = "00000000-0000-0000-0000-000000000002";
const RAW_EMAIL = "user@example.com";
const REDACTED = "[REDACTED]";

/** Mock custom skill row — template "{{input}}" so the compiled prompt IS the (masked) param. */
const SKILL_ROW = {
  id: "00000000-0000-0000-0000-0000000000s1".slice(0, 36),
  name: "custom_translate",
  displayName: "Translate",
  description: "Translate text.",
  type: "custom",
  config: JSON.stringify({ template: "{{input}}", defaultParams: {}, injectAs: "user" }),
  slug: "translate",
  skillMode: "prompt",
  inputSchema: JSON.stringify({ type: "object", properties: { input: { type: "string" } }, required: ["input"] }),
  isEnabled: true,
  isBuiltIn: false,
  organizationId: "00000000-0000-0000-0000-000000000000",
  userId: null,
  workspaceId: null,
  createdBy: "admin-001",
};

function setDlpEnabled(value: string) {
  (jest.requireMock("../services/systemConfigService").getSetting as jest.Mock).mockImplementation(
    async (key: string) => ({ value: key === "DLP_ENABLED" ? value : "false" }),
  );
}

function mockStreamNoTokens() {
  (runAgentStreaming as jest.Mock).mockImplementation(async () => ({
    response: "x", sources: [], toolCalls: [], iterations: 1,
    tokenUsage: null, providerType: "ollama", resolvedModel: "gemma:latest",
  }));
}

function mockNonStreamRun() {
  (runAgent as jest.Mock).mockImplementation(async () => ({
    response: "ok", sources: [], toolCalls: [], iterations: 1,
    tokenUsage: null, providerType: "ollama", resolvedModel: "gemma:latest",
  }));
}

function seedPrismaForStream() {
  (prisma.chat.findFirst as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null });
  (prisma.chat.create as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null });
  (prisma.chatMessage.create as jest.Mock).mockResolvedValue({ id: "assistant-msg-1" });
  (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: "00000000-0000-0000-0000-000000000000",
  });
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

describe("chat/stream × skillCall — DLP masking before compilation (SKIL-04, D-13)", () => {
  const token = generateTestToken("admin-001");

  beforeEach(() => {
    jest.clearAllMocks();
    seedPrismaForStream();
    mockStreamNoTokens();
  });

  it("DLP_ENABLED true → skillCall param masked via scanContentAsync BEFORE compile (redacted over raw)", async () => {
    setDlpEnabled("true");
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([SKILL_ROW]);

    const text = await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, {
      message: "invoke",
      skillCall: { slug: "translate", params: { input: RAW_EMAIL } },
    });

    // The mocked agent received the resolved skillCall payload
    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0] as {
      skillCall?: { slug: string; params: Record<string, string>; compiledPrompt: string };
    };
    expect(params.skillCall).toBeDefined();
    expect(params.skillCall!.slug).toBe("translate");
    // (a) compiled prompt carries the redaction marker, NEVER the raw email
    expect(params.skillCall!.compiledPrompt).toContain(REDACTED);
    expect(params.skillCall!.compiledPrompt).not.toContain(RAW_EMAIL);
    // (b) the masked params ride params.skillCall.params (metadata/toolCalls show masked values)
    expect(params.skillCall!.params.input).toBe(REDACTED);
    // (c) the SSE stream terminates with done (error-then-done semantics preserved)
    expect(text).toContain("event: done");
  });

  it("DLP_ENABLED false → masking skipped, compiled prompt contains the RAW email (DLP-off twin)", async () => {
    setDlpEnabled("false");
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([SKILL_ROW]);

    await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, {
      message: "invoke",
      skillCall: { slug: "translate", params: { input: RAW_EMAIL } },
    });

    const params = (runAgentStreaming as jest.Mock).mock.calls[0][0] as {
      skillCall?: { params: Record<string, string>; compiledPrompt: string };
    };
    expect(params.skillCall).toBeDefined();
    expect(params.skillCall!.compiledPrompt).toContain(RAW_EMAIL);
    expect(params.skillCall!.params.input).toBe(RAW_EMAIL);
  });

  it("unresolvable slug → SSE error event carrying the slug, runAgentStreaming NOT called", async () => {
    setDlpEnabled("true");
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);

    const text = await postSSE(`/api/workspaces/${WORKSPACE_ID}/chat/stream`, token, {
      message: "invoke",
      skillCall: { slug: "ghost-skill", params: { input: "x" } },
    });

    expect(text).toContain("event: error");
    expect(text).toContain("ghost-skill");
    expect(runAgentStreaming).not.toHaveBeenCalled();
  });

  it("non-stream twin: skillCall param masked the same way (Pattern 4 ordering on POST /chat)", async () => {
    setDlpEnabled("true");
    mockNonStreamRun();
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([SKILL_ROW]);

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/chat`)
      .set("Authorization", `Bearer ${generateTestToken("admin-001")}`)
      .send({ message: "invoke", skillCall: { slug: "translate", params: { input: RAW_EMAIL } } });

    expect(res.status).toBe(200);
    const params = (runAgent as jest.Mock).mock.calls[0][0] as {
      skillCall?: { params: Record<string, string>; compiledPrompt: string };
    };
    expect(params.skillCall).toBeDefined();
    expect(params.skillCall!.compiledPrompt).toContain(REDACTED);
    expect(params.skillCall!.compiledPrompt).not.toContain(RAW_EMAIL);
    expect(params.skillCall!.params.input).toBe(REDACTED);
  });

  it("non-stream twin: unresolvable slug → 400 { error } carrying the slug, runAgent NOT called", async () => {
    setDlpEnabled("true");
    mockNonStreamRun();
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/chat`)
      .set("Authorization", `Bearer ${generateTestToken("admin-001")}`)
      .send({ message: "invoke", skillCall: { slug: "ghost-skill", params: { input: "x" } } });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("ghost-skill");
    expect(runAgent).not.toHaveBeenCalled();
  });
});