// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * CrossEncoder Reranker Service — Phase 93 / RER-01
 *
 * Collector-side CrossEncoder inference layer that the server (93-02) calls
 * post-RRF to re-score the fused top-K candidate list. Sibling of
 * HuggingFaceLocalEmbeddingProvider (embeddings.ts:149-214); ~90% structural
 * reuse — lazy `pipeline()` load, air-gap stance, `initializing` promise mutex.
 *
 * Design decisions (see 93-01-PLAN.md must_haves.decisions):
 *   D-01: new file + getReranker() lazy singleton (sibling of HF local embed).
 *   D-04: RERANKER_MODEL default `Xenova/bge-reranker-base`
 *         (A1 correction — BAAI/bge-reranker-v2-m3 ships safetensors-only and
 *         throws at pipeline() load time under JS; the ONNX-community fork is
 *         the Transformers.js-tagged model).
 *   D-05: rerank score = sigmoid(logit) = 1/(1+Math.exp(-score)) → 0..1 prob;
 *         candidates sorted DESC by the route (rerank() returns scores in
 *         candidate order so the route can re-align by index).
 *   D-06: Xenova v2 (^4.2.0, upgraded from ^3.8.1 in 105-01); dtype 'q8' (NOT quantized:true — Pitfall 3:
 *         passing `quantized` silently ignores and loads fp32, 5x larger/slower).
 *   D-08: rerank is a pure function over {query, candidates}; warm-cache latency
 *         target ~50ms +1 hop is a design target, NOT a CI gate.
 *
 * Air-gap stance (T-93-01 mitigate):
 *   - env.allowRemoteModels = false  (no HF hub downloads once cache is seeded)
 *   - env.allowLocalModels   = true   (load only from on-disk cache)
 *   - env.cacheDir            = RERANKER_CACHE_DIR || HF_CACHE_DIR || env.cacheDir
 *   - cache miss = HARD ERROR (throw), NOT a silent network attempt (mirror
 *     embeddings.ts:170-171).
 *
 * Concurrency (RER-01 auto-covered): the `initializing` promise mutex mirrors
 * HuggingFaceLocalEmbeddingProvider — concurrent rerank calls share one pipeline
 * instance (no double-load race). Interruption mid-rerank returns the RRF
 * candidate order unchanged (graceful fallback handled by the server caller);
 * rerank is a pure function with no shared mutable state.
 */

import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

export interface RerankCandidate {
  chunkText: string;
}

export interface RerankScore {
  score: number;
}

// NOTE: the 4 files the quantized ONNX pipeline actually loads (mirror of
// embeddings.ts REQUIRED_FILES) are documented in the operator runbook and
// the CrossEncoderReranker pipeline-load errors — the former
// checkRerankerAvailability() pre-flight that enumerated them was removed
// with the Phase 180 dead-code sweep (no production caller).

/**
 * Sigmoid mapping raw CrossEncoder logits to 0..1 probabilities (D-05).
 * `1/(1+Math.exp(-score))`. Clamped to [0,1] to absorb fp overflow at the
 * tails (Math.exp(-large) → 0 → 1.0; Math.exp(large) → Infinity → 0.0).
 */
