// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 194 interaction matrix — pair 2/6: DLP × skills.
 *
 * ONE owned test (194-CONTEXT D-01/D-02) pinning the INTERACTION seam only:
 * the LLM-INVOKED executor arm. This closes 190-VERIFICATION's
 * behavior_unverified SC-2 item — the explicit /slug arm's mask→compile
 * ordering is already pinned by chatStreamSkillDlp.test.ts (route level),
 * and orchestrator.dlpMaskingWiring.test.ts pins the flag threading
 * (arg shape, mocked executor) — NEITHER is re-asserted here.
 *
 * The value THIS test adds: the FULL LLM-invoked chain in one drive —
 * a real orchestrator ReAct loop (the wiring seam) invoking the REAL
 * createPromptSkillExecutor (skillService) whose params pass through the
 * REAL scanContentAsync (the same fixture approach chatStreamSkillDlp uses:
 * the lazy getActiveCompiledPatterns DB read fails → built-in fallback
 * pattern set — the production graceful-degradation path, deterministic
 * Postgres-free). Assert: the compiled prompt context entry of the
 * LLM-invoked arm carries the redaction marker, NEVER the raw PII.
 *
 * D-02 boundary: single-feature behavior (mask→compile in skillService,
 * flag-threading shape in orchestrator) is owned by the delivered suites;
 * this test owns ONLY the masked × LLM-invoked combination.
 *
 * Mock skeleton mirrors orchestrator.dlpMaskingWiring.test.ts (streamLLM
 * queue, lazy-spied execute on globalThis); the spy delegates to the REAL
 * createPromptSkillExecutor so the round-trip is production behavior.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const { prisma } = createMockPrisma();
  const defaultAgentConfig = {
    workspaceId: "ws-test",
    enabledSkills: JSON.stringify(["rag_search"]),
    systemPrompt: null,
    model: "default",
    temperature: 0.7,
    planMode: false,
  };
  (prisma as any).workspaceAgentConfig = {
    findUnique: jest.fn().mockResolvedValue(defaultAgentConfig),
    create: jest.fn().mockResolvedValue(defaultAgentConfig),
  };
  (prisma as any).workspaceTokenUsage = { create: jest.fn().mockResolvedValue({}) };
  (prisma as any).chatMessage = {
    create: jest.fn().mockResolvedValue({ id: "msg-id" }),
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
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
    LLM_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_MODEL: "gemma4:latest",
    AGENT_WALLCLOCK_TIMEOUT_MS: 600000,
    AGENT_MAX_TOTAL_TOKENS: 200000,
    AGENT_MAX_CONTEXT_BYTES: 500000,
    AGENT_MAX_TOOL_OUTPUT_LENGTH: 5000,
    AGENT_MAX_SKILL_EXECUTION_MS: 60000,
    AGENT_LOOP_DETECTION_WINDOW: 3,
  })),
}));

jest.mock("../services/templateService", () => ({
  resolveSystemPrompt: jest.fn().mockResolvedValue("You are a helpful assistant."),
  resolveSkills: jest.fn().mockResolvedValue(["custom_translate"]),
  getTemplateForWorkspace: jest.fn().mockResolvedValue(null),
  seedTemplates: jest.fn(),
}));

jest.mock("../services/providerService", () => ({
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
  deriveCapabilities: jest.fn().mockReturnValue([]),
}));

// Lazy-spied execute (hoisting-safe idiom from orchestrator.dlpMaskingWiring):
// the spy is parked on globalThis immediately after the hoisted registration.
// resolveSkillsForChat is mocked wholesale (fixture-consistency — the D-05
// DB resolution shape is owned by skills.routes.test.ts) but the definition's
// execute RIDES THE SPY, and the spy delegates to the REAL
// createPromptSkillExecutor — the masking round-trip is production code.
const skillExecute = jest.fn();
jest.mock("../agent/skills", () => {
  const actual = jest.requireActual("../agent/skills");
  return {
    __esModule: true,
    ...actual,
    resolveSkillsForChat: jest.fn().mockResolvedValue([
      {
        name: "custom_translate",
        displayName: "Translate",
        description: "custom skill",
        type: "custom",
        execute: (...args: unknown[]) =>
          ((globalThis as Record<string, unknown>).__skillExecuteSpy as (...a: unknown[]) => unknown)(...args),
      },
    ]),
  };
});
(globalThis as Record<string, unknown>).__skillExecuteSpy = skillExecute;

