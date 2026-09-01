// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import axios from "axios";
import { Prisma } from "@prisma/client";
import { ftsSearch } from "./ftsService";
import { getEnv } from "../config/env";
import { getSetting } from "./systemConfigService";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import { rerankCandidates } from "./rerankService";
import type { HybridSearchFilters } from "@simmetric-chat/shared";

/**
 * 260830-ur9 — RAG metadata filter support.
 *
 * normalizeInputFilters: single module-local date-normalization point. Maps
 * an incoming (shared-schema-validated) HybridSearchFilters to its canonical
 * wire form:
 *   - dateFrom/dateTo → full UTC ISO strings (date-only inputs are inclusive:
 *     dateFrom emits start-of-day 00:00:00.000Z, dateTo end-of-day
 *     23:59:59.999Z so "2025-06-01" covers the whole day).
 *   - always emits dateFromMs/dateToMs epoch mirrors for Qdrant's numeric
 *     range DSL.
 * Invalid dates throw a 400-style TypeError (the shared schema pre-validates,
 * this is defense-in-depth for direct callers).
 */
function normalizeInputFilters(
  filters?: HybridSearchFilters,
): HybridSearchFilters | undefined {
  if (!filters) return undefined;
  const hasTypes = Array.isArray(filters.documentTypes) && filters.documentTypes.length > 0;
  const hasAny = hasTypes || filters.dateFrom !== undefined || filters.dateTo !== undefined;
  if (!hasAny) return undefined;

  const normalized: HybridSearchFilters = {};
  if (hasTypes) normalized.documentTypes = filters.documentTypes;

  if (filters.dateFrom !== undefined && filters.dateFrom !== null && (filters.dateFrom as unknown) !== "") {
    const d = new Date(filters.dateFrom);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError(`Invalid date filter: dateFrom "${filters.dateFrom}" is not a parsable date`);
    }
    normalized.dateFrom = d.toISOString();
    normalized.dateFromMs = d.getTime();
  }
  if (filters.dateTo !== undefined && filters.dateTo !== null && (filters.dateTo as unknown) !== "") {
    let d = new Date(filters.dateTo);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError(`Invalid date filter: dateTo "${filters.dateTo}" is not a parsable date`);
    }
    // Date-only bound (length === 10, e.g. "2025-06-01") → end-of-day UTC so
    // the upper bound is inclusive of the whole target day.
    if (filters.dateTo.length === 10) {
      d = new Date(`${filters.dateTo}T23:59:59.999Z`);
    }
    normalized.dateTo = d.toISOString();
    normalized.dateToMs = d.getTime();
  }
  return normalized;
}

/** True when the filters object carries at least one filter key (post-normalization). */
function filtersAreActive(filters?: HybridSearchFilters): boolean {
  return (
    filters !== undefined &&
    ((Array.isArray(filters.documentTypes) && filters.documentTypes.length > 0) ||
      filters.dateFrom !== undefined ||
      filters.dateTo !== undefined)
  );
}

// RRF constant (standard value from literature)
// D-06 (Phase 62): RRF corpus-size normalization is NOT implemented here.
// Multi-workspace fusion sums raw 1/(K+rank) contributions per workspace, which
// biases the fused score toward workspaces with larger corpora (more chunks →
// more chances to contribute rank-scored hits). This is a known deferred limit,
// not a correctness bug — single-workspace ordering is unaffected. Tuning RRF_K
// or adding size normalization is deferred per the Phase 62 decision register.
const RRF_K = 60;

/**
 * D-05 (Phase 62): Deterministic tiebreaker comparator for fused RRF results.
 * Primary: score descending. Tiebreaker 1: documentId ASC (string compare).
 * Tiebreaker 2: chunkIndex ASC (numeric). Guarantees reproducible ordering
 * regardless of Map insertion order — required for regression-test stability
 * and reproducible retrieval.
 */
function compareFusedResults(
  a: { score: number; documentId: string; chunkIndex: number },
  b: { score: number; documentId: string; chunkIndex: number }
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.documentId < b.documentId) return -1;
  if (a.documentId > b.documentId) return 1;
  return a.chunkIndex - b.chunkIndex;
}

