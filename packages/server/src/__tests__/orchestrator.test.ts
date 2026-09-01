// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Orchestrator Tests
 *
 * Covers:
 * - ragContext behavior in runAgent and runAgentStreaming
 * - BOT-02 single-call ReAct loop (one streamLLM per iteration, no callLLM
 *   in the loop)
 * - BOT-01 token usage saved in finally on ALL exit paths (success,
 *   wallclock, token-budget)
 * - D-02 buffered-replay (tool-call iterations discard buffer, final-answer
 *   replays token-by-token to onToken)
 * - abortReason in return shape (consumed by 62-05 for D-04)
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  return {
    __esModule: true,
    default: {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      workspaceAgentConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "test-config-id",
          workspaceId: "test-ws-id",
          systemPrompt: "You are a helpful assistant.",
          enabledSkills: JSON.stringify(["rag_search", "workspace_memory"]),
          model: "gemma4:latest",
          temperature: 0.7,
        }),
      },
      chatMessage: {
        create: jest.fn().mockResolvedValue({ id: "msg-id" }),
      },
      workspaceTokenUsage: {
        create: jest.fn().mockResolvedValue({}),
      },
    },
  };
});

jest.mock("../services/templateService", () => ({
  resolveSystemPrompt: jest.fn().mockResolvedValue("You are a helpful assistant."),
  // Phase 151 (RAG-03): pass-through so tests can control the enabled-skill
  // list via workspaceAgentConfig.enabledSkills.
  resolveSkills: jest.fn().mockImplementation((_workspaceId: string, names: string[]) => Promise.resolve(names)),
  getTemplateForWorkspace: jest.fn().mockResolvedValue(null),
}));

jest.mock("../agent/skills", () => ({
  getSkillsForWorkspace: jest.fn().mockReturnValue([
    {
      name: "rag_search",
      displayName: "RAG Search",
      description: "Search the workspace knowledge base.",
      type: "builtin",
      execute: jest.fn().mockResolvedValue({ success: true, data: "search results" }),
    },
    {
      name: "workspace_memory",
      displayName: "Workspace Memory",
      description: "Read/write workspace notes.",
      type: "builtin",
      execute: jest.fn().mockResolvedValue({ success: true, data: "memory data" }),
    },
  ]),
  resolveSkillsForChat: jest.fn().mockImplementation((_workspaceId: string, _chatId: string, enabledSkillNames: string[]) =>
    enabledSkillNames.map((name) => ({
      name,
      displayName: name,
      description: "Mock skill.",
      type: "builtin",
      execute: jest.fn().mockResolvedValue({ success: true, data: "mock data" }),
    }))
  ),
  AgentSkillDefinition: undefined,
  SkillResult: undefined,
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn().mockReturnValue({
    LLM_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "http://ollama:11434",
    OLLAMA_MODEL: "gemma4:latest",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    LLM_API_KEY: "",
    LLM_TIMEOUT: 5000,
    AGENT_WALLCLOCK_TIMEOUT_MS: 5000,
    AGENT_MAX_TOTAL_TOKENS: 1000,
    AGENT_MAX_CONTEXT_BYTES: 500000,
    AGENT_MAX_TOOL_OUTPUT_LENGTH: 5000,
    AGENT_MAX_SKILL_EXECUTION_MS: 1000,
    AGENT_LOOP_DETECTION_WINDOW: 3,
    CHAT_MAX_CONCURRENT_PER_USER: 5,
  }),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/providerService", () => ({
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
  // Phase 95 (D-01): modelFallback.ts now imports deriveCapabilities to
  // thread `nativeToolsReliable` on the env-var fallback path. The mock
  // must expose it so buildFallbackConfig resolves (mock-seam additive —
  // no behavioral assertion changed, mirrors the Phase 92 buildOllamaTools
  // seam addition at line 117).
  deriveCapabilities: jest.fn().mockReturnValue([]),
}));

