// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Embedding Service — Strategy Pattern
 *
 * Default: Local embedding using @xenova/transformers (air-gapped compatible)
 * Extensible: OpenAI embedding provider for cloud deployments
 *
 * The user selects the embedding model at upload time, and the appropriate
 * strategy is instantiated based on configuration.
 */

import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import axios from "axios";
import { getOllamaClient } from "./ollamaClient";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  getDimension(): number;
  getModelName(): string;
}

interface EmbeddingConfig {
  providerId: string;
  model: string;
  type: "ollama" | "openai" | "anthropic" | "local";
  baseUrl: string | null;
  apiKey: string | null;
}

async function fetchEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  try {
    const serverUrl = process.env.SERVER_URL || "http://localhost:3000";
    const response = await axios.get(`${serverUrl}/api/system/settings/embedding-config`, { timeout: 5000 });
    return response.data as EmbeddingConfig;
  } catch (err: any) {
    // A 404 is the server's intentional signal that no external embedding
    // provider is configured (EMBEDDING_PROVIDER=local) — the collector falls
    // back to the local Xenova model. This is the nominal path, so log at debug.
    // Any other failure (network, 500) is genuinely unexpected → keep warn.
    if (err.response?.status === 404) {
      logger.debug(`[embeddings] No external embedding provider configured, using local fallback`);
      return null;
    }
    logger.warn(`[embeddings] Failed to fetch embedding config from server: ${err.message}`);
    return null;
  }
}

// ─── Shared dimension map (D-05: shared, NOT duplicated) ────────────────────
// Used by both LocalEmbeddingProvider (Xenova 2.x) and HuggingFaceLocalEmbeddingProvider
// (HF v4). Same model IDs → same dims → NO re-index when switching local→hf-local.
const LOCAL_EMBEDDING_DIMENSION_MAP: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-MiniLM-L12-v2": 384,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/bge-base-en-v1.5": 768,
  "Xenova/bge-large-en-v1.5": 1024,
};

/**
 * Local embedding provider using @xenova/transformers.
 * Runs models entirely in the browser/Node.js — no external API calls.
 * Default for air-gapped deployments.
 */
class LocalEmbeddingProvider implements EmbeddingProvider {
  private pipeline: any = null;
  private modelName: string;
  private initializing: Promise<any> | null = null;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  async initialize() {
    if (this.pipeline) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      logger.info(`[embeddings] Loading local model: ${this.modelName}`);
      logger.info(`[embeddings] warming embedding model (cold start may take 5-30s)`);
      const { pipeline, env } = await import("@xenova/transformers");
      // Air-gap safety: prevent remote model downloads once the cache is seeded.
      // allowRemoteModels=false keeps the runtime off the public HF hub; the
      // cacheDir points at the on-disk cache so air-gapped nodes serve from disk.
      // HF_ALLOW_REMOTE_MODELS=true (docker-compose default) allows first-use
      // download when the cache is empty; set to false for air-gapped deployments.
      env.allowRemoteModels = process.env.HF_ALLOW_REMOTE_MODELS !== "false";
      env.cacheDir = process.env.XENOVA_CACHE_DIR || env.cacheDir;
      const progress_callback = (progress: { status?: string; file?: string; progress?: number }) => {
        const parts = [
          `[embeddings] model load progress: ${progress.status ?? ""}`,
          progress.file ?? "",
          progress.progress !== undefined ? `${Math.round(progress.progress * 100)}%` : "",
        ].filter(Boolean);
        logger.info(parts.join(" ").trimEnd());
      };
      this.pipeline = await pipeline("feature-extraction", this.modelName, {
        quantized: true, // Use quantized models for smaller size
        progress_callback,
      });
      logger.info(`[embeddings] Local model loaded: ${this.modelName}`);
    })();

    await this.initializing;
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.initialize();

    const results: number[][] = [];
    for (const text of texts) {
      const output = await this.pipeline(text, { pooling: "mean", normalize: true });
      results.push(Array.from(output.data as Float32Array));
    }

    return results;
  }

  getDimension(): number {
    return LOCAL_EMBEDDING_DIMENSION_MAP[this.modelName] || 384;
  }

  getModelName(): string {
    return this.modelName;
  }
}