/**
 * 260815-fk8 — Enrich HybridSearchResult[] with missing documentName.
 *
 * The vector store can return results with empty/undefined `documentName` in
 * metadata (the collector's reembed path stores `documentName: ""` because the
 * server already keeps the name on the `documents.name` column; older ingested
 * docs may also lack it). When that happens the chat RAG sources panel falls
 * back to the "Unknown" string in builtinSkills.ts. This helper patches the
 * missing names by looking up the `documents` table via a single batched
 * `prisma.document.findMany` on `documentId` — no N+1.
 *
 * Fast path: when every result already has a truthy `documentName` (FTS path
 * populates it via a JOIN in ftsService.ts), no DB query is fired at all.
 *
 * Soft deletes: the prisma singleton carries `withSoftDelete()`; the query
 * below filters `deletedAt: null` explicitly so a tombstoned document between
 * ingestion and search is excluded (documentName stays undefined → the caller's
 * `|| "Unknown"` fallback handles it as the last-resort safety net).
 *
 * @param results  Fused RRF results (single-WS or multi-WS) at the exit boundary.
 * @returns         New array with `documentName` patched where it was missing.
 *                  Results that already had a name are returned unchanged.
 */
async function enrichDocumentNames(
  results: HybridSearchResult[],
): Promise<HybridSearchResult[]> {
  if (results.length === 0) return results;

  // Collect distinct documentIds where documentName is falsy (undefined or "").
  // 260815-i4s: when documentId is empty/undefined but chunkId is present and
  // matches the `${documentId}-${chunkIndex}` format (established at
  // collector/src/routes/ingest.ts:280, `id: \`${documentId}-${i}\``), derive
  // the documentId from the chunkId prefix (everything before the last dash)
  // so we can still look up the name from the documents table. Mirrors the
  // `deriveChunkIndex` logic below (line 102) which uses the same lastIndexOf
  // split but keeps the SUFFIX (chunkIndex) — here we keep the PREFIX.
  // Guard: chunkId must have a dash AND the trailing segment must be numeric
  // (so we don't mis-parse a UUID-only chunkId, whose last segment is hex and
  // would produce a garbage derived documentId). Malformed chunkId (no dash,
  // non-numeric suffix) → derivation skipped, documentName stays undefined and
  // the caller's `|| "Unknown"` fallback handles it.
  const missingIds = new Set<string>();
  for (const r of results) {
    if (r.documentName) continue;
    if (r.documentId) {
      missingIds.add(r.documentId);
      continue;
    }
    // documentId is empty/undefined — try deriving from chunkId.
    if (r.chunkId) {
      const lastDash = r.chunkId.lastIndexOf("-");
      if (lastDash > 0) {
        const suffix = r.chunkId.slice(lastDash + 1);
        const parsed = parseInt(suffix, 10);
        if (Number.isFinite(parsed) && String(parsed) === suffix) {
          const derived = r.chunkId.slice(0, lastDash);
          if (derived) {
            missingIds.add(derived);
            r.documentId = derived;
          }
        }
      }
    }
  }

  // Fast path: nothing to look up.
  if (missingIds.size === 0) return results;

  // Single batched query. Include soft-deleted docs — the chunk may still
  // be in the vector store after the document was soft-deleted, and the
  // citation should still show the original document name instead of
  // "Unknown".
  const docs = await prisma.document.findMany({
    where: { id: { in: Array.from(missingIds) } },
    select: { id: true, name: true },
  });
  const nameMap = new Map<string, string>();
  for (const d of docs) nameMap.set(d.id, d.name);

  logger.debug(
    `[hybrid] enrichDocumentNames: looked up ${missingIds.size} missing names, found ${nameMap.size}`,
  );

  // Patch only results with a falsy documentName; leave the rest untouched.
  return results.map((r) =>
    !r.documentName && r.documentId
      ? { ...r, documentName: nameMap.get(r.documentId) }
      : r,
  );
}

/**
 * D-01 (Fase 60): chunkId format is `${documentId}-${chunkIndex}` where
 * documentId is a UUID v4 (no trailing dash) and chunkIndex is numeric.
 * Derive chunkIndex by parsing the substring after the last dash. Returns 0
 * if the chunkId has no dash or the trailing segment is non-numeric —
 * DocumentChunk has no chunkIndex DB column, so this is the canonical source.
 */
