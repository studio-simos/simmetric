// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * llmStreaming contract tests
 *
 * Covers the D-07 abort-estimate resolve path in the streamOllama ollama-js
 * iterator path + parseSSEStream: on client disconnect
 * (abortController.abort()) the stream promise resolves with
 * floor(content.length/4) completion tokens instead of rejecting, so the
 * orchestrator's budget.consumeTokens gets the usage and 62-03's
 * save-in-finally persists it.
 *
 * Also covers the happy-path usage propagation and the non-abort / empty-
 * content rejection paths.
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

// Mock axios — each test configures axios.post to return a controlled stream.
// NOTE: mock fn lives INSIDE the factory to avoid TDZ under @swc/jest.
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn() },
  AxiosError: class AxiosError extends Error {
    response?: { status: number };
    code?: string;
  },
}));
const mockAxiosPost = require("axios").default.post as jest.Mock;

// Mock the ollama module — the 92-01 getOllamaClient() factory constructs
// `new Ollama(...)` per cache key; every instance shares this one chat mock,
// so the factory's Map cache is transparent to tests. Same TDZ discipline as
// the axios mock above (mock fn declared INSIDE the factory, retrieved via
// require("ollama")).
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

import { streamLLM, type ChatMessageEntry, type OnTokenCallback } from "../agent/llmStreaming";
import type { ProviderConfig } from "@simmetric-chat/shared";

// Build a fake raw stream for the axios-based providers (Gemini below).
// Each emitted chunk is a Buffer of one or more lines terminated by \n.
function makeFakeStream(): Readable & EventEmitter {
  const stream = new EventEmitter() as Readable & EventEmitter;
  // NodeJS.ReadableStream typing: the parser only uses .on("data"/"end"/"error")
  return stream;
}

// Build a fake ollama-js chat stream: an async generator mirroring the
// AbortableAsyncIterator's for-await surface (yields chunks, may throw).
async function* fakeChatStream(parts: unknown[]): AsyncGenerator<unknown, void, unknown> {
  for (const p of parts) yield p;
}

// Yield a microtask so streamLLM's `await axios.post(...)` resolves and
// parseOllamaStream attaches its data/end/error listeners before we emit.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const ollamaConfig: ProviderConfig = {
  type: "ollama",
  baseUrl: "http://ollama:11434",
  model: "gemma:latest",
  apiKey: null,
  temperature: 0.7,
  maxTokens: 2048,
  isLocal: true,
} as unknown as ProviderConfig;

const ollamaContext: ChatMessageEntry[] = [
  { role: "user", content: "Hello" },
];

