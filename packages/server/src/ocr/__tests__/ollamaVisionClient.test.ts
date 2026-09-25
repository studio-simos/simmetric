// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for ollamaVisionClient — vision OCR via the ollama-js client
 *
 * Transport seam: the module-under-test talks to Ollama through the
 * getOllamaClient() factory (92-01), mocked below. Fake streams are
 * async generators yielding PARSED chunk objects (ollama-js parses
 * NDJSON upstream — Pitfall 5: streams are async generators, not
 * EventEmitters).
 *
 * Behavioral assertions are FROZEN (OJ-01 SC1). The only sanctioned
 * adaptations (92-03 plan, Task 1 behavior):
 * (a) endpoint assertion form: "POSTs to /api/generate" -> mockGenerate
 *     called once AND mockChat not called (and vice versa for chat configs)
 * (b) keep_alive "5m" -> "10m" (value now flows from mocked
 *     OLLAMA_KEEP_ALIVE, locked D-04)
 * (c) axios-config AbortSignal test -> behavioral abort-bridge test
 *     (per-request iterator.abort(), ocrPage rejects with the generic wrap)
 * (d) added getOllamaClient call-args assertion replacing the deleted
 *     createOcrAxiosInstance contract (same env-host + OCR_TIMEOUT truth)
 */

import { logger } from "../../utils/logger";
import { getEnv } from "../../config/env";

// Mock logger to silence test output and verify warning calls
jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Phase 205 (OCR-03): the preprocessing module is mocked so the hook
// assertions pin ocrPage's passthrough behavior without running the real
// sharp chain in this suite (the chain itself is covered by
// preprocessing.test.ts with sharp used directly).
const mockPreprocessForOcr = jest.fn();
jest.mock("../preprocessing", () => ({
  preprocessForOcr: (...args: any[]) => mockPreprocessForOcr(...args),
}));

// Mock getEnv (OLLAMA_KEEP_ALIVE required by D-04; OCR_NUM_PREDICT flows into
// the request options.num_predict — default 8192 mirrors the env schema;
// OCR_NUM_CTX: 0 = registry fallback per Phase 205 D-09 — Pitfall 6: every
// options-reading test breaks without it)
jest.mock("../../config/env", () => ({
  getEnv: jest.fn().mockReturnValue({
    OLLAMA_BASE_URL: "http://ollama:11434",
    OCR_TIMEOUT: 600000,
    OLLAMA_KEEP_ALIVE: "10m",
    OCR_NUM_PREDICT: 8192,
    OCR_NUM_CTX: 0,
  }),
}));

// Mock modelRegistry (OcrModelConfig type import only)
jest.mock("../modelRegistry", () => ({}));

// Mock the 92-01 ollamaClient factory
// NOTE: mock fns live INSIDE the factory to avoid TDZ under @swc/jest
// (SWC hoists ESM imports above `const`; factory runs at import-time before
// the outer const would initialize). Exposed via require() after jest.mock.
jest.mock("../../services/ollamaClient", () => {
  const mockGenerate = jest.fn();
  const mockChat = jest.fn();
  const mockShow = jest.fn();
  const mockGetOllamaClient = jest.fn(() => ({
    generate: mockGenerate,
    chat: mockChat,
    show: mockShow,
  }));
  return {
    getOllamaClient: mockGetOllamaClient,
    // test-only exports to retrieve the inner mock fns
    __mockGenerate: mockGenerate,
    __mockChat: mockChat,
    __mockShow: mockShow,
    __mockGetOllamaClient: mockGetOllamaClient,
  };
});
const ollamaClientMock = require("../../services/ollamaClient");
const mockGetOllamaClient = ollamaClientMock.__mockGetOllamaClient as jest.Mock;
const mockGenerate = ollamaClientMock.__mockGenerate as jest.Mock;
const mockChat = ollamaClientMock.__mockChat as jest.Mock;
const mockShow = ollamaClientMock.__mockShow as jest.Mock;

import { ocrPage } from "../ollamaVisionClient";

// Helper: create an async-generator fake stream yielding PARSED chunk
// objects (ollama-js delivers parsed objects, not NDJSON strings). The
// returned iterator carries an abort spy mirroring AbortableAsyncIterator.
function createFakeStream<T>(
  chunks: T[],
): AsyncGenerator<T, void, void> & { abort: jest.Mock } {
  const gen = (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })() as AsyncGenerator<T, void, void> & { abort: jest.Mock };
  gen.abort = jest.fn();
  return gen;
}

