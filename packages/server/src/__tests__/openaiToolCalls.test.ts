// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * openaiToolCalls contract tests — Phase 95-02 (NTV-01 SC1/SC2 — OpenAI
 * native function-calling plumbing + dispatch)
 *
 * Covers the OpenAI-specific native-tools path layered on streamOpenAI:
 *  - `buildOpenAITools`: maps `{ name, description, inputSchema? }[]` → OpenAI
 *    tool shape `[{ type: "function", function: { name, description, parameters } }]`
 *    (`parameters` populated from `skill.inputSchema` when present — required
 *    for gpt-4o-mini to populate arguments, G-95-7 closure; falls back to
 *    `{ type: "object", properties: {} }` when absent). Empty input → `[]`.
 *  - `normalizeOpenAIToolCalls`: JSON.parses the OpenAI `arguments` JSON
 *    STRING before Zod validation (Pitfall 2 — OpenAI `arguments` is a JSON
 *    string, NOT an object like Ollama's). Throws loud with the entry index
 *    on JSON.parse failure OR Zod-invalid shape.
 *  - `streamOpenAI` `tools?` param (additive 6th param — byte-identical when
 *    absent/empty).
 *  - `parseSSEStream` OpenAI branch accumulates `delta.tool_calls[]` by
 *    `index` across chunks, concatenating `function.arguments` string
 *    FRAGMENTS (Pitfall 3 — multi-chunk accumulation).
 *  - 3-level fallback chain (D-04): L1 native valid → short-circuit / L2
 *    native invalid (JSON.parse OR Zod) → parseToolCall(content) / L3 no
 *    tool_calls → parseToolCall(content) (legacy).
 *
 * Mock seam mirrors llmStreaming.test.ts (TDZ-safe jest.mock("axios")
 * factory with mock fn declared INSIDE, retrieved via require). The OpenAI
 * SSE stream is emulated via `Readable`+`EventEmitter` data/end events.
 */
import "./helpers/setupEnv";

import { EventEmitter } from "events";
import type { Readable } from "stream";

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

// Mock axios — TDZ-safe factory (mock fn INSIDE, retrieved via require).
// Each test configures axios.post to return a controlled SSE stream.
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn() },
  AxiosError: class AxiosError extends Error {
    response?: { status: number };
    code?: string;
  },
}));
const mockAxiosPost = require("axios").default.post as jest.Mock;

// Mock the ollama module — required for module load (llmStreaming imports
// `type { Tool } from "ollama"`); not invoked in these tests.
jest.mock("ollama", () => {
  const chat = jest.fn();
  return {
    __esModule: true,
    Ollama: jest.fn(() => ({ chat })),
    default: { chat },
    __mockChat: chat,
  };
});

import {
  streamLLM,
  buildOpenAITools,
  buildProviderTools,
  normalizeOpenAIToolCalls,
  type ChatMessageEntry,
} from "../agent/llmStreaming";
import type { ProviderConfig } from "@simmetric-chat/shared";

// ---------------------------------------------------------------------------
// Test helpers — emulate an axios responseType:"stream" body via EventEmitter.
// ---------------------------------------------------------------------------

// Build a fake raw stream for the axios-based providers. parseSSEStream only
// uses `.on("data"/"end"/"error")` so a bare EventEmitter satisfies the
// NodeJS.ReadableStream contract.
function makeFakeStream(): Readable & EventEmitter {
  return new EventEmitter() as Readable & EventEmitter;
}

// Yield a microtask so streamLLM's `await axios.post(...)` resolves and
// parseSSEStream attaches its data/end/error listeners before we emit.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Emit one SSE event (`data: <json>\n\n`) on the fake stream.
function emitSSE(stream: Readable & EventEmitter, obj: unknown): void {
  stream.emit("data", Buffer.from(`data: ${JSON.stringify(obj)}\n\n`));
}

const openaiConfig: ProviderConfig = {
  type: "openai",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  apiKey: "sk-test",
  temperature: 0.7,
  maxTokens: 2048,
} as unknown as ProviderConfig;

const openaiContext: ChatMessageEntry[] = [{ role: "user", content: "Search for x" }];

