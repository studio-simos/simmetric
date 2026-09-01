// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MOD-01 characterization pinning — captured on BASE BEFORE the extraction.
 *
 * These 5 tests pin the public-facade contracts the orchestrator split
 * (plan 88-01) MUST NOT break. They run green against the UNMODIFIED
 * `orchestrator.ts` (single 1042-line file). After extraction (Task 2),
 * `orchestrator.ts` becomes a thin facade over `planRunner.ts`,
 * `modelFallback.ts`, `toolCallResolver.ts` — these tests must stay green
 * without modification, proving the facade is byte-identical.
 *
 * Per D-07: jest is the gate for MOD-01 (no UAT canaries). The 5 tests below
 * + the existing `planMode.test.ts` + the existing
 * `orchestrator.implicitToolCall.test.ts` are the MOD-01 gate.
 *
 * Fixtures (D-07 "cheapest net that pins the specific contracts"):
 *   1. runAgent — no tool, no implicit → finalResponse === content, done.
 *   2. runAgent — <search><query>...</query></search> → toolCalls non-empty
 *      (pins resolveImplicitToolCall wiring in the non-streaming loop).
 *   3. runAgentStreaming — same XML fixture → toolCalls non-empty
 *      (Pitfall 2 guard: pins wiring in the streaming loop too).
 *   4. generatePlan — mocked axios returns malformed (empty) plan → null
 *      (pins the fallback path: malformed → null → caller falls back to
 *      direct execution).
 *   5. generatePlan — mocked axios rejects fast (timeout/error fallback) →
 *      null (pins withTimeout's reject path → caught → null after
 *      PLAN_MAX_ATTEMPTS).
 */
import "../../__tests__/helpers/setupEnv";

// --- Mocks (mirror orchestrator.implicitToolCall.test.ts:13-60) --------------

jest.mock("../../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("../../__tests__/helpers/mockPrisma");
  const { prisma } = createMockPrisma();
  const defaultAgentConfig = {
    workspaceId: "ws-char",
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

jest.mock("../../config/env", () => ({
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
    OPENROUTER_API_KEY: "",
    OPENROUTER_MODEL: "",
    OPENROUTER_BASE_URL: "",
    OLLAMA_API_KEY: "",
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    VECTOR_DB_PROVIDER: "lancedb",
    VECTOR_DB_URL: "",
    VECTOR_DB_API_KEY: "",
    LICENSE_KEY: "",
    STORAGE_PATH: "/tmp/sc-test",
    LOG_LEVEL: "error",
    LLM_TIMEOUT: 30000,
    OLLAMA_KEEP_ALIVE: "10m",
    AGENT_WALLCLOCK_TIMEOUT_MS: 600000,
    AGENT_MAX_TOTAL_TOKENS: 200000,
    AGENT_MAX_CONTEXT_BYTES: 500000,
    AGENT_MAX_TOOL_OUTPUT_LENGTH: 5000,
    AGENT_MAX_SKILL_EXECUTION_MS: 60000,
    AGENT_LOOP_DETECTION_WINDOW: 3,
    AGENT_MAX_ITERATIONS: 10,
  })),
}));

jest.mock("../../services/templateService", () => ({
  resolveSystemPrompt: jest.fn().mockResolvedValue("You are a helpful assistant."),
  resolveSkills: jest.fn().mockResolvedValue(["rag_search", "workspace_memory"]),
  getTemplateForWorkspace: jest.fn().mockResolvedValue(null),
  seedTemplates: jest.fn(),
}));

jest.mock("../../services/providerService", () => ({
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
  // Phase 95 (D-01): modelFallback imports deriveCapabilities — expose a
  // no-op mock so buildFallbackConfig resolves (mock-seam additive).
  deriveCapabilities: jest.fn().mockReturnValue([]),
}));

