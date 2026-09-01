// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 93-02 Task 1 — `rerankCandidates(query, candidates)`: post-RRF
 * CrossEncoder rerank orchestration. Server-side consumer of the collector's
 * `/api/ingest/rerank` endpoint (Phase 93-01).
 *
 * SC1 (D-04): `rag_reranker_enabled` SystemConfig key defaults to `false`
 * (admin-editable, DB>ENV>Default). When disabled, `rerankCandidates` returns
 * `candidates` unchanged and `axios.post` is NEVER called — zero behavior
 * change at rest.
 *
 * D-05 score semantics: when enabled, the collector scores each
 * `{query, candidate.chunkText}` pair through the CrossEncoder and returns
 * sigmoid probabilities (0..1). The server just forwards the reranked list —
 * `VectorSearchResult.score` (well, `HybridSearchResult.score`) carries the
 * rerank sigmoid relevance for display when enabled, else the RRF score.
 *
 * D-07 graceful fallback: on any collector failure (ECONNREFUSED/ECONNRESET/
 * ETIMEDOUT/500/...), `rerankCandidates` logs `logger.warn` and returns the
 * original RRF-ordered `candidates` — NOT a hard failure; the RRF top-K is
 * still usable. The error message is logged but NOT candidate text or query
 * content (T-93-06 — mirrors existing `[hybrid]` log discipline).
 *
 * Pitfall 4: `rerankCandidates` is a NEW post-RRF function in a SEPARATE file.
 * It is called AFTER `multiWorkspaceHybridSearch` returns; the RRF code in
 * `hybridSearchService.ts` is read-only (SC2). The over-fetch + trim logic
 * (D-03) lives in the `hybridSearchWithRerank` wrapper (Task 2), NOT here —
 * `rerankCandidates` is a pure function over `{ query, candidates }` and is
 * agnostic to the pool size.
 *
 * Pitfall 5: rerank is for ORDERING only, top-k only — there is NO threshold
 * SystemConfig key; the reranker never replaces RRF, it re-orders its output.
 */
import axios from "axios";
import { getEnv } from "../config/env";
import { getSetting } from "./systemConfigService";
import { logger } from "../utils/logger";
import type { HybridSearchResult } from "./hybridSearchService";

/**
 * Post-RRF rerank: optionally call the collector `/ingest/rerank` endpoint to
 * re-order the fused candidates by CrossEncoder relevance. When the
 * `rag_reranker_enabled` SystemConfig key is anything other than `'true'`,
 * the function is a no-op returning the input unchanged (SC1 default OFF).
 *
 * @param query       The user query (or implicit tool-call query).
 * @param candidates  The RRF-fused top-K candidate list (post-RRF, pre-rerank).
 * @returns           The reranked list when enabled + collector reachable;
 *                    otherwise the original `candidates` array (graceful
 *                    fallback, D-07). Never throws to the caller.
 */
export async function rerankCandidates(
  query: string,
  candidates: HybridSearchResult[],
): Promise<HybridSearchResult[]> {
  // SC1 default OFF: any value other than 'true' is treated as disabled.
  // (covers `false`, `undefined`, empty string, malformed values — fail-safe).
  const enabledSetting = await getSetting("rag_reranker_enabled");
  if (enabledSetting.value !== "true") {
    return candidates;
  }

  // Empty candidate list: skip the collector hop entirely. The RRF top-K is
  // already empty, rerank has nothing to score, and the collector route would
  // reject an empty `candidates` array via Zod (.min(1)) anyway.
  if (candidates.length === 0) {
    return candidates;
  }

  try {
    const env = getEnv();
    const collectorUrl = env.COLLECTOR_URL || "http://localhost:3210";

    // Forward the full candidate objects so the collector can re-align scores
    // with the original RRF list via chunkId/documentId (RerankRequestSchema
    // pass-through fields, Phase 93-01). The collector scores each
    // {query, chunkText} pair and returns the list sorted DESC by sigmoid
    // probability (D-05).
    const response = await axios.post(
      `${collectorUrl}/api/ingest/rerank`,
      {
        query,
        candidates: candidates.map((c) => ({
          chunkId: c.chunkId,
          documentId: c.documentId,
          chunkText: c.chunkText,
          score: c.score,
          ...(c.source !== undefined ? { source: c.source } : {}),
          ...(c.chunkIndex !== undefined ? { chunkIndex: c.chunkIndex } : {}),
          ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
        })),
      },
      { timeout: 30000 },
    );

    // The collector returns { results: HybridSearchResult[] } sorted DESC by
    // sigmoid score (D-05). The results carry the rerank sigmoid in `score`.
    const results = (response.data?.results ?? []) as HybridSearchResult[];
    return results;
  } catch (err: unknown) {
    // D-07 graceful fallback: log the error message (NOT candidate/query text,
    // per T-93-06) and return the original RRF-ordered candidates. The live
    // RAG path still gets usable results — rerank is a soft layer above RRF.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[rerank] collector rerank failed, returning RRF order: ${message}`);
    return candidates;
  }
}