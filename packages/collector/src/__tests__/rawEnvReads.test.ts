// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * Phase 178 (raw-env-reads-guard) — COLLECTOR raw-channel behavioral guard
 * suite.
 *
 * Phase 176 consolidated env parsing into Zod (fail-loud) and Phase 177 added
 * the root-env loader (loadRootEnv). The keys below are DOCUMENTED raw
 * `process.env` reads (docs/CONFIGURATION.md "Zod validation" paragraph) that
 * are deliberately NOT in the collector Zod schema. These suites ARE the
 * regression tripwire: any refactor (Zod absorption, loader shadowing, rename)
 * that removes the raw reads turns them RED.
 *
 * Guarded here (behavioral probes at the consumption sites):
 *   1. HF_ALLOW_REMOTE_MODELS ×2 sites:
 *        - embeddings.ts:95  (LocalEmbeddingProvider — import @xenova/transformers)
 *        - reranker.ts:118   (CrossEncoderReranker.initialize — @xenova/transformers)
 *      NOTE: the `hf-local` provider (HuggingFaceLocalEmbeddingProvider,
 *      @huggingface/transformers) HARD-CODES allowRemoteModels=false — the
 *      raw read exists ONLY in the two @xenova sites above. The probes route
 *      through the provider that actually performs each raw read.
 *   2. XENOVA_CACHE_DIR (embeddings.ts:96, Xenova path)
 *   3. HF_CACHE_DIR (embeddings.ts:182, HF v4 path)
 *   4. Reranker cache chain: RERANKER_CACHE_DIR || HF_CACHE_DIR (reranker.ts:122)
 *   5. OPENAI_API_KEY dual-path (embeddings.ts:420-424): raw channel vs the
 *      Zod EMBEDDING_API_KEY channel — proven as two INDEPENDENT channels;
 *      either alone satisfies the openai provider; Zod wins when both set.
 *   6. LOG_LEVEL (utils/logger.ts:16 MODULE-LOAD read)
 *   7. D-03 schema-absence tripwire against the REAL collector env.ts schema.
 *
 * Doctrine: mock the package name each module actually imports (the airgap
 * files' top comments warn exactly about this trap); ONE ../config/env mock
 * per fresh-module describe so behavior comes from real process.env;
 * jest.resetModules() per probe (module-level providerCache must not leak);
 * delete-never-undefined save/restore in afterEach (T-178-02); placeholder
 * fixtures only (T-178-01); DB-free and network-free (transformers/axios/fs
 * mocked, https.request + fetch monkeypatched to throw).
 */

// ─── Mock the transformers packages (BOTH names — see header note) ──────────
const mockPipelineFactory = jest.fn();
const mockXenovaEnv = {
  allowRemoteModels: true, // pre-state; LocalEmbeddingProvider.initialize() flips from raw env
  allowLocalModels: false,
  cacheDir: "/tmp/xenova-default-cache", // the mock's default — asserted on delete
};
const mockHfEnv = {
  allowRemoteModels: true, // pre-state; hf-local provider hardcodes false
  allowLocalModels: false,
  cacheDir: "/tmp/hf-v4-default-cache", // the mock's default — asserted on delete
};
jest.mock("@xenova/transformers", () => ({
  pipeline: mockPipelineFactory,
  env: mockXenovaEnv,
}));
jest.mock("@huggingface/transformers", () => ({
  pipeline: mockPipelineFactory,
  env: mockHfEnv,
}));

// Mock fs so any existsSync pre-flight (reranker availability guard) is inert.
const mockExistsSync = jest.fn();
jest.mock("fs", () => ({
  existsSync: mockExistsSync,
}));

// ─── ../config/env mock with per-case mutation hooks ─────────────────────────
// One mutable envValues object the getEnv stub reads from; beforeEach resets.
const envValues: Record<string, string | undefined> = {};
const ENV_DEFAULTS: Record<string, string | undefined> = {
  COLLECTOR_PORT: "3210",
  COLLECTOR_URL: "http://localhost:3210",
  SERVER_URL: "http://localhost:3000",
  EMBEDDING_PROVIDER: "local",
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
};
const mockedGetEnv = jest.fn(() => ({ ...ENV_DEFAULTS, ...envValues }));
jest.mock("../config/env", () => ({
  getEnv: mockedGetEnv,
  clearEnvCache: jest.fn(),
}));

// Mock axios so fetchEmbeddingConfig rejects (config = null → env-var
// fallback path — exactly the path the raw reads live on).
jest.mock("axios", () => ({
  get: jest.fn().mockRejectedValue(new Error("test: no server available")),
}));

import https from "https";

// ─── Network fail-closed monkeypatch (T-178 airgap precedents) ───────────────
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

// ─── Env save/restore doctrine (T-178-02: delete never assign undefined) ─────
const TOUCHED_ENV_KEYS = [
  "HF_ALLOW_REMOTE_MODELS",
  "HF_CACHE_DIR",
  "XENOVA_CACHE_DIR",
  "RERANKER_CACHE_DIR",
  "OPENAI_API_KEY",
  "COLLECTOR_SECRET",
  "LOG_LEVEL",
] as const;
const ORIGINALS: Record<string, string | undefined> = {};
for (const key of TOUCHED_ENV_KEYS) {
  ORIGINALS[key] = process.env[key];
}

afterEach(() => {
  for (const key of TOUCHED_ENV_KEYS) {
    if (ORIGINALS[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINALS[key];
    }
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(envValues, ENV_DEFAULTS);
  envValues.EMBEDDING_API_KEY = undefined;
  envValues.RERANKER_CACHE_DIR = undefined;
  mockXenovaEnv.allowRemoteModels = true;
  mockXenovaEnv.allowLocalModels = false;
  mockXenovaEnv.cacheDir = "/tmp/xenova-default-cache";
  mockHfEnv.allowRemoteModels = true;
  mockHfEnv.allowLocalModels = false;
  mockHfEnv.cacheDir = "/tmp/hf-v4-default-cache";
  mockPipelineFactory.mockImplementation(() => {
    return async (text: string) => ({
      data: new Float32Array(384).fill(0.01),
    });
  });
  mockExistsSync.mockImplementation(() => true);
});

// ─── RAW_ENV_EXCEPTIONS (D-03 — per-package tripwire constant) ───────────────
// The collector raw-only keys per docs/CONFIGURATION.md. If any is absorbed
// into the Zod schema, the D-03 block below fails.
const RAW_ENV_EXCEPTIONS: ReadonlySet<string> = new Set([
  "HF_ALLOW_REMOTE_MODELS",
  "HF_CACHE_DIR",
  "XENOVA_CACHE_DIR",
  "OPENAI_API_KEY",
]);

// Placeholder fixtures (T-178-01: values carry no secret material).
const RAW_OPENAI_PLACEHOLDER = "raw-channel-openai-placeholder";
const ZOD_EMBEDDING_PLACEHOLDER = "zod-channel-embedding-placeholder";

// ─── Fresh-module helpers (module-level providerCache must not leak) ─────────

/** Fresh embeddings module. envValues.EMBEDDING_PROVIDER selects which provider
 * getEmbeddingProvider constructs (local → @xenova … / hf-local → @huggingface). */
async function freshEmbeddings() {
  jest.resetModules();
  jest.doMock("@xenova/transformers", () => ({
    pipeline: mockPipelineFactory,
    env: mockXenovaEnv,
  }));
  jest.doMock("@huggingface/transformers", () => ({
    pipeline: mockPipelineFactory,
    env: mockHfEnv,
  }));
  jest.doMock("fs", () => ({ existsSync: mockExistsSync }));
  jest.doMock("../config/env", () => ({ getEnv: mockedGetEnv, clearEnvCache: jest.fn() }));
  jest.doMock("axios", () => ({
    get: jest.fn().mockRejectedValue(new Error("no server")),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../services/embeddings") as typeof import("../services/embeddings");
}

/** Fresh reranker module (mock @xenova — the package reranker.ts imports). */
async function freshReranker() {
  jest.resetModules();
  jest.doMock("@xenova/transformers", () => ({
    pipeline: mockPipelineFactory,
    env: mockXenovaEnv,
  }));
  jest.doMock("fs", () => ({ existsSync: mockExistsSync }));
  jest.doMock("../config/env", () => ({ getEnv: mockedGetEnv, clearEnvCache: jest.fn() }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../services/reranker") as typeof import("../services/reranker");
}

// ═════════════════════════════════════════════════════════════════════════════
// 1a. HF_ALLOW_REMOTE_MODELS — embeddings site (LocalEmbeddingProvider/@xenova)
// ═════════════════════════════════════════════════════════════════════════════
describe("HF_ALLOW_REMOTE_MODELS raw channel — embeddings site (LocalEmbeddingProvider)", () => {
  it('HF_ALLOW_REMOTE_MODELS="false" → after initialize(), allowRemoteModels === false', async () => {
    process.env.HF_ALLOW_REMOTE_MODELS = "false";
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["trigger initialize"]);
    expect(mockXenovaEnv.allowRemoteModels).toBe(false);
  });

  it("deleted → allowRemoteModels === true (default allows first-use download)", async () => {
    delete process.env.HF_ALLOW_REMOTE_MODELS;
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["trigger initialize"]);
    expect(mockXenovaEnv.allowRemoteModels).toBe(true);
  });

  it('HF_ALLOW_REMOTE_MODELS="true" → allowRemoteModels === true (only exact "false" closes)', async () => {
    process.env.HF_ALLOW_REMOTE_MODELS = "true";
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["trigger initialize"]);
    expect(mockXenovaEnv.allowRemoteModels).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1b. HF_ALLOW_REMOTE_MODELS — reranker site (CrossEncoderReranker/@xenova)
// ═════════════════════════════════════════════════════════════════════════════
describe("HF_ALLOW_REMOTE_MODELS raw channel — reranker site", () => {
  it('HF_ALLOW_REMOTE_MODELS="false" → after initialize(), allowRemoteModels === false', async () => {
    process.env.HF_ALLOW_REMOTE_MODELS = "false";
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    await reranker.rerank("trigger initialize", [{ chunkText: "c" }]);
    expect(mockXenovaEnv.allowRemoteModels).toBe(false);
  });

  it("deleted → allowRemoteModels === true", async () => {
    delete process.env.HF_ALLOW_REMOTE_MODELS;
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    await reranker.rerank("trigger initialize", [{ chunkText: "c" }]);
    expect(mockXenovaEnv.allowRemoteModels).toBe(true);
  });

  it('"true" → allowRemoteModels === true', async () => {
    process.env.HF_ALLOW_REMOTE_MODELS = "true";
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    await reranker.rerank("trigger initialize", [{ chunkText: "c" }]);
    expect(mockXenovaEnv.allowRemoteModels).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Cache-dir raw overrides (XENOVA / HF / reranker chain)
// ═════════════════════════════════════════════════════════════════════════════
describe("Cache-dir raw overrides", () => {
  it("XENOVA_CACHE_DIR set (embeddings Xenova path) → mockEnv.cacheDir === that value", async () => {
    process.env.XENOVA_CACHE_DIR = "/tmp/xenova-raw-probe";
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["trigger initialize"]);
    expect(mockXenovaEnv.cacheDir).toBe("/tmp/xenova-raw-probe");
  });

  it("XENOVA_CACHE_DIR deleted → cacheDir stays the mock default (no override)", async () => {
    delete process.env.XENOVA_CACHE_DIR;
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["trigger initialize"]);
    expect(mockXenovaEnv.cacheDir).toBe("/tmp/xenova-default-cache");
  });

  it("HF_CACHE_DIR set (embeddings hf-local path) → lands in cacheDir", async () => {
    envValues.EMBEDDING_PROVIDER = "hf-local";
    process.env.HF_CACHE_DIR = "/tmp/hf-raw-probe";
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("Xenova/all-MiniLM-L6-v2");
    await provider.embed(["trigger initialize"]);
    expect(mockHfEnv.cacheDir).toBe("/tmp/hf-raw-probe");
  });

  it("Reranker chain: RERANKER_CACHE_DIR set → wins over HF_CACHE_DIR", async () => {
    process.env.RERANKER_CACHE_DIR = "/tmp/reranker-raw-probe";
    process.env.HF_CACHE_DIR = "/tmp/hf-raw-probe";
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    await reranker.rerank("trigger initialize", [{ chunkText: "c" }]);
    expect(mockXenovaEnv.cacheDir).toBe("/tmp/reranker-raw-probe");
  });

  it("Reranker chain: RERANKER_CACHE_DIR deleted + HF_CACHE_DIR set → HF_CACHE_DIR wins (D-04 ordering)", async () => {
    delete process.env.RERANKER_CACHE_DIR;
    process.env.HF_CACHE_DIR = "/tmp/hf-raw-probe";
    const { getReranker } = await freshReranker();
    const reranker = await getReranker();
    await reranker.rerank("trigger initialize", [{ chunkText: "c" }]);
    expect(mockXenovaEnv.cacheDir).toBe("/tmp/hf-raw-probe");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. OPENAI_API_KEY dual-path — raw channel vs Zod EMBEDDING_API_KEY channel
// ═════════════════════════════════════════════════════════════════════════════
describe("OPENAI_API_KEY dual-path (embeddings.ts openai branch)", () => {
  beforeEach(() => {
    envValues.EMBEDDING_PROVIDER = "openai";
    envValues.EMBEDDING_MODEL = "text-embedding-3-small";
  });

  it("case A: EMBEDDING_API_KEY undefined + OPENAI_API_KEY set → provider uses the RAW value (raw channel alive)", async () => {
    delete envValues.EMBEDDING_API_KEY;
    process.env.OPENAI_API_KEY = RAW_OPENAI_PLACEHOLDER;
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("raw-openai-guard-model");
    expect((provider as any).apiKey).toBe(RAW_OPENAI_PLACEHOLDER);
    expect(provider.getModelName()).toBe("raw-openai-guard-model");
  });

  it("case B: EMBEDDING_API_KEY set (Zod mock) + OPENAI_API_KEY deleted → provider uses the Zod value (Zod channel alive)", async () => {
    envValues.EMBEDDING_API_KEY = ZOD_EMBEDDING_PLACEHOLDER;
    delete process.env.OPENAI_API_KEY;
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("zod-openai-guard-model");
    expect((provider as any).apiKey).toBe(ZOD_EMBEDDING_PLACEHOLDER);
    expect(provider.getModelName()).toBe("zod-openai-guard-model");
  });

  it("case C: BOTH set → provider uses the Zod EMBEDDING_API_KEY value (independence: Zod wins, raw still readable)", async () => {
    envValues.EMBEDDING_API_KEY = ZOD_EMBEDDING_PLACEHOLDER;
    process.env.OPENAI_API_KEY = RAW_OPENAI_PLACEHOLDER;
    const { getEmbeddingProvider } = await freshEmbeddings();
    const provider = await getEmbeddingProvider("both-guard-model");
    expect((provider as any).apiKey).toBe(ZOD_EMBEDDING_PLACEHOLDER);
    expect(process.env.OPENAI_API_KEY).toBe(RAW_OPENAI_PLACEHOLDER); // raw channel untouched
  });

  it("case D: both deleted → throws /requires EMBEDDING_API_KEY or OPENAI_API_KEY/", async () => {
    delete envValues.EMBEDDING_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { getEmbeddingProvider } = await freshEmbeddings();
    await expect(getEmbeddingProvider("no-key-guard-model")).rejects.toThrow(
      /requires EMBEDDING_API_KEY or OPENAI_API_KEY/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. LOG_LEVEL — utils/logger.ts MODULE-LOAD read
// ═════════════════════════════════════════════════════════════════════════════
describe("LOG_LEVEL module-load read (utils/logger.ts)", () => {
  it('LOG_LEVEL="debug" at import → logger.level === "debug"', async () => {
    process.env.LOG_LEVEL = "debug";
    jest.resetModules();
    const { logger } = await import("../utils/logger");
    expect(logger.level).toBe("debug");
  });

  it("LOG_LEVEL deleted at import → logger.level === \"info\" (default intact)", async () => {
    delete process.env.LOG_LEVEL;
    jest.resetModules();
    const { logger } = await import("../utils/logger");
    expect(logger.level).toBe("info");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. D-03 schema-absence tripwire — against the REAL collector env.ts
// ═════════════════════════════════════════════════════════════════════════════
describe("D-03 schema-absence tripwire (collector env.ts — REAL schema)", () => {
  function makeRealEnvHermetic(): void {
    // Collector unit tests have no auto-loaded .env.test (airgap suites mock
    // ../config/env precisely to avoid process.exit) — make the REAL getEnv()
    // call hermetic first: the only .min(1) required key is COLLECTOR_SECRET.
    if (!process.env.COLLECTOR_SECRET) {
      process.env.COLLECTOR_SECRET = "raw-env-reads-guard-hermetic-secret";
    }
  }

  async function realSchemaKeys(): Promise<string[]> {
    makeRealEnvHermetic();
    jest.dontMock("../config/env");
    jest.dontMock("../utils/logger");
    jest.dontMock("@simmetric-chat/shared");
    jest.resetModules();
    const envModule = await import("../config/env");
    envModule.clearEnvCache();
    return Object.keys(envModule.getEnv());
  }

  it("HF_ALLOW_REMOTE_MODELS is ABSENT from Object.keys(getEnv())", async () => {
    expect(RAW_ENV_EXCEPTIONS.has("HF_ALLOW_REMOTE_MODELS")).toBe(true);
    expect(await realSchemaKeys()).not.toContain("HF_ALLOW_REMOTE_MODELS");
  });

  it("HF_CACHE_DIR is ABSENT from Object.keys(getEnv())", async () => {
    expect(RAW_ENV_EXCEPTIONS.has("HF_CACHE_DIR")).toBe(true);
    expect(await realSchemaKeys()).not.toContain("HF_CACHE_DIR");
  });

  it("XENOVA_CACHE_DIR is ABSENT from Object.keys(getEnv())", async () => {
    expect(RAW_ENV_EXCEPTIONS.has("XENOVA_CACHE_DIR")).toBe(true);
    expect(await realSchemaKeys()).not.toContain("XENOVA_CACHE_DIR");
  });

  it("OPENAI_API_KEY is ABSENT from Object.keys(getEnv())", async () => {
    expect(RAW_ENV_EXCEPTIONS.has("OPENAI_API_KEY")).toBe(true);
    expect(await realSchemaKeys()).not.toContain("OPENAI_API_KEY");
  });
});