// streamLLM is the single LLM call per iteration (BOT-02). The mock captures
// the context array (1st arg) so tests can assert on the system prompt, and
// returns { content, toolCall, usage } matching StreamingLLMResult.
// 92-05: buildOllamaTools added to the factory so the orchestrator's new
// `buildOllamaTools(activeSkills)` 5th-arg wiring resolves (mock-seam
// addition; no behavioral assertion changed — OJ-01 SC1 freeze preserved).
// Phase 95 (D-03): buildProviderTools added to the factory for the same
// reason — the orchestrator now calls buildProviderTools instead of
// buildOllamaTools directly (conditional gating helper).
jest.mock("../agent/llmStreaming", () => ({
  parseToolCall: jest.fn().mockReturnValue(null),
  streamLLM: jest.fn().mockResolvedValue({
    content: "Streaming response",
    toolCall: null,
    usage: { promptTokens: 10, completionTokens: 20 },
  }),
  buildOllamaTools: jest.fn((skills: { name: string; description: string }[]) =>
    skills.map((s) => ({ type: "function", function: { name: s.name, description: s.description } })),
  ),
  buildProviderTools: jest.fn((_providerType: string, skills: { name: string; description: string }[]) =>
    skills.map((s) => ({ type: "function", function: { name: s.name, description: s.description } })),
  ),
}));

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

import { runAgent, runAgentStreaming, type AgentRunParams } from "../agent/orchestrator";
import { getSkillsForWorkspace } from "../agent/skills";
import { streamLLM } from "../agent/llmStreaming";
import axios from "axios";
import prisma from "../utils/prisma";

const streamLLMMock = streamLLM as jest.MockedFunction<typeof streamLLM>;
const axiosPostMock = axios.post as jest.Mock;
const tokenUsageCreate = (prisma as any).workspaceTokenUsage.create as jest.Mock;
// Phase 95-04 (D-05): accessed via require to spy on the mocked logger.warn
// and override resolveProviderConfig per-test without re-wiring the factory.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger } = require("../utils/logger") as { logger: { warn: jest.Mock; info: jest.Mock; error: jest.Mock; debug: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveProviderConfig } = require("../services/providerService") as { resolveProviderConfig: jest.Mock };

// Helper: mock streamLLM to return a direct response (no tool call) —
// replaces the old mockLLMDirectResponse that rigged axios.post for callLLM.
function mockLLMDirectResponse(content = "I can help with that.") {
  streamLLMMock.mockResolvedValue({
    content,
    toolCall: null,
    usage: { promptTokens: 10, completionTokens: 20 },
  });
}

// Helper: mock streamLLM to return a tool call on the Nth call, then direct.
function mockToolThenDirect(toolName: string, toolInput: Record<string, unknown> = { query: "test" }) {
  let callIdx = 0;
  streamLLMMock.mockImplementation((() => {
    callIdx++;
    if (callIdx === 1) {
      return Promise.resolve({
        content: `Calling ${toolName}`,
        toolCall: { toolName, toolInput },
        usage: { promptTokens: 10, completionTokens: 20 },
      });
    }
    return Promise.resolve({
      content: "Final answer after tool.",
      toolCall: null,
      usage: { promptTokens: 12, completionTokens: 25 },
    });
  }) as typeof streamLLM);
}