describe("ocrPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: preprocessing passes the original buffer through applied
    // (real-chain stand-in so legacy tests keep asserting the ORIGINAL
    // buffer's base64 — the sharp chain itself is exercised in
    // preprocessing.test.ts).
    mockPreprocessForOcr.mockImplementation(async (input: Buffer) => ({
      buffer: input,
      applied: true,
      estimatedSkewDeg: 0,
      resized: false,
    }));
  });

  const testImageBuffer = Buffer.from("fake-image-data");
  const testModelConfig = {
    name: "glm-ocr:latest",
    namePattern: "glm-ocr:latest",
    apiEndpoint: "generate" as const,
    inputMode: "base64_array" as const,
    supportedModes: ["text", "table", "figure", "generic"] as Array<"text" | "table" | "figure" | "generic">,
    promptTemplate: "glm-ocr" as const,
    contextWindow: 4096,
  };

  // Test: Constructs the shared client with env host + OCR_TIMEOUT
  it("should construct the client via getOllamaClient with env host and OCR_TIMEOUT", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer, 1, 1, testModelConfig.name, testModelConfig);

    expect(mockGetOllamaClient).toHaveBeenCalledWith("http://ollama:11434", {
      timeoutMs: 600000,
    });
  });

  // Test: Calls the generate endpoint with correct body structure
  it("should call generate with images as base64 array", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([
        { response: "test output", done: true, eval_count: 10 },
      ]),
    );

    const result = await ocrPage(testImageBuffer, 1, 5, testModelConfig.name, testModelConfig);

    // endpoint semantics: generate config -> generate called, chat not called
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockChat).not.toHaveBeenCalled();

    const body = mockGenerate.mock.calls[0][0];
    expect(body.model).toBe(testModelConfig.name);
    expect(body.images).toEqual([testImageBuffer.toString("base64")]);
    expect(body.stream).toBe(true);
    expect(body.prompt).toContain("Transcribe page 1 of 5");

    // Temperature must be inside options, not at top level
    expect(body.options).toBeDefined();
    expect(body.options.temperature).toBe(0);
    expect(body.options.num_predict).toBe(8192);
    expect(body.options.num_ctx).toBe(4096);

    // verify temperature is NOT at top level
    expect(body.temperature).toBeUndefined();

    // keep_alive flows from OLLAMA_KEEP_ALIVE (D-04)
    expect(body.keep_alive).toBe("10m");

    // verify result
    expect(result.markdown).toBe("test output");
    expect(result.tokensUsed).toBe(10);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // Test: Per-request abort bridges the caller's signal to THIS stream only
  it("should abort only the per-request stream when the AbortSignal fires", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    const abortSpy = jest.fn();
    // Fake stream yields one chunk then blocks until its own abort spy
    // rejects the pending await with an AbortError (ollama-js semantics).
    const gen = (async function* () {
      yield { response: "partial", done: false };
      await new Promise<never>((_resolve, reject) => {
        abortSpy.mockImplementation(() =>
          reject(
            Object.assign(new Error("The operation was aborted"), {
              name: "AbortError",
            }),
          ),
        );
      });
    })() as AsyncGenerator<{ response: string; done: boolean }, void, void> & {
      abort: jest.Mock;
    };
    gen.abort = abortSpy;
    mockGenerate.mockResolvedValueOnce(gen);

    const controller = new AbortController();
    const promise = ocrPage(
      testImageBuffer,
      1,
      1,
      testModelConfig.name,
      testModelConfig,
      controller.signal,
    );

    // Let the stream start and consume the first chunk before aborting mid-flight
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(promise).rejects.toThrow(/^Ollama vision OCR error:/);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  // Test: Logs warning when done_reason is "length" and surfaces truncated flag
  it("should log warning when done_reason is length", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([
        {
          response: "part",
          done: true,
          done_reason: "length",
          eval_count: 50,
        },
      ]),
    );

    const result = await ocrPage(testImageBuffer, 1, 1, testModelConfig.name, testModelConfig);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("truncat"),
      expect.any(Object),
    );
    expect(result.truncated).toBe(true);
  });

  // Test: sets truncated=false for normal done_reason "stop" (no truncation log)
  it("sets truncated=false (or undefined) for normal done_reason stop", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([
        {
          response: "full output",
          done: true,
          done_reason: "stop",
          eval_count: 30,
        },
      ]),
    );

    const result = await ocrPage(testImageBuffer, 1, 1, testModelConfig.name, testModelConfig);
    expect(result.truncated).toBe(false);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("truncat"),
      expect.any(Object),
    );
  });

  // Test: num_predict flows from OCR_NUM_PREDICT env var (override to 16384)
  it("uses OCR_NUM_PREDICT from env for num_predict", async () => {
    // ocrPage calls getEnv() multiple times (OLLAMA_BASE_URL, OCR_TIMEOUT,
    // OCR_NUM_PREDICT, OLLAMA_KEEP_ALIVE) — queue enough mockReturnValueOnce
    // overrides so every call within this invocation sees the raised cap.
    // mockReturnValueOnce is consumed before the default mockReturnValue, so
    // later tests still get the default 8192 env.
    const overrideEnv = {
      OLLAMA_BASE_URL: "http://ollama:11434",
      OCR_TIMEOUT: 600000,
      OLLAMA_KEEP_ALIVE: "10m",
      OCR_NUM_PREDICT: 16384,
      OCR_NUM_CTX: 0,
    };
    for (let i = 0; i < 6; i++) {
      (getEnv as jest.Mock).mockReturnValueOnce(overrideEnv);
    }

    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer, 1, 1, testModelConfig.name, testModelConfig);

    const body = mockGenerate.mock.calls[0][0];
    expect(body.options.num_predict).toBe(16384);
  });

  // Test: Uses fallback prompt when useFallbackPrompt is true
  it("should use simplified fallback prompt when specified", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "text", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer, 3, 10, testModelConfig.name, testModelConfig, undefined, true);

    const body = mockGenerate.mock.calls[0][0];
    expect(body.prompt).toContain("plain text");
  });

  // Test: Deepseek prompt format when config returns deepseek-ocr template
  it("should use deepseek prompt format when model config is deepseek-ocr", async () => {
    const deepseekConfig = {
      name: "deepseek-ocr:latest",
      namePattern: "deepseek-ocr:latest",
      apiEndpoint: "chat" as const,
      inputMode: "single_image" as const,
      supportedModes: ["text", "generic"] as Array<"text" | "table" | "figure" | "generic">,
      promptTemplate: "deepseek-ocr" as const,
      contextWindow: 8192,
      specialTokens: ["<|grounding|>"],
    };

    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockChat.mockResolvedValueOnce(
      createFakeStream([
        { message: { content: "# Title" }, done: true, eval_count: 10 },
      ]),
    );

    await ocrPage(testImageBuffer, 1, 5, deepseekConfig.name, deepseekConfig);

    // endpoint semantics: chat config -> chat called, generate not called
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();

    const body = mockChat.mock.calls[0][0];
    // deepseek-ocr uses the chat endpoint, so body has messages array
    expect(body.messages).toBeDefined();
    expect(body.messages.length).toBe(2); // system + user
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("document OCR engine");
    expect(body.messages[1].role).toBe("user");
    // Production uses official DeepSeek-OCR prompt format (per deepseek-ai/deepseek-ocr docs):
    // "<|grounding|>Convert the document to markdown. [Page X/Y]"
    expect(body.messages[1].content).toContain("<|grounding|>Convert the document to markdown.");
    expect(body.messages[1].content).toContain("[Page 1/5]");
    expect(body.messages[1].images).toEqual([testImageBuffer.toString("base64")]);
  });

  // Test: ocrMode and customInstructions are passed through to prompt
  it("should pass ocrMode and customInstructions through to prompt", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "# Table", done: true, eval_count: 10 }]),
    );

    await ocrPage(
      testImageBuffer,
      1,
      5,
      testModelConfig.name,
      testModelConfig,
      undefined,
      false,
      "table",
      "Preserve borders",
    );

    const body = mockGenerate.mock.calls[0][0];
    // GLM-ocr table mode sets table-specific system prompt
    expect(body.system).toContain("table recognition engine");
    expect(body.prompt).toContain("Preserve borders");
  });

  // Test: fallback prompt ignores registry config
  it("should use simplified fallback prompt regardless of registry config", async () => {
    const deepseekConfig = {
      name: "deepseek-ocr:latest",
      namePattern: "deepseek-ocr:latest",
      apiEndpoint: "chat" as const,
      inputMode: "single_image" as const,
      supportedModes: ["text", "generic"] as Array<"text" | "table" | "figure" | "generic">,
      promptTemplate: "deepseek-ocr" as const,
      contextWindow: 8192,
      specialTokens: ["<|grounding|>"],
    };

    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockChat.mockResolvedValueOnce(
      createFakeStream([
        { message: { content: "text" }, done: true, eval_count: 1 },
      ]),
    );

    await ocrPage(testImageBuffer, 3, 10, deepseekConfig.name, deepseekConfig, undefined, true);

    const body = mockChat.mock.calls[0][0];
    // Fallback prompt still uses the chat endpoint for deepseek-ocr
    expect(body.messages).toBeDefined();
    const userMsg = body.messages[1];
    expect(userMsg.content).toContain("plain text");
    // Should NOT use deepseek prompt format
    expect(userMsg.content).not.toContain("Mode:");
  });

  // Test: salvages non-empty content when stream ends WITHOUT done marker
  // (260829-lkq — glm-ocr custom engine intermittently closes the NDJSON
  // stream after complete content without the final done:true chunk;
  // ollama-js 0.6.3 then throws "Did not receive done or success response
  // in stream." — the accumulated transcription is REAL and must not be
  // discarded. Salvage: return it with truncated:true.)
  it("should salvage non-empty content when stream ends without done marker (generate)", async () => {
    // Stream that yields content chunks then throws the ollama-js
    // done-less termination error — mirrors AbortableAsyncIterator's
    // end-of-stream check (browser.cjs:52).
    const gen = (async function* () {
      yield { response: "## Invoice", done: false };
      yield { response: " — total €100", done: false };
      throw new Error("Did not receive done or success response in stream.");
    })() as AsyncGenerator<
      { response: string; done: boolean },
      void,
      void
    > & { abort: jest.Mock };
    gen.abort = jest.fn();
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(gen);

    const result = await ocrPage(testImageBuffer, 1, 1, testModelConfig.name, testModelConfig);

    // The good transcription is salvaged, not discarded
    expect(result.markdown).toBe("## Invoice — total €100");
    expect(result.truncated).toBe(true);
    expect(result.tokensUsed).toBe(0);
    expect(result.pageNumber).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // WARN (not error) — the salvage is a degraded-but-successful path
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("done marker"),
      expect.objectContaining({
        pageNumber: 1,
        contentLength: "## Invoice — total €100".length,
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  // Test: done-less stream with EMPTY content is a REAL failure — still throws
  it("should throw when stream ends without done marker and content is empty", async () => {
    const gen = (async function* () {
      // zero content chunks — done-less AND content-less
      yield { response: "", done: false };
      throw new Error("Did not receive done or success response in stream.");
    })() as AsyncGenerator<
      { response: string; done: boolean },
      void,
      void
    > & { abort: jest.Mock };
    gen.abort = jest.fn();
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(gen);

    await expect(
      ocrPage(testImageBuffer, 1, 1, testModelConfig.name, testModelConfig),
    ).rejects.toThrow(/^Ollama vision OCR error: Did not receive done/);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("done marker"),
      expect.any(Object),
    );
  });

  // Test: salvage applies to the chat endpoint (deepseek-ocr) too
  it("should salvage non-empty content when chat stream ends without done marker", async () => {
    const deepseekConfig = {
      name: "deepseek-ocr:latest",
      namePattern: "deepseek-ocr:latest",
      apiEndpoint: "chat" as const,
      inputMode: "single_image" as const,
      supportedModes: ["text", "generic"] as Array<"text" | "table" | "figure" | "generic">,
      promptTemplate: "deepseek-ocr" as const,
      contextWindow: 8192,
      specialTokens: ["<|grounding|>"],
    };

    const gen = (async function* () {
      yield { message: { content: "# Title" }, done: false };
      throw new Error("Did not receive done or success response in stream.");
    })() as AsyncGenerator<
      { message?: { content?: string }; done: boolean },
      void,
      void
    > & { abort: jest.Mock };
    gen.abort = jest.fn();
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockChat.mockResolvedValueOnce(gen);

    const result = await ocrPage(testImageBuffer, 1, 1, deepseekConfig.name, deepseekConfig);

    expect(result.markdown).toBe("# Title");
    expect(result.truncated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("done marker"),
      expect.any(Object),
    );
  });

  // Test: unknown model falls back to generic template
  it("should fall back to generic template for unknown model", async () => {
    const genericConfig = {
      name: "unknown-model:latest",
      namePattern: "*",
      apiEndpoint: "generate" as const,
      inputMode: "base64_array" as const,
      supportedModes: ["generic"] as Array<"text" | "table" | "figure" | "generic">,
      promptTemplate: "generic" as const,
      contextWindow: 4096,
    };

    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([
        { response: "# Title", done: true, eval_count: 10 },
      ]),
    );

    await ocrPage(testImageBuffer, 1, 5, genericConfig.name, genericConfig);

    const body = mockGenerate.mock.calls[0][0];
    expect(body.system).toContain("document OCR engine");
    expect(body.prompt).toContain("Transcribe page 1 of 5");
  });
});

