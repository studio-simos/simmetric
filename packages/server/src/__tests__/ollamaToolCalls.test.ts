// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ollamaToolCalls contract tests — Phase 92-05 (OJ-02 native tools plumbing)
 *
 * Covers the additive native-tools path layered on the 92-02 streamOllama
 * adapter:
 *  - `normalizeNativeToolCalls`: ollama-js `ToolCall[]` → frozen dispatch
 *    `{ toolName, toolInput }[]` shape, each entry Zod-validated individually
 *    (fail loud with the entry index), array order preserved.
 *  - `streamLLM` (ollama branch): when the done chunk carries
 *    `message.tool_calls[]`, the result `toolCall` is the normalized first
 *    entry (dispatch-identical to the parseToolCall output shape); when no
 *    native tool_calls are present, the existing `parseToolCall(content)` L3
 *    fallback runs byte-identically.
 *  - `buildOllamaTools`: maps active skills (name+description only, no
 *    `parameters` key) to ollama-js `Tool[]`; empty input → `[]`.
 *  - Request shaping: `client.chat` receives a `tools` key ONLY when a
 *    non-empty tools array is threaded; absent/empty → no `tools` key at all.
 *  - Edge matrix: multi-tool ordering, UTF-8 fidelity, invalid-entry fail
 *    loud, empty/undefined tool_calls → L3 fallback, coexistence with the
 *    text-based parseToolCall path.
 *
 * Mock re-seam mirrors llmStreaming.test.ts (TDZ-safe jest.mock("ollama")
 * factory with the chat mock fn declared INSIDE, retrieved via require).
 */
import "./helpers/setupEnv";

