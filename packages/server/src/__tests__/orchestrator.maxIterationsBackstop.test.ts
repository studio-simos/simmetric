// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 155 / Plan 02 — CSW-07 ReAct maxIterations backstop (TDD).
 *
 * Covers the defensive last-resort iteration cap added to both ReAct
 * `while(true)` loops (runAgent at orchestrator.ts:272, runAgentStreaming at
 * :761). The backstop is a hardcoded `MAX_ITERATIONS_BACKSTOP = 50` break
 * that fires ONLY if every watchdog (wallclock, token budget, loop detection,
 * unknown-tool breaker) fails to. In normal operation (1-10 iterations) it
 * never trips.
 *
 * Tests rig streamLLM to keep returning a tool call (loop continues) while
 * the watchdogs are neutralized (mocked to never fire), then assert the loop
 * breaks at iteration 50 with `budget.setAbortReason("maxIterations")`.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  return {
    __esModule: true,
    default: {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      workspaceAgentConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        // 260829-xxx fix: enable BOTH tools the unbounded loop alternates.
        // The old single-skill ["rag_search"] list made every workspace_memory
        // call trip the unknown-tool breaker at 5-total — "unknown_tool_breaker"
        // aborted at iteration 5, long before the iteration-50 backstop this
        // suite exists to prove. With both skills enabled the only remaining
        // breaker is MAX_ITERATIONS_BACKSTOP itself.
        create: jest.fn().mockResolvedValue({
          id: "test-config-id",
          workspaceId: "test-ws-id",
          systemPrompt: "You are a helpful assistant.",
          enabledSkills: JSON.stringify(["rag_search", "workspace_memory"]),
          model: "gemma4:latest",
          temperature: 0.7,
        }),
      },
      chatMessage: { create: jest.fn().mockResolvedValue({ id: "msg-id" }) },
      workspaceTokenUsage: { create: jest.fn().mockResolvedValue({}) },
    },
  };
});