// ---------------------------------------------------------------------------
// Phase 205 (OCR-02 / D-08/D-09/D-10): num_ctx boundary + top_k + show() cap
// audit. OCR_NUM_CTX 0 → registry contextWindow; >= 1 → env wins. The show()
// audit warns greppably on clamp, degrades fail-open on show() failure, and
// handles model_info as plain object OR Map (Assumption A4).
// ---------------------------------------------------------------------------
describe("ocrPage — num_ctx override + effective-cap audit (Phase 205)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Replace the Once-queue with a deterministic default so leftover
    // mockReturnValueOnce entries from sibling tests can't leak into these
    // tests' getEnv() reads.
    (getEnv as jest.Mock).mockImplementation(
      () => ({
        OLLAMA_BASE_URL: "http://ollama:11434",
        OCR_TIMEOUT: 600000,
        OLLAMA_KEEP_ALIVE: "10m",
        OCR_NUM_PREDICT: 8192,
        OCR_NUM_CTX: 0,
      }),
    );
  });

  const testImageBuffer2 = Buffer.from("fake-image-data");
  const testModelConfig = {
    name: "glm-ocr:latest",
    namePattern: "glm-ocr:latest",
    apiEndpoint: "generate" as const,
    inputMode: "base64_array" as const,
    supportedModes: ["text", "table", "figure", "generic"] as Array<
      "text" | "table" | "figure" | "generic"
    >,
    promptTemplate: "glm-ocr" as const,
    contextWindow: 4096,
  };

  // Helper: override specific env values for every getEnv() call within one
  // ocrPage invocation (mockImplementation — immune to Once-queue leakage).
  function queueEnvOverride(overrides: Partial<{
    OCR_NUM_CTX: number;
    OLLAMA_BASE_URL: string;
    OCR_TIMEOUT: number;
    OLLAMA_KEEP_ALIVE: string;
    OCR_NUM_PREDICT: number;
  }>) {
    const env = {
      OLLAMA_BASE_URL: "http://ollama:11434",
      OCR_TIMEOUT: 600000,
      OLLAMA_KEEP_ALIVE: "10m",
      OCR_NUM_PREDICT: 8192,
      OCR_NUM_CTX: 0,
      ...overrides,
    };
    (getEnv as jest.Mock).mockImplementation(() => env);
  }

  // (a) OCR_NUM_CTX 0 → registry contextWindow (4096 for the glm-ocr config)
  it("uses the registry contextWindow for num_ctx when OCR_NUM_CTX is 0 (boundary: 0 = fallback)", async () => {
    queueEnvOverride({ OCR_NUM_CTX: 0 });
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer2, 1, 1, testModelConfig.name, testModelConfig);

    const body = mockGenerate.mock.calls[0][0];
    expect(body.options.num_ctx).toBe(4096); // modelConfig.contextWindow
    expect(body.options.top_k).toBe(1);
  });

  // (b) OCR_NUM_CTX 16384 → env value wins, top_k 1 always present
  it("uses OCR_NUM_CTX for num_ctx when the env value is > 0 (boundary: >= 1 wins) with top_k 1", async () => {
    queueEnvOverride({ OCR_NUM_CTX: 16384 });
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer2, 1, 1, testModelConfig.name, testModelConfig);

    const body = mockGenerate.mock.calls[0][0];
    expect(body.options.num_ctx).toBe(16384);
    expect(body.options.top_k).toBe(1);
  });

  // (c) requested > trained → the greppable silent-clamp warn fires
  it("warns with the silent-clamp message when requested num_ctx exceeds the trained context_length", async () => {
    queueEnvOverride({ OCR_NUM_CTX: 16384 });
    mockShow.mockResolvedValueOnce({
      model_info: { "somearch.context_length": 8192 },
    });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer2, 1, 1, testModelConfig.name, testModelConfig);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("silent clamp expected"),
      expect.objectContaining({
        model: testModelConfig.name,
        requested: 16384,
        trained: 8192,
        effective: 8192,
      }),
    );
  });

  // (d) requested <= trained → info log, no clamp warn
  it("logs the effective num_ctx info without a clamp warn when requested <= trained", async () => {
    queueEnvOverride({ OCR_NUM_CTX: 4096 });
    mockShow.mockResolvedValueOnce({
      model_info: { "somearch.context_length": 131072 },
    });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer2, 1, 1, testModelConfig.name, testModelConfig);

    expect(logger.info).toHaveBeenCalledWith(
      "[ocr] effective num_ctx",
      expect.objectContaining({
        model: testModelConfig.name,
        requested: 4096,
        trained: 131072,
      }),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("silent clamp expected"),
      expect.any(Object),
    );
  });

  // (e) show() rejects (ResponseError 404 — model not created yet) → warn
  // logged AND the OCR call still completes normally (fail-open, Pitfall 5)
  it("degrades fail-open when show() rejects with ResponseError 404 — OCR still completes", async () => {
    queueEnvOverride({ OCR_NUM_CTX: 0 });
    const responseErr = Object.assign(
      new Error("model 'glm-ocr:latest' not found"),
      { name: "ResponseError", status_code: 404 },
    );
    mockShow.mockRejectedValueOnce(responseErr);
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "still works", done: true, eval_count: 2 }]),
    );

    const result = await ocrPage(testImageBuffer2, 1, 1, testModelConfig.name, testModelConfig);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read model_info"),
      expect.objectContaining({
        model: testModelConfig.name,
        error: "model 'glm-ocr:latest' not found",
      }),
    );
    // num_ctx falls back to the registry value; the request completes
    const body = mockGenerate.mock.calls[0][0];
    expect(body.options.num_ctx).toBe(4096);
    expect(result.markdown).toBe("still works");
  });

  // (f) model_info arriving as a Map instance is scanned correctly (A4)
  it("scans model_info when it arrives as a Map instance (A4)", async () => {
    queueEnvOverride({ OCR_NUM_CTX: 16384 });
    const modelInfo = new Map<string, unknown>([["glmv.context_length", 8192]]);
    mockShow.mockResolvedValueOnce({ model_info: modelInfo });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer2, 1, 1, testModelConfig.name, testModelConfig);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("silent clamp expected"),
      expect.objectContaining({ requested: 16384, trained: 8192 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 205 (D-14): ttftMs — time-to-first-token on both return paths.
// ---------------------------------------------------------------------------
describe("ocrPage — ttftMs metric (Phase 205 D-14)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const testImageBuffer3 = Buffer.from("fake-image-data");
  const testModelConfig = {
    name: "glm-ocr:latest",
    namePattern: "glm-ocr:latest",
    apiEndpoint: "generate" as const,
    inputMode: "base64_array" as const,
    supportedModes: ["text", "table", "figure", "generic"] as Array<
      "text" | "table" | "figure" | "generic"
    >,
    promptTemplate: "glm-ocr" as const,
    contextWindow: 4096,
  };

  it("sets ttftMs on the normal path (number, 0 <= ttftMs <= durationMs)", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([
        { response: "hello ", done: false },
        { response: "world", done: true, eval_count: 5 },
      ]),
    );

    const result = await ocrPage(testImageBuffer3, 1, 1, testModelConfig.name, testModelConfig);

    expect(result.markdown).toBe("hello world");
    expect(typeof result.ttftMs).toBe("number");
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
    expect(result.ttftMs!).toBeLessThanOrEqual(result.durationMs);
  });

  it("stamps ttftMs only when content first arrives (empty leading chunks)", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    // A chunk with no content must not set ttftMs; the chunk carrying the
    // first real content does. ttftMs === 0 only when the very first chunk
    // carries content within the same millisecond; leading empties make the
    // stamp strictly later — here we assert ttftMs is populated and the
    // markdown includes only the content deltas.
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([
        { response: "", done: false },
        { response: "first content", done: true, eval_count: 3 },
      ]),
    );

    const result = await ocrPage(testImageBuffer3, 1, 1, testModelConfig.name, testModelConfig);

    expect(result.markdown).toBe("first content");
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
    expect(result.ttftMs!).toBeLessThanOrEqual(result.durationMs);
  });

  it("populates ttftMs on the salvage path (done-less stream with content)", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    const gen = (async function* () {
      yield { response: "## Invoice", done: false };
      throw new Error("Did not receive done or success response in stream.");
    })() as AsyncGenerator<
      { response: string; done: boolean },
      void,
      void
    > & { abort: jest.Mock };
    gen.abort = jest.fn();
    mockGenerate.mockResolvedValueOnce(gen);

    const result = await ocrPage(testImageBuffer3, 1, 1, testModelConfig.name, testModelConfig);

    // Salvaged runs are degraded successes — metrics still reported
    expect(result.truncated).toBe(true);
    expect(result.markdown).toBe("## Invoice");
    expect(typeof result.ttftMs).toBe("number");
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
    expect(result.ttftMs!).toBeLessThanOrEqual(result.durationMs);
  });

  it("populates ttftMs on the chat-endpoint path too", async () => {
    const chatConfig = {
      ...testModelConfig,
      name: "deepseek-ocr:latest",
      apiEndpoint: "chat" as const,
      promptTemplate: "deepseek-ocr" as const,
    };
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockChat.mockResolvedValueOnce(
      createFakeStream([
        { message: { content: "chat delta" }, done: true, eval_count: 2 },
      ]),
    );

    const result = await ocrPage(testImageBuffer3, 1, 1, chatConfig.name, chatConfig);

    expect(result.markdown).toBe("chat delta");
    expect(typeof result.ttftMs).toBe("number");
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 205 (OCR-04 / D-11): ocrPrompt threading — non-empty replaces the
// glm-ocr systemPrompt in all modes; empty/undefined keeps the legacy
// per-mode prompt (byte-identical); deepseek-ocr/generic templates ignore it.
// ---------------------------------------------------------------------------
describe("ocrPage — ocrPrompt threading (Phase 205 OCR-04)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const testImageBuffer4 = Buffer.from("fake-image-data");
  const testModelConfig = {
    name: "glm-ocr:latest",
    namePattern: "glm-ocr:latest",
    apiEndpoint: "generate" as const,
    inputMode: "base64_array" as const,
    supportedModes: ["text", "table", "figure", "generic"] as Array<
      "text" | "table" | "figure" | "generic"
    >,
    promptTemplate: "glm-ocr" as const,
    contextWindow: 4096,
  };

  const GLM_TEXT_LEGACY =
    "You are a text recognition engine. Transcribe all visible text into clean Markdown.";
  const GLM_TABLE_LEGACY =
    "You are a table recognition engine. Extract all tables as Markdown pipe tables.";
  const GLM_GENERIC_LEGACY =
    "You are a document OCR engine. Your sole task is to transcribe the content of document images into clean, well-structured Markdown.\n\nRules:\n1. Output ONLY the Markdown content of the document. No greetings, no explanations, no \"Here is the transcription:\" preambles.\n2. Preserve the document's structure: headings (# ## ###), bullet lists, numbered lists, tables (Markdown pipe tables), and paragraph breaks.\n3. For images or diagrams, insert: [Image: brief description]\n4. If text is unclear, ambiguous, or potentially misread, insert: [UNVERIFIED: reason] immediately after the uncertain text.\n5. Do not correct grammar, spelling, or formatting of the source document. Transcribe what you see, not what you think it should be.\n6. For handwritten text, do your best and mark it: [HANDWRITING: transcribed text]\n7. Preserve the reading order: left-to-right, top-to-bottom.";

  it("sends the threaded ocrPrompt as the system message when non-empty (generate)", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(
      testImageBuffer4,
      1,
      1,
      testModelConfig.name,
      testModelConfig,
      undefined,
      false,
      "table", // non-default mode — override must win in ALL modes
      undefined,
      "Text recognition:",
    );

    const body = mockGenerate.mock.calls[0][0];
    expect(body.system).toBe("Text recognition:");
  });

  it("sends the legacy per-mode system prompt when ocrPrompt is empty (generate)", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(
      testImageBuffer4,
      1,
      1,
      testModelConfig.name,
      testModelConfig,
      undefined,
      false,
      "table",
      undefined,
      "",
    );

    const body = mockGenerate.mock.calls[0][0];
    expect(body.system).toBe(GLM_TABLE_LEGACY);
  });

  it("sends the legacy generic system prompt when ocrPrompt is undefined (generate)", async () => {
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(testImageBuffer4, 1, 1, testModelConfig.name, testModelConfig);

    const body = mockGenerate.mock.calls[0][0];
    expect(body.system).toBe(GLM_GENERIC_LEGACY);
  });

  it("keeps the legacy text-mode system prompt for the chat endpoint (deepseek ignores ocrPrompt)", async () => {
    // deepseek-ocr uses the shared OCR_SYSTEM_PROMPT as systemPrompt — the
    // ocrPrompt value must NOT leak into its messages (D-11 constraint).
    const deepseekConfig = {
      name: "deepseek-ocr:latest",
      namePattern: "deepseek-ocr:latest",
      apiEndpoint: "chat" as const,
      inputMode: "single_image" as const,
      supportedModes: ["text", "generic"] as Array<"text" | "table" | "figure" | "generic">,
      promptTemplate: "deepseek-ocr" as const,
      contextWindow: 8192,
    };

    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockChat.mockResolvedValueOnce(
      createFakeStream([
        { message: { content: "ok" }, done: true, eval_count: 1 },
      ]),
    );

    await ocrPage(
      testImageBuffer4,
      1,
      1,
      deepseekConfig.name,
      deepseekConfig,
      undefined,
      false,
      "text",
      undefined,
      "Text recognition:",
    );

    const body = mockChat.mock.calls[0][0];
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("document OCR engine");
    expect(body.messages[0].content).not.toBe("Text recognition:");
  });
});