function sigmoid(logit: number): number {
  const p = 1 / (1 + Math.exp(-logit));
  if (Number.isNaN(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * CrossEncoder reranker — loads a `text-classification` pipeline over the
 * ONNX-quantized bge-reranker-v2-m3 model and scores `{query, candidate}` text
 * pairs. The pipeline is loaded lazily on first `rerank()` call (lazy singleton
 * via getReranker); the `initializing` promise mutex prevents concurrent load
 * storms (mirror HuggingFaceLocalEmbeddingProvider).
 */
export class CrossEncoderReranker {
  private pipeline: any = null;
  private modelName: string;
  private initializing: Promise<any> | null = null;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  async initialize(): Promise<void> {
    if (this.pipeline) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      logger.info(`[reranker] Loading CrossEncoder model: ${this.modelName}`);
      logger.info(`[reranker] warming reranker model (cold start may take 5-30s)`);
      const { pipeline, env } = await import("@xenova/transformers");
      // Air-gap safety (T-93-01 mitigate): fail-closed — no remote HF hub
      // downloads. A cache miss throws at pipeline() load time, NOT a silent
      // network attempt (mirror embeddings.ts:170-171).
      // HF_ALLOW_REMOTE_MODELS=true (docker-compose default) allows first-use
      // download when the cache is empty; set to false for air-gapped deployments
      // with a pre-seeded cache.
      env.allowRemoteModels = process.env.HF_ALLOW_REMOTE_MODELS !== "false";
      env.allowLocalModels = true;
      // D-04: RERANKER_CACHE_DIR wins over HF_CACHE_DIR (reranker may share the
      // embed cache or pin a separate dir for the larger reranker model).
      env.cacheDir =
        process.env.RERANKER_CACHE_DIR || process.env.HF_CACHE_DIR || env.cacheDir;
      // quantized: true works identically in Xenova v2 (v4 API identical to v3 — never
      // pass `quantized` which would silently load fp32, ~2.2 GB, 5x slower).
      this.pipeline = await pipeline("text-classification", this.modelName, {
        quantized: true,
      });
      logger.info(`[reranker] CrossEncoder model loaded: ${this.modelName}`);
    })();

    await this.initializing;
  }

  /**
   * Score `{query, candidate.chunkText}` pairs through the CrossEncoder and map
   * raw logits to 0..1 sigmoid probabilities (D-05). Returns `{ score }[]` in
   * the SAME ORDER as `candidates` (scored[i] ↔ candidates[i]) so the route can
   * re-align scores with the original RRF list by index, then sort DESC.
   *
   * Pure function over `{query, candidates}` (D-08 / SC3): no shared mutable
   * state, no DB, no file writes. Warm-cache latency target ~50ms +1 hop is a
   * design target, NOT a CI gate.
   */
  async rerank(
    query: string,
    candidates: RerankCandidate[],
  ): Promise<RerankScore[]> {
    await this.initialize();
    if (candidates.length === 0) return [];

    // text_pair: the Xenova v2 text-classification pipeline accepts a single
    // `text` + an array `text_pair` and returns one { label, score } per pair.
    const output = await this.pipeline(
      query,
      candidates.map((c) => c.chunkText),
    );

    // Normalize to RerankScore[] in candidate order. The HF pipeline returns
    // either an array (multi-pair) or a single object (one pair); normalize
    // both shapes to an array.
    const results: Array<{ label: string; score: number }> = Array.isArray(output)
      ? output
      : [output];
    return results.map((r) => ({ score: sigmoid(r.score) }));
  }

  getModelName(): string {
    return this.modelName;
  }
}

// ─── Lazy singleton (mirror getEmbeddingProvider cache Map) ────────────────
// Keyed by RERANKER_MODEL so two different reranker models can coexist (e.g.
// a small + a large reranker). Concurrent calls share one pipeline instance
// (no double-load race — guarded by the `initializing` promise mutex inside
// each CrossEncoderReranker).
const rerankerCache = new Map<string, CrossEncoderReranker>();

/**
 * Get a CrossEncoderReranker instance for the configured RERANKER_MODEL. Lazy:
 * the pipeline is NOT loaded until the first `rerank()` call (initialize() is
 * called inside rerank()). Cached per model name so subsequent calls return
 * the same instance (mirror getEmbeddingProvider).
 */
export async function getReranker(): Promise<CrossEncoderReranker> {
  const env = getEnv();
  const modelName = env.RERANKER_MODEL;
  const existing = rerankerCache.get(modelName);
  if (existing) return existing;
  const reranker = new CrossEncoderReranker(modelName);
  rerankerCache.set(modelName, reranker);
  return reranker;
}

// NOTE (Phase 180 dead-code sweep): the `checkRerankerAvailability()` guard
// and its `RerankerAvailability` type were REMOVED — no production caller
// existed (only the air-gap test file exercised them; the embedding twin
// checkEmbeddingModelAvailability IS wired into routes/ingest.ts and
// stays). The 4-file REQUIRED_FILES knowledge lives on in the operator
// runbook + the CrossEncoderReranker pipeline-load errors.