jest.mock("../services/templateService", () => ({
  resolveSystemPrompt: jest.fn().mockResolvedValue("You are a helpful assistant."),
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
    // 260829-xxx fix: mockUnboundedToolLoop alternates rag_search and
    // workspace_memory, but the mock only exposed rag_search — every
    // workspace_memory call tripped the unknown-tool counter and the BOT-03
    // breaker fired at 5-total ("unknown_tool_breaker") long before the
    // iteration-50 backstop the test exists to prove. Both alternated tools
    // must be KNOWN so the only remaining breaker is the backstop itself.
    {
      name: "workspace_memory",
      displayName: "Workspace Memory",
      description: "Search the workspace memory.",
      type: "builtin",
      execute: jest.fn().mockResolvedValue({ success: true, data: "memory results" }),
    },
  ]),
  resolveSkillsForChat: jest.fn().mockImplementation((_ws: string, _c: string, names: string[]) =>
    names.map((name) => ({
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
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/providerService", () => ({
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
  deriveCapabilities: jest.fn().mockReturnValue([]),
}));

jest.mock("../agent/llmStreaming", () => ({
  parseToolCall: jest.fn().mockReturnValue(null),
  streamLLM: jest.fn().mockResolvedValue({
    content: "Streaming response",
    toolCall: null,
    usage: { promptTokens: 10, completionTokens: 20 },
  }),
  buildOllamaTools: jest.fn((s: { name: string; description: string }[]) =>
    s.map((x) => ({ type: "function", function: { name: x.name, description: x.description } }))
  ),
  buildProviderTools: jest.fn((_t: string, s: { name: string; description: string }[]) =>
    s.map((x) => ({ type: "function", function: { name: x.name, description: x.description } }))
  ),
}));

jest.mock("axios", () => ({ __esModule: true, default: { post: jest.fn() } }));

import { runAgent, runAgentStreaming, type AgentRunParams } from "../agent/orchestrator";
import { streamLLM } from "../agent/llmStreaming";
import { AgentBudgetTracker } from "../services/agentBudgetService";

const streamLLMMock = streamLLM as jest.MockedFunction<typeof streamLLM>;

// 260829-xxx fix: the suite had NO mock-clear between tests — the call
// counter accumulated across the three describes ("normal operation" makes
// 2 calls, then each runaway test's 50 stack on top of the previous total:
// 51/100 observed). The per-test `toHaveBeenCalledTimes(50)` asserts were
// un-satisfiable for any test after the first. mockClear resets ONLY the
// calls; mockImplementation set by mockUnboundedToolLoop per-test survives
// (it is re-set before each runaway test anyway).
beforeEach(() => {
  streamLLMMock.mockClear();
});

const baseParams: AgentRunParams = {
  workspaceId: "test-ws-id",
  userId: "test-user-id",
  message: "Test",
  chatId: "test-chat-id",
};

// Drive the loop with an unending sequence of DISTINCT tool calls so the loop
// detector (same tool+input N times) never fires, while the loop keeps going.
// Each call alternates tool+input so loop_detection_window (3) never triggers.
function mockUnboundedToolLoop() {
  let callIdx = 0;
  streamLLMMock.mockImplementation((() => {
    callIdx++;
    // Alternate two different tool+input combos so the sliding window never
    // sees 3-in-a-row of the same pair (loop_detector window=3).
    const tool = callIdx % 2 === 0 ? "rag_search" : "workspace_memory";
    const query = `q-${callIdx}`;
    return Promise.resolve({
      content: `Calling ${tool}`,
      toolCall: { toolName: tool, toolInput: { query } },
      usage: { promptTokens: 10, completionTokens: 20 },
    });
  }) as typeof streamLLM);
}

// Neutralize all watchdogs so only the backstop can break the loop.
function neutralizeWatchdogs() {
  const wallSpy = jest.spyOn(AgentBudgetTracker.prototype, "wallclockExpired");
  wallSpy.mockReturnValue(false);
  const budgetSpy = jest.spyOn(AgentBudgetTracker.prototype, "isTokenBudgetExhausted");
  budgetSpy.mockReturnValue(false);
  return () => {
    wallSpy.mockRestore();
    budgetSpy.mockRestore();
  };
}

describe("CSW-07 — ReAct MAX_ITERATIONS_BACKSTOP (runAgent)", () => {
  it("normal operation: backstop does NOT fire when iterations stay under 50 (returns done)", async () => {
    // 2 iterations: tool call then direct response.
    let callIdx = 0;
    streamLLMMock.mockImplementation((() => {
      callIdx++;
      if (callIdx === 1) {
        return Promise.resolve({
          content: "Calling rag_search",
          toolCall: { toolName: "rag_search", toolInput: { query: "x" } },
          usage: { promptTokens: 10, completionTokens: 20 },
        });
      }
      return Promise.resolve({
        content: "Final answer.",
        toolCall: null,
        usage: { promptTokens: 12, completionTokens: 25 },
      });
    }) as typeof streamLLM);

    const result = await runAgent(baseParams);
    expect(result.abortReason).toBe("done");
  });

  it("runaway: breaks at iteration 50 with abortReason 'maxIterations' when all watchdogs fail", async () => {
    mockUnboundedToolLoop();
    const restore = neutralizeWatchdogs();

    const result = await runAgent(baseParams);
    // The backstop fires at iteration 50 (the last-resort break).
    expect(result.abortReason).toBe("maxIterations");
    // 49 LLM calls, not 50: the loop order is `iterations++` → watchdog
    // checks (incl. `iterations >= MAX_ITERATIONS_BACKSTOP`) → LLM call.
    // On iteration 50 the check trips BEFORE the call — 49 calls were made,
    // the 50th is never dispatched. The old `toHaveBeenCalledTimes(50)` pin
    // was unreachable by construction (the suite never passed with it).
    expect(streamLLMMock).toHaveBeenCalledTimes(49);
    restore();
  });
});

describe("CSW-07 — ReAct MAX_ITERATIONS_BACKSTOP (runAgentStreaming)", () => {
  it("runaway: streaming loop breaks at iteration 50 with abortReason 'maxIterations'", async () => {
    mockUnboundedToolLoop();
    const restore = neutralizeWatchdogs();

    const result = await runAgentStreaming(
      baseParams,
      () => {},
      () => {},
      // 4th arg is `signal?: AbortSignal` — the old test passed a bare
      // `() => {}` here (TS2345, pre-existing typecheck failure). Omit it;
      // the trailing optional callbacks (onEvent/onPlan/onThinking) are
      // unused by this test.
    );
    expect(result.abortReason).toBe("maxIterations");
    // Same 49-not-50 arithmetic as the runAgent variant (check-before-call).
    expect(streamLLMMock).toHaveBeenCalledTimes(49);
    restore();
  });
});