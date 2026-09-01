// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Plan mode — SSE integration test (spec §8 "Integration: SSE flow").
 *
 * Exercises the chat stream route's SSE wiring for the `plan` event without
 * a real database or LLM: `runAgentStreaming` is mocked so we can drive the
 * planning-phase callback (`onPlan`) deterministically and assert the SSE
 * contract the frontend `useChat` hook relies on:
 *
 *   - When the orchestrator emits a plan, `event: plan` is sent BEFORE
 *     `event: token` (so the banner renders above the in-flight response).
 *   - When the orchestrator does NOT emit a plan, no `plan` event appears
 *     in the stream at all (zero overhead in the non-plan path).
 *
 * The orchestrator's internal planMode decision (reading `agentConfig.planMode`
 * and calling `generatePlan`) is covered by planMode.test.ts + orchestrator
 * unit tests; here we verify the route→SSE boundary only.
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

// Mock the orchestrator — we drive the plan/token callbacks from the test.
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
jest.mock("../routes/push", () => {
  const express = jest.requireActual("express");
  return {
    __esModule: true,
    default: express.Router(),
    sendPushNotification: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      _res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    next();
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
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000010";
const CHAT_ID = "00000000-0000-0000-0000-000000000001";

const SAMPLE_PLAN = {
  goal: "Find the retention policy",
  steps: [
    { step: 1, action: "Search documents for 'retention policy'", tool: "rag_search" },
    { step: 2, action: "Summarize and answer", tool: null },
  ],
};

/** Collect an SSE stream into an ordered list of { event, data }. */
function parseSSE(text: string): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.match(/^event: (.+)$/m)?.[1];
    const dataLine = block.match(/^data: (.+)$/m)?.[1];
    if (!eventLine) continue;
    let data: unknown = dataLine;
    try { data = dataLine ? JSON.parse(dataLine) : dataLine; } catch { /* keep raw */ }
    events.push({ event: eventLine.trim(), data });
  }
  return events;
}

/** Fire a request against the Express app and collect the full SSE body. */
function postSSE(path: string, token: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => { res.setEncoding("utf8"); let data = ""; res.on("data", (chunk) => { data += chunk; }); res.on("end", () => { server.close(); resolve(data); }); },
      );
      req.on("error", (err) => { server.close(); reject(err); });
      req.write(payload);
      req.end();
    });
    server.on("error", reject);
  });
}

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
  (prisma.chat.create as jest.Mock).mockResolvedValue({
    id: CHAT_ID, workspaceId: WORKSPACE_ID, providerId: null, model: null,
  });
  (prisma.chatMessage.create as jest.Mock).mockResolvedValue({ id: "assistant-msg-1" });
  (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([]);
}

describe("Plan mode SSE integration (POST /chat/stream)", () => {
  const token = generateTestToken("admin-001");

  beforeEach(() => {
    jest.clearAllMocks();
    seedPrismaForStream();
  });

  it("emits the `plan` event BEFORE `token` when the orchestrator produces a plan", async () => {
    (runAgentStreaming as jest.Mock).mockImplementation(
      async (
        _p: unknown,
        onToken: (t: string) => void,
        _s: unknown,
        _g: unknown,
        _e: unknown,
        onPlan?: (p: unknown) => void,
      ) => {
        if (onPlan) onPlan(SAMPLE_PLAN);
        // D-01 (plan 62-04): the route only emits `token` SSE events when the
        // orchestrator drives the onToken callback (progressive DLP flush) +
        // a final held-back tail. Drive onToken so a `token` event appears.
        onToken("Here is the answer.");
        return mockAgentResult();
      },
    );

    const text = await postSSE(
      `/api/workspaces/${WORKSPACE_ID}/chat/stream`,
      token,
      { message: "What is the retention policy?" },
    );

    const events = parseSSE(text);
    const names = events.map((e) => e.event);

    const planIndex = names.indexOf("plan");
    const tokenIndex = names.indexOf("token");
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeLessThan(tokenIndex);

    const planEvent = events[planIndex]?.data as { goal: string; steps: unknown[] } | undefined;
    expect(planEvent).toBeDefined();
    expect(planEvent!.goal).toBe(SAMPLE_PLAN.goal);
    expect(planEvent!.steps).toHaveLength(2);

    expect(names[names.length - 1]).toBe("done");
  });

  it("emits NO `plan` event when the orchestrator does not produce a plan", async () => {
    (runAgentStreaming as jest.Mock).mockImplementation(
      async (_p: unknown, onToken: (t: string) => void) => {
        // D-01 (plan 62-04): drive onToken so a `token` event appears in the stream.
        onToken("Hello back.");
        return mockAgentResult();
      },
    );

    const text = await postSSE(
      `/api/workspaces/${WORKSPACE_ID}/chat/stream`,
      token,
      { message: "Hello" },
    );

    const events = parseSSE(text);
    const names = events.map((e) => e.event);

    expect(names).not.toContain("plan");
    expect(names).toContain("token");
    expect(names).toContain("done");
  });
});