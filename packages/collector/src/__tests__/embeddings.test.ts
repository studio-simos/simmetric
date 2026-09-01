// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Embedding provider tests
 * - OllamaEmbeddingProvider: error message quality for missing models
 * - LocalEmbeddingProvider: cold-start progress_callback + "warming" log (ING-05)
 * - checkEmbeddingModelAvailability: cache hit/miss guard (260721-lrm D-02)
 *
 * Transport seam (Phase 92-04): OllamaEmbeddingProvider talks to the daemon
 * through the 92-01 collector-local getOllamaClient() factory, mocked below.
 * The previous fetch-based stub is gone — fetch is no longer the transport.
 * Behavioral assertions are FROZEN (OJ-01 SC1); only the transport-seam target
 * moved, plus the two sanctioned call-arg pins (getOllamaClient host, embed
 * request object with keep_alive).
 */

// Mock @xenova/transformers pipeline so LocalEmbeddingProvider.initialize never
// hits the network or loads a real model. The factory closes over `mockPipeline`
// so the same jest.fn reference is returned on every (re-)require.
const mockPipeline = jest.fn();
const mockEnv = { allowRemoteModels: true, cacheDir: "/tmp/xenova-cache" };
jest.mock("@xenova/transformers", () => ({
  pipeline: mockPipeline,
  env: mockEnv,
}));

// Mock fs so checkEmbeddingModelAvailability's existsSync call is controllable.
// Node's real `fs.existsSync` is non-configurable, so jest.spyOn cannot
// redefine it — a top-level jest.mock factory is the only way.
// TDZ discipline (same lesson as the ollamaClient factory below): the mock
// fns are declared INSIDE the factory and exposed via __mock* keys — a
// top-level `const mockExistsSync` used by the factory breaks once the
// shared-barrel import graph (@simmetric-chat/shared → config/loadEnv → fs)
// loads before this module body runs.
jest.mock("fs", () => {
  const mockExistsSync = jest.fn();
  return {
    __esModule: true,
    existsSync: mockExistsSync,
    // test-only export to retrieve the inner mock fn after dynamic imports
    __mockExistsSync: mockExistsSync,
    // Preserve any other fs APIs that might be imported elsewhere in the test
    // graph (none are used by checkEmbeddingModelAvailability, but jest.mock
    // replaces the entire module).
  };
});

// Mock env to avoid process.exit(1) on missing COLLECTOR_SECRET and control provider config
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_PORT: 3210,
    COLLECTOR_URL: "http://localhost:3210",
    SERVER_URL: "http://localhost:3000",
    EMBEDDING_PROVIDER: "ollama",
    EMBEDDING_MODEL: "nomic-embed-text-v2-moe:latest",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_KEEP_ALIVE: "10m",
    VECTOR_DB_PROVIDER: "lancedb",
    STORAGE_PATH: "./storage",
    COLLECTOR_SECRET: "test-secret-for-unit-tests",
  })),
  clearEnvCache: jest.fn(),
}));

// Also mock axios so fetchEmbeddingConfig doesn't make real HTTP calls
jest.mock("axios", () => ({
  get: jest.fn().mockRejectedValue(new Error("test: no server available")),
}));

// Mock the 92-01 collector-local ollamaClient factory. TDZ discipline under
// @swc/jest (Pitfall 5): mock fns are declared INSIDE the factory and exposed
// via __mock* keys. `jest.resetModules()` re-runs the factory, so handles
// captured before a per-test dynamic `await import("../services/embeddings")`
// point at a dead jest.fn — retrieve handles with `require()` AFTER the
// dynamic import in each test.
jest.mock("../services/ollamaClient", () => {
  const mockEmbed = jest.fn();
  const mockGetOllamaClient = jest.fn(() => ({
    embed: mockEmbed,
  }));
  return {
    getOllamaClient: mockGetOllamaClient,
    // test-only exports to retrieve the inner mock fns after a dynamic import
    __mockEmbed: mockEmbed,
    __mockGetOllamaClient: mockGetOllamaClient,
  };
});

import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { getEmbeddingProvider, checkEmbeddingModelAvailability } from "../services/embeddings";
import { WikiPagesIngestSchema } from "@simmetric-chat/shared";

const mockedGetEnv = getEnv as unknown as jest.Mock;