function deriveChunkIndex(chunkId: string): number {
  const lastDash = chunkId.lastIndexOf("-");
  if (lastDash < 0) return 0;
  const parsed = parseInt(chunkId.slice(lastDash + 1), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 260721-np3 Task 2 — Return the set of distinct embeddingModel values
 * currently indexed on non-deleted documents in the workspace. Used by the
 * query-time mismatch guard: if even one stored model differs from the
 * admin-configured query model, the stored vectors are a mix of models and a
 * single-model query vector cannot match all of them → the caller skips the
 * vector leg entirely and degrades to FTS-only (graceful, no error).
 *
 * Empty workspace (0 docs) → empty Set → no mismatch possible → vector leg
 * runs normally. The `archive:<archiveId>` pseudo-workspace path used by
 * wiki_query and by rag_search's archive fallback has no Document rows, so
 * the guard is a no-op for archive searches (correct).
 *
 * Soft deletes: filtered via `deletedAt: null` so a tombstoned Document
 * does not trip the guard after an admin re-embeds the workspace with a
 * different model.
 */
async function getWorkspaceEmbeddingModels(
  workspaceId: string,
): Promise<Set<string>> {
  const docs = await prisma.document.findMany({
    where: { workspaceId, deletedAt: null },
    select: { embeddingModel: true },
    distinct: ["embeddingModel"],
  });
  return new Set(docs.map((d: { embeddingModel: string }) => d.embeddingModel));
}

/**
 * RAG-02 (D-04): Return a Map<workspaceId, non-deleted document_chunks count>
 * for the given workspaces. Used as the per-workspace corpus-size divisor in
 * multiWorkspaceHybridSearch's second-pass RRF fusion (D-01).
 *
 * Single grouped raw count via `prisma.$queryRaw` + `Prisma.join(workspaceIds)`
 * (parameterized — no string concatenation, T-85-injection mitigation). Soft
 * deletes are filtered via `d."deletedAt" IS NULL` (mirrors ftsService.ts:48-63).
 * `count(*)::bigint` returns bigint → `Number(r.n)` cast (Landmine L4).
 * Workspaces with 0 chunks are absent from the Map → the `|| 1` divisor guard
 * at the fusion addend handles them (Pitfall 4 — a workspace with 0 chunks
 * produces no fan-out results anyway, so the loop body never runs for it).
 */
async function getCorpusSizes(
  workspaceIds: string[],
): Promise<Map<string, number>> {
  if (workspaceIds.length === 0) return new Map();
  const rows: { ws: string; n: bigint }[] = await prisma.$queryRaw`
    SELECT d."workspaceId" AS ws, count(*)::bigint AS n
    FROM "document_chunks" c
    JOIN "documents" d ON d."id" = c."documentId"
    WHERE d."workspaceId" IN (${Prisma.join(workspaceIds)})
      AND d."deletedAt" IS NULL
    GROUP BY d."workspaceId"
  `;
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.ws, Number(r.n));
  return map;
}

export interface HybridSearchResult {
  chunkId: string;
  documentId: string;
  documentName?: string;
  chunkText: string;
  score: number;
  // 260721-np3 Task 3 — widened to include "archive" so rag_search's archive
  // fallback can tag its results distinctly from workspace "vector"/"fts"/
  // "both" results. The RRF scoring logic in hybridSearch still produces only
  // "vector"/"fts"/"both"; "archive" is ONLY set by the rag_search fallback
  // mapping in builtinSkills.ts. This keeps the type-level change minimal
  // and avoids touching the RRF scoring code.
  source: "vector" | "fts" | "both" | "archive";
  chunkIndex: number;
  metadata?: Record<string, unknown>;
}

interface VectorSearchResult {
  id: string;
  score: number;
  text?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Perform hybrid search combining vector search (via collector HTTP API)
 * + PostgreSQL tsvector full-text search, merging results with Reciprocal Rank Fusion (RRF).
 *
 * 260830-ur9: optional `filters` (last parameter — all existing call sites
 * compile unchanged). When present it is threaded into the collector POST
 * body (key omitted entirely when absent — byte-identical request) and into
 * the FTS SQL as parameterized predicates. A post-retrieval backstop
 * (see below) guarantees filtered correctness on ALL providers.
 */
export async function hybridSearch(
  query: string,
  workspaceId: string,
  limit: number = 10,
  filters?: HybridSearchFilters
): Promise<HybridSearchResult[]> {
  // 260830-ur9: normalize the filter dates ONCE (canonical ISO + *Ms mirrors).
  // Archive pseudo-workspaces (workspaceId starts with "archive:") have no
  // Document rows — filters are NOT forwarded there (fallback correctness,
  // orchestrator-locked truth).
  const isArchiveWorkspace = workspaceId.startsWith("archive:");
  const normalizedFilters = isArchiveWorkspace ? undefined : normalizeInputFilters(filters);

  // 260721-np3 Task 2 — Query-time embedding-model mismatch guard.
  // If even one non-deleted Document in the workspace has an embeddingModel
  // differing from getSetting("EMBEDDING_MODEL"), the stored vectors are a
  // mix of models and a single-model query vector cannot match all of them
  // → skip the vector leg entirely and degrade to FTS-only (graceful, no
  // error). The conservative rule fires only when a query model is set AND the
  // workspace has at least one stored model AND not all stored models equal
  // the query model. Empty workspace (0 docs) and archive pseudo-workspaces
  // (no Document rows) → empty storedModels Set → no mismatch → vector leg
  // runs normally. Soft-deleted docs are excluded via deletedAt: null in
  // getWorkspaceEmbeddingModels.
  const queryModelSetting = await getSetting("EMBEDDING_MODEL");
  const queryModel = queryModelSetting.value || undefined;
  const storedModels = await getWorkspaceEmbeddingModels(workspaceId);
  const skipVector =
    !!queryModel &&
    storedModels.size > 0 &&
    !(storedModels.size === 1 && storedModels.has(queryModel));
  if (skipVector) {
    logger.warn(
      `[hybrid] embedding model mismatch: query=${queryModel} vs stored=${Array.from(storedModels).join(",")}, vector leg skipped`,
    );
  }

  // Run both searches in parallel. When skipVector is true the vector leg is
  // short-circuited to an empty array — no collector HTTP call is made, which
  // is the whole point of the guard (avoid a 30s-timeout round-trip against a
  // collector that would return dimension-mismatched vectors).
  // 260830-ur9: filters spread conditionally — absent filters keep BOTH call
  // signatures byte-identical (ftsSearch stays a 3-arg call).
  const ftsPromise = normalizedFilters
    ? ftsSearch(query, workspaceId, limit * 2, normalizedFilters)
    : ftsSearch(query, workspaceId, limit * 2);
  const [vectorResults, ftsResults] = await Promise.all([
    skipVector ? Promise.resolve([]) : vectorSearchViaCollector(query, workspaceId, limit * 2, normalizedFilters),
    ftsPromise,
  ]);

  logger.info(`[hybrid] Vector results: ${vectorResults.length}, FTS results: ${ftsResults.length}`);

  // If both are empty, return nothing
  if (vectorResults.length === 0 && ftsResults.length === 0) {
    return [];
  }

  // If FTS is unavailable (empty results), fall back to vector-only
  if (ftsResults.length === 0) {
    const vectorOnly = vectorResults.slice(0, limit).map((r, i) => ({
      chunkId: r.id,
      documentId: ((r.metadata as Record<string, unknown>)?.documentId as string) || "",
      documentName: (r.metadata as Record<string, unknown>)?.documentName as string || undefined,
      chunkText: (r.text || (r.metadata as Record<string, unknown>)?.chunkText || "") as string,
      score: 1 / (RRF_K + i + 1),
      source: "vector" as const,
      chunkIndex: deriveChunkIndex(r.id),
      metadata: r.metadata,
    }));
    // 260830-ur9 backstop also guards the vector-only path.
    const gated = await applyMetadataBackstop(vectorOnly, workspaceId, normalizedFilters);
    return enrichDocumentNames(gated);
  }

  // Apply Reciprocal Rank Fusion
  const rrfScores = new Map<string, {
    score: number;
    chunkText: string;
    documentId: string;
    documentName?: string;
    metadata?: Record<string, unknown>;
    sources: Set<string>;
  }>();

  // Score vector results
  vectorResults.forEach((result, rank) => {
    const id = result.id;
    const existing = rrfScores.get(id) || {
      score: 0,
      chunkText: (result.text || (result.metadata as Record<string, unknown>)?.chunkText || "") as string,
      documentId: ((result.metadata as Record<string, unknown>)?.documentId as string) || "",
      documentName: (result.metadata as Record<string, unknown>)?.documentName as string || undefined,
      metadata: result.metadata as Record<string, unknown>,
      sources: new Set<string>(),
    };
    existing.score += 1 / (RRF_K + rank + 1);
    existing.sources.add("vector");
    rrfScores.set(id, existing);
  });

  // Score FTS results
  ftsResults.forEach((result, rank) => {
    const id = result.chunkId;
    const existing = rrfScores.get(id) || {
      score: 0,
      chunkText: result.chunkText,
      documentId: result.documentId,
      documentName: result.documentName,
      metadata: undefined,
      sources: new Set<string>(),
    };
    existing.score += 1 / (RRF_K + rank + 1);
    existing.sources.add("fts");
    // Fill in chunk text from FTS if not already present
    if (!existing.chunkText) existing.chunkText = result.chunkText;
    // ING-02: propagate documentName from FTSResult (populated by ftsService JOIN)
    if (!existing.documentName) existing.documentName = result.documentName;
    rrfScores.set(id, existing);
  });

  // Sort by RRF score descending, with D-05 deterministic tiebreaker
  // (documentId ASC, then chunkIndex ASC) for reproducible ordering.
  const fused = Array.from(rrfScores.entries())
    .map(([chunkId, data]) => ({
      chunkId,
      documentId: data.documentId,
      documentName: data.documentName,
      chunkText: data.chunkText,
      score: data.score,
      source: (data.sources.has("vector") && data.sources.has("fts")
        ? "both"
        : data.sources.has("vector")
          ? "vector"
          : "fts") as HybridSearchResult["source"],
      chunkIndex: deriveChunkIndex(chunkId),
      metadata: data.metadata,
    }))
    .sort(compareFusedResults);

  // 260830-ur9: post-retrieval metadata backstop BEFORE the final enrich.
  const gated = await applyMetadataBackstop(fused.slice(0, limit), workspaceId, normalizedFilters);
  return enrichDocumentNames(gated);
}

/**
 * 260830-ur9 — post-retrieval metadata-filter backstop (correctness
 * guarantee, orchestrator-locked). The documents table is AUTHORITATIVE: when
 * filters are active, collect the unique documentIds from the merged result
 * list and verify each against a single batched findMany carrying the SAME
 * filter predicates (type IN-list + createdAt range). Results whose
 * documentId misses the match are dropped.
 *
 * Scope: applied when filters are active AND the workspaceId is NOT an
 * "archive:*" pseudo-workspace (no Document rows — never dropped, never
 * receives document filters).
 *
 * Legacy vector rows lacking ingest-time stamps: providers that pre-filter
 * (pgvector/Qdrant) drop them pre-query; providers that ignore filters
 * (LanceDB/Chroma) may return them — the backstop re-checks every documentId
 * against the authoritative table, so filtered correctness is guaranteed
 * regardless of provider support. Legacy docs re-gain stamps on admin
 * re-embed (the reembed route re-stamps from the Document row).
 *
 * Failure policy: on a backstop error the filter guarantee cannot be upheld
 * by this path — FAIL OPEN with a warn (matches graceful-degradation
 * discipline: the FTS leg remains SQL-filtered; pre-filter providers remain
 * filtered; only this last-resort check is skipped).
 */
async function applyMetadataBackstop(
  results: HybridSearchResult[],
  workspaceId: string,
  normalizedFilters?: HybridSearchFilters,
): Promise<HybridSearchResult[]> {
  if (!filtersAreActive(normalizedFilters)) return results;
  if (workspaceId.startsWith("archive:")) return results;

  // FTS-sourced results are already SQL-filtered (parameterized predicates in
  // ftsService) — the backstop targets the VECTOR leg. `both` chunks are
  // double-covered (FTS proved the same chunk matched the SQL too) but we
  // still verify their documentId conservatively; only pure `fts` results
  // bypass the gate.
  // Legacy vector rows pre-dating ingest-time stamps: pre-filter providers
  // (pgvector/Qdrant) drop them pre-query; ignore-filter providers (LanceDB/
  // Chroma) may return them — this authoritative-table re-check is what
  // guarantees filtered correctness on EVERY provider. Legacy docs re-gain
  // stamps on admin re-embed (reembed re-stamps from the Document row).
  const docIds = Array.from(new Set(results.map((r) => r.documentId).filter((id): id is string => !!id)));
  if (docIds.length === 0) return results;

  try {
    const matchedDocs = await prisma.document.findMany({
      where: {
        id: { in: docIds },
        ...(normalizedFilters!.documentTypes ? { type: { in: normalizedFilters!.documentTypes } } : {}),
        ...(normalizedFilters!.dateFrom || normalizedFilters!.dateTo
          ? {
              createdAt: {
                ...(normalizedFilters!.dateFrom ? { gte: new Date(normalizedFilters!.dateFrom) } : {}),
                ...(normalizedFilters!.dateTo ? { lte: new Date(normalizedFilters!.dateTo) } : {}),
              },
            }
          : {}),
      },
      select: { id: true },
    });
    const matching = new Set(matchedDocs.map((d: { id: string }) => d.id));
    const gated = results.filter(
      (r) => r.source === "fts" || matching.has(r.documentId),
    );
    logger.debug(
      `[hybrid] metadata backstop: ${docIds.length} docIds checked, kept ${gated.length}/${results.length} results`,
    );
    return gated;
  } catch (err: unknown) {
    logger.warn(
      `[hybrid] metadata-filter backstop failed (${err instanceof Error ? err.message : String(err)}); ` +
        `failing open — FTS leg remains SQL-filtered; pre-filter providers remain filtered`,
    );
    return results;
  }
}

/**
 * Quick health check: pings the collector and returns whether it's reachable.
 * Useful for diagnostics when RAG returns no results.
 */
export async function checkCollectorHealth(): Promise<{ reachable: boolean; error?: string }> {
  try {
    const env = getEnv();
    const collectorUrl = env.COLLECTOR_URL || "http://localhost:3210";
    const response = await axios.get(`${collectorUrl}/api/health`, { timeout: 5000 });
    return { reachable: response.status === 200 };
  } catch (err: unknown) {
    return { reachable: false, error: (err as Error).message };
  }
}

/**
 * Multi-workspace hybrid search: fans out hybridSearch() per workspace in parallel,
 * then merges all per-workspace result sets with a second-pass RRF fusion.
 * Deduplicates by chunkId and tags results with sourceWorkspaceId.
 */
export async function multiWorkspaceHybridSearch(
  query: string,
  workspaceIds: string[],
  limit: number = 10,
  filters?: HybridSearchFilters
): Promise<HybridSearchResult[]> {
  // Single workspace: delegate directly and tag sourceWorkspaceId.
  // IN-01: guard against a sparse `length === 1` array passing `undefined`
  // to hybridSearch. Real callers pass dense arrays; this is defense-in-depth.
  const singleWsId = workspaceIds.length === 1 ? workspaceIds[0] : undefined;
  if (singleWsId) {
    // Over-fetch via hybridSearch(limit*2) for fuller ranking, then cap to
    // `limit` to respect the caller's request size (mirrors multi-ws branch).
    const results = await hybridSearch(query, singleWsId, limit * 2, filters);
    return results
      .slice(0, limit)
      .map((r) => ({
        ...r,
        metadata: { ...r.metadata, sourceWorkspaceId: singleWsId },
      }));
  }

  // Fan out hybridSearch per workspace in parallel, requesting limit*2 per workspace.
  // RAG-02 (D-04 / Pitfall 3): run getCorpusSizes IN PARALLEL with the fan-out
  // (NOT serialized before) so the extra DB round-trip is hidden behind the
  // per-workspace hybridSearch latency. 260830-ur9: filters forwarded to
  // every per-workspace call.
  const [perWorkspaceResults, corpusSizes] = await Promise.all([
    Promise.all(workspaceIds.map((wsId) => hybridSearch(query, wsId, limit * 2, filters))),
    getCorpusSizes(workspaceIds),
  ]);

  // Second-pass RRF merge across all per-workspace result sets
  const rrfScores = new Map<string, {
    score: number;
    chunkText: string;
    documentId: string;
    documentName?: string;
    sourceWorkspaceId: string;
    matchSource: Set<string>;
    metadata?: Record<string, unknown>;
  }>();

  let totalRawResults = 0;

  for (let wsIdx = 0; wsIdx < perWorkspaceResults.length; wsIdx++) {
    const wsId = workspaceIds[wsIdx];
    const results = perWorkspaceResults[wsIdx]!;
    totalRawResults += results.length;

    results.forEach((result, rank) => {
      const id = result.chunkId;
      const existing = rrfScores.get(id) || {
        score: 0,
        chunkText: result.chunkText,
        documentId: result.documentId,
        documentName: result.documentName,
        sourceWorkspaceId: wsId!,
        matchSource: new Set<string>(),
        metadata: result.metadata,
      };
      // RAG-02 (D-01): per-WS corpus-size normalization. Single-WS ordering
      // preserved by construction (one constant denominator per workspace →
      // relative scores unchanged within that workspace). The RAG-01 guard
      // (85-01) is the regression net proving that property. The `|| 1`
      // divisor guard handles empty/missing workspaces (Pitfall 4).
      existing.score += (1 / (RRF_K + rank + 1)) / (corpusSizes.get(wsId!) || 1);
      existing.matchSource.add(result.source);
      // Track sourceWorkspaceId from the first workspace that produced this chunk
      // (for deduplicated chunks, keep the first occurrence's workspace)
      if (!rrfScores.has(id)) {
        existing.sourceWorkspaceId = wsId!;
      }
      rrfScores.set(id, existing);
    });
  }

  const fused = Array.from(rrfScores.entries())
    .map(([chunkId, data]) => ({
      chunkId,
      documentId: data.documentId,
      documentName: data.documentName,
      chunkText: data.chunkText,
      score: data.score,
      source: (data.matchSource.has("vector") && data.matchSource.has("fts")
        ? "both"
        : data.matchSource.has("vector")
          ? "vector"
          : "fts") as HybridSearchResult["source"],
      chunkIndex: deriveChunkIndex(chunkId),
      metadata: { ...data.metadata, sourceWorkspaceId: data.sourceWorkspaceId },
    }))
    .sort(compareFusedResults)
    .slice(0, limit);

  logger.info(`[hybrid] Multi-workspace search: ${workspaceIds.length} workspaces, ${totalRawResults} total raw results, ${fused.length} fused results`);

  return enrichDocumentNames(fused);
}

/**
 * Vector search via the collector HTTP API.
 * This respects the CLAUDE.md constraint: server and collector communicate via HTTP, not direct imports.
 */
async function vectorSearchViaCollector(
  query: string,
  workspaceId: string,
  limit: number,
  filters?: HybridSearchFilters
): Promise<VectorSearchResult[]> {
  // IN-02: hoist getEnv() out of the try block so the catch branch can reuse
  // the same cached env instance instead of calling getEnv() a second time.
  const env = getEnv();
  try {
    const collectorUrl = env.COLLECTOR_URL || "http://localhost:3210";

    // Read the embedding model from system config to ensure queries use
    // the same model that was used for document ingestion.
    const embeddingModelSetting = await getSetting("EMBEDDING_MODEL");
    const embeddingModel = embeddingModelSetting.value || undefined;

    // Look up workspace name for human-readable Qdrant collection names
    let workspaceName: string | undefined;
    try {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true },
      });
      workspaceName = ws?.name || undefined;
    } catch {
      // Non-blocking: fall back to UUID-only collection name
    }

    // 260830-ur9: the `filters` key is added ONLY when non-empty — omitting
    // it entirely keeps the no-filter request byte-identical to today's body.
    const normalized = normalizeInputFilters(filters);
    const response = await axios.post(`${collectorUrl}/api/ingest/query`, {
      query,
      workspaceId,
      workspaceName,
      limit,
      embeddingModel,
      ...(normalized ? { filters: normalized } : {}),
    }, { timeout: 30000 });

    // IN-03: drop the dead `r.metadata?.chunkId` fallback — the collector's
    // VectorSearchResult.metadata never sets chunkId (it sets documentId,
    // workspaceId, documentName, chunkIndex). The `r.id` fallback is the
    // real path; chunkText is still read from metadata because the collector
    // does populate that field.
    const results = (response.data.results || []) as Array<{ id?: string; score?: number; text?: string; metadata?: { chunkText?: string } }>;
    return results.map((r) => ({
      id: r.id || "",
      score: r.score || 0,
      text: r.text || r.metadata?.chunkText || undefined,
      metadata: r.metadata,
    }));
  } catch (err: unknown) {
    const errorCode = (err as Record<string, unknown>)?.code;
    if (errorCode === "ECONNREFUSED" || errorCode === "ECONNRESET") {
      logger.warn(`[hybrid] Vector search unavailable: collector not running at ${env.COLLECTOR_URL || "http://localhost:3210"} (${errorCode})`);
    } else if (errorCode === "ETIMEDOUT" || errorCode === "ECONNABORTED") {
      logger.warn(`[hybrid] Vector search timed out after 30s`);
    } else {
      logger.warn(`[hybrid] Vector search via collector failed: ${(err as Error).message}`);
    }
    return [];
  }
}

