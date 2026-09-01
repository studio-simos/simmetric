// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Orchestrator implicit tool-call recovery — integration test.
 *
 * Reproduces the deepseek-v4:pro:cloud bug: the model ignores the JSON
 * tool-call format in the system prompt and emits a bare XML tag
 * `<search><query>...</query></search>`. parseToolCall returns null (it only
 * knows structured formats), so without the resolver the orchestrator would
 * treat the tag as a final answer and stream the raw `<search>` text to the
 * user. This test asserts the resolver routes the tag to rag_search, the
 * skill executes with the extracted query, and the raw XML never reaches the
 * final response (non-stream) nor the onToken stream (streaming).
 */
import "./helpers/setupEnv";

// --- Mocks ------------------------------------------------------------------

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const { prisma } = createMockPrisma();
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
  (prisma as any).workspaceTokenUsage = { create: jest.fn().mockResolvedValue({}) };
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
    LLM_MODEL: "deepseek-v4:pro:cloud",
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

// rag_search skill with a spied execute so we can assert it ran with the
// query extracted from the <query> child element.
const ragSearchExecute = jest.fn().mockResolvedValue({
  success: true,
  data: "Document A: invoice 2024. Document B: contract. Document C: spec.",
});
jest.mock("../agent/skills", () => ({
  resolveSkillsForChat: jest.fn().mockResolvedValue([
    {
      name: "rag_search",
      displayName: "RAG Search",
      description: "Search the workspace knowledge base.",
      type: "builtin",
      execute: ragSearchExecute,
    },
    {
      name: "workspace_memory",
      displayName: "Workspace Memory",
      description: "Read/write workspace-scoped key-value pairs.",
      type: "builtin",
      execute: jest.fn().mockResolvedValue({ success: true, data: "" }),
    },
  ]),
}));

// streamLLM is mocked so we can feed the exact deepseek emission. parseToolCall
// returns null (it does NOT recognise the bare <search> tag) — this forces the
// orchestrator down the resolveImplicitToolCall recovery path. parseXMLElements
// is the REAL implementation (jest.requireActual) so the resolver can extract
// the <query> child element.
//
// The mock invokes the onToken callback (3rd arg) with the full content so the
// orchestrator's D-02 buffering/replay path is exercised just like a real
// stream — tool-call iterations buffer+discard, final-answer iterations
// buffer+replay to the real onToken.
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
    parseToolCall: jest.fn(() => null),
  };
});

jest.mock("../agent/builtinSkills", () => ({}));

// --- Tests ------------------------------------------------------------------

describe("orchestrator — implicit tool-call recovery (deepseek <search> tag)", () => {
  beforeEach(() => {
    streamLLMMock.mockClear();
    streamLLMQueue.length = 0;
    ragSearchExecute.mockClear();
  });

  test("runAgent: <search><query>...</query></search> routes to rag_search, raw XML not in response", async () => {
    // Iteration 1: model emits the bare XML tag (parseToolCall → null).
    // Iteration 2: after the tool result, model produces a real final answer.
    streamLLMQueue.push(
      {
        content: "<search> <query>workspace memory documents metadata</query> </search>",
        toolCall: null,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: "The workspace contains 3 documents: an invoice, a contract, and a spec.",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    );

    const { runAgent } = await import("../agent/orchestrator");
    const result = await runAgent({
      workspaceId: "ws-test",
      userId: "u-test",
      message: "Summarize the documents in this workspace",
      chatId: "c-test",
    });

    // rag_search was invoked with the query extracted from <query>.
    expect(ragSearchExecute).toHaveBeenCalledTimes(1);
    const callArg = ragSearchExecute.mock.calls[0][0] as { query?: string };
    expect(callArg.query).toBe("workspace memory documents metadata");

    // A tool call was recorded.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.tool).toBe("rag_search");

    // The final response is the real summary, NOT the raw <search> XML.
    expect(result.response).toBe("The workspace contains 3 documents: an invoice, a contract, and a spec.");
    expect(result.response).not.toContain("<search>");
    expect(result.response).not.toContain("<query>");
  });

  test("runAgentStreaming: raw <search> XML is NOT replayed to onToken; only the final answer is", async () => {
    streamLLMQueue.push(
      {
        content: "<search><query>workspace memory documents metadata</query></search>",
        toolCall: null,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: "Summary: 3 documents found.",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    );

    const streamed: string[] = [];
    const statuses: string[] = [];

    const { runAgentStreaming } = await import("../agent/orchestrator");
    const result = await runAgentStreaming(
      {
        workspaceId: "ws-test",
        userId: "u-test",
        message: "Summarize the documents in this workspace",
        chatId: "c-test",
      },
      (token: string) => streamed.push(token),
      (status: string) => statuses.push(status),
    );

    // rag_search ran with the extracted query.
    expect(ragSearchExecute).toHaveBeenCalledTimes(1);
    const callArg = ragSearchExecute.mock.calls[0][0] as { query?: string };
    expect(callArg.query).toBe("workspace memory documents metadata");

    // The raw XML was NEVER forwarded to the client stream.
    const joined = streamed.join("");
    expect(joined).not.toContain("<search>");
    expect(joined).not.toContain("<query>");
    // The final answer WAS streamed.
    expect(joined).toContain("Summary: 3 documents found.");

    // The tool-call iteration emitted a "Using tool" status (not a final
    // "Generating response" for the XML iteration).
    expect(statuses.some((s) => /using tool/i.test(s))).toBe(true);

    expect(result.response).toBe("Summary: 3 documents found.");
  });

  test("runAgent: plain prose (no XML tag) still returns as a direct final answer", async () => {
    // Regression guard: the resolver must not break the normal direct-answer
    // path. Content not starting with `<` → resolveImplicitToolCall returns
    // null → treated as final answer.
    streamLLMQueue.push({
      content: "I can help with that.",
      toolCall: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const { runAgent } = await import("../agent/orchestrator");
    const result = await runAgent({
      workspaceId: "ws-test",
      userId: "u-test",
      message: "hi",
      chatId: "c-test",
    });

    expect(ragSearchExecute).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(0);
    expect(result.response).toBe("I can help with that.");
  });
});