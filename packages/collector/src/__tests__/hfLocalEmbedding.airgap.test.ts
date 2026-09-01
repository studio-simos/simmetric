// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Air-gap test for HuggingFaceLocalEmbeddingProvider (Phase 105-02, D-04).
 *
 * INVARIANT under test: the HF v4 provider MUST NOT make any network call when
 * embedding. A cache miss is a HARD ERROR (throw), not a silent auto-download.
 *
 * Strategy: mock @huggingface/transformers so the pipeline factory returns a
 * controllable spy. The spy never touches the real ONNX runtime or HF hub.
 * Additionally monkeypatch https.request and global.fetch to throw an assertion
 * error if anything in the import graph attempts a network call. This makes
 * the test fully hermetic — it does NOT require a real model to be staged and
 * does NOT require network to pass (D-06 discretion: "structure the test to
 * assert fail-closed behavior").
 *
 * The 4 tests:
 *   1. no-network embed from staged (mocked) cache returns a 384-dim vector
 *   2. cache-miss (pipeline factory throws) → embed() throws hard error,
 *      no network attempt
 *   3. result[0].length === 384 for Xenova/all-MiniLM-L6-v2 (D-05 A1)
 *   4. provider.initialize() sets env.allowRemoteModels=false and
 *      env.allowLocalModels=true (air-gap stance assertion via mock spy)
 */

// ─── Mock @huggingface/transformers (must be hoisted before imports) ────────
// The mock returns a pipeline factory that yields a deterministic 384-dim
// Float32Array per text — mirrors the real Xenova/all-MiniLM-L6-v2 output shape
// without loading the ONNX runtime. mockEnv is the observable spy for Test 4.
const mockPipelineFactory = jest.fn();
const mockEnv = {
  allowRemoteModels: true, // pre-state; provider.initialize() must flip to false
  allowLocalModels: false, // pre-state; provider.initialize() must flip to true
  cacheDir: "/tmp/hf-v4-default-cache",
};
jest.mock("@huggingface/transformers", () => ({
  pipeline: mockPipelineFactory,
  env: mockEnv,
}));

// Mock fs so checkEmbeddingModelAvailability's existsSync call is controllable.
const mockExistsSync = jest.fn();
jest.mock("fs", () => ({
  existsSync: mockExistsSync,
}));

// Mock env so we never hit process.exit(1) on missing COLLECTOR_SECRET and can
// control EMBEDDING_PROVIDER. Default the test provider to "hf-local".
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
  STORAGE_PATH: "./storage",
  COLLECTOR_SECRET: "test-secret-for-unit-tests",
}));
jest.mock("../config/env", () => ({
  getEnv: mockedGetEnv,
  clearEnvCache: jest.fn(),
}));

// Mock axios so fetchEmbeddingConfig returns null (falls back to env vars).
jest.mock("axios", () => ({
  get: jest.fn().mockRejectedValue(new Error("test: no server available")),
}));

import https from "https";