// ---------------------------------------------------------------------------
// Test 1 + Test 2: buildOpenAITools shape
// ---------------------------------------------------------------------------

describe("buildOpenAITools", () => {
  it("produces OpenAI tool shape [{ type:'function', function:{ name, description, parameters } }]", () => {
    const tools = buildOpenAITools([{ name: "rag_search", description: "Search RAG" }]);
    expect(tools).toEqual([
      { type: "function", function: { name: "rag_search", description: "Search RAG", parameters: { type: "object", properties: {} } } },
    ]);
  });

  it("returns [] for empty input (byte-identical no-tools behavior)", () => {
    expect(buildOpenAITools([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests 3-6: normalizeOpenAIToolCalls (JSON string arguments — Pitfall 2)
// ---------------------------------------------------------------------------

describe("normalizeOpenAIToolCalls", () => {
  it("JSON.parses arguments string → { toolName, toolInput } (Pitfall 2 — OpenAI args is JSON string)", () => {
    const out = normalizeOpenAIToolCalls([
      { id: "call_abc", function: { name: "rag_search", arguments: '{"query":"x"}' } },
    ]);
    expect(out).toEqual([{ toolName: "rag_search", toolInput: { query: "x" } }]);
  });

  it("throws on invalid JSON arguments string (JSON.parse failure)", () => {
    expect(() =>
      normalizeOpenAIToolCalls([
        { function: { name: "rag_search", arguments: "not-json" } },
      ]),
    ).toThrow(/index 0: arguments JSON.parse failed/);
  });

  it("throws on Zod-invalid entry (missing toolName)", () => {
    expect(() =>
      normalizeOpenAIToolCalls([{ function: { arguments: "{}" } }]),
    ).toThrow(/index 0/);
  });

  it("handles empty arguments string → toolInput {} (JSON.parse('{}') fallback)", () => {
    const out = normalizeOpenAIToolCalls([
      { function: { name: "workspace_memory", arguments: "" } },
    ]);
    expect(out).toEqual([{ toolName: "workspace_memory", toolInput: {} }]);
  });
});

// ---------------------------------------------------------------------------
// buildProviderTools dispatcher — openai/openrouter returns buildOpenAITools
// ---------------------------------------------------------------------------

describe("buildProviderTools — openai/openrouter dispatch", () => {
  it("returns buildOpenAITools(skills) for 'openai'", () => {
    const tools = buildProviderTools("openai", [
      { name: "rag_search", description: "Search the KB" },
    ]);
    expect(tools).toEqual([
      { type: "function", function: { name: "rag_search", description: "Search the KB", parameters: { type: "object", properties: {} } } },
    ]);
  });

  it("returns buildOpenAITools(skills) for 'openrouter'", () => {
    const tools = buildProviderTools("openrouter", [
      { name: "rag_search", description: "Search the KB" },
    ]);
    expect(tools).toEqual([
      { type: "function", function: { name: "rag_search", description: "Search the KB", parameters: { type: "object", properties: {} } } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 95-05 (G-95-7 closure): inputSchema-present case — buildOpenAITools
// threads skill.inputSchema into function.parameters so gpt-4o-mini can
// populate native tool arguments instead of emitting empty {}.
// ---------------------------------------------------------------------------

describe("buildOpenAITools — inputSchema threading (G-95-7)", () => {
  it("includes function.parameters from skill.inputSchema when present", () => {
    const inputSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const tools = buildOpenAITools([
      { name: "rag_search", description: "Search RAG", inputSchema },
    ]);
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "rag_search",
          description: "Search RAG",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
    ]);
  });

  it("buildProviderTools threads inputSchema for 'openai'", () => {
    const inputSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const tools = buildProviderTools("openai", [
      { name: "rag_search", description: "x", inputSchema },
    ]);
    expect(tools).toBeDefined();
    expect(Array.isArray(tools)).toBe(true);
    const first = (tools as Array<{ function: { parameters: Record<string, unknown> } }>)[0];
    expect(first).toBeDefined();
    expect(first!.function.parameters).toEqual(inputSchema);
  });
});

// ---------------------------------------------------------------------------
// Tests 7-10: streamOpenAI streaming accumulation + fallback chain
// ---------------------------------------------------------------------------

describe("streamLLM openai — native tool_calls streaming + fallback chain", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  it("Test 7: accumulates delta.tool_calls fragments across chunks (Pitfall 3) and resolves normalized[0]", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(openaiContext, openaiConfig, () => {});
    await tick();
    // Chunk (a): first fragment of arguments + id + name
    emitSSE(stream, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "rag_search", arguments: '{"qu' },
              },
            ],
          },
        },
      ],
    });
    // Chunk (b): second fragment of arguments (concat by index)
    emitSSE(stream, {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"x"}' } }] } },
      ],
    });
    // Chunk (c): finish_reason: tool_calls (Phase 94 D-04 maps to doneReason: stop)
    emitSSE(stream, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    const result = await promise;
    expect(result.toolCall).toEqual({
      toolName: "rag_search",
      toolInput: { query: "x" },
    });
    // Phase 94 D-04: finish_reason "tool_calls" → doneReason "stop".
    expect(result.doneReason).toBe("stop");
  });

  it("Test 8: L2 fallback — JSON.parse failure on arguments falls back to parseToolCall(content)", async () => {
    // Native tool_calls arrive with malformed JSON arguments, AND the content
    // carries a text-encoded tool call. Phase 95 (D-04) try/catch must fall
    // through to parseToolCall(content) and recover the text-encoded call.
    const contentWithToolCall = `{"tool": "rag_search", "input": {"query": "y"}}`;
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(openaiContext, openaiConfig, () => {});
    await tick();
    emitSSE(stream, { choices: [{ delta: { content: contentWithToolCall } }] });
    emitSSE(stream, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: "rag_search", arguments: "not-json" } }],
          },
        },
      ],
    });
    stream.emit("end");
    const result = await promise;
    expect(result.toolCall).not.toBeNull();
    expect(result.toolCall?.toolName).toBe("rag_search");
    expect(result.toolCall?.toolInput.query).toBe("y");
  });

  it("Test 9: L3 fallback — NO delta.tool_calls + content text JSON tool call → parseToolCall resolves (legacy)", async () => {
    const contentWithToolCall = `{"tool": "rag_search", "input": {"query": "z"}}`;
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(openaiContext, openaiConfig, () => {});
    await tick();
    emitSSE(stream, { choices: [{ delta: { content: contentWithToolCall } }] });
    stream.emit("end");
    const result = await promise;
    expect(result.toolCall).toEqual({
      toolName: "rag_search",
      toolInput: { query: "z" },
    });
  });

  it("Test 10: no tools param → byte-identical existing behavior (content only, parseToolCall L3)", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(openaiContext, openaiConfig, () => {});
    await tick();
    emitSSE(stream, { choices: [{ delta: { content: "just a plain answer" } }] });
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    const result = await promise;
    expect(result.toolCall).toBeNull();
    expect(result.content).toBe("just a plain answer");
  });
});