// Mock env so getEnv() returns deterministic values for the streaming layer.
jest.mock("../config/env", () => ({
  getEnv: jest.fn().mockReturnValue({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    COLLECTOR_PORT: 3210,
    SERVER_URL: "http://localhost:3000",
    COLLECTOR_URL: "http://localhost:3210",
    LLM_PROVIDER: "ollama",
    LLM_MODEL: "gemma:latest",
    OLLAMA_BASE_URL: "http://ollama:11434",
    OLLAMA_MODEL: "gemma:latest",
    OPENAI_API_KEY: "sk-test",
    ANTHROPIC_API_KEY: "sk-test",
    LLM_API_KEY: "",
    LLM_TIMEOUT: 5000,
    OLLAMA_KEEP_ALIVE: "10m",
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
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock axios — untouched by this plan but required for module load.
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn() },
  AxiosError: class AxiosError extends Error {
    response?: { status: number };
    code?: string;
  },
}));

// Mock the ollama module — TDZ-safe factory (mock fn INSIDE, retrieved via
// require("ollama")). Every constructed instance shares this one chat mock.
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

import {
  streamLLM,
  normalizeNativeToolCalls,
  buildOllamaTools,
  type ChatMessageEntry,
} from "../agent/llmStreaming";
import { nativeToolCallSchema } from "@simmetric-chat/shared";
import type { ProviderConfig } from "@simmetric-chat/shared";

// Build a fake ollama-js chat stream: an async generator mirroring the
// AbortableAsyncIterator's for-await surface (yields chunks, may throw).
async function* fakeChatStream(parts: unknown[]): AsyncGenerator<unknown, void, unknown> {
  for (const p of parts) yield p;
}

const ollamaConfig: ProviderConfig = {
  type: "ollama",
  baseUrl: "http://ollama:11434",
  model: "gemma:latest",
  apiKey: null,
  temperature: 0.7,
  maxTokens: 2048,
  isLocal: true,
} as unknown as ProviderConfig;

const ollamaContext: ChatMessageEntry[] = [{ role: "user", content: "Hello" }];

// ---------------------------------------------------------------------------
// Schema (D-05)
// ---------------------------------------------------------------------------

describe("nativeToolCallSchema (D-05)", () => {
  it("parses a valid { toolName, toolInput } entry", () => {
    const parsed = nativeToolCallSchema.safeParse({
      toolName: "rag_search",
      toolInput: { query: "x" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty toolName", () => {
    const parsed = nativeToolCallSchema.safeParse({ toolName: "", toolInput: {} });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-object toolInput (string)", () => {
    const parsed = nativeToolCallSchema.safeParse({ toolName: "t", toolInput: "not-an-object" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-object toolInput (array)", () => {
    const parsed = nativeToolCallSchema.safeParse({ toolName: "t", toolInput: ["a"] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-object toolInput (number)", () => {
    const parsed = nativeToolCallSchema.safeParse({ toolName: "t", toolInput: 42 });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing toolInput", () => {
    const parsed = nativeToolCallSchema.safeParse({ toolName: "t" });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeNativeToolCalls
// ---------------------------------------------------------------------------

describe("normalizeNativeToolCalls", () => {
  it("maps ollama-js { function: { name, arguments } } → { toolName, toolInput }", () => {
    const out = normalizeNativeToolCalls([
      { function: { name: "rag_search", arguments: { query: "hello" } } },
    ]);
    expect(out).toEqual([{ toolName: "rag_search", toolInput: { query: "hello" } }]);
  });

  it("treats null/undefined arguments as empty object {}", () => {
    const out = normalizeNativeToolCalls([
      { function: { name: "workspace_memory", arguments: null } },
      { function: { name: "wiki_query", arguments: undefined } },
    ]);
    expect(out).toEqual([
      { toolName: "workspace_memory", toolInput: {} },
      { toolName: "wiki_query", toolInput: {} },
    ]);
  });

  it("preserves array order for multiple entries (no sort/reorder)", () => {
    const input = [
      { function: { name: "rag_search", arguments: { q: 1 } } },
      { function: { name: "workspace_memory", arguments: { k: "v" } } },
      { function: { name: "wiki_query", arguments: { q: "z" } } },
    ];
    const out = normalizeNativeToolCalls(input);
    expect(out.map((o) => o.toolName)).toEqual([
      "rag_search",
      "workspace_memory",
      "wiki_query",
    ]);
  });

  it("throws loud with the entry index on invalid entry (empty name at index 1)", () => {
    expect(() =>
      normalizeNativeToolCalls([
        { function: { name: "rag_search", arguments: {} } },
        { function: { name: "", arguments: {} } },
      ]),
    ).toThrow(/index 1/);
  });

  it("throws loud when an entry is missing function", () => {
    expect(() => normalizeNativeToolCalls([{ not_function: true }])).toThrow(/index 0/);
  });

  it("throws loud when arguments is a non-object string", () => {
    expect(() =>
      normalizeNativeToolCalls([
        { function: { name: "rag_search", arguments: "not-an-object" } },
      ]),
    ).toThrow(/index 0/);
  });

  it("preserves UTF-8 in tool names and arguments (no re-serialization loss)", () => {
    const out = normalizeNativeToolCalls([
      {
        function: {
          name: "调用_ricerca",
          arguments: { q: "caffè ☕ 資料 🚀" },
        },
      },
    ]);
    expect(out[0]?.toolName).toBe("调用_ricerca");
    expect(out[0]?.toolInput).toEqual({ q: "caffè ☕ 資料 🚀" });
  });
});

// ---------------------------------------------------------------------------
// streamLLM ollama branch — native tool_calls consumption
// ---------------------------------------------------------------------------

describe("streamLLM ollama — native tool_calls consumption", () => {
  beforeEach(() => {
    mockOllamaChat.mockReset();
  });

  it("resolves toolCall from native message.tool_calls (dispatch-identical shape)", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "Let me search." } },
        {
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
          message: {
            tool_calls: [{ function: { name: "rag_search", arguments: { query: "hello" } } }],
          },
        },
      ]),
    );

    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    expect(result.toolCall).toEqual({
      toolName: "rag_search",
      toolInput: { query: "hello" },
    });
    expect(result.content).toBe("Let me search.");
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
  });

  it("L3 fallback unchanged when done chunk has NO tool_calls (text JSON tool call)", async () => {
    // The content carries an instructed-format JSON tool call; parseToolCall
    // must still resolve it because no native tool_calls are present.
    const contentWithToolCall = `{"tool": "rag_search", "input": {"query": "from-text"}}`;
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: contentWithToolCall } },
        { done: true, prompt_eval_count: 2, eval_count: 8 },
      ]),
    );

    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    expect(result.toolCall).toEqual({
      toolName: "rag_search",
      toolInput: { query: "from-text" },
    });
  });

  it("empty tool_calls array → L3 fallback decides (byte-for-byte L3 behavior)", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "just a plain answer" } },
        { done: true, prompt_eval_count: 1, eval_count: 2, message: { tool_calls: [] } },
      ]),
    );

    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    expect(result.toolCall).toBeNull();
    expect(result.content).toBe("just a plain answer");
  });

  it("undefined tool_calls → same as empty (L3 fallback)", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "answer" } },
        { done: true, prompt_eval_count: 1, eval_count: 1, message: {} },
      ]),
    );

    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    expect(result.toolCall).toBeNull();
  });

  it("coexistence: tools advertised AND model answers with text JSON tool call (no native tool_calls) → parseToolCall L3 resolves it", async () => {
    const contentWithToolCall = `{"tool": "rag_search", "input": {"query": "text-path"}}`;
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: contentWithToolCall } },
        { done: true, prompt_eval_count: 1, eval_count: 1 },
      ]),
    );

    const tools = buildOllamaTools([{ name: "rag_search", description: "Search the KB" }]);
    const result = await streamLLM(ollamaContext, ollamaConfig, () => {}, undefined, tools);
    expect(result.toolCall).toEqual({
      toolName: "rag_search",
      toolInput: { query: "text-path" },
    });
  });
});

// ---------------------------------------------------------------------------
// buildOllamaTools (request side)
// ---------------------------------------------------------------------------