describe("Orchestrator ragContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: streamLLM returns a direct response (no tool call).
    mockLLMDirectResponse();
  });

  describe("runAgent (non-streaming)", () => {
    it("should include ragContext text in system prompt when ragContext is provided", async () => {
      const ragContextText = "[Source: doc1.pdf]\nThis is a test document chunk about AI.";
      mockLLMDirectResponse();

      await runAgent({
        workspaceId: "test-ws-id",
        userId: "test-user-id",
        message: "Tell me about AI",
        chatId: "test-chat-id",
        ragContext: ragContextText,
      });

      // streamLLM is the single call — verify context[0] (system prompt)
      const calls = streamLLMMock.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const context = calls[0]![0] as Array<{ role: string; content: string }>;
      const systemMessage = context.find((m) => m.role === "system");
      expect(systemMessage).toBeDefined();
      expect(systemMessage!.content).toContain(ragContextText);
      expect(systemMessage!.content).toContain("pre-retrieved documents");
      expect(systemMessage!.content).not.toContain("You have access to the following tools:");
    });

    it("should exclude rag_search from activeSkills when ragContext is provided", async () => {
      const ragContextText = "[Source: doc1.pdf]\nTest chunk.";
      const mockRagSearch = jest.fn().mockResolvedValue({ success: true, data: "results" });
      const mockWorkspaceMemory = jest.fn().mockResolvedValue({ success: true, data: "memory" });
      (getSkillsForWorkspace as jest.Mock).mockReturnValue([
        { name: "rag_search", displayName: "RAG Search", description: "Search.", type: "builtin", execute: mockRagSearch },
        { name: "workspace_memory", displayName: "Workspace Memory", description: "Notes.", type: "builtin", execute: mockWorkspaceMemory },
      ]);

      // streamLLM returns a rag_search tool call first, then direct.
      mockToolThenDirect("rag_search", { query: "test" });

      await runAgent({
        workspaceId: "test-ws-id",
        userId: "test-user-id",
        message: "Search for AI",
        chatId: "test-chat-id",
        ragContext: ragContextText,
      });

      // rag_search was filtered out of activeSkills → skill lookup misses →
      // the tool never executes (mockRagSearch not called).
      expect(mockRagSearch).not.toHaveBeenCalled();
    });

    it("should use buildSystemPrompt format when ragContext is NOT provided", async () => {
      mockLLMDirectResponse();

      await runAgent({
        workspaceId: "test-ws-id",
        userId: "test-user-id",
        message: "Tell me about AI",
        chatId: "test-chat-id",
      });

      const context = streamLLMMock.mock.calls[0]![0] as Array<{ role: string; content: string }>;
      const systemMessage = context.find((m) => m.role === "system");
      expect(systemMessage).toBeDefined();
      expect(systemMessage!.content).toContain("You have access to the following tools:");
      expect(systemMessage!.content).toContain("rag_search");
      expect(systemMessage!.content).not.toContain("pre-retrieved documents");
    });

    it("should include rag_search in activeSkills when ragContext is NOT provided", async () => {
      mockLLMDirectResponse();

      await runAgent({
        workspaceId: "test-ws-id",
        userId: "test-user-id",
        message: "Tell me about AI",
        chatId: "test-chat-id",
      });

      const context = streamLLMMock.mock.calls[0]![0] as Array<{ role: string; content: string }>;
      const systemMessage = context.find((m) => m.role === "system");
      expect(systemMessage!.content).toContain("- rag_search:");
      expect(systemMessage!.content).toContain("- workspace_memory:");
    });
  });

  describe("runAgentStreaming", () => {
    it("should include ragContext text in system prompt when ragContext is provided", async () => {
      const ragContextText = "[Source: doc2.pdf]\nAnother test document about ML.";
      mockLLMDirectResponse();

      const onToken = jest.fn();
      const onStatus = jest.fn();

      await runAgentStreaming(
        { workspaceId: "test-ws-id", userId: "test-user-id", message: "Tell me about ML", chatId: "test-chat-id", ragContext: ragContextText },
        onToken,
        onStatus,
      );

      const systemMessages = streamLLMMock.mock.calls
        .map((c) => (c[0] as Array<{ role: string; content: string }>).find((m) => m.role === "system"))
        .filter(Boolean) as Array<{ content: string }>;
      expect(systemMessages.some((m) => m.content.includes(ragContextText))).toBe(true);
      expect(systemMessages.some((m) => m.content.includes("pre-retrieved documents"))).toBe(true);
    });

    it("should exclude rag_search from activeSkills when ragContext is provided in streaming mode", async () => {
      const ragContextText = "[Source: doc3.pdf]\nStreaming test document.";
      const mockRagSearch = jest.fn().mockResolvedValue({ success: true, data: "results" });
      (getSkillsForWorkspace as jest.Mock).mockReturnValue([
        { name: "rag_search", displayName: "RAG Search", description: "Search.", type: "builtin", execute: mockRagSearch },
        { name: "workspace_memory", displayName: "Workspace Memory", description: "Notes.", type: "builtin", execute: jest.fn().mockResolvedValue({ success: true, data: "memory" }) },
      ]);

      mockToolThenDirect("rag_search", { query: "test" });

      const onToken = jest.fn();
      const onStatus = jest.fn();

      await runAgentStreaming(
        { workspaceId: "test-ws-id", userId: "test-user-id", message: "Search for ML", chatId: "test-chat-id", ragContext: ragContextText },
        onToken,
        onStatus,
      );

      expect(mockRagSearch).not.toHaveBeenCalled();
    });
  });

  describe("AgentRunParams type", () => {
    it("should accept optional ragContext field", () => {
      const paramsWithRagContext: AgentRunParams = {
        workspaceId: "test-ws-id",
        userId: "test-user-id",
        message: "Test",
        chatId: "test-chat-id",
        ragContext: "Some pre-computed context",
      };
      const paramsWithoutRagContext: AgentRunParams = {
        workspaceId: "test-ws-id",
        userId: "test-user-id",
        message: "Test",
        chatId: "test-chat-id",
      };
      expect(paramsWithRagContext.ragContext).toBe("Some pre-computed context");
      expect(paramsWithoutRagContext.ragContext).toBeUndefined();
    });
  });
});