describe("OllamaEmbeddingProvider", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("returns actionable error when Ollama returns 404 for embedding model", async () => {
    const { getEmbeddingProvider } = await import("../services/embeddings");
    const ollamaClientMock = require("../services/ollamaClient");
    const mockEmbed = ollamaClientMock.__mockEmbed as jest.Mock;
    // Duck-typed ResponseError (Pitfall 3: ResponseError is NOT exported
    // from "ollama"; the provider normalizes by err.name + err.status_code).
    mockEmbed.mockRejectedValue({
      name: "ResponseError",
      status_code: 404,
      error: "model not found",
      message: "model not found",
    });

    const provider = await getEmbeddingProvider("nomic-embed-text-v2-moe:latest");

    await expect(provider.embed(["test text"])).rejects.toThrow(
      "Ollama embedding model 'nomic-embed-text-v2-moe:latest' not found on the Ollama server",
    );
    await expect(provider.embed(["test text"])).rejects.toThrow(
      "docker exec simmetric-chat-ollama ollama pull nomic-embed-text-v2-moe:latest",
    );
  });

  it("returns generic error without pull hint for non-404 Ollama errors", async () => {
    const { getEmbeddingProvider } = await import("../services/embeddings");
    const ollamaClientMock = require("../services/ollamaClient");
    const mockEmbed = ollamaClientMock.__mockEmbed as jest.Mock;
    mockEmbed.mockRejectedValue({
      name: "ResponseError",
      status_code: 500,
      error: "internal server error",
      message: "internal server error",
    });

    const provider = await getEmbeddingProvider("nomic-embed-text-v2-moe:latest");

    await expect(provider.embed(["test text"])).rejects.toThrow("Ollama embedding failed (500)");
    await expect(provider.embed(["test text"])).rejects.toThrow("internal server error");
    // Must NOT include the docker exec suggestion for non-404 errors
    await expect(provider.embed(["test text"])).rejects.not.toThrow("docker exec");
  });

  it("returns embeddings array on successful Ollama response", async () => {
    const { getEmbeddingProvider } = await import("../services/embeddings");
    const ollamaClientMock = require("../services/ollamaClient");
    const mockEmbed = ollamaClientMock.__mockEmbed as jest.Mock;
    const mockGetOllamaClient = ollamaClientMock.__mockGetOllamaClient as jest.Mock;
    mockEmbed.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] });

    const provider = await getEmbeddingProvider("nomic-embed-text-v2-moe:latest");

    const result = await provider.embed(["test text"]);
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    // Sanctioned call-arg pin (a): factory called with the env-resolved host
    // (mocked OLLAMA_BASE_URL → constructor trailing-slash strip → unchanged).
    expect(mockGetOllamaClient).toHaveBeenCalledWith("http://localhost:11434");
    // Sanctioned call-arg pin (b): D-04 keep_alive threaded from OLLAMA_KEEP_ALIVE.
    expect(mockEmbed).toHaveBeenCalledWith({
      model: "nomic-embed-text-v2-moe:latest",
      input: ["test text"],
      keep_alive: "10m",
    });
  });
});