// ---------------------------------------------------------------------------
// Phase 205 (OCR-03 / D-01, D-05): ocrPage entry preprocessing hook — the
// PREPROCESSED buffer's base64 reaches the request when preprocessing
// applies; the ORIGINAL buffer's base64 flows through when preprocessForOcr
// fail-opens (applied=false + buffer=original). One landing point covers all
// 6 call sites — the hook lives inside ocrPage, so ocrStages/ragOcrService/
// ocrRepair inherit it with zero per-site code.
// ---------------------------------------------------------------------------
describe("ocrPage — preprocessing entry hook (Phase 205 OCR-03)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getEnv as jest.Mock).mockImplementation(() => ({
      OLLAMA_BASE_URL: "http://ollama:11434",
      OCR_TIMEOUT: 600000,
      OLLAMA_KEEP_ALIVE: "10m",
      OCR_NUM_PREDICT: 8192,
      OCR_NUM_CTX: 0,
    }));
  });

  const testModelConfig = {
    name: "glm-ocr:latest",
    namePattern: "glm-ocr:latest",
    apiEndpoint: "generate" as const,
    inputMode: "base64_array" as const,
    supportedModes: ["text", "table", "figure", "generic"] as Array<
      "text" | "table" | "figure" | "generic"
    >,
    promptTemplate: "glm-ocr" as const,
    contextWindow: 4096,
  };

  it("sends the PREPROCESSED buffer's base64 when preprocessing applies", async () => {
    const original = Buffer.from("original-image-bytes");
    const processed = Buffer.from("processed-jpeg-bytes");
    mockPreprocessForOcr.mockResolvedValueOnce({
      buffer: processed,
      applied: true,
      estimatedSkewDeg: -4.5,
      resized: true,
    });
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    const result = await ocrPage(original, 1, 1, testModelConfig.name, testModelConfig);

    // preprocessForOcr was invoked at entry with the ORIGINAL buffer
    expect(mockPreprocessForOcr).toHaveBeenCalledTimes(1);
    expect(mockPreprocessForOcr).toHaveBeenCalledWith(original);
    // The request carries the PROCESSED buffer's base64
    const body = mockGenerate.mock.calls[0][0];
    expect(body.images).toEqual([processed.toString("base64")]);
    expect(body.images).not.toEqual([original.toString("base64")]);
    // applied preprocessing is logged with the estimator metrics
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("preprocessed page image"),
      expect.objectContaining({
        pageNumber: 1,
        estimatedSkewDeg: -4.5,
        resized: true,
      }),
    );
    expect(result.markdown).toBe("ok");
  });

  it("passes the ORIGINAL buffer's base64 through when preprocessing fail-opens", async () => {
    const original = Buffer.from("original-image-bytes");
    mockPreprocessForOcr.mockResolvedValueOnce({
      buffer: original,
      applied: false,
      estimatedSkewDeg: 0,
      resized: false,
    });
    mockShow.mockResolvedValueOnce({ model_info: {} });
    mockGenerate.mockResolvedValueOnce(
      createFakeStream([{ response: "ok", done: true, eval_count: 1 }]),
    );

    await ocrPage(original, 1, 1, testModelConfig.name, testModelConfig);

    const body = mockGenerate.mock.calls[0][0];
    // D-05 passthrough: the request carries the ORIGINAL buffer's base64
    expect(body.images).toEqual([original.toString("base64")]);
    // No applied-log when preprocessing did not apply
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("preprocessed page image"),
      expect.any(Object),
    );
  });
});