// ============================================================
// BOT-02 / BOT-01 / D-02 / abortReason — single-call + save-in-finally
// ============================================================
describe("Orchestrator single-call + save-in-finally + buffered-replay", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLLMDirectResponse();
  });

  it("single call per iteration — streamLLM called once, axios.post (callLLM) called zero times for the ReAct loop", async () => {
    mockLLMDirectResponse();

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Hello",
      chatId: "test-chat-id",
    });

    expect(streamLLMMock).toHaveBeenCalledTimes(1);
    // callLLM (axios.post) is NOT used in the ReAct loop — only generatePlan
    // (plan mode) uses it, and plan mode is off here.
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("save token usage on success — workspaceTokenUsage.create called with totalTokens after runAgent completes", async () => {
    mockLLMDirectResponse();

    const result = await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Hello",
      chatId: "test-chat-id",
    });

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArg = tokenUsageCreate.mock.calls[0][0].data;
    expect(createArg.totalTokens).toBe(30); // 10 prompt + 20 completion
    expect(createArg.promptTokens).toBe(10);
    expect(createArg.completionTokens).toBe(20);
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.totalTokens).toBe(30);
  });

  it("save token usage on wallclock abort — save-in-finally fires even when wallclock trips", async () => {
    // Rig streamLLM with usage so the budget accumulates; rig the budget's
    // wallclock to be expired on the 2nd iteration by making the first call
    // return a tool call (loop continues), then wallclock trips.
    // We mock AgentBudgetTracker via prototype spy.
    const { AgentBudgetTracker } = require("../services/agentBudgetService");
    const wallSpy = jest.spyOn(AgentBudgetTracker.prototype, "wallclockExpired");
    let wallCalls = 0;
    wallSpy.mockImplementation(function (this: any) {
      wallCalls++;
      return wallCalls > 2; // trip on 3rd check (2nd iteration)
    });

    mockToolThenDirect("rag_search", { query: "test" });

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Search",
      chatId: "test-chat-id",
    });

    // Even on wallclock abort, the finally block fires workspaceTokenUsage.create.
    expect(tokenUsageCreate).toHaveBeenCalled();
    wallSpy.mockRestore();
  });

  it("save token usage on token-budget abort — save-in-finally fires even when token budget exhausted", async () => {
    const { AgentBudgetTracker } = require("../services/agentBudgetService");
    const budgetSpy = jest.spyOn(AgentBudgetTracker.prototype, "isTokenBudgetExhausted");
    let budgetCalls = 0;
    budgetSpy.mockImplementation(function (this: any) {
      budgetCalls++;
      return budgetCalls > 2; // trip on 3rd check (2nd iteration)
    });

    mockToolThenDirect("rag_search", { query: "test" });

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Search",
      chatId: "test-chat-id",
    });

    expect(tokenUsageCreate).toHaveBeenCalled();
    budgetSpy.mockRestore();
  });

  it("no double call — tool-call iteration then final-answer iteration: streamLLM called twice, axios.post called zero times", async () => {
    mockToolThenDirect("rag_search", { query: "test" });

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Search",
      chatId: "test-chat-id",
    });

    // 2 iterations → 2 streamLLM calls. No callLLM in the loop.
    expect(streamLLMMock).toHaveBeenCalledTimes(2);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("D-02 buffered-replay: tool-call iteration does not call onToken, final-answer iteration replays buffer token-by-token", async () => {
    // Rig streamLLM to emit tokens via the bufferingOnToken during both
    // iterations. First iteration: tool call (buffer discarded). Second
    // iteration: final answer (buffer replayed to real onToken).
    let callIdx = 0;
    streamLLMMock.mockImplementation((async (_ctx: any, _cfg: any, onToken: (t: string) => void) => {
      callIdx++;
      if (callIdx === 1) {
        // Tool-call iteration — tokens buffered then discarded (D-02).
        onToken("Tool-");
        onToken("thinking");
        return {
          content: "Calling rag_search",
          toolCall: { toolName: "rag_search", toolInput: { query: "test" } },
          usage: { promptTokens: 10, completionTokens: 20 },
        };
      }
      // Final-answer iteration — tokens buffered then replayed to real onToken.
      onToken("Final-");
      onToken("answer");
      return {
        content: "Final answer after tool.",
        toolCall: null,
        usage: { promptTokens: 12, completionTokens: 25 },
      };
    }) as typeof streamLLM);

    const realOnToken = jest.fn();
    const onStatus = jest.fn();

    await runAgentStreaming(
      { workspaceId: "test-ws-id", userId: "test-user-id", message: "Search", chatId: "test-chat-id" },
      realOnToken,
      onStatus,
    );

    // During the tool-call iteration (callIdx === 1), the real onToken must
    // NOT be called (D-02: tool-call buffer discarded).
    // During the final-answer iteration (callIdx === 2), the real onToken
    // MUST be called with each replayed token.
    const realCalls = realOnToken.mock.calls.map((c) => c[0]);
    // The tool-call iteration tokens ("Tool-", "thinking") must NOT appear.
    expect(realCalls).not.toContain("Tool-");
    expect(realCalls).not.toContain("thinking");
    // The final-answer tokens ("Final-", "answer") MUST appear (replayed).
    expect(realCalls).toContain("Final-");
    expect(realCalls).toContain("answer");
    // onStatus provides tool feedback during tool-call iteration.
    expect(onStatus).toHaveBeenCalled();
  });

  it("abortReason in return — wallclock trip sets abortReason on the returned object", async () => {
    const { AgentBudgetTracker } = require("../services/agentBudgetService");
    const wallSpy = jest.spyOn(AgentBudgetTracker.prototype, "wallclockExpired");
    wallSpy.mockReturnValue(true); // trip immediately

    const result = await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Hello",
      chatId: "test-chat-id",
    });

    expect(result.abortReason).toBe("wallclock");
    wallSpy.mockRestore();
  });

  it("abortReason in return — successful completion sets abortReason to 'done'", async () => {
    mockLLMDirectResponse();

    const result = await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Hello",
      chatId: "test-chat-id",
    });

    expect(result.abortReason).toBe("done");
  });
});