describe("LocalEmbeddingProvider cold-start progress_callback", () => {
  const localEnv = {
    COLLECTOR_PORT: 3210,
    COLLECTOR_URL: "http://localhost:3210",
    SERVER_URL: "http://localhost:3000",
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    OLLAMA_BASE_URL: "http://localhost:11434",
    VECTOR_DB_PROVIDER: "lancedb",
    STORAGE_PATH: "./storage",
    COLLECTOR_SECRET: "test-secret-for-unit-tests",
  };

  beforeEach(() => {
    mockPipeline.mockReset();
    // pipeline() returns a callable that yields a tensor-like object for embed()
    mockPipeline.mockResolvedValue(
      jest.fn(async () => ({ data: new Float32Array(384) })),
    );
    mockedGetEnv.mockImplementation(() => ({ ...localEnv }));
  });

  afterEach(() => {
    mockedGetEnv.mockReset();
  });

  it("passes progress_callback in pipeline() options during initialize", async () => {
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["test text"]);

    expect(mockPipeline).toHaveBeenCalledTimes(1);
    const optionsArg = mockPipeline.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(optionsArg).toBeDefined();
    expect(typeof optionsArg.progress_callback).toBe("function");
  });

  it("progress_callback logs model load progress on 'initiate' status", async () => {
    const infoSpy = jest.spyOn(logger, "info");
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L12-v2");
    await provider.embed(["test text"]);

    const optionsArg = mockPipeline.mock.calls[0]?.[2] as { progress_callback: (p: { status?: string }) => void };
    optionsArg.progress_callback({ status: "initiate" });

    const logged = infoSpy.mock.calls.find((c) => /model load progress: initiate/.test(String(c[0])));
    expect(logged).toBeDefined();
    infoSpy.mockRestore();
  });

  it("progress_callback logs model load progress on 'ready' status", async () => {
    const infoSpy = jest.spyOn(logger, "info");
    const provider = await getEmbeddingProvider("Xenova/bge-small-en-v1.5");
    await provider.embed(["test text"]);

    const optionsArg = mockPipeline.mock.calls[0]?.[2] as { progress_callback: (p: { status?: string }) => void };
    optionsArg.progress_callback({ status: "ready" });

    const logged = infoSpy.mock.calls.find((c) => /model load progress: ready/.test(String(c[0])));
    expect(logged).toBeDefined();
    infoSpy.mockRestore();
  });

  it("getDimension returns correct dimension for configured model", async () => {
    const provider = await getEmbeddingProvider("Xenova/bge-base-en-v1.5");
    expect(provider.getDimension()).toBe(768);
  });
});

