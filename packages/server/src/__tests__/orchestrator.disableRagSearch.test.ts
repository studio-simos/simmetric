// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WID-02 (Fase 65, plan 65-01) — disableRagSearch filter guardrail.
 *
 * Three tests:
 *   1. grep guardrail: `ragContext || disableRagSearch` appears exactly twice
 *      in orchestrator.ts (both runAgent AND runAgentStreaming filter sites).
 *      Pitfall 1 regression guard.
 *   2. runAgentStreaming with disableRagSearch:true filters rag_search out of
 *      activeSkills — the model requesting rag_search hits "Unknown tool".
 *   3. runAgent (parity) with disableRagSearch:true exhibits the same filter.
 *
 * orchestrator.test.ts (649 lines) covers ragContext/BOT-02/BOT-01/D-02/abortReason
 * — see Phase 62. This file focuses on the disableRagSearch filter (WID-02, Phase 65).
 */

import "./helpers/setupEnv";
import * as fs from "fs";
import * as path from "path";

// --- Mocks -----------------------------------------------------------------

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const { prisma } = createMockPrisma();
  // workspaceAgentConfig is not in the base mock factory — add it inline.
  // Return a default config so the orchestrator does not attempt to auto-create.
  const defaultAgentConfig = {
    workspaceId: "ws-test",
    enabledSkills: JSON.stringify(["rag_search", "workspace_memory"]),
    systemPrompt: null,
    model: "default",
    temperature: 0.7,
    planMode: false,
  };
  (prisma as any).workspaceAgentConfig = {
    findUnique: jest.fn().mockResolvedValue(defaultAgentConfig),
    create: jest.fn().mockResolvedValue(defaultAgentConfig),
    update: jest.fn().mockResolvedValue(defaultAgentConfig),
  };
  (prisma as any).workspaceTokenUsage = {
    create: jest.fn().mockResolvedValue({}),
  };
  prisma.user.findUnique = jest.fn().mockResolvedValue(null);
  return { __esModule: true, default: prisma };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    SERVER_URL: "http://localhost:3000",
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
    LLM_PROVIDER: "ollama",
    LLM_MODEL: "gemma4:latest",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    VECTOR_DB_PROVIDER: "lancedb",
    VECTOR_DB_URL: "",
    VECTOR_DB_API_KEY: "",
    LICENSE_KEY: "",
    STORAGE_PATH: "/tmp/sc-test",
    LOG_LEVEL: "error",
    AGENT_WALLCLOCK_TIMEOUT_MS: 600000,
    AGENT_MAX_TOTAL_TOKENS: 200000,
    AGENT_MAX_CONTEXT_BYTES: 500000,
    AGENT_MAX_TOOL_OUTPUT_LENGTH: 5000,
    AGENT_MAX_SKILL_EXECUTION_MS: 60000,
    AGENT_LOOP_DETECTION_WINDOW: 3,
    AGENT_MAX_ITERATIONS: 10,
  })),
}));

jest.mock("../services/templateService", () => ({
  resolveSystemPrompt: jest.fn().mockResolvedValue("You are a helpful assistant."),
  resolveSkills: jest.fn().mockResolvedValue(["rag_search", "workspace_memory"]),
  getTemplateForWorkspace: jest.fn().mockResolvedValue(null),
  seedTemplates: jest.fn(),
}));

jest.mock("../services/providerService", () => ({
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
  // Phase 95 (D-01): modelFallback imports deriveCapabilities — expose a
  // no-op mock so buildFallbackConfig resolves (mock-seam additive).
  deriveCapabilities: jest.fn().mockReturnValue([]),
}));

jest.mock("../agent/skills", () => ({
  resolveSkillsForChat: jest.fn().mockResolvedValue([
    // 131-07 (G-131-19): the execute mock returns a valid SkillResult so the
    // archive-survival tests (rag_search NOT filtered when archiveId is set)
    // can assert the skill actually ran. The pre-existing filter tests never
    // execute the skill (rag_search is filtered out), so this default is
    // additive and behavior-neutral for them.
    { name: "rag_search", execute: jest.fn().mockResolvedValue({ success: true, data: "archive fallback result" }) } as any,
    { name: "workspace_memory", execute: jest.fn() } as any,
  ]),
}));