/**
 * HuggingFace v4 local embedding provider (Phase 105-01).
 *
 * Air-gap successor to LocalEmbeddingProvider using the maintained
 * @huggingface/transformers v4 package (Xenova was renamed to HuggingFace).
 * Same model IDs (e.g. "Xenova/all-MiniLM-L6-v2") → same dim 384 → NO re-index.
 *
 * Air-gap stance (D-05 + D-06):
 *   - env.allowRemoteModels = false  (no HF hub downloads once cache is seeded)
 *   - env.allowLocalModels   = true   (load only from on-disk cache)
 *   - env.cacheDir            = HF_CACHE_DIR || env.cacheDir (v4 default ./.cache/)
 *   - cache miss = HARD ERROR (throw), NOT a silent network attempt.
 *
 * v4 API consistent with v3 (RESEARCH confirms identical signature):
 *   - `dtype: "q8"` works identically in v4 (no change needed).
 *   - `pipeline("feature-extraction", ...)` signature unchanged.
 *   - `env.allowRemoteModels`, `env.allowLocalModels`, `env.cacheDir` all
 *     work identically in v4.
 *
 * The provider is registered behind `EMBEDDING_PROVIDER=hf-local` (additive enum
 * branch in getEmbeddingProvider). `=local` keeps Xenova 2.x as the unchanged default.
 */
class HuggingFaceLocalEmbeddingProvider implements EmbeddingProvider {
  private pipeline: any = null;
  private modelName: string;
  private initializing: Promise<any> | null = null;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  async initialize() {
    if (this.pipeline) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      logger.info(`[embeddings] Loading HF v4 local model: ${this.modelName}`);
      logger.info(`[embeddings] warming HF v4 embedding model (cold start may take 5-30s)`);
      const { pipeline, env } = await import("@huggingface/transformers");
      // Air-gap safety (D-05): fail-closed — no remote HF hub downloads.
      // A cache miss throws at pipeline() load time, NOT a silent network attempt.
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.cacheDir = process.env.HF_CACHE_DIR || env.cacheDir;
      // dtype: "q8" works identically in HF v4 (no change needed — v4 API
      // is identical to v3 per RESEARCH; never pass `quantized` which would
      // silently load fp32, 5x larger/slower).
      const progress_callback = (progress: { status?: string; file?: string; progress?: number }) => {
        const parts = [
          `[embeddings] HF v4 model load progress: ${progress.status ?? ""}`,
          progress.file ?? "",
          progress.progress !== undefined ? `${Math.round(progress.progress * 100)}%` : "",
        ].filter(Boolean);
        logger.info(parts.join(" ").trimEnd());
      };
      this.pipeline = await pipeline("feature-extraction", this.modelName, {
        dtype: "q8",
        progress_callback,
      });
      logger.info(`[embeddings] HF v4 local model loaded: ${this.modelName}`);
    })();

    await this.initializing;
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.initialize();

    const results: number[][] = [];
    for (const text of texts) {
      const output = await this.pipeline(text, { pooling: "mean", normalize: true });
      results.push(Array.from(output.data as Float32Array));
    }

    return results;
  }

  getDimension(): number {
    // D-05: SHARE the dimension map with LocalEmbeddingProvider — do NOT duplicate.
    return LOCAL_EMBEDDING_DIMENSION_MAP[this.modelName] || 384;
  }

  getModelName(): string {
    return this.modelName;
  }
}