// ─── checkEmbeddingModelAvailability (260721-lrm) ────────────────
// D-02: lightweight file-presence guard so a missing local Xenova cache
// surfaces as a structured 503 instead of a silent 500 at embed() time.
describe("checkEmbeddingModelAvailability", () => {
  // Retrieve the inner mock fn from the CURRENT fs factory instance in
  // beforeEach (not at module scope): earlier describes' jest.resetModules()
  // re-instantiates the factory on next import, so a file-load capture would
  // go stale (same TDZ/dead-handle discipline as the ollamaClient factory).
  let mockExistsSync: jest.Mock;
  const localEnv = {
    COLLECTOR_PORT: 3210,
    COLLECTOR_URL: "http://localhost:3210",
    SERVER_URL: "http://localhost:3000",
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    OLLAMA_BASE_URL: "http://localhost:11434",
    VECTOR_DB_PROVIDER: "lancedb",
    STORAGE_PATH: "./storage",
    COLLECTOR_SECRET: "test-secret-for-unit-tests",
  };

  beforeEach(() => {
    mockedGetEnv.mockImplementation(() => ({ ...localEnv }));
    mockExistsSync = (
      jest.requireMock("fs") as { __mockExistsSync: jest.Mock }
    ).__mockExistsSync;
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    mockedGetEnv.mockReset();
  });

  it("returns available:true when ALL 4 quantized pipeline files exist (cache hit)", async () => {
    // 260721-np3 Task 1: the guard now verifies config.json + tokenizer_config.json
    // + tokenizer.json + onnx/model_quantized.onnx. A cache that has all 4 files
    // is a complete quantized-pipeline cache → available:true.
    mockExistsSync.mockReturnValue(true);
    const result = await checkEmbeddingModelAvailability("Xenova/all-MiniLM-L6-v2");
    expect(result.available).toBe(true);
    expect(result.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(result.provider).toBe("local");
    expect(result.error).toBeUndefined();
  });

  it("returns available:false with Air-gap hint + all 4 required files listed on full cache miss", async () => {
    // 260721-np3 Task 1: every file missing → first missing (config.json) is
    // surfaced, but the error enumerates ALL 4 required files so the operator
    // knows the full cache layout, plus the air-gap hint + resolved cache dir.
    mockExistsSync.mockReturnValue(false);
    const result = await checkEmbeddingModelAvailability("Xenova/all-MiniLM-L6-v2");
    expect(result.available).toBe(false);
    expect(result.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(result.provider).toBe("local");
    expect(result.error).toBeDefined();
    // First missing file path is surfaced (config.json is checked first).
    expect(result.error).toContain("/Xenova/all-MiniLM-L6-v2/config.json");
    // Air-gap stance so the operator does not expect an auto-download.
    expect(result.error).toContain("Air-gap");
    // Resolved cache directory is surfaced so the operator knows where to
    // restore the model files.
    expect(result.error).toContain("/Xenova/all-MiniLM-L6-v2/");
  });

  it("returns available:false when onnx/model_quantized.onnx is missing but tokenizer.json exists (live-ops false-positive regression)", async () => {
    // 260721-np3 Task 1 root cause: the old guard checked ONLY tokenizer.json,
    // so a half-seeded cache (tokenizer.json present, onnx/model_quantized.onnx
    // missing) returned available:true and then failed at pipeline load with
    // "file was not found locally at .../tokenizer_config.json". The new guard
    // must surface the onnx miss explicitly.
    mockExistsSync.mockImplementation((p: string) => !String(p).includes("onnx/model_quantized.onnx"));
    const result = await checkEmbeddingModelAvailability("Xenova/all-MiniLM-L6-v2");
    expect(result.available).toBe(false);
    expect(result.provider).toBe("local");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("onnx/model_quantized.onnx");
    expect(result.error).toContain("Air-gap");
  });

  it("returns available:false when config.json is missing even if the other 3 exist", async () => {
    // 260721-np3 Task 1: config.json is the first file checked — a miss on it
    // must fail fast (no need to check the rest of the pipeline).
    mockExistsSync.mockImplementation((p: string) => !String(p).endsWith("config.json"));
    const result = await checkEmbeddingModelAvailability("Xenova/all-MiniLM-L6-v2");
    expect(result.available).toBe(false);
    expect(result.provider).toBe("local");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("config.json");
  });

  it("returns available:false when tokenizer_config.json is missing", async () => {
    // 260721-np3 Task 1: tokenizer_config.json is the second file checked.
    mockExistsSync.mockImplementation((p: string) => !String(p).endsWith("tokenizer_config.json"));
    const result = await checkEmbeddingModelAvailability("Xenova/all-MiniLM-L6-v2");
    expect(result.available).toBe(false);
    expect(result.provider).toBe("local");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("tokenizer_config.json");
  });

  it("error message lists all 4 required files so the operator knows the full cache layout", async () => {
    // 260721-np3 Task 1: regardless of which file triggered the miss, the error
    // string enumerates all 4 required files so the operator can restore the
    // complete cache in one pass instead of fixing one file at a time.
    mockExistsSync.mockImplementation((p: string) => !String(p).endsWith("tokenizer.json"));
    const result = await checkEmbeddingModelAvailability("Xenova/all-MiniLM-L6-v2");
    expect(result.available).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("config.json");
    expect(result.error).toContain("tokenizer_config.json");
    expect(result.error).toContain("tokenizer.json");
    expect(result.error).toContain("onnx/model_quantized.onnx");
  });

  it("returns available:true for ollama provider (no pre-check needed)", async () => {
    mockedGetEnv.mockImplementation(() => ({
      ...localEnv,
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_MODEL: "nomic-embed-text:latest",
    }));
    const result = await checkEmbeddingModelAvailability("nomic-embed-text:latest");
    expect(result.available).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("nomic-embed-text:latest");
  });

  it("returns available:true for openai provider (no pre-check needed)", async () => {
    mockedGetEnv.mockImplementation(() => ({
      ...localEnv,
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_MODEL: "text-embedding-3-small",
    }));
    const result = await checkEmbeddingModelAvailability("text-embedding-3-small");
    expect(result.available).toBe(true);
    expect(result.provider).toBe("openai");
  });

  it("detects ollama model name (contains ':') even when EMBEDDING_PROVIDER=local", async () => {
    mockedGetEnv.mockImplementation(() => ({ ...localEnv }));
    const result = await checkEmbeddingModelAvailability("nomic-embed-text:latest");
    expect(result.available).toBe(true);
    expect(result.provider).toBe("ollama");
  });
});

// ─── WikiPagesIngestSchema backward-compat (260721-lrm Step E) ────
describe("WikiPagesIngestSchema backward-compat", () => {
  const validBase = {
    archiveId: "550e8400-e29b-41d4-a716-446655440000",
    pageId: "550e8400-e29b-41d4-a716-446655440001",
    slug: "home",
    title: "Home",
    bodyText: "body",
    contentHash: "abc123",
  };

  it("parses without embeddingModel (existing callers still work)", () => {
    const result = WikiPagesIngestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("parses with embeddingModel (new archive wiring)", () => {
    const result = WikiPagesIngestSchema.safeParse({
      ...validBase,
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
    });
    expect(result.success).toBe(true);
  });
});