// Capture streamLLM calls so we can assert activeSkills filtering. The
// orchestrator looks up `toolName` in activeSkills; if rag_search is filtered
// out, the lookup fails and an "Unknown tool" error is pushed to context.
// We then return a final-response (no toolCall) on the second call so the
// loop exits cleanly via the "done" abort reason.
const streamLLMMock = jest.fn();
// 92-05: buildOllamaTools added to the factory so the orchestrator's new
// `buildOllamaTools(activeSkills)` 5th-arg wiring resolves (mock-seam
// addition; no behavioral assertion changed — OJ-01 SC1 freeze preserved).
jest.mock("../agent/llmStreaming", () => ({
  streamLLM: (...args: unknown[]) => streamLLMMock(...args),
  parseToolCall: jest.fn(() => null),
  buildOllamaTools: jest.fn((skills: { name: string; description: string }[]) =>
    skills.map((s) => ({ type: "function", function: { name: s.name, description: s.description } })),
  ),
  // Phase 95 (D-03): orchestrator now calls buildProviderTools instead of
  // buildOllamaTools directly (conditional gating helper).
  buildProviderTools: jest.fn((_providerType: string, skills: { name: string; description: string }[]) =>
    skills.map((s) => ({ type: "function", function: { name: s.name, description: s.description } })),
  ),
}));

jest.mock("../agent/builtinSkills", () => ({}));

// --- Tests -----------------------------------------------------------------

describe("orchestrator — disableRagSearch filter (WID-02)", () => {
  beforeEach(() => {
    streamLLMMock.mockReset();
  });

  test("grep guardrail: the degraded-filter condition appears exactly twice in orchestrator.ts", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../agent/orchestrator.ts"),
      "utf8",
    );
    // 131-07 (G-131-19): the condition gained the archive-survival clause —
    // rag_search stays live when an archive is bound (the archive fallback is
    // the degraded path's only archive-capable skill). Both runAgent AND
    // runAgentStreaming filter sites must stay in lockstep.
    const matches = src.match(/ragContext \|\| \(disableRagSearch && !params\.archiveId\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });

  test("runAgentStreaming with disableRagSearch:true filters rag_search from activeSkills", async () => {
    // First call: model tries to call rag_search (should be filtered out).
    // Second call: model produces a final response — loop exits.
    streamLLMMock
      .mockResolvedValueOnce({
        content: "",
        toolCall: { toolName: "rag_search", toolInput: { query: "x" } },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        content: "final answer",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      });

    const { runAgentStreaming } = await import("../agent/orchestrator");
    const result = await runAgentStreaming(
      {
        workspaceId: "ws-test",
        userId: "u-test",
        message: "hi",
        chatId: "c-test",
        disableRagSearch: true,
      },
      () => {},
      () => {},
    );

    // The rag_search tool was filtered out, so no skill executed.
    expect(result.toolCalls).toHaveLength(0);
    // The loop exited via "done" on the second call (final response).
    expect(result.response).toBe("final answer");
  });

  test("runAgent (parity) with disableRagSearch:true filters rag_search from activeSkills", async () => {
    streamLLMMock
      .mockResolvedValueOnce({
        content: "",
        toolCall: { toolName: "rag_search", toolInput: { query: "x" } },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        content: "final answer non-stream",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      });

    const { runAgent } = await import("../agent/orchestrator");
    const result = await runAgent({
      workspaceId: "ws-test",
      userId: "u-test",
      message: "hi",
      chatId: "c-test",
      disableRagSearch: true,
    });

    expect(result.toolCalls).toHaveLength(0);
    expect(result.response).toBe("final answer non-stream");
  });

  // 131-07 (G-131-19): rag_search SURVIVES the degraded filter when an archive
  // is bound — the archive fallback (builtinSkills.ts:59-61) is the degraded
  // path's only archive-capable skill, so stripping it would make the archive
  // unreachable exactly when the workspace search failed.
  test("runAgentStreaming with disableRagSearch:true AND archiveId keeps rag_search in activeSkills", async () => {
    streamLLMMock
      .mockResolvedValueOnce({
        content: "",
        toolCall: { toolName: "rag_search", toolInput: { query: "x" } },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        content: "archive answer",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      });

    const { runAgentStreaming } = await import("../agent/orchestrator");
    const result = await runAgentStreaming(
      {
        workspaceId: "ws-test",
        userId: "u-test",
        message: "hi",
        chatId: "c-test",
        disableRagSearch: true,
        archiveId: "00000000-0000-4000-8000-0000000000aa",
      },
      () => {},
      () => {},
    );

    // rag_search was NOT filtered — the skill executed (archive fallback live).
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.tool).toBe("rag_search");
    expect(result.response).toBe("archive answer");
  });

  test("runAgent (parity) with disableRagSearch:true AND archiveId keeps rag_search in activeSkills", async () => {
    streamLLMMock
      .mockResolvedValueOnce({
        content: "",
        toolCall: { toolName: "rag_search", toolInput: { query: "x" } },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        content: "archive answer non-stream",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      });

    const { runAgent } = await import("../agent/orchestrator");
    const result = await runAgent({
      workspaceId: "ws-test",
      userId: "u-test",
      message: "hi",
      chatId: "c-test",
      disableRagSearch: true,
      archiveId: "00000000-0000-4000-8000-0000000000aa",
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.tool).toBe("rag_search");
    expect(result.response).toBe("archive answer non-stream");
  });
});