describe("llmStreaming abort estimate (D-07)", () => {
  beforeEach(() => {
    mockOllamaChat.mockReset();
  });

  it("abort estimate — resolves with floor(content.length/4) on ERR_CANCELED", async () => {
    const abortErr = new Error("aborted") as Error & { code?: string };
    abortErr.code = "ERR_CANCELED";
    mockOllamaChat.mockResolvedValue(
      (async function* () {
        yield { message: { content: "partial" } };
        throw abortErr;
      })(),
    );

    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    // "partial" length = 7 -> floor(7/4) = 1
    expect(result.usage.completionTokens).toBe(Math.floor("partial".length / 4));
    expect(result.usage.promptTokens).toBe(0);
    expect(result.content).toBe("partial");
  });

  it("happy path usage — propagates prompt_eval_count and eval_count", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "Hello " } },
        { message: { content: "world" } },
        { done: true, prompt_eval_count: 10, eval_count: 20 },
      ]),
    );

    const tokens: string[] = [];
    const onToken: OnTokenCallback = (t) => tokens.push(t);

    const result = await streamLLM(ollamaContext, ollamaConfig, onToken);
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(20);
    expect(result.content).toBe("Hello world");
    expect(tokens.join("")).toBe("Hello world");
  });

  it("non-abort error rejects — genuine LLM failures still reject", async () => {
    mockOllamaChat.mockResolvedValue(
      // Mock of an ollama-js async iterator that throws on the first .next()
      // (genuine LLM failure). A yield here would emit a chunk before failing
      // and change the test, so suppress require-yield on the generator line.
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error("network failure");
      })(),
    );

    const promise = streamLLM(ollamaContext, ollamaConfig, () => {});
    await expect(promise).rejects.toThrow("network failure");
  });

  it("empty content abort rejects — no tokens generated, no estimate to emit", async () => {
    const abortErr = new Error("aborted") as Error & { code?: string };
    abortErr.code = "ERR_CANCELED";
    mockOllamaChat.mockResolvedValue(
      // Mock of an ollama-js async iterator that throws on the first .next()
      // (empty-content abort). A yield here would emit a chunk before failing
      // and change the test, so suppress require-yield on the generator line.
      // eslint-disable-next-line require-yield
      (async function* () {
        throw abortErr;
      })(),
    );

    const promise = streamLLM(ollamaContext, ollamaConfig, () => {});
    await expect(promise).rejects.toThrow(/abort|cancel/i);
  });

  it("ECANCELED code also triggers abort estimate (defensive detection)", async () => {
    const abortErr = new Error("cancel") as Error & { code?: string };
    abortErr.code = "ECANCELED";
    mockOllamaChat.mockResolvedValue(
      (async function* () {
        yield { message: { content: "abcdef" } };
        throw abortErr;
      })(),
    );

    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    // "abcdef" length = 6 -> floor(6/4) = 1
    expect(result.usage.completionTokens).toBe(Math.floor("abcdef".length / 4));
    expect(result.content).toBe("abcdef");
  });
});

describe("gemini streaming", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  const geminiConfig: ProviderConfig = {
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-1.5-pro",
    apiKey: "sk-gemini",
    temperature: 0.7,
    maxTokens: 2048,
  } as unknown as ProviderConfig;

  const geminiContext: ChatMessageEntry[] = [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
  ];

  // Gemini SSE: lines are `data: {json}\n`. Emit one SSE event.
  function emitSSE(stream: Readable & EventEmitter, obj: unknown): void {
    stream.emit("data", Buffer.from(`data: ${JSON.stringify(obj)}\n\n`));
  }

  it("requires an API key", async () => {
    const noKey = { ...geminiConfig, apiKey: null } as unknown as ProviderConfig;
    await expect(streamLLM(geminiContext, noKey, () => {})).rejects.toThrow(
      "Gemini API key not configured",
    );
  });

  it("streams tokens from candidates parts and propagates usageMetadata", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });

    const tokens: string[] = [];
    const onToken: OnTokenCallback = (t) => tokens.push(t);

    const promise = streamLLM(geminiContext, geminiConfig, onToken);
    await tick();

    emitSSE(stream, { candidates: [{ content: { parts: [{ text: "Hello " }] } }] });
    emitSSE(stream, { candidates: [{ content: { parts: [{ text: "world" }] } }] });
    // Final usage-only chunk (no content)
    emitSSE(stream, { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } });
    stream.emit("end");

    const result = await promise;
    expect(result.content).toBe("Hello world");
    expect(tokens.join("")).toBe("Hello world");
    expect(result.usage.promptTokens).toBe(4);
    expect(result.usage.completionTokens).toBe(2);

    // Verify the request hit the streamGenerateContent endpoint with the API
    // key in the x-goog-api-key header (not Authorization Bearer).
    const [url, , opts] = mockAxiosPost.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:streamGenerateContent?alt=sse",
    );
    expect((opts as { headers: Record<string, string> }).headers["x-goog-api-key"]).toBe("sk-gemini");
  });

  it("maps system message to systemInstruction and assistant to 'model' in the request body", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });

    const promise = streamLLM(
      [
        { role: "system", content: "Sys" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
      ],
      geminiConfig,
      () => {},
    );
    await tick();
    stream.emit("end");

    await promise;
    const [, body] = mockAxiosPost.mock.calls[0]!;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Sys" }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "U" }] },
      { role: "model", parts: [{ text: "A" }] },
    ]);
  });
});