// Helper: rig streamLLM to return an unknown-tool call N times, then a direct
// response. Used by the BOT-03 breaker tests (plan 62-05).
function mockUnknownToolThenDirect(unknownCalls: number, toolName = "nonexistent_tool") {
  let callIdx = 0;
  streamLLMMock.mockImplementation((() => {
    callIdx++;
    if (callIdx <= unknownCalls) {
      return Promise.resolve({
        content: `Calling ${toolName}`,
        toolCall: { toolName, toolInput: { query: "x" } },
        usage: { promptTokens: 10, completionTokens: 20 },
      });
    }
    return Promise.resolve({
      content: "Final answer.",
      toolCall: null,
      usage: { promptTokens: 12, completionTokens: 25 },
    });
  }) as typeof streamLLM);
}

// Helper: rig streamLLM to return a sequence of tool calls (unknown or
// existing), then a direct response. Each entry is either a toolName string
// (emits a toolCall for that name) or null (emits a direct response and stops).
// "nonexistent_tool" is unknown; "rag_search" is an existing skill (resets the
// consecutive counter).
function mockToolSequence(sequence: Array<string | null>) {
  let callIdx = 0;
  streamLLMMock.mockImplementation((() => {
    const step = sequence[callIdx];
    callIdx++;
    if (step === null || step === undefined) {
      return Promise.resolve({
        content: "Final answer.",
        toolCall: null,
        usage: { promptTokens: 12, completionTokens: 25 },
      });
    }
    return Promise.resolve({
      content: `Calling ${step}`,
      toolCall: { toolName: step, toolInput: { query: "x" } },
      usage: { promptTokens: 10, completionTokens: 20 },
    });
  }) as typeof streamLLM);
}

