// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Air-gap test for CrossEncoderReranker (Phase 93-01, RER-01 / DEP-06).
 *
 * INVARIANT under test: the reranker MUST NOT make any network call when
 * scoring. A cache miss is a HARD ERROR (throw), not a silent auto-download.
 * The reranker is a pure function over `{ query, candidates }` (D-08 / SC3);
 * latency target ~50ms warm +1 hop is a design target, NOT a CI gate.
 *
 * Strategy: mock @huggingface/transformers so the pipeline factory returns a
 * controllable spy. The spy never touches the real ONNX runtime or HF hub.
 * Additionally monkeypatch https.request and global.fetch to throw an assertion
 * error if anything in the import graph attempts a network call. This makes
 * the test fully hermetic — it does NOT require a real model to be staged and
 * does NOT require network to pass (mirrors hfLocalEmbedding.airgap.test.ts).
 *
 * The 6 tests:
 *   1. no-network rerank from staged (mocked) cache returns sigmoid scores
 *   2. cache-miss (pipeline factory throws) → rerank() throws HARD error,
 *      no network attempt
 *   3. sigmoid arithmetic: logits [-2, 0, 2] → [~0.119, 0.5, ~~0.881]
 *   4. initialize() sets env.allowLocalModels=true; allowRemoteModels follows
 *      HF_ALLOW_REMOTE_MODELS (0b0e4b8a configurable stance)
 *   5. quantized:true + task 'text-classification' (Xenova v2 API since
 *      5ef3c568 — NOT dtype:'q8', NOT 'feature-extraction');
 *   6. DESC sort: candidates A/B/C with logits [1.0, 3.0, 2.0] → B, C, A
 *
 * (The former test 7 exercised checkRerankerAvailability() — removed with
 * the Phase 180 dead-code sweep: no production caller existed.)
 *
 * DEP-06 SC4: the existing hfLocalEmbedding.airgap.test.ts suite stays green
 * after the HF v4 bump (verified separately by running that suite).
 */

// ─── Mock the transformers package the reranker actually imports ───────────
// 260829-xxx fix: 5ef3c568 switched reranker.ts's dynamic import from
// @huggingface/transformers (v4) to @xenova/transformers (v2, bge-reranker-base
// Tensor.location fix) but this mock kept the old package name — the mock
// never intercepted the import, Jest fell through to the real @xenova
// package (pure ESM, "type":"module"), and SWC does not transform
// node_modules → "SyntaxError: Unexpected token 'export'" on every test in
// the suite since that commit. Mock the name the code imports.
const mockPipelineFactory = jest.fn();
const mockEnv = {
  allowRemoteModels: true, // pre-state; reranker.initialize() must flip to false
  allowLocalModels: false, // pre-state; reranker.initialize() must flip to true
  cacheDir: "/tmp/reranker-default-cache",
};
jest.mock("@xenova/transformers", () => ({
  pipeline: mockPipelineFactory,
  env: mockEnv,
}));

// Mock env so we never hit process.exit(1) on missing COLLECTOR_SECRET and can
// control RERANKER_MODEL / RERANKER_CACHE_DIR. Provider is "hf-local" so the
// embed cache lookup path is deterministic.
const mockedGetEnv = jest.fn(() => ({
  COLLECTOR_PORT: 3210,
  COLLECTOR_URL: "http://localhost:3210",
  SERVER_URL: "http://localhost:3000",
  EMBEDDING_PROVIDER: "hf-local",
  EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  EMBEDDING_API_KEY: undefined,
  VECTOR_DB_PROVIDER: "lancedb",
  VECTOR_DB_URL: undefined,
  VECTOR_DB_API_KEY: undefined,
  OLLAMA_BASE_URL: "http://localhost:11434",
  OLLAMA_KEEP_ALIVE: "10m",
  STORAGE_PATH: "./storage",
  COLLECTOR_SECRET: "test-secret-for-unit-tests",
  RERANKER_MODEL: "Xenova/bge-reranker-base",
  RERANKER_CACHE_DIR: undefined,
}));
jest.mock("../config/env", () => ({
  getEnv: mockedGetEnv,
  clearEnvCache: jest.fn(),
}));

import https from "https";

// ─── Network fail-closed monkeypatch (T-93-01) ──────────────────────────────
const NETWORK_ERROR = new Error("NETWORK_CALL_FORBIDDEN");
let originalHttpsRequest: typeof https.request;
let originalFetch: typeof fetch;