// ---------------------------------------------------------------------------
// Request shaping — tools key spread into axios.post body (D-08)
// ---------------------------------------------------------------------------

describe("streamLLM openai — request shaping (tools key)", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  it("axios.post body includes a `tools` key when non-empty tools array is threaded", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const tools = buildOpenAITools([{ name: "rag_search", description: "Search the KB" }]);
    const promise = streamLLM(openaiContext, openaiConfig, () => {}, undefined, tools);
    await tick();
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    await promise;
    const reqBody = mockAxiosPost.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(reqBody).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(reqBody, "tools")).toBe(true);
    expect(Array.isArray(reqBody.tools)).toBe(true);
    expect((reqBody.tools as unknown[]).length).toBe(1);
  });

  it("axios.post body has NO `tools` key when tools is absent (byte-identical no-tools)", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(openaiContext, openaiConfig, () => {});
    await tick();
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    await promise;
    const reqBody = mockAxiosPost.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(reqBody).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(reqBody, "tools")).toBe(false);
  });

  it("axios.post body has NO `tools` key when tools is an empty array", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(openaiContext, openaiConfig, () => {}, undefined, []);
    await tick();
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    await promise;
    const reqBody = mockAxiosPost.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(reqBody).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(reqBody, "tools")).toBe(false);
  });
});