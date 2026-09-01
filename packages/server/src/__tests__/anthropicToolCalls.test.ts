// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * anthropicToolCalls contract tests — Phase 95-03 (NTV-01 SC1/SC2 — Anthropic
 * native function-calling plumbing + dispatch)
 *
 * Covers the Anthropic-specific native-tools path layered on streamAnthropic:
 *  - `buildAnthropicTools`: maps `{ name, description }[]` → Anthropic tool
 *    shape `[{ name, description, input_schema: { type: "object", properties:
 *    {} } }]` (the `input_schema` with `type: "object"` is REQUIRED by the
 *    Anthropic API — unlike OpenAI which accepts tools without parameters).
 *    Empty input → `[]`.
 *  - `normalizeAnthropicToolCalls`: JSON.parses the accumulated `inputJson`
 *    STRING (built from `partial_json` fragments across chunks — Pitfall 4)
 *    before Zod validation. Anthropic's `content_block_start.input` is an
 *    empty `{}` placeholder (Pitfall 4 — NOT the actual input). Throws loud
 *    with the entry index on `JSON.parse` failure OR Zod-invalid shape.
 *  - `streamAnthropic` `tools?` param (additive 6th param — byte-identical
 *    when absent/empty).
 *  - `parseSSEStream` Anthropic branch accumulates `content_block_start`
 *    (type `tool_use`) + `content_block_delta` (type `input_json_delta`,
 *    `partial_json` string fragments) by `content_block_index`
 *    (Pitfall 4 — multi-chunk accumulation). Field names verified via
 *    Context7: `delta.type === "input_json_delta"`, `delta.partial_json`
 *    (string).
 *  - 3-level fallback chain (D-04): L1 native valid → short-circuit / L2
 *    native invalid (JSON.parse OR Zod) → parseToolCall(content) / L3 no
 *    tool_use blocks → parseToolCall(content) (legacy).
 *
 * Mock seam mirrors openaiToolCalls.test.ts (TDZ-safe jest.mock("axios")
 * factory with mock fn declared INSIDE, retrieved via require). The Anthropic
 * SSE stream is emulated via `Readable`+`EventEmitter` data/end events. The
 * Anthropic SSE protocol uses typed `event:` lines followed by `data:` lines;
 * parseSSEStream skips `event:` lines (line ~1341).
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
  buildAnthropicTools,
  buildProviderTools,
  normalizeAnthropicToolCalls,
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

// Anthropic SSE has typed `event:` lines followed by `data:` lines.
// parseSSEStream skips `event:` lines (line ~1341). We include both for
// fidelity with the real wire format.
function emitAnthropicSSE(
  stream: Readable & EventEmitter,
  eventType: string,
  obj: unknown,
): void {
  stream.emit("data", Buffer.from(`event: ${eventType}\ndata: ${JSON.stringify(obj)}\n\n`));
}

const anthropicConfig: ProviderConfig = {
  type: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "claude-3-5-sonnet",
  apiKey: "sk-test",
  temperature: 0.7,
  maxTokens: 2048,
} as unknown as ProviderConfig;

const anthropicContext: ChatMessageEntry[] = [{ role: "user", content: "Search for x" }];

// ---------------------------------------------------------------------------
// Test 1 + Test 2: buildAnthropicTools shape
// ---------------------------------------------------------------------------