/**
 * OpenAI embedding provider.
 * Requires OPENAI_API_KEY or EMBEDDING_API_KEY in environment.
 */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = "text-embedding-3-small") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${error}`);
    }

    const data: any = await response.json();
    return data.data.sort((a: any, b: any) => a.index - b.index).map((item: any) => item.embedding);
  }

  getDimension(): number {
    const dimensionMap: Record<string, number> = {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
      "text-embedding-ada-002": 1536,
    };
    return dimensionMap[this.model] || 1536;
  }

  getModelName(): string {
    return this.model;
  }
}

/**
 * Ollama embedding provider.
 * Calls the Ollama daemon through the official ollama-js client obtained from
 * the collector-local getOllamaClient factory (single Ollama plumbing, D-01);
 * `keep_alive` flows from OLLAMA_KEEP_ALIVE (D-04) so the embedding model stays
 * resident between ingest batches. Errors are duck-typed at the boundary
 * (ResponseError is thrown by ollama-js but NOT exported — Pitfall 3); no
 * ollama-js error type escapes this provider (D-08).
 */
class OllamaEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // No timeout option (Pitfall 1): the pre-migration fetch plumbing had no
    // timeout (call-site inventory #12), and the factory's no-timeout default
    // preserves that semantics exactly — adding one here would be an
    // unsanctioned behavior change outside the locked migration scope.
    const client = getOllamaClient(this.baseUrl);
    try {
      const response = await client.embed({
        model: this.model,
        input: texts,
        keep_alive: getEnv().OLLAMA_KEEP_ALIVE,
      });
      if (!response.embeddings || !Array.isArray(response.embeddings)) {
        throw new Error("Ollama embedding response missing embeddings array");
      }
      // D-09: batch pass-through — EmbedResponse.embeddings is number[][], the
      // exact shape the EmbeddingProvider interface returns. The embeddings[0]
      // unwrap clause is vacuous at this call site (no single-text caller).
      return response.embeddings;
    } catch (err: unknown) {
      // Duck-typed ResponseError (Pitfall 3): ResponseError is thrown by
      // ollama-js but NOT exported — importing it fails typecheck. Normalize
      // by err.name + err.status_code; non-ResponseError errors (TypeError
      // fetch failed, TimeoutError) propagate unchanged (D-08 parity with
      // the pre-migration fetch-failure path).
      const e = err as { name?: string; status_code?: number; error?: string };
      if (e?.name === "ResponseError") {
        const status = e.status_code;
        const body = e.error ?? (err instanceof Error ? err.message : String(err));
        if (status === 404) {
          throw new Error(
            `Ollama embedding model '${this.model}' not found on the Ollama server. ` +
            `Pull it first: docker exec simmetric-chat-ollama ollama pull ${this.model}`,
            { cause: err },
          );
        }
        if (typeof status === "number") {
          throw new Error(`Ollama embedding failed (${status}): ${body}`, {
            cause: err,
          });
        }
      }
      throw err;
    }
  }

  getDimension(): number {
    const dimensionMap: Record<string, number> = {
      "nomic-embed-text": 768,
      "all-minilm": 384,
      "mxbai-embed-large": 1024,
      "bge-m3": 1024,
      "bge-large": 1024,
      "snowflake-arctic-embed": 1024,
    };
    const key = Object.keys(dimensionMap).find((k) => this.model.includes(k));
    return key ? (dimensionMap[key] ?? 768) : 768;
  }

  getModelName(): string {
    return this.model;
  }
}

// Cache for initialized providers to avoid re-loading models
const providerCache = new Map<string, EmbeddingProvider>();

/**
 * Get an embedding provider based on configuration.
 * Uses a cache to avoid re-initializing models on each request.
 * Prefers Provider system config; falls back to environment variables.
 */
export async function getEmbeddingProvider(model?: string): Promise<EmbeddingProvider> {
  // 1. Try Provider system
  const config = await fetchEmbeddingConfig();
  if (config) {
    // Cache key MUST match the model the provider is actually constructed
    // with. The provider uses `model || config.model` (per-request override
    // wins), so two requests that resolve to the same `config` but pass
    // different `model` overrides must NOT share a cache entry — otherwise
    // request B silently receives a provider built with request A's model,
    // producing wrong-dimension vectors with no error (CR-02). Keying on the
    // effective model guarantees a 1:1 match between cache key and the
    // constructed provider's model.
    const effectiveModel = model || config.model;
    const cacheKey = `${config.providerId}:${effectiveModel}`;
    if (providerCache.has(cacheKey)) {
      return providerCache.get(cacheKey)!;
    }

    let provider: EmbeddingProvider;
    if (config.type === "openai") {
      if (!config.apiKey) {
        throw new Error("OpenAI embedding provider requires an API key");
      }
      provider = new OpenAIEmbeddingProvider(config.apiKey, effectiveModel);
    } else if (config.type === "ollama") {
      provider = new OllamaEmbeddingProvider(config.baseUrl || "", effectiveModel);
    } else if (config.type === "local") {
      // Local embedding (Xenova/transformers) — model from settings page
      provider = new LocalEmbeddingProvider(effectiveModel);
    } else {
      // Anthropic and any other unknown types fall back to local
      provider = new LocalEmbeddingProvider(effectiveModel);
    }

    providerCache.set(cacheKey, provider);
    return provider;
  }

  // 2. Fallback to legacy env vars
  const env = getEnv();
  const providerType = env.EMBEDDING_PROVIDER;
  const modelName = model || env.EMBEDDING_MODEL || "";
  const cacheKey = `${providerType}:${modelName}`;

  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)!;
  }

  let provider: EmbeddingProvider;

  // Detect Ollama model names (e.g. "nomic-embed-text:latest") even in fallback mode
  const isOllamaModel = modelName.includes(":") || modelName.toLowerCase().startsWith("ollama/");

  switch (providerType) {
    case "openai":
      if (!env.EMBEDDING_API_KEY && !process.env.OPENAI_API_KEY) {
        throw new Error("OpenAI embedding provider requires EMBEDDING_API_KEY or OPENAI_API_KEY");
      }
      provider = new OpenAIEmbeddingProvider(
        env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "",
        modelName,
      );
      break;
    case "ollama":
      provider = new OllamaEmbeddingProvider(env.OLLAMA_BASE_URL, modelName);
      break;
    case "hf-local":
      // Phase 105-01: HF v4 provider. Same model IDs as "local" (Xenova),
      // same dim 384 → NO re-index. Air-gap: allowRemoteModels=false (hard error on miss).
      if (isOllamaModel) {
        // Defensive: an Ollama-shaped model name wins even under hf-local, matching
        // the "local" branch's fallback. Keeps the ollama-detection invariant uniform.
        provider = new OllamaEmbeddingProvider(env.OLLAMA_BASE_URL, modelName);
      } else {
        provider = new HuggingFaceLocalEmbeddingProvider(modelName);
      }
      break;
    case "local":
    default:
      if (isOllamaModel) {
        provider = new OllamaEmbeddingProvider(env.OLLAMA_BASE_URL, modelName);
      } else {
        provider = new LocalEmbeddingProvider(modelName);
      }
      break;
  }

  providerCache.set(cacheKey, provider);
  return provider;
}

// ─── Model availability guard (260721-lrm, D-02) ─────────────────
// Lightweight file-presence check so a configured-but-not-locally-available
// embedding model is surfaced as a structured 503 instead of a silent 500 at
// embed() time. Does NOT instantiate the pipeline (no model load, no network)
// — O(1) per request. Used by the wiki-pages ingest route to pre-flight the
// local Xenova cache before chunking. Air-gap stance (allowRemoteModels=false)
// is unchanged: a cache miss is an operator-actionable error, not an
// auto-download trigger.

export interface EmbeddingModelAvailability {
  available: boolean;
  model: string;
  provider: string;
  error?: string;
}

/**
 * Resolve the effective model + provider type using the SAME precedence as
 * `getEmbeddingProvider`, then for the local Xenova provider only, run a
 * file-presence check on the 4 files the quantized pipeline actually loads.
 * For ollama/openai providers, return `available: true` — these providers
 * already fail with clear actionable errors at embed() time (see
 * `OllamaEmbeddingProvider` "Pull it first: ..." message), so no pre-check
 * is needed (blast-radius minimization).
 *
 * 260721-np3 Task 1: the guard now verifies the complete quantized-pipeline
 * cache layout (config.json + tokenizer_config.json + tokenizer.json +
 * onnx/model_quantized.onnx) instead of only tokenizer.json. A half-seeded
 * cache (e.g. tokenizer.json present but onnx/model_quantized.onnx missing)
 * previously passed the guard and then failed at pipeline load with a
 * confusing `file was not found locally at .../tokenizer_config.json` error.
 * The new guard surfaces the FIRST missing file path AND enumerates all 4
 * required files in the error so the operator can restore the full cache in
 * one pass. Air-gap stance (allowRemoteModels=false) is unchanged — a cache
 * miss is an operator-actionable error, not an auto-download trigger.
 */
export async function checkEmbeddingModelAvailability(
  model?: string,
): Promise<EmbeddingModelAvailability> {
  // 1. Resolve provider type + effective model using the same precedence
  //    as getEmbeddingProvider: Provider system config first, then env vars.
  const config = await fetchEmbeddingConfig();
  let providerType: string;
  let effectiveModel: string;

  if (config) {
    providerType = config.type;
    effectiveModel = model || config.model;
  } else {
    const env = getEnv();
    providerType = env.EMBEDDING_PROVIDER;
    effectiveModel = model || env.EMBEDDING_MODEL || "";
  }

  // Detect Ollama model names (e.g. "nomic-embed-text:latest") even when the
  // configured provider is local — matches getEmbeddingProvider's fallback.
  const isOllamaModel =
    effectiveModel.includes(":") || effectiveModel.toLowerCase().startsWith("ollama/");

  if (isOllamaModel) {
    providerType = "ollama";
  }

  // 2. For ollama / openai: no pre-check — these providers surface clear
  //    actionable errors at embed() time. Pinging them here would amplify
  //    latency and blast radius.
  if (providerType === "ollama" || providerType === "openai") {
    return { available: true, model: effectiveModel, provider: providerType };
  }

  const fs = await import("fs");

  // Phase 105-01: HF v4 provider branch — air-gap cache pre-flight.
  // cacheDir resolution mirrors HuggingFaceLocalEmbeddingProvider.initialize:
  // HF_CACHE_DIR env var wins, else the @huggingface/transformers default.
  //
  // Pitfall 7 / A2: HF v4's on-disk cache layout for `Xenova/all-MiniLM-L6-v2`
  // is the documented 4-file Xenova-like layout (config.json,
  // tokenizer_config.json, tokenizer.json, onnx/model_quantized.onnx). This
  // assumption is verified empirically by the checkpoint:human-verify in
  // plan 89-03 Task 3.5; if the layout differs, this guard is adapted. The
  // D-06 air-gap test (hfLocalEmbedding.airgap.test.ts) is the safety net.
  if (providerType === "hf-local") {
    const { env: hfEnv } = await import("@huggingface/transformers");
    const cacheDir = process.env.HF_CACHE_DIR || hfEnv.cacheDir;
    const modelDir = `${cacheDir}/${effectiveModel}`;
    const REQUIRED_FILES = [
      "config.json",
      "tokenizer_config.json",
      "tokenizer.json",
      "onnx/model_quantized.onnx",
    ] as const;

    for (const relativePath of REQUIRED_FILES) {
      const filePath = `${modelDir}/${relativePath}`;
      if (!fs.existsSync(filePath)) {
        return {
          available: false,
          model: effectiveModel,
          provider: "hf-local",
          error:
            `HF v4 model file not found at ${filePath}. ` +
            `Restore the HF v4 cache (place all 4 files: config.json, tokenizer_config.json, tokenizer.json, onnx/model_quantized.onnx under ${modelDir}) ` +
            `or change EMBEDDING_MODEL. Air-gap stance (allowRemoteModels=false, allowLocalModels=true) prevents auto-download; ` +
            `set HF_CACHE_DIR to point at the on-disk cache.`,
        };
      }
    }
    return { available: true, model: effectiveModel, provider: "hf-local" };
  }

  // 3. Local Xenova provider: file-presence check on the cache directory.
  //    cacheDir resolution mirrors LocalEmbeddingProvider.initialize:
  //    XENOVA_CACHE_DIR env var wins, else the transformers default.
  const { env: xenovaEnv } = await import("@xenova/transformers");
  const cacheDir = process.env.XENOVA_CACHE_DIR || xenovaEnv.cacheDir;
  const modelDir = `${cacheDir}/${effectiveModel}`;

  // 260721-np3 Task 1 — the 4 files the quantized pipeline loads (verified
  // from the Xenova cache layout on the Trash host). Order matters for the
  // error message: the FIRST missing file is surfaced as the specific path,
  // then all 4 required files are enumerated so the operator knows the full
  // cache layout and can restore the complete cache in one pass.
  const REQUIRED_FILES = [
    "config.json",
    "tokenizer_config.json",
    "tokenizer.json",
    "onnx/model_quantized.onnx",
  ] as const;

  for (const relativePath of REQUIRED_FILES) {
    const filePath = `${modelDir}/${relativePath}`;
    if (!fs.existsSync(filePath)) {
      return {
        available: false,
        model: effectiveModel,
        provider: "local",
        error:
          `Model file not found at ${filePath}. ` +
          `Restore the Xenova cache (place all 4 files: config.json, tokenizer_config.json, tokenizer.json, onnx/model_quantized.onnx under ${modelDir}) ` +
          `or change EMBEDDING_MODEL. Air-gap stance (allowRemoteModels=false) prevents auto-download.`,
      };
    }
  }

  return { available: true, model: effectiveModel, provider: "local" };
}