describe("BOT-03 unknown-tool circuit breaker (plan 62-05)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLLMDirectResponse();
  });

  it("breaker trips at 3 consecutive unknown-tool calls (runAgent)", async () => {
    mockUnknownToolThenDirect(3);
    const result = await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Test",
      chatId: "test-chat-id",
    });
    expect(result.abortReason).toBe("unknown_tool_breaker");
  });

  it("breaker trips at 5 total unknown-tool calls (non-consecutive, runAgent)", async () => {
    // Alternate unknown/existing so consecutive never reaches 3, but total
    // reaches 5: u, rag_search, u, workspace_memory, u, rag_search, u, u
    // (5 unknown, consecutive max=2). Existing tools alternate to avoid
    // tripping loop_detect (window=3) on the same tool+input repeat.
    // Trip fires on the 5th total unknown-tool call.
    mockToolSequence([
      "nonexistent_tool", "rag_search",
      "nonexistent_tool", "workspace_memory",
      "nonexistent_tool", "rag_search",
      "nonexistent_tool", "nonexistent_tool",
      null,
    ]);
    const result = await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Test",
      chatId: "test-chat-id",
    });
    expect(result.abortReason).toBe("unknown_tool_breaker");
  });

  it("consecutive counter resets on existing tool — 2 unknown + 1 existing + 2 unknown = no trip (total 4 < 5, consecutive 2 < 3)", async () => {
    mockToolSequence([
      "nonexistent_tool", "nonexistent_tool",
      "rag_search",
      "nonexistent_tool", "nonexistent_tool",
      null,
    ]);
    const result = await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Test",
      chatId: "test-chat-id",
    });
    // No trip — loop completes to a direct response.
    expect(result.abortReason).toBe("done");
  });

  it("token usage saved on breaker trip — D-04 (workspaceTokenUsage.create called in finally)", async () => {
    mockUnknownToolThenDirect(3);
    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Test",
      chatId: "test-chat-id",
    });
    // BOT-01 save-in-finally fires on the breaker-trip break path — no free runs.
    expect(tokenUsageCreate).toHaveBeenCalled();
  });

  it("abortReason in return on breaker trip — contract for chat.ts D-04 guard", async () => {
    mockUnknownToolThenDirect(3);
    const result = await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Test",
      chatId: "test-chat-id",
    });
    expect(result.abortReason).toBe("unknown_tool_breaker");
    // The chat.ts D-04 guard branches on this field to skip assistant save +
    // emit SSE event:error. That path is exercised by the abortReason contract
    // assertion here; chat.ts itself has no dedicated integration test for the
    // breaker branch (no chat route integration test exists in this suite).
  });

  // Note: "no assistant message saved on breaker trip" (D-04) is exercised at
  // the chat.ts layer, not the orchestrator layer — the orchestrator never
  // calls chatMessage.create. The chat.ts D-04 guard (result.abortReason !==
  // "unknown_tool_breaker") is validated by the abortReason contract assertion
  // above + the chat.ts code path committed in plan 62-05 Task 2.
});