/**
 * Phase 93-02 — LIVE RAG query path wrapper (D-07 BLOCKER fix).
 *
 * `hybridSearchWithRerank(query, wsIds, limit)` is the NEW live caller for the
 * RAG query path. It reads `rag_reranker_enabled` + `rag_reranker_candidate_pool`
 * from SystemConfig and either:
 *  - disabled (SC1 default) → delegates to `hybridSearch` (single-WS) or
 *    `multiWorkspaceHybridSearch` (multi-WS) with the ORIGINAL limit, returns
 *    RRF order byte-identical (SC2 wiring-layer regression — no over-fetch, no
 *    collector rerank call). The single-vs-multi branching mirrors the exact
 *    ternary previously at `internalWidget.ts:59-61` so disabled behavior is
 *    byte-identical to the pre-wrapper direct calls.
 *  - enabled (D-03 over-fetch) → `effectiveLimit = Math.min(limit * poolRatio,
 *    100)` (capped at 100 via RerankRequestSchema .max(100)), calls the RRF
 *    function with `effectiveLimit`, then `rerankCandidates(query, fused)`,
 *    then `.slice(0, limit)` to trim to final K. The rerank failure path is
 *    caught → `logger.warn` + `fused.slice(0, limit)` (graceful fallback,
 *    D-07 — RRF top-K still usable, NOT a throw).
 *
 * SC2 frozen: the RRF function bodies (`hybridSearch` lines 135-260,
 * `multiWorkspaceHybridSearch` lines 282-378) are READ-ONLY — this wrapper is
 * a NEW additive export. Pitfall 4: `rerankCandidates` is called AFTER the
 * RRF function returns; the RRF code is never inlined.
 *
 * @param query   The user query (or implicit tool-call query).
 * @param wsIds   A single workspace id (string) OR an array of workspace ids.
 *                A single-element array delegates to the single-WS path
 *                (mirrors the previous internalWidget ternary).
 * @param limit   Final K — the number of results the caller wants.
 * @returns       RRF-ordered results when disabled; reranked + trimmed when
 *                enabled; never throws (graceful fallback on rerank failure).
 */