type StreamResult = {
  content: string;
  toolCall: { toolName: string; toolInput: Record<string, unknown> } | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
};
const streamLLMQueue: StreamResult[] = [];
const streamLLMMock = jest.fn((_ctx: any, _cfg: any, onToken: ((t: string) => void) | undefined, _signal: any) => {
  const result = streamLLMQueue.shift();
  if (!result) throw new Error("streamLLMMock: queue exhausted");
  if (onToken && result.content) onToken(result.content);
  return Promise.resolve(result);
});
jest.mock("../agent/llmStreaming", () => {
  const actual = jest.requireActual("../agent/llmStreaming");
  return {
    ...actual,
    streamLLM: (...args: any[]) => (streamLLMMock as any)(...args),
  };
});

// The REAL dlpFilter stays unmocked (same fixture approach as
// chatStreamSkillDlp): its lazy getActiveCompiledPatterns read is arranged
// to throw → scanContentAsync falls back to the built-in pattern set (email
// pattern matches the fixture param) — the production graceful-degradation
// path, deterministic Postgres-free.
jest.mock("../services/dlpPatternService", () => ({
  getActiveCompiledPatterns: jest.fn().mockRejectedValue(new Error("db down (mock)")),
  logDbFallback: jest.fn(),
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runAgent } from "../agent/orchestrator";
import { createPromptSkillExecutor } from "../services/skillService";

/**
 * Custom skill row — template "{{input}}" so the compiled prompt IS the
 * (masked) param. Same fixture shape as chatStreamSkillDlp's SKILL_ROW;
 * the REAL createPromptSkillExecutor compiles it.
 */
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
  createdBy: "user-1",
};

const RAW_EMAIL = "user@example.com";
const REDACTED = "[REDACTED]";

describe("Phase 194 interaction matrix — DLP × skills (LLM-invoked arm, real scanContentAsync round-trip)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The spy rides the REAL executor — createPromptSkillExecutor is the
    // ONLY execute path for a prompt-mode custom skill (skillService D-01),
    // exactly what resolveCustomSkillsForChat → toDefinition wires in
    // production. The orchestrator loop invokes it with dlpMaskingEnabled
    // threaded (WR-02) — the seam under test.
    skillExecute.mockImplementation((params: any) => createPromptSkillExecutor(SKILL_ROW)(params));
    streamLLMQueue.length = 0;
    streamLLMQueue.push(
      {
        content: "",
        toolCall: { toolName: "custom_translate", toolInput: { input: RAW_EMAIL } },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: "done",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    );
  });

  it("DLP on + LLM tool-call carrying PII mid-loop → the compiled context entry carries the redaction marker, never the raw PII (190-VERIFICATION behavior_unverified SC-2 closure)", async () => {
    await runAgent({
      workspaceId: "ws-test",
      userId: "user-1",
      message: "invoke translate",
      chatId: "c-test",
      dlpMaskingEnabled: true, // the chat route's dlpScanEnabled decision, threaded (WR-02)
    });

    // The LLM (not the user) invoked the skill mid-loop — the tool-call arm.
    expect(skillExecute).toHaveBeenCalledTimes(1);
    const params = skillExecute.mock.calls[0][0] as {
      metadata?: { input?: string };
      dlpMaskingEnabled?: boolean;
    };
    // The orchestrator threads the DLP decision into SkillParams (wiring arm).
    expect(params.dlpMaskingEnabled).toBe(true);
    // The tool input arrives RAW (the LLM typed the email) — masking happens
    // INSIDE the executor, before compilation.
    expect(params.metadata?.input).toBe(RAW_EMAIL);

    // The executor's returned data IS the compiled (spotlighted) prompt: the
    // compiled prompt context entry carries the redaction marker, NEVER the
    // raw PII — through the REAL scanContentAsync round-trip.
    const result = (await skillExecute.mock.results[0]!.value) as { success: boolean; data?: unknown };
    expect(result.success).toBe(true);
    const compiledPrompt = String(result.data);
    expect(compiledPrompt).toContain(REDACTED);
    expect(compiledPrompt).not.toContain(RAW_EMAIL);
  });
});