describe("buildAnthropicTools", () => {
  it("produces Anthropic tool shape [{ name, description, input_schema: { type:'object', properties:{} } }]", () => {
    const tools = buildAnthropicTools([{ name: "rag_search", description: "Search RAG" }]);
    expect(tools).toEqual([
      {
        name: "rag_search",
        description: "Search RAG",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("returns [] for empty input (byte-identical no-tools behavior)", () => {
    expect(buildAnthropicTools([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests 3-6: normalizeAnthropicToolCalls (accumulated inputJson string — Pitfall 4)
// ---------------------------------------------------------------------------

describe("normalizeAnthropicToolCalls", () => {
  it("Test 3: JSON.parses accumulated inputJson string → { toolName, toolInput } (Pitfall 4 — partial_json fragments)", () => {
    const out = normalizeAnthropicToolCalls([
      { id: "toolu_abc", name: "rag_search", inputJson: '{"query":"x"}' },
    ]);
    expect(out).toEqual([{ toolName: "rag_search", toolInput: { query: "x" } }]);
  });

  it("Test 4: throws on invalid JSON inputJson (JSON.parse failure)", () => {
    expect(() =>
      normalizeAnthropicToolCalls([{ name: "rag_search", inputJson: "not-json" }]),
    ).toThrow(/index 0: input JSON.parse failed/);
  });

  it("Test 5: throws on Zod-invalid entry (missing name)", () => {
    expect(() => normalizeAnthropicToolCalls([{ inputJson: "{}" }])).toThrow(/index 0/);
  });

  it("Test 6: handles empty inputJson string → toolInput {} (JSON.parse('{}') fallback)", () => {
    const out = normalizeAnthropicToolCalls([
      { name: "workspace_memory", inputJson: "" },
    ]);
    expect(out).toEqual([{ toolName: "workspace_memory", toolInput: {} }]);
  });
});

// ---------------------------------------------------------------------------
// buildProviderTools dispatcher — anthropic returns buildAnthropicTools
// ---------------------------------------------------------------------------

describe("buildProviderTools — anthropic dispatch", () => {
  it("returns buildAnthropicTools(skills) for 'anthropic'", () => {
    const tools = buildProviderTools("anthropic", [
      { name: "rag_search", description: "Search the KB" },
    ]);
    expect(tools).toEqual([
      {
        name: "rag_search",
        description: "Search the KB",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 95-05 (G-95-8 closure): inputSchema-present case — buildAnthropicTools
// populates input_schema.properties + required from skill.inputSchema so
// claude-sonnet-4-5 can populate native tool arguments instead of emitting
// empty {}.
// ---------------------------------------------------------------------------

describe("buildAnthropicTools — inputSchema threading (G-95-8)", () => {
  it("populates input_schema.properties + required from skill.inputSchema when present", () => {
    const inputSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const tools = buildAnthropicTools([
      { name: "rag_search", description: "Search RAG", inputSchema },
    ]);
    expect(tools).toEqual([
      {
        name: "rag_search",
        description: "Search RAG",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    ]);
  });

  it("buildProviderTools threads inputSchema for 'anthropic'", () => {
    const inputSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const tools = buildProviderTools("anthropic", [
      { name: "rag_search", description: "x", inputSchema },
    ]);
    expect(tools).toBeDefined();
    expect(Array.isArray(tools)).toBe(true);
    const first = (tools as Array<{ input_schema: Record<string, unknown> }>)[0];
    expect(first).toBeDefined();
    expect(first!.input_schema).toEqual(inputSchema);
  });
});

// ---------------------------------------------------------------------------
// Tests 7-10: streamAnthropic streaming accumulation + fallback chain
// ---------------------------------------------------------------------------

describe("streamLLM anthropic — native tool_use streaming + fallback chain", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  it("Test 7: accumulates content_block_delta(input_json_delta, partial_json) fragments by index (Pitfall 4) and resolves normalized[0]", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(anthropicContext, anthropicConfig, () => {});
    await tick();
    // (a) content_block_start at index 0 — tool_use block with empty input {}
    // placeholder (Pitfall 4 — the actual input arrives via partial_json
    // fragments in content_block_delta below, NOT here).
    emitAnthropicSSE(stream, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "rag_search", input: {} },
    });
    // (b) content_block_delta — first partial_json fragment at index 0
    emitAnthropicSSE(stream, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"qu' },
    });
    // (c) content_block_delta — second partial_json fragment at index 0
    // (concatenated to the first by index — Pitfall 4).
    emitAnthropicSSE(stream, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'ery":"x"}' },
    });
    // (d) content_block_stop at index 0
    emitAnthropicSSE(stream, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    // (e) message_delta with stop_reason: tool_use (Phase 94 D-04 maps to
    // doneReason: stop).
    emitAnthropicSSE(stream, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    });
    stream.emit("end");
    const result = await promise;
    expect(result.toolCall).toEqual({
      toolName: "rag_search",
      toolInput: { query: "x" },
    });
    // Phase 94 D-04: stop_reason "tool_use" → doneReason "stop".
    expect(result.doneReason).toBe("stop");
  });

  it("Test 8: L2 fallback — JSON.parse failure on partial_json fragments falls back to parseToolCall(content)", async () => {
    // Native tool_use arrives with malformed partial_json fragments, AND the
    // content carries a text-encoded tool call. Phase 95 (D-04) try/catch
    // must fall through to parseToolCall(content) and recover the
    // text-encoded call.
    const contentWithToolCall = `{"tool": "rag_search", "input": {"query": "y"}}`;
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(anthropicContext, anthropicConfig, () => {});
    await tick();
    // Content text delta carries the text-encoded tool call (L2 fallback
    // source — parseToolCall reads from `content`).
    emitAnthropicSSE(stream, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: contentWithToolCall },
    });
    // Tool_use block with malformed partial_json (JSON.parse fails at stream
    // end → L2 fallback fires).
    emitAnthropicSSE(stream, "content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_2", name: "rag_search", input: {} },
    });
    emitAnthropicSSE(stream, "content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "not-json" },
    });
    emitAnthropicSSE(stream, "content_block_stop", {
      type: "content_block_stop",
      index: 1,
    });
    stream.emit("end");
    const result = await promise;
    expect(result.toolCall).not.toBeNull();
    expect(result.toolCall?.toolName).toBe("rag_search");
    expect(result.toolCall?.toolInput.query).toBe("y");
  });

  it("Test 9: L3 fallback — NO tool_use blocks + content text JSON tool call → parseToolCall resolves (legacy)", async () => {
    const contentWithToolCall = `{"tool": "rag_search", "input": {"query": "z"}}`;
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(anthropicContext, anthropicConfig, () => {});
    await tick();
    emitAnthropicSSE(stream, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: contentWithToolCall },
    });
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
    const promise = streamLLM(anthropicContext, anthropicConfig, () => {});
    await tick();
    emitAnthropicSSE(stream, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "just a plain answer" },
    });
    stream.emit("end");
    const result = await promise;
    expect(result.toolCall).toBeNull();
    expect(result.content).toBe("just a plain answer");
  });
});

// ---------------------------------------------------------------------------
// Request shaping — tools key spread into axios.post body (D-08)
// ---------------------------------------------------------------------------

describe("streamLLM anthropic — request shaping (tools key)", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  it("axios.post body includes a `tools` key when non-empty tools array is threaded", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const tools = buildAnthropicTools([{ name: "rag_search", description: "Search the KB" }]);
    const promise = streamLLM(anthropicContext, anthropicConfig, () => {}, undefined, tools);
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
    const promise = streamLLM(anthropicContext, anthropicConfig, () => {});
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
    const promise = streamLLM(anthropicContext, anthropicConfig, () => {}, undefined, []);
    await tick();
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    await promise;
    const reqBody = mockAxiosPost.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(reqBody).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(reqBody, "tools")).toBe(false);
  });
});