// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTES at the repository root for full terms.

/**
 * WR-02 (Phase 190, D-13) — orchestrator wiring pin: BOTH ReAct loops thread
 * AgentRunParams.dlpMaskingEnabled into skill.execute (SkillParams), so the
 * prompt-skill executor masks LLM-supplied tool input BEFORE template
 * compilation (the explicit /slug path is masked in the route — both
 * invocation styles share the masking contract).
 *
 * Mock shape mirrors orchestrator.implicitToolCall.test.ts: a spied execute
 * + a streamLLM queue (iteration 1 emits a NATIVE tool call, iteration 2 a
 * direct answer). The pin is on the execute-call args, NOT on masking
 * behavior itself (that lives in skillService.test.ts against the real
 * scanContentAsync).
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

// Lazy-spied execute: jest.mock factories are hoisted ABOVE the const
// declarations, so the factory cannot close over a top-level jest.fn. The
// indirection defers the lookup to call time (the spy is parked on globalThis
// immediately after the hoisted registrations, before any test runs).
const skillExecute = jest.fn().mockResolvedValue({ success: true, data: "skill output" });
jest.mock("../agent/skills", () => ({
  __esModule: true,
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
}));
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

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runAgent, runAgentStreaming } from "../agent/orchestrator";

describe("WR-02: the orchestrator threads dlpMaskingEnabled into skill.execute (both loops)", () => {
  beforeEach(() => {
    streamLLMMock.mockClear();
    skillExecute.mockClear();
    streamLLMQueue.length = 0;
    streamLLMQueue.push(
      {
        content: "",
        toolCall: { toolName: "custom_translate", toolInput: { input: "user@example.com" } },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: "done",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    );
  });

  it("runAgent passes the flag through (true → execute sees dlpMaskingEnabled: true)", async () => {
    await runAgent({
      workspaceId: "ws-test",
      userId: "u-test",
      message: "invoke translate",
      chatId: "c-test",
      dlpMaskingEnabled: true,
    });
    expect(skillExecute).toHaveBeenCalledTimes(1);
    expect(skillExecute.mock.calls[0][0]).toEqual(
      expect.objectContaining({ dlpMaskingEnabled: true, metadata: { input: "user@example.com" } }),
    );
  });

  it("runAgentStreaming passes the flag through the same way", async () => {
    await runAgentStreaming(
      {
        workspaceId: "ws-test",
        userId: "u-test",
        message: "invoke translate",
        chatId: "c-test",
        dlpMaskingEnabled: true,
      },
      jest.fn(),
      jest.fn(),
    );
    expect(skillExecute).toHaveBeenCalledTimes(1);
    expect(skillExecute.mock.calls[0][0]).toEqual(
      expect.objectContaining({ dlpMaskingEnabled: true }),
    );
  });

  it("flag absent → execute sees dlpMaskingEnabled: undefined (additive-optional byte-shape)", async () => {
    await runAgent({
      workspaceId: "ws-test",
      userId: "u-test",
      message: "invoke translate",
      chatId: "c-test",
    });
    expect(skillExecute.mock.calls[0][0]).toEqual(
      expect.objectContaining({ dlpMaskingEnabled: undefined }),
    );
  });
});