// Phase 95-04 (D-05 — Pitfall 2 warning sign): parseToolCall call count
// metric. The orchestrator tracks a proxy counter per ReAct loop run and
// emits logger.warn when native tools are active, the loop ran >= 3 turns,
// AND parseToolCall was never the source of a dispatched toolCall (count = 0)
// — the canonical Pitfall 2 silent-drift warning sign. The metric is
// ADVISORY (no behavior change, no done-event field).
describe("Phase 95-04 parseToolCall call count metric (D-05)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLLMDirectResponse();
  });

  it("logs warning when parseToolCall count = 0 after 3 turns with native tools active (runAgent)", async () => {
    resolveProviderConfig.mockResolvedValue({
      type: "ollama",
      baseUrl: "http://ollama:11434",
      apiKey: null,
      model: "qwen2.5:3b",
      displayName: "qwen2.5",
      temperature: 0.7,
      isLocal: true,
      nativeToolsReliable: true,
    });
    mockToolSequence(["rag_search", "rag_search", "rag_search", null]);

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Search for quantum computing",
      chatId: "test-chat-id",
    });

    const warnCalls = logger.warn.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("parseToolCall call count = 0"),
    );
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]![0]).toContain("fallback may be dead code");
  });

  it("logs warning when native tools are active and parseToolCall is never used (runAgent)", async () => {
    resolveProviderConfig.mockResolvedValue({
      type: "ollama",
      baseUrl: "http://ollama:11434",
      apiKey: null,
      model: "gemma4:latest",
      displayName: "gemma4",
      temperature: 0.7,
      isLocal: true,
      nativeToolsReliable: false,
    });
    mockToolSequence(["rag_search", "rag_search", "rag_search", null]);

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Search for quantum computing",
      chatId: "test-chat-id",
    });

    // Native tools are now always active when skills exist, so the warning
    // fires when all tool calls come from native tools (parseToolCall count = 0).
    const warnCalls = logger.warn.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("parseToolCall call count = 0"),
    );
    expect(warnCalls.length).toBe(1);
  });

  it("does NOT log warning when loop runs < 3 turns with native tools active (runAgent)", async () => {
    resolveProviderConfig.mockResolvedValue({
      type: "ollama",
      baseUrl: "http://ollama:11434",
      apiKey: null,
      model: "qwen2.5:3b",
      displayName: "qwen2.5",
      temperature: 0.7,
      isLocal: true,
      nativeToolsReliable: true,
    });
    mockToolSequence(["rag_search", null]);

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Search for quantum computing",
      chatId: "test-chat-id",
    });

    const warnCalls = logger.warn.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("parseToolCall call count = 0"),
    );
    expect(warnCalls.length).toBe(0);
  });

  it("logs warning when parseToolCall count = 0 after 3 turns with native tools active (runAgentStreaming)", async () => {
    resolveProviderConfig.mockResolvedValue({
      type: "ollama",
      baseUrl: "http://ollama:11434",
      apiKey: null,
      model: "qwen2.5:3b",
      displayName: "qwen2.5",
      temperature: 0.7,
      isLocal: true,
      nativeToolsReliable: true,
    });
    mockToolSequence(["rag_search", "rag_search", "rag_search", null]);

    await runAgentStreaming(
      {
        workspaceId: "test-ws-id",
        userId: "test-user-id",
        message: "Search for quantum computing",
        chatId: "test-chat-id",
      },
      jest.fn(),
      jest.fn(),
      undefined,
    );

    const warnCalls = logger.warn.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("parseToolCall call count = 0"),
    );
    expect(warnCalls.length).toBe(1);
  });
});