export async function hybridSearchWithRerank(
  query: string,
  wsIds: string | string[],
  limit: number = 10,
  filters?: HybridSearchFilters
): Promise<HybridSearchResult[]> {
  // SC1 default OFF: any value other than 'true' is treated as disabled.
  const enabledSetting = await getSetting("rag_reranker_enabled");
  const enabled = enabledSetting.value === "true";

  // Normalize wsIds → decide single-WS vs multi-WS path. A single-element array
  // delegates to the single-WS path (mirrors the previous internalWidget
  // ternary `workspaceIds.length === 1 ? hybridSearch(...) : multiWorkspace...`).
  const isSingleWs = typeof wsIds === "string" || (Array.isArray(wsIds) && wsIds.length === 1);
  const singleWsId = typeof wsIds === "string" ? wsIds : (wsIds as string[])[0]!;

  if (!enabled) {
    // Disabled path: delegate to the RRF function with the ORIGINAL limit.
    // No over-fetch, no collector rerank call, no rerankCandidates invocation.
    // This is the SC2 wiring-layer regression guarantee — byte-identical to a
    // direct hybridSearch / multiWorkspaceHybridSearch call.
    // 260830-ur9: filters forwarded on both delegations.
    if (isSingleWs) {
      return hybridSearch(query, singleWsId, limit, filters);
    }
    return multiWorkspaceHybridSearch(query, wsIds as string[], limit, filters);
  }

  // Enabled path (D-03 over-fetch). Read the pool ratio from SystemConfig;
  // default 4 when missing/invalid. The `parseInt` radix=10 + finite+positive
  // guard mirrors the plan's "poolRatio = Number.isFinite(poolRaw) &&
  // poolRaw > 0 ? poolRaw : 4" safe-default.
  const poolSetting = await getSetting("rag_reranker_candidate_pool");
  const poolRaw = parseInt((poolSetting?.value ?? "4") as string, 10);
  const poolRatio = Number.isFinite(poolRaw) && poolRaw > 0 ? poolRaw : 4;
  // D-03 cap at 100 — the collector RerankRequestSchema .max(100) bounds
  // inference latency (~50ms warm +1 hop per candidate, SC3 design target).
  const effectiveLimit = Math.min(limit * poolRatio, 100);

  // Run the RRF function with the over-fetched limit. The RRF bodies are
  // FROZEN (SC2) — this is a plain call, not an inlined modification.
  // 260830-ur9: filters are applied BEFORE the over-fetch so the rerank
  // candidate pool is already metadata-filtered.
  const fused = isSingleWs
    ? await hybridSearch(query, singleWsId, effectiveLimit, filters)
    : await multiWorkspaceHybridSearch(query, wsIds as string[], effectiveLimit, filters);

  // Post-RRF rerank (Pitfall 4: AFTER the RRF function returns). The rerank
  // failure path is caught → graceful fallback (D-07): the RRF-ordered
  // over-fetched candidates sliced to `limit` are still usable.
  try {
    const reranked = await rerankCandidates(query, fused);
    // D-03 trim to final K. The reranker re-orders; we cap to the caller's
    // requested limit. (rerankCandidates is agnostic to limit — it returns
    // the reranked full pool; the wrapper owns the trim.)
    return reranked.slice(0, limit);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[hybridSearchWithRerank] rerank failed, returning RRF order: ${message}`);
    // Graceful fallback: RRF-ordered over-fetched candidates sliced to limit.
    return fused.slice(0, limit);
  }
}