// ─── Network fail-closed monkeypatch (D-06) ─────────────────────────────────
// Any attempt to call https.request or global.fetch throws a distinctive
// assertion error so the test fails loudly on any network escape.
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
  // Reset mockEnv to the pre-initialize state so Test 4 can assert the provider
  // flips the flags itself.
  mockEnv.allowRemoteModels = true;
  mockEnv.allowLocalModels = false;
  mockEnv.cacheDir = "/tmp/hf-v4-default-cache";
  // Default: pipeline factory returns a spy that yields a 384-dim Float32Array.
  mockPipelineFactory.mockImplementation(() => {
    return async (text: string) => ({
      data: new Float32Array(384).fill(0.01),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
  mockExistsSync.mockImplementation(() => true);
});

// Helper: import the provider fresh so the module-level providerCache does not
// leak between tests.
async function freshEmbeddings() {
  jest.resetModules();
  // Re-apply the same mock factories after resetModules.
  jest.doMock("@huggingface/transformers", () => ({
    pipeline: mockPipelineFactory,
    env: mockEnv,
  }));
  jest.doMock("fs", () => ({ existsSync: mockExistsSync }));
  jest.doMock("../config/env", () => ({ getEnv: mockedGetEnv, clearEnvCache: jest.fn() }));
  jest.doMock("axios", () => ({ get: jest.fn().mockRejectedValue(new Error("no server")) }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../services/embeddings") as typeof import("../services/embeddings");
}

describe("HuggingFaceLocalEmbeddingProvider (D-04 v4 air-gap)", () => {
  test("1. embed from staged (mocked) cache returns 384-dim vector with NO network call", async () => {
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    const result = await provider.embed(["test text"]);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]?.length).toBe(384);
    // Air-gap invariant: NO network call attempted during embed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((https as any).request).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("2. cache-miss (pipeline factory throws) → embed() throws HARD error, NO network attempt", async () => {
    mockPipelineFactory.mockImplementation(() => {
      throw new Error("Model file not found in cache (air-gap: allowRemoteModels=false)");
    });
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");

    await expect(provider.embed(["text"])).rejects.toThrow();
    // Hard error must NOT have escaped to the network layer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((https as any).request).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  test("3. result[0].length === 384 for Xenova/all-MiniLM-L6-v2 (D-05 A1: no re-index)", async () => {
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    const result = await provider.embed(["test text", "second text"]);
    expect(result.length).toBe(2);
    expect(result[0]?.length).toBe(384);
    expect(result[1]?.length).toBe(384);
    expect(provider.getDimension()).toBe(384);
  });

  test("4. provider.initialize() sets env.allowRemoteModels=false and env.allowLocalModels=true (air-gap stance)", async () => {
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["trigger initialize"]);

    // The provider must have flipped the env flags to the air-gap stance.
    expect(mockEnv.allowRemoteModels).toBe(false);
    expect(mockEnv.allowLocalModels).toBe(true);
    // cacheDir must honor HF_CACHE_DIR when set.
    process.env.HF_CACHE_DIR = "/tmp/hf-v4-custom-cache";
    jest.clearAllMocks();
    mockEnv.allowRemoteModels = true;
    mockEnv.allowLocalModels = false;
    mockPipelineFactory.mockImplementation(() => async () => ({
      data: new Float32Array(384).fill(0.01),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));
    const { getEmbeddingProvider: freshGet } = await freshEmbeddings();
    const provider2 = await freshGet("Xenova/all-MiniLM-L6-v2");
    await provider2.embed(["trigger"]);
    expect(mockEnv.cacheDir).toBe("/tmp/hf-v4-custom-cache");
    delete process.env.HF_CACHE_DIR;
  });

  test("5. dtype:'q8' passed to pipeline (Pitfall 1 (dtype not quantized))", async () => {
    mockPipelineFactory.mockClear();
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["trigger initialize"]);

    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    const call = mockPipelineFactory.mock.calls[0];
    // call signature: pipeline("feature-extraction", modelName, options)
    expect(call[0]).toBe("feature-extraction");
    expect(call[1]).toBe("Xenova/all-MiniLM-L6-v2");
    const options = call[2] as Record<string, unknown>;
    expect(options.dtype).toBe("q8");
    expect(options.quantized).toBeUndefined();
  });

  test("6. checkEmbeddingModelAvailability('hf-local') probes HF v4 cache layout", async () => {
    // Staged cache: existsSync returns true for all 4 files → available.
    mockExistsSync.mockImplementation(() => true);
    const { checkEmbeddingModelAvailability } = await freshEmbeddings();
    const result = await checkEmbeddingModelAvailability("Xenova/all-MiniLM-L6-v2");
    expect(result.available).toBe(true);
    expect(result.provider).toBe("hf-local");
    expect(result.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  test("7. checkEmbeddingModelAvailability('hf-local') surfaces hard error on cache-miss (no auto-download)", async () => {
    mockExistsSync.mockImplementation(() => false);
    const { checkEmbeddingModelAvailability } = await freshEmbeddings();
    const result = await checkEmbeddingModelAvailability("Xenova/all-MiniLM-L6-v2");
    expect(result.available).toBe(false);
    expect(result.provider).toBe("hf-local");
    expect(result.error).toMatch(/HF v4 model file not found/);
    expect(result.error).toMatch(/allowRemoteModels=false/);
    // No network attempt from the pre-flight guard.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((https as any).request).not.toHaveBeenCalled();
  });
});