describe("buildOllamaTools", () => {
  it("maps { name, description }[] 1:1 in order with no parameters key", () => {
    const tools = buildOllamaTools([
      { name: "rag_search", description: "Search the knowledge base" },
      { name: "workspace_memory", description: "Read/write workspace memory" },
    ]);
    expect(tools).toEqual([
      { type: "function", function: { name: "rag_search", description: "Search the knowledge base" } },
      { type: "function", function: { name: "workspace_memory", description: "Read/write workspace memory" } },
    ]);
    // No parameters key on any entry (builtins lack inputSchema; Phase 95 concern).
    for (const t of tools) {
      expect("parameters" in t.function).toBe(false);
    }
  });

  it("returns [] for empty input", () => {
    expect(buildOllamaTools([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Request shaping — tools key present ONLY when non-empty
// ---------------------------------------------------------------------------

describe("streamLLM ollama — request shaping (tools key)", () => {
  beforeEach(() => {
    mockOllamaChat.mockReset();
  });

  it("client.chat receives a tools key when a non-empty tools array is threaded", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([{ done: true, prompt_eval_count: 0, eval_count: 0 }]),
    );

    const tools = buildOllamaTools([{ name: "rag_search", description: "Search the KB" }]);
    await streamLLM(ollamaContext, ollamaConfig, () => {}, undefined, tools);

    const reqArg = mockOllamaChat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(reqArg).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(reqArg, "tools")).toBe(true);
    expect(Array.isArray(reqArg.tools)).toBe(true);
    expect((reqArg.tools as unknown[]).length).toBe(1);
  });

  it("client.chat request has NO tools key when tools is absent (5th param omitted)", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([{ done: true, prompt_eval_count: 0, eval_count: 0 }]),
    );

    await streamLLM(ollamaContext, ollamaConfig, () => {});

    const reqArg = mockOllamaChat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(reqArg).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(reqArg, "tools")).toBe(false);
  });

  it("client.chat request has NO tools key when tools is an empty array", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([{ done: true, prompt_eval_count: 0, eval_count: 0 }]),
    );

    await streamLLM(ollamaContext, ollamaConfig, () => {}, undefined, []);

    const reqArg = mockOllamaChat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(reqArg).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(reqArg, "tools")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 95 (D-04) — 3-level fallback chain (L1 valid → L2 invalid → L3 absent)
// ---------------------------------------------------------------------------

describe("streamLLM ollama — Phase 95 3-level fallback chain (D-04, Pitfall 2 guard)", () => {
  beforeEach(() => {
    mockOllamaChat.mockReset();
  });

  it("L2 fallback: invalid native tool_calls falls back to parseToolCall(content) — no throw (Pitfall 2 guard)", async () => {
    // The done chunk carries a Zod-invalid `message.tool_calls` entry
    // (arguments is a non-object string → normalizeNativeToolCalls throws),
    // AND the content carries a valid text JSON tool call. Phase 95 (D-04)
    // try/catch must fall through to parseToolCall(content) and recover the
    // text-encoded tool call. Pitfall 2: the catch must NEVER throw out of
    // the ReAct loop.
    const contentWithToolCall = `{"tool": "rag_search", "input": {"query": "x"}}`;
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: contentWithToolCall } },
        {
          done: true,
          prompt_eval_count: 2,
          eval_count: 4,
          message: {
            tool_calls: [
              { function: { name: "rag_search", arguments: "not-an-object" } },
            ],
          },
        },
      ]),
    );

    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    // L2 recovery: parseToolCall(content) resolved the text-encoded tool call.
    expect(result.toolCall).not.toBeNull();
    expect(result.toolCall?.toolName).toBe("rag_search");
    expect(result.toolCall?.toolInput.query).toBe("x");
    // No throw escaped the stream — the ReAct loop continues.
  });

  it("L1 short-circuit: valid native tool_calls wins (no double dispatch — Pitfall 5 guard)", async () => {
    // The done chunk carries a VALID native tool_call, AND the content
    // carries a DIFFERENT text JSON tool call. The native call MUST win
    // (L1 short-circuits) — the text path is NOT also dispatched (Pitfall 5:
    // double-dispatch guard).
    const contentWithDifferentToolCall = `{"tool": "workspace_memory", "input": {"key": "y"}}`;
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: contentWithDifferentToolCall } },
        {
          done: true,
          prompt_eval_count: 3,
          eval_count: 5,
          message: {
            tool_calls: [
              { function: { name: "rag_search", arguments: { query: "native-wins" } } },
            ],
          },
        },
      ]),
    );

    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    expect(result.toolCall).toEqual({
      toolName: "rag_search",
      toolInput: { query: "native-wins" },
    });
    // The text-encoded `workspace_memory` call was NOT dispatched — native
    // short-circuits before parseToolCall runs (Pitfall 5 double-dispatch).
    expect(result.toolCall?.toolName).not.toBe("workspace_memory");
  });
});