beforeAll(() => {
  originalHttpsRequest = https.request;
  originalFetch = global.fetch;
  (https as unknown as { request: jest.Mock }).request = jest.fn(() => {
    throw NETWORK_ERROR;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = jest.fn(() => {
    throw NETWORK_ERROR;
  });
});

afterAll(() => {
  (https as unknown as { request: typeof https.request }).request = originalHttpsRequest;
  global.fetch = originalFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset mockEnv to the pre-initialize state so Test 4 can assert the reranker
  // flips the flags itself.
  mockEnv.allowRemoteModels = true;
  mockEnv.allowLocalModels = false;
  mockEnv.cacheDir = "/tmp/reranker-default-cache";
  // Default: pipeline factory returns a spy that yields a deterministic
  // text-classification output (array of { label, score } per text_pair).
  mockPipelineFactory.mockImplementation(() => {
    return async (_input: { text: string; text_pair: string[] }) => [
      { label: "LABEL_0", score: 2.5 },
    ];
  });
});

// Helper: import the reranker fresh so the module-level singleton cache does
// not leak between tests.
async function freshReranker() {
  jest.resetModules();
  // Re-apply the same mock factories after resetModules. NOTE: the mock name
  // is @xenova/transformers — the package reranker.ts imports since 5ef3c568.
  jest.doMock("@xenova/transformers", () => ({
    pipeline: mockPipelineFactory,
    env: mockEnv,
  }));
  jest.doMock("../config/env", () => ({ getEnv: mockedGetEnv, clearEnvCache: jest.fn() }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../services/reranker") as typeof import("../services/reranker");
}

describe("CrossEncoderReranker (RER-01 / DEP-06 air-gap)", () => {
  test("1. rerank from staged (mocked) cache returns sigmoid scores with NO network call", async () => {
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    const results = await reranker.rerank("hello world", [
      { chunkText: "candidate one" },
    ]);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    // sigmoid(2.5) ≈ 0.9241
    expect(results[0]?.score).toBeCloseTo(0.9241, 3);
    // Air-gap invariant: NO network call attempted during rerank.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((https as any).request).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("2. cache-miss (pipeline factory throws) → rerank() throws HARD error, NO network attempt", async () => {
    mockPipelineFactory.mockImplementation(() => {
      throw new Error("Model file not found in cache (air-gap: allowRemoteModels=false)");
    });
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();

    await expect(
      reranker.rerank("q", [{ chunkText: "c1" }]),
    ).rejects.toThrow();
    // Hard error must NOT have escaped to the network layer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((https as any).request).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("3. sigmoid arithmetic: logits [-2, 0, 2] → probabilities [~0.119, 0.5, ~0.881]", async () => {
    mockPipelineFactory.mockImplementation(() => {
      return async (_input: { text: string; text_pair: string[] }) => [
        { label: "LABEL_0", score: -2 },
        { label: "LABEL_0", score: 0 },
        { label: "LABEL_0", score: 2 },
      ];
    });
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    const results = await reranker.rerank("q", [
      { chunkText: "a" },
      { chunkText: "b" },
      { chunkText: "c" },
    ]);
    expect(results[0]?.score).toBeCloseTo(0.1192, 3);
    expect(results[1]?.score).toBeCloseTo(0.5, 3);
    expect(results[2]?.score).toBeCloseTo(0.8808, 3);
    // All scores in [0, 1].
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  test("4. initialize() sets env.allowLocalModels=true and allowRemoteModels from HF_ALLOW_REMOTE_MODELS (0b0e4b8a configurable stance)", async () => {
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    await reranker.rerank("trigger initialize", [{ chunkText: "c" }]);

    // 0b0e4b8a made the remote-models stance configurable:
    // env.allowRemoteModels = process.env.HF_ALLOW_REMOTE_MODELS !== "false".
    // In the test env the var is unset → true (first-use download allowed);
    // air-gapped deployments set HF_ALLOW_REMOTE_MODELS=false → false.
    // The old assert (hard-coded false) pinned the pre-0b0e4b8a stance.
    expect(mockEnv.allowRemoteModels).toBe(process.env.HF_ALLOW_REMOTE_MODELS !== "false");
    expect(mockEnv.allowLocalModels).toBe(true);
  });

  test("5. quantized:true + task 'text-classification' (5ef3c568 Xenova v2 API — NOT dtype:'q8', NOT feature-extraction)", async () => {
    mockPipelineFactory.mockClear();
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    await reranker.rerank("trigger initialize", [{ chunkText: "c" }]);

    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    const call = mockPipelineFactory.mock.calls[0];
    // call signature: pipeline("text-classification", modelName, options)
    expect(call[0]).toBe("text-classification");
    expect(call[1]).toBe("Xenova/bge-reranker-base");
    const options = call[2] as Record<string, unknown>;
    // 5ef3c568 switched back to the Xenova v2 API: quantized:true is the
    // correct option there (the code comment: "quantized: true works
    // identically in Xenova v2"). The old dtype:'q8' assert pinned the
    // transient @huggingface/transformers v4 API that was reverted.
    expect(options.quantized).toBe(true);
    expect(options.dtype).toBeUndefined();
  });

  test("6. DESC sort: candidates A/B/C with logits [1.0, 3.0, 2.0] → B, C, A by score descending", async () => {
    mockPipelineFactory.mockImplementation(() => {
      return async (_input: { text: string; text_pair: string[] }) => [
        { label: "LABEL_0", score: 1.0 },
        { label: "LABEL_0", score: 3.0 },
        { label: "LABEL_0", score: 2.0 },
      ];
    });
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    const candidates = [
      { chunkText: "A" },
      { chunkText: "B" },
      { chunkText: "C" },
    ];
    const results = await reranker.rerank("q", candidates);
    // rerank() returns scores in candidate order (A, B, C). The route sorts
    // DESC; mirror that here to assert the B, C, A ordering.
    const indexed = results.map((r, i) => ({ ...r, originalIndex: i }));
    const sorted = indexed.sort((a, b) => b.score - a.score);
    // sigmoid(3.0) ≈ 0.9526 (B), sigmoid(2.0) ≈ 0.8808 (C), sigmoid(1.0) ≈ 0.7311 (A)
    expect(sorted[0]?.originalIndex).toBe(1); // B
    expect(sorted[1]?.originalIndex).toBe(2); // C
    expect(sorted[2]?.originalIndex).toBe(0); // A
    expect(sorted[0]?.score).toBeCloseTo(0.9526, 3);
    expect(sorted[1]?.score).toBeCloseTo(0.8808, 3);
    expect(sorted[2]?.score).toBeCloseTo(0.7311, 3);
  });
});