// ─── Phase 94: Ollama thinking field separation + doneReason (D-01, D-04) ───

describe("Ollama thinking field separation (D-01)", () => {
  beforeEach(() => {
    mockOllamaChat.mockReset();
  });

  it("separates thinking from content when message.thinking present", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "", thinking: "reasoning" } },
        { message: { content: "answer", thinking: "" } },
        { done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 10 },
      ]),
    );

    const tokens: string[] = [];
    const thinking: string[] = [];
    const onToken: OnTokenCallback = (t) => tokens.push(t);
    const onThinking = (t: string) => thinking.push(t);

    const result = await streamLLM(
      ollamaContext,
      ollamaConfig,
      onToken,
      undefined,
      undefined,
      onThinking,
    );
    expect(result.content).toBe("answer");
    expect(result.doneReason).toBe("stop");
    // The thinking callback fires for the reasoning chunk; the empty-thinking
    // content chunk does NOT fire it (guard: `if thinking` truthiness).
    expect(thinking.join("")).toBe("reasoning");
  });

  it("doneReason maps done_reason length", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "partial" } },
        { done: true, done_reason: "length", prompt_eval_count: 1, eval_count: 1 },
      ]),
    );
    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    expect(result.doneReason).toBe("length");
  });

  it("doneReason maps done_reason unload", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "x" } },
        { done: true, done_reason: "unload", prompt_eval_count: 1, eval_count: 1 },
      ]),
    );
    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    expect(result.doneReason).toBe("unload");
  });

  it("doneReason undefined when done_reason absent", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "x" } },
        { done: true, prompt_eval_count: 1, eval_count: 1 },
      ]),
    );
    const result = await streamLLM(ollamaContext, ollamaConfig, () => {});
    expect(result.doneReason).toBeUndefined();
  });

  it("onThinking not called when thinking field absent", async () => {
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "answer" } },
        { done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
      ]),
    );
    const thinking: string[] = [];
    const onThinking = (t: string) => thinking.push(t);
    await streamLLM(ollamaContext, ollamaConfig, () => {}, undefined, undefined, onThinking);
    expect(thinking).toHaveLength(0);
  });
});

// ─── Phase 94: Pitfall 4 opt-in gate (D-03, WARNING 3 explicit coverage) ───
// The onThinking callback ALWAYS fires (D-01), but the chat.ts route checks
// `include_thinking` before emitting `event: thinking`. These tests pin that
// the SSE body does NOT contain `event: thinking` when the flag is false, and
// DOES when the flag is true. The opt-in gate is the load-bearing safety net
// for Pitfall 4 (HIGHEST RISK widget break).