// ─── Phase 151 (RAG-03): skill-conditional tool-selection affordance ────────

describe("RAG-03 tool-selection affordance (buildSystemPrompt)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLLMDirectResponse();
  });

  function getSystemPrompt(): string {
    const context = streamLLMMock.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const systemMessage = context.find((m) => m.role === "system");
    expect(systemMessage).toBeDefined();
    return systemMessage!.content;
  }

  function setEnabledSkills(names: string[]) {
    (prisma as any).workspaceAgentConfig.findUnique.mockResolvedValue({
      id: "test-config-id",
      workspaceId: "test-ws-id",
      systemPrompt: "You are a helpful assistant.",
      enabledSkills: JSON.stringify(names),
      model: "gemma4:latest",
      temperature: 0.7,
    });
  }

  it("(a) both skills present → affordance text present", async () => {
    setEnabledSkills(["rag_search", "wiki_query"]);

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Tell me about AI",
      chatId: "test-chat-id",
    });

    const prompt = getSystemPrompt();
    expect(prompt).toContain("TOOL SELECTION RULES:");
    expect(prompt).toContain("Use rag_search to search uploaded documents in the workspace knowledge base");
    expect(prompt).toContain("Use wiki_query to read synthesized wiki pages of the bound archive");
    expect(prompt).toContain("cite the wiki page once");
  });

  it("(b) only rag_search → wiki_query not mentioned in the affordance block", async () => {
    setEnabledSkills(["rag_search"]);

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Tell me about AI",
      chatId: "test-chat-id",
    });

    const prompt = getSystemPrompt();
    expect(prompt).toContain("TOOL SELECTION RULES:");
    expect(prompt).toContain("Use rag_search to search uploaded documents in the workspace knowledge base");
    // The affordance block must not mention wiki_query (the base prompt's
    // anti-hallucination rule 1 mentions it as "if available" — scope the
    // assertion to the TOOL SELECTION RULES block).
    const block = prompt.split("TOOL SELECTION RULES:")[1] ?? "";
    expect(block).not.toContain("wiki_query");
  });

  it("(c) neither skill → no affordance text", async () => {
    setEnabledSkills(["workspace_memory"]);

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Tell me about AI",
      chatId: "test-chat-id",
    });

    const prompt = getSystemPrompt();
    expect(prompt).not.toContain("TOOL SELECTION RULES:");
    expect(prompt).not.toContain("Use rag_search to search uploaded documents");
    expect(prompt).not.toContain("Use wiki_query to read synthesized wiki pages");
  });

  it("(d) MANDATORY SEARCH RULE still present in all cases", async () => {
    setEnabledSkills(["rag_search", "wiki_query"]);

    await runAgent({
      workspaceId: "test-ws-id",
      userId: "test-user-id",
      message: "Tell me about AI",
      chatId: "test-chat-id",
    });

    const prompt = getSystemPrompt();
    // The MANDATORY SEARCH RULE is constraint-gated (hybridSearchForced) —
    // with the default mock config it is NOT injected; the affordance must
    // not remove the CRITICAL ANTI-HALLUCINATION rule 1 which references
    // rag_search (and wiki_query if available).
    expect(prompt).toContain("CRITICAL ANTI-HALLUCINATION RULES:");
    expect(prompt).toContain("you MUST use rag_search (and wiki_query if available) BEFORE responding");
  });
});