const ragSearchExecute = jest.fn().mockResolvedValue({
  success: true,
  data: "Document A. Document B. Document C.",
});
jest.mock("../skills", () => ({
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

// streamLLM mock with a queue (same shape as orchestrator.implicitToolCall.test.ts).
type StreamResult = {
  content: string;
  toolCall: { toolName: string; toolInput: Record<string, unknown> } | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  doneReason?: "stop" | "length" | "unload" | "load" | "error";
};
const streamLLMQueue: StreamResult[] = [];
const streamLLMMock = jest.fn((_ctx: any, _cfg: any, onToken: ((t: string) => void) | undefined, _signal: any) => {
  const result = streamLLMQueue.shift();
  if (!result) throw new Error("streamLLMMock: queue exhausted");
  if (onToken && result.content) onToken(result.content);
  return Promise.resolve(result);
});
jest.mock("../llmStreaming", () => {
  const actual = jest.requireActual("../llmStreaming");
  return {
    ...actual,
    streamLLM: (...args: any[]) => (streamLLMMock as any)(...args),
    parseToolCall: jest.fn(() => null),
  };
});

jest.mock("../builtinSkills", () => ({}));

// axios mock for generatePlan tests (callLLM uses axios.post directly).
const axiosPostMock = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: axiosPostMock },
  AxiosError: jest.requireActual("axios").AxiosError,
}));

// ollama-module mock — planRunner.callLLM's ollama case goes through the 92-01
// getOllamaClient() factory (92-02 re-seam). Mock fn declared INSIDE the
// factory (TDZ-safe under @swc/jest), retrieved via require("ollama"). Every
// constructed Ollama instance shares this one chat mock, so the factory's Map
// cache is transparent to tests.
jest.mock("ollama", () => {
  const chat = jest.fn();
  return {
    __esModule: true,
    Ollama: jest.fn(() => ({ chat })),
    default: { chat },
    __mockChat: chat,
  };
});
const mockOllamaChat = (require("ollama") as { __mockChat: jest.Mock }).__mockChat;

// --- Tests -------------------------------------------------------------------