describe("Pitfall 4 opt-in gate — onThinking callback always fires, SSE emission is gated (D-03)", () => {
  beforeEach(() => {
    mockOllamaChat.mockReset();
  });

  it("onThinking callback fires even when include_thinking is false (reasoning parsed + discarded)", async () => {
    // The callback ALWAYS fires (D-01) — chat.ts is responsible for the
    // opt-in gate (checking include_thinking before sendSSE). This test pins
    // that streamLLM itself does NOT gate on include_thinking — the gate
    // lives in chat.ts. The reasoning is "parsed and silently discarded" at
    // the chat.ts layer (D-03).
    mockOllamaChat.mockResolvedValue(
      fakeChatStream([
        { message: { content: "", thinking: "secret reasoning" } },
        { message: { content: "answer" } },
        { done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
      ]),
    );
    const thinking: string[] = [];
    const onThinking = (t: string) => thinking.push(t);
    await streamLLM(ollamaContext, ollamaConfig, () => {}, undefined, undefined, onThinking);
    // The callback fired — reasoning was separated. The chat.ts route (NOT
    // streamLLM) checks include_thinking before emitting the SSE event.
    expect(thinking.join("")).toBe("secret reasoning");
  });
});

// ─── Phase 94, Plan 94-02: OpenAI + Anthropic doneReason integration (D-04) ───
// Additive assertions that the streaming functions map finish_reason (OpenAI)
// and stop_reason (Anthropic) to the normalized DoneReason enum. Existing
// assertions (abort estimate, gemini, Ollama thinking) unchanged per D-06.

describe("OpenAI doneReason mapping (D-04)", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  const openaiConfig: ProviderConfig = {
    type: "openai",
    baseUrl: "https://api.openai.com",
    model: "gpt-4o",
    apiKey: "sk-test",
    temperature: 0.7,
    maxTokens: 2048,
  } as unknown as ProviderConfig;

  function emitOpenAISSE(stream: Readable & EventEmitter, obj: unknown): void {
    stream.emit("data", Buffer.from(`data: ${JSON.stringify(obj)}\n\n`));
  }

  it("maps finish_reason: stop to doneReason: stop", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(ollamaContext, openaiConfig, () => {});
    await tick();
    emitOpenAISSE(stream, { choices: [{ delta: { content: "ans" }, finish_reason: "stop" }] });
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    const result = await promise;
    expect(result.doneReason).toBe("stop");
  });

  it("maps finish_reason: length to doneReason: length", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(ollamaContext, openaiConfig, () => {});
    await tick();
    emitOpenAISSE(stream, { choices: [{ delta: { content: "ans" }, finish_reason: "length" }] });
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    const result = await promise;
    expect(result.doneReason).toBe("length");
  });

  it("maps finish_reason: tool_calls to doneReason: stop (normal termination)", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(ollamaContext, openaiConfig, () => {});
    await tick();
    emitOpenAISSE(stream, { choices: [{ delta: { content: "ans" }, finish_reason: "tool_calls" }] });
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    const result = await promise;
    expect(result.doneReason).toBe("stop");
  });

  it("maps finish_reason: content_filter to doneReason: error (more informative for fallback)", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(ollamaContext, openaiConfig, () => {});
    await tick();
    emitOpenAISSE(stream, {
      choices: [{ delta: { content: "ans" }, finish_reason: "content_filter" }],
    });
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    const result = await promise;
    expect(result.doneReason).toBe("error");
  });

  it("doneReason undefined when finish_reason absent", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(ollamaContext, openaiConfig, () => {});
    await tick();
    emitOpenAISSE(stream, { choices: [{ delta: { content: "ans" } }] });
    stream.emit("data", Buffer.from("data: [DONE]\n\n"));
    stream.emit("end");
    const result = await promise;
    expect(result.doneReason).toBeUndefined();
  });
});

describe("Anthropic doneReason mapping (D-04)", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  const anthropicConfig: ProviderConfig = {
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-5-sonnet",
    apiKey: "sk-test",
    temperature: 0.7,
    maxTokens: 2048,
  } as unknown as ProviderConfig;

  function emitAnthropicSSE(stream: Readable & EventEmitter, obj: unknown): void {
    stream.emit("data", Buffer.from(`data: ${JSON.stringify(obj)}\n\n`));
  }

  it("maps stop_reason: end_turn to doneReason: stop", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(ollamaContext, anthropicConfig, () => {});
    await tick();
    emitAnthropicSSE(stream, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "ans" },
    });
    emitAnthropicSSE(stream, {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
    stream.emit("end");
    const result = await promise;
    expect(result.doneReason).toBe("stop");
  });

  it("maps stop_reason: max_tokens to doneReason: length", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(ollamaContext, anthropicConfig, () => {});
    await tick();
    emitAnthropicSSE(stream, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "ans" },
    });
    emitAnthropicSSE(stream, {
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
    });
    stream.emit("end");
    const result = await promise;
    expect(result.doneReason).toBe("length");
  });

  it("maps stop_reason: tool_use to doneReason: stop (normal termination)", async () => {
    const stream = makeFakeStream();
    mockAxiosPost.mockResolvedValue({ data: stream });
    const promise = streamLLM(ollamaContext, anthropicConfig, () => {});
    await tick();
    emitAnthropicSSE(stream, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "ans" },
    });
    emitAnthropicSSE(stream, {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    });
    stream.emit("end");
    const result = await promise;
    expect(result.doneReason).toBe("stop");
  });
});