describe("MOD-01 characterization: orchestrator public facade (base pinning)", () => {
  beforeEach(() => {
    streamLLMMock.mockClear();
    streamLLMQueue.length = 0;
    ragSearchExecute.mockClear();
    axiosPostMock.mockReset();
    mockOllamaChat.mockReset();
  });

  test("1. runAgent: no tool-call and no implicit tool-call → finalResponse === content, abortReason === 'done'", async () => {
    streamLLMQueue.push({
      content: "Direct answer to the user.",
      toolCall: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const { runAgent } = await import("../orchestrator");
    const result = await runAgent({
      workspaceId: "ws-char",
      userId: "u-char",
      message: "hi",
      chatId: "c-char",
    });

    expect(result.response).toBe("Direct answer to the user.");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.abortReason).toBe("done");
    expect(ragSearchExecute).not.toHaveBeenCalled();
  });

  test("2. runAgent: <search><query>...</query></search> → implicit tool-call resolved, toolCalls non-empty", async () => {
    streamLLMQueue.push(
      {
        content: "<search><query>workspace documents</query></search>",
        toolCall: null,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: "Summary based on documents.",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    );

    const { runAgent } = await import("../orchestrator");
    const result = await runAgent({
      workspaceId: "ws-char",
      userId: "u-char",
      message: "search the documents",
      chatId: "c-char",
    });

    expect(ragSearchExecute).toHaveBeenCalledTimes(1);
    expect((ragSearchExecute.mock.calls[0][0] as { query?: string }).query).toBe("workspace documents");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.tool).toBe("rag_search");
    expect(result.response).toBe("Summary based on documents.");
  });

  test("3. runAgentStreaming: same <search><query> XML → implicit tool-call resolved in streaming loop (Pitfall 2 guard)", async () => {
    streamLLMQueue.push(
      {
        content: "<search><query>workspace documents</query></search>",
        toolCall: null,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: "Streaming summary.",
        toolCall: null,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    );

    const streamed: string[] = [];
    const statuses: string[] = [];

    const { runAgentStreaming } = await import("../orchestrator");
    const result = await runAgentStreaming(
      {
        workspaceId: "ws-char",
        userId: "u-char",
        message: "search the documents",
        chatId: "c-char",
      },
      (token: string) => streamed.push(token),
      (status: string) => statuses.push(status),
    );

    expect(ragSearchExecute).toHaveBeenCalledTimes(1);
    expect((ragSearchExecute.mock.calls[0][0] as { query?: string }).query).toBe("workspace documents");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.tool).toBe("rag_search");
    // Raw XML never reaches the onToken stream.
    expect(streamed.join("")).not.toContain("<search>");
    expect(streamed.join("")).toContain("Streaming summary.");
    expect(result.response).toBe("Streaming summary.");
  });

  test("4. generatePlan: mocked axios returns malformed (empty content) plan → returns null (fallback path)", async () => {
    // callLLM for ollama reads `response.message?.content || ""`. An empty
    // message.content → content === "" → parsePlan("") === null → after
    // PLAN_MAX_ATTEMPTS (2) generatePlan returns null → caller falls back to
    // direct execution.
    mockOllamaChat.mockResolvedValue({ message: { content: "" }, prompt_eval_count: 0, eval_count: 0 });

    const { generatePlan } = await import("../orchestrator");
    const plan = await generatePlan(
      "Plan my task",
      [],
      [{ name: "rag_search", displayName: "RAG", description: "search", type: "builtin", execute: jest.fn() }],
      {
        type: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: null,
        model: "deepseek-v4:pro:cloud",
        displayName: undefined,
        temperature: 0.2,
        isLocal: false,
      },
    );

    expect(plan).toBeNull();
    // Both attempts actually fired (PLAN_MAX_ATTEMPTS === 2).
    expect(mockOllamaChat).toHaveBeenCalledTimes(2);
  });

  test("5. generatePlan: mocked axios rejects fast (timeout/error fallback) → returns null after PLAN_MAX_ATTEMPTS", async () => {
    // Fast-rejecting ollama chat stands in for a withTimeout rejection: the
    // callLLM promise rejects, generatePlan's catch block logs and continues,
    // and after PLAN_MAX_ATTEMPTS the function returns null. This pins the same
    // null-return contract a real 15000ms withTimeout rejection would.
    mockOllamaChat.mockRejectedValue(new Error("plan_timeout"));

    const { generatePlan } = await import("../orchestrator");
    const plan = await generatePlan(
      "Plan my task",
      [],
      [{ name: "rag_search", displayName: "RAG", description: "search", type: "builtin", execute: jest.fn() }],
      {
        type: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: null,
        model: "deepseek-v4:pro:cloud",
        displayName: undefined,
        temperature: 0.2,
        isLocal: false,
      },
    );

    expect(plan).toBeNull();
    expect(mockOllamaChat).toHaveBeenCalledTimes(2);
  });

  test("6. G-131-17: system prompt contains the [WIKI_NO_CONTENT] anti-retry rule", async () => {
    // The streamLLMMock receives the context array as its first arg — the
    // system prompt is context[0].content. Capture it to assert the
    // anti-retry rule (zero-export-change route: buildSystemPrompt is private).
    streamLLMQueue.push({
      content: "Direct answer to the user.",
      toolCall: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const { runAgent } = await import("../orchestrator");
    await runAgent({
      workspaceId: "ws-char",
      userId: "u-char",
      message: "hi",
      chatId: "c-char",
    });

    expect(streamLLMMock).toHaveBeenCalled();
    const contextArg = streamLLMMock.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const systemContent = contextArg.find((m) => m.role === "system")?.content ?? "";
    // The marker reference + the stop-retrying instruction.
    expect(systemContent).toContain("[WIKI_NO_CONTENT]");
    expect(systemContent).toContain("do NOT call that tool again");
  });

  test("7. G-131-19: locale-aware no-results rule — Italian locale → Italian sentence + supersede instruction", async () => {
    streamLLMQueue.push({
      content: "Direct answer to the user.",
      toolCall: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const { runAgent } = await import("../orchestrator");
    await runAgent({
      workspaceId: "ws-char",
      userId: "u-char",
      message: "Ciao",
      chatId: "c-char",
      locale: "it",
    });

    expect(streamLLMMock).toHaveBeenCalled();
    const contextArg = streamLLMMock.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const systemContent = contextArg.find((m) => m.role === "system")?.content ?? "";
    // The no-results sentence is localized in Italian.
    expect(systemContent).toContain("Non ho trovato informazioni");
    // The supersede instruction protects against a custom prompt carrying a
    // foreign-language no-results sentence (resolveSystemPrompt returns DB
    // prompts verbatim).
    expect(systemContent).toContain("superseded");
  });

  test("8. G-131-19: locale-aware no-results rule — English locale → English sentence", async () => {
    streamLLMQueue.push({
      content: "Direct answer to the user.",
      toolCall: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const { runAgent } = await import("../orchestrator");
    await runAgent({
      workspaceId: "ws-char",
      userId: "u-char",
      message: "hi",
      chatId: "c-char",
      locale: "en",
    });

    expect(streamLLMMock).toHaveBeenCalled();
    const contextArg = streamLLMMock.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const systemContent = contextArg.find((m) => m.role === "system")?.content ?? "";
    expect(systemContent).toContain("no information was found");
    expect(systemContent).not.toContain("Non ho trovato informazioni");
  });

  test("9. G-131-19: absent locale keeps the existing default no-results sentence (backward compat)", async () => {
    streamLLMQueue.push({
      content: "Direct answer to the user.",
      toolCall: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const { runAgent } = await import("../orchestrator");
    await runAgent({
      workspaceId: "ws-char",
      userId: "u-char",
      message: "hi",
      chatId: "c-char",
    });

    expect(streamLLMMock).toHaveBeenCalled();
    const contextArg = streamLLMMock.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const systemContent = contextArg.find((m) => m.role === "system")?.content ?? "";
    // The pre-existing default sentence (Italian, unchanged for workspace chats).
    expect(systemContent).toContain("Non ho trovato informazioni su questo argomento nei documenti del workspace");
  });
});

describe("shouldFallbackForDoneReason (D-05)", () => {
  beforeEach(() => {
    streamLLMMock.mockClear();
    streamLLMQueue.length = 0;
    ragSearchExecute.mockClear();
  });

  it("returns context fallback for doneReason length", async () => {
    const { shouldFallbackForDoneReason } = await import("../modelFallback");
    expect(shouldFallbackForDoneReason("length")).toEqual({ fallback: true, reason: "context" });
  });

  it("returns model fallback for doneReason error", async () => {
    const { shouldFallbackForDoneReason } = await import("../modelFallback");
    expect(shouldFallbackForDoneReason("error")).toEqual({ fallback: true, reason: "model" });
  });

  it("returns no fallback for doneReason stop", async () => {
    const { shouldFallbackForDoneReason } = await import("../modelFallback");
    expect(shouldFallbackForDoneReason("stop")).toEqual({ fallback: false, reason: "none" });
  });

  it("returns no fallback with log for doneReason unload", async () => {
    const { shouldFallbackForDoneReason } = await import("../modelFallback");
    const decision = shouldFallbackForDoneReason("unload");
    expect(decision.fallback).toBe(false);
    expect(decision.reason).toBe("none");
    expect(typeof decision.log).toBe("string");
    expect(decision.log!.length).toBeGreaterThan(0);
  });

  it("returns no fallback with log for doneReason load", async () => {
    const { shouldFallbackForDoneReason } = await import("../modelFallback");
    const decision = shouldFallbackForDoneReason("load");
    expect(decision.fallback).toBe(false);
    expect(decision.reason).toBe("none");
    expect(typeof decision.log).toBe("string");
    expect(decision.log!.length).toBeGreaterThan(0);
  });

  it("returns no fallback for doneReason undefined (backward compat)", async () => {
    const { shouldFallbackForDoneReason } = await import("../modelFallback");
    expect(shouldFallbackForDoneReason(undefined)).toEqual({ fallback: false, reason: "none" });
  });
});

describe("AgentRunResult.doneReason (D-04 additive)", () => {
  beforeEach(() => {
    streamLLMMock.mockClear();
    streamLLMQueue.length = 0;
    ragSearchExecute.mockClear();
  });

  it("doneReason is undefined when streamLLM doesn't return it (backward compat)", async () => {
    streamLLMQueue.push({
      content: "Direct answer to the user.",
      toolCall: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const { runAgent } = await import("../orchestrator");
    const result = await runAgent({
      workspaceId: "ws-char",
      userId: "u-char",
      message: "hi",
      chatId: "c-char",
    });

    expect(result.response).toBe("Direct answer to the user.");
    expect(result.doneReason).toBeUndefined();
  });

  it("doneReason is present when streamLLM returns it", async () => {
    streamLLMQueue.push({
      content: "Direct answer with doneReason.",
      toolCall: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      doneReason: "stop",
    });

    const { runAgent } = await import("../orchestrator");
    const result = await runAgent({
      workspaceId: "ws-char",
      userId: "u-char",
      message: "hi",
      chatId: "c-char",
    });

    expect(result.response).toBe("Direct answer with doneReason.");
    expect(result.doneReason).toBe("stop");
  });
});