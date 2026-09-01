// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 93-02 Task 2 — hybridSearchWithRerank integration test.
 *
 * The wrapper `hybridSearchWithRerank(query, wsIds, limit)` is the NEW live
 * RAG query path (D-07 BLOCKER fix). It reads `rag_reranker_enabled` +
 * `rag_reranker_candidate_pool` from SystemConfig and either:
 *  - disabled → delegates to hybridSearch (single-WS) or
 *    multiWorkspaceHybridSearch (multi-WS) with the ORIGINAL limit (SC2
 *    byte-identical, no over-fetch, no collector call); OR
 *  - enabled → over-fetches effectiveLimit = min(limit * poolRatio, 100)
 *    (D-03), calls the RRF function with effectiveLimit, then
 *    rerankCandidates(query, fused), then .slice(0, limit) to trim to final K.
 *
 * Behaviors (mirrors 93-02-PLAN.md `<behavior>`):
 *  1. disabled single-WS = RRF order byte-identical (SC2 wiring-layer regression)
 *  2. disabled multi-WS = RRF order byte-identical
 *  3. enabled = rerank invoked + over-fetch + trim (D-03)
 *  4. enabled multi-WS path
 *  5. cap at 100 (D-03)
 *  6. graceful fallback propagates (D-07): rerank failure → RRF top-K still usable
 */
import type { HybridSearchResult } from "../services/hybridSearchService";

// ─── Mock skeleton (mirrors hybridSearch.test.ts:1-70) ──────────────────────

jest.mock("../services/ftsService", () => ({
  ftsSearch: jest.fn(),
  initPostgreSQLFTS: jest.fn(),
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    COLLECTOR_URL: "http://localhost:3210",
  })),
}));

// Default: disabled. Tests override via mockGetSetting.mockResolvedValue.
// NOTE: jest.mock factories are hoisted — cannot reference const declared
// below (TDZ under @swc/jest, Phase 93-01 deviation 3). Use jest.fn() inline
// and access the mock via the imported binding cast to jest.Mock.
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: "false" }),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("axios", () => ({
  post: jest.fn(),
  create: jest.fn(() => ({ post: jest.fn(), get: jest.fn() })),
}));

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ name: "Test Workspace" }),
    },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
}));

// Mock rerankCandidates so the wrapper's rerank hop is controllable. The
// wrapper imports it from ./rerankService; we mock the module so the wrapper
// gets our spy. Default implementation: passthrough (returns input unchanged)
// — tests override per-case. Use jest.fn() inline (TDZ-safe, see above).
jest.mock("../services/rerankService", () => ({
  rerankCandidates: jest.fn(async (_q: string, c: HybridSearchResult[]) => c),
}));

const mockFtsSearch = require("../services/ftsService").ftsSearch as jest.Mock;
const mockAxiosPost = require("axios").post as jest.Mock;
const mockGetSetting = require("../services/systemConfigService").getSetting as jest.Mock;
const mockRerankCandidates = require("../services/rerankService").rerankCandidates as jest.Mock;

// Import after mocks. The wrapper is a sibling of hybridSearch/
// multiWorkspaceHybridSearch in the same module — we do NOT mock them, we let
// them run against the mocked deps (ftsService + axios + prisma) so the
// disabled path is byte-identical to a direct call.
import {
  hybridSearch,
  multiWorkspaceHybridSearch,
  hybridSearchWithRerank,
} from "../services/hybridSearchService";

// ─── Fixture ─────────────────────────────────────────────────────────────────

// 4 FTS results, fixed array order. RRF score = 1/(60+rank+1) — rank 0 wins.
const FTS_FIXTURE: HybridSearchResult[] = [
  { chunkId: "doc-c-2", documentId: "doc-c", documentName: "Doc C", chunkText: "c2", score: 0, source: "fts", chunkIndex: 2, metadata: {} },
  { chunkId: "doc-a-0", documentId: "doc-a", documentName: "Doc A", chunkText: "a0", score: 0, source: "fts", chunkIndex: 0, metadata: {} },
  { chunkId: "doc-b-1", documentId: "doc-b", documentName: "Doc B", chunkText: "b1", score: 0, source: "fts", chunkIndex: 1, metadata: {} },
  { chunkId: "doc-a-1", documentId: "doc-a", documentName: "Doc A", chunkText: "a1", score: 0, source: "fts", chunkIndex: 1, metadata: {} },
];
const EXPECTED_RRF_ORDER = ["doc-c-2", "doc-a-0", "doc-b-1", "doc-a-1"];

function setupFtsOnlyFixture(fixture: HybridSearchResult[], wsIds: string[]) {
  mockFtsSearch.mockReset();
  mockAxiosPost.mockReset();
  mockFtsSearch.mockImplementation(async (_q: string, wsId: string, _l: number) => {
    if (!wsIds.includes(wsId)) return [];
    return fixture.map((r) => ({
      chunkId: r.chunkId, documentId: r.documentId, documentName: r.documentName,
      chunkText: r.chunkText, rank: 0,
    }));
  });
  // vectorSearchViaCollector → empty results (FTS-only path).
  mockAxiosPost.mockResolvedValue({ data: { results: [] } });
}

describe("hybridSearchWithRerank (Phase 93-02 Task 2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue({ value: "false" });
    mockRerankCandidates.mockImplementation(async (_q: string, c: HybridSearchResult[]) => c);
  });

  // ─── Test 1: disabled single-WS = RRF byte-identical ────────────────────────
  it("SC2 wiring regression: disabled single-WS returns RRF order byte-identical to direct hybridSearch call, no over-fetch, no rerank", async () => {
    setupFtsOnlyFixture(FTS_FIXTURE, ["ws-1"]);

    const direct = await hybridSearch("query", "ws-1", 10);
    const wrapped = await hybridSearchWithRerank("query", "ws-1", 10);

    expect(wrapped).toEqual(direct);
    expect(wrapped.map((r) => r.chunkId)).toEqual(EXPECTED_RRF_ORDER);
    // rerankCandidates is NOT invoked when disabled.
    expect(mockRerankCandidates).not.toHaveBeenCalled();
    // No over-fetch: the wrapper delegates with the ORIGINAL limit (10), not
    // limit*pool. Assert ftsSearch was called with limit*2 = 20 (hybridSearch's
    // internal over-fetch), NOT 10*4*2 = 80.
    const ftsCalls = mockFtsSearch.mock.calls;
    for (const c of ftsCalls) {
      const limitArg = c[2] as number;
      expect(limitArg).toBe(20); // hybridSearch internal limit*2
    }
  });

  // ─── Test 2: disabled multi-WS = RRF byte-identical ─────────────────────────
  it("SC2 wiring regression: disabled multi-WS returns RRF order byte-identical to direct multiWorkspaceHybridSearch call", async () => {
    setupFtsOnlyFixture(FTS_FIXTURE, ["ws-1", "ws-2", "ws-3"]);

    const direct = await multiWorkspaceHybridSearch("query", ["ws-1", "ws-2", "ws-3"], 10);
    const wrapped = await hybridSearchWithRerank("query", ["ws-1", "ws-2", "ws-3"], 10);

    expect(wrapped).toEqual(direct);
    expect(mockRerankCandidates).not.toHaveBeenCalled();
  });

  // ─── Test 2b: disabled single-element array delegates to single-WS path ────
  it("disabled single-element array [ws-1] delegates to hybridSearch single-WS path (byte-identical to direct call)", async () => {
    setupFtsOnlyFixture(FTS_FIXTURE, ["ws-1"]);

    const direct = await hybridSearch("query", "ws-1", 10);
    const wrapped = await hybridSearchWithRerank("query", ["ws-1"], 10);

    expect(wrapped).toEqual(direct);
    expect(mockRerankCandidates).not.toHaveBeenCalled();
  });

  // ─── Test 3: enabled = rerank invoked + over-fetch + trim (D-03) ────────────
  it("D-03 enabled single-WS: over-fetches min(10*4, 100)=40, calls rerankCandidates with 40, trims to 10", async () => {
    // Enabled: rag_reranker_enabled=true + pool=4.
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "rag_reranker_enabled") return { value: "true" };
      if (key === "rag_reranker_candidate_pool") return { value: "4" };
      // EMBEDDING_MODEL etc. — return undefined so the mismatch guard is a no-op.
      return { value: undefined };
    });

    // 40 candidates from RRF (the over-fetch pool). hybridSearch will produce
    // 40 fused results when called with effectiveLimit=40 (FTS fixture of 40).
    const pool40: HybridSearchResult[] = Array.from({ length: 40 }, (_, i) => ({
      chunkId: `doc-p-${i}`, documentId: "doc-p", documentName: "Pool",
      chunkText: `chunk ${i}`, score: 0, source: "fts" as const,
      chunkIndex: i, metadata: {},
    }));
    setupFtsOnlyFixture(pool40, ["ws-1"]);

    // Rerank reorders: reverse order. The wrapper should trim to 10.
    mockRerankCandidates.mockImplementation(async (_q: string, c: HybridSearchResult[]) =>
      [...c].reverse(),
    );

    const result = await hybridSearchWithRerank("query", "ws-1", 10);

    // Over-fetch: hybridSearch called with effectiveLimit = min(10*4, 100) = 40.
    // ftsSearch receives limit*2 = 80 (hybridSearch's internal doubling).
    const ftsCalls = mockFtsSearch.mock.calls;
    expect(ftsCalls.length).toBeGreaterThan(0);
    const ftsLimit = ftsCalls[0]![2] as number;
    expect(ftsLimit).toBe(80); // 40 * 2

    // rerankCandidates called once with the fused candidates.
    expect(mockRerankCandidates).toHaveBeenCalledTimes(1);
    const rerankArg = mockRerankCandidates.mock.calls[0]![1] as HybridSearchResult[];
    expect(rerankArg.length).toBe(40);

    // Trim to final K = 10.
    expect(result).toHaveLength(10);
    // The rerank mock reverses the input array. The wrapper then slices to 10.
    // Assert the chunkId order is the reverse of the fused chunkIds sliced to 10.
    // (hybridSearch rebuilds candidates with RRF scores — we assert structure,
    // not exact score values, since the RRF score is computed internally.)
    const fusedChunkIds = rerankArg.map((r) => r.chunkId);
    const expectedOrder = [...fusedChunkIds].reverse().slice(0, 10);
    expect(result.map((r) => r.chunkId)).toEqual(expectedOrder);
    // The result carries the rerank-mock's score passthrough (the mock returns
    // objects unchanged except order — so the scores are the RRF scores from
    // hybridSearch, which are > 0 and distinct).
    expect(result[0]!.score).toBeGreaterThan(0);
  });

  // ─── Test 4: enabled multi-WS path ──────────────────────────────────────────
  it("D-03 enabled multi-WS: calls multiWorkspaceHybridSearch with over-fetched limit, then rerank, then trim", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "rag_reranker_enabled") return { value: "true" };
      if (key === "rag_reranker_candidate_pool") return { value: "4" };
      return { value: undefined };
    });

    // 40 candidates per workspace → multiWorkspaceHybridSearch with effectiveLimit=40
    // produces a fused list (deduped across 3 workspaces). Since each workspace
    // returns the SAME 40 chunkIds, the fusion dedupes to 40 unique chunks.
    const pool40: HybridSearchResult[] = Array.from({ length: 40 }, (_, i) => ({
      chunkId: `doc-m-${i}`, documentId: "doc-m", documentName: "Multi",
      chunkText: `chunk ${i}`, score: 0, source: "fts" as const,
      chunkIndex: i, metadata: {},
    }));
    setupFtsOnlyFixture(pool40, ["ws-1", "ws-2", "ws-3"]);

    mockRerankCandidates.mockImplementation(async (_q: string, c: HybridSearchResult[]) =>
      [...c].reverse(),
    );

    const result = await hybridSearchWithRerank("query", ["ws-1", "ws-2", "ws-3"], 10);

    expect(mockRerankCandidates).toHaveBeenCalledTimes(1);
    const rerankArg = mockRerankCandidates.mock.calls[0]![1] as HybridSearchResult[];
    // 3 workspaces × 40 candidates each, but deduped by chunkId → 40 unique.
    expect(rerankArg.length).toBe(40);
    // Trim to final K = 10.
    expect(result).toHaveLength(10);
  });

  // ─── Test 5: cap at 100 (D-03) ──────────────────────────────────────────────
  it("D-03 cap at 100: pool='10' + limit=20 → effectiveLimit = min(200, 100) = 100", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "rag_reranker_enabled") return { value: "true" };
      if (key === "rag_reranker_candidate_pool") return { value: "10" };
      return { value: undefined };
    });

    const pool100: HybridSearchResult[] = Array.from({ length: 100 }, (_, i) => ({
      chunkId: `doc-cap-${i}`, documentId: "doc-cap", documentName: "Cap",
      chunkText: `chunk ${i}`, score: 0, source: "fts" as const,
      chunkIndex: i, metadata: {},
    }));
    setupFtsOnlyFixture(pool100, ["ws-1"]);

    mockRerankCandidates.mockImplementation(async (_q: string, c: HybridSearchResult[]) => c);

    const result = await hybridSearchWithRerank("query", "ws-1", 20);

    // ftsSearch receives effectiveLimit*2 = 100*2 = 200 (NOT 200*2 = 400).
    const ftsLimit = mockFtsSearch.mock.calls[0]![2] as number;
    expect(ftsLimit).toBe(200); // 100 * 2 — capped at 100, not 200.
    // rerankCandidates receives the capped pool (100, not 200).
    const rerankArg = mockRerankCandidates.mock.calls[0]![1] as HybridSearchResult[];
    expect(rerankArg.length).toBe(100);
    // Trim to final K = 20.
    expect(result).toHaveLength(20);
  });

  // ─── Test 6: graceful fallback propagates (D-07) ───────────────────────────
  it("D-07 live-path: rerank failure (collector down) → wrapper catches, logs warn, returns RRF-ordered over-fetched candidates sliced to limit (NOT a throw)", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "rag_reranker_enabled") return { value: "true" };
      if (key === "rag_reranker_candidate_pool") return { value: "4" };
      return { value: undefined };
    });

    const pool40: HybridSearchResult[] = Array.from({ length: 40 }, (_, i) => ({
      chunkId: `doc-fb-${i}`, documentId: "doc-fb", documentName: "Fallback",
      chunkText: `chunk ${i}`, score: 0, source: "fts" as const,
      chunkIndex: i, metadata: {},
    }));
    setupFtsOnlyFixture(pool40, ["ws-1"]);

    // rerankCandidates throws (collector down). The wrapper should catch and
    // return the RRF-ordered over-fetched candidates sliced to limit.
    mockRerankCandidates.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3210"));

    const result = await hybridSearchWithRerank("query", "ws-1", 10);

    // Not a throw — wrapper caught.
    expect(result).toHaveLength(10);
    // The result is the RRF-ordered pool (pool40 in rank order) sliced to 10.
    // The RRF order for an FTS-only fixture is the array order (rank 0..39).
    expect(result.map((r) => r.chunkId)).toEqual(pool40.slice(0, 10).map((r) => r.chunkId));
  });

  // ─── Edge: enabled with pool=0 or invalid → defaults to 4 (D-03 safe) ───────
  it("D-03 safe-default: invalid pool value ('NaN' / '0' / '-1') falls back to poolRatio=4", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "rag_reranker_enabled") return { value: "true" };
      if (key === "rag_reranker_candidate_pool") return { value: "NaN" };
      return { value: undefined };
    });

    const pool40: HybridSearchResult[] = Array.from({ length: 40 }, (_, i) => ({
      chunkId: `doc-sd-${i}`, documentId: "doc-sd", documentName: "Safe",
      chunkText: `chunk ${i}`, score: 0, source: "fts" as const,
      chunkIndex: i, metadata: {},
    }));
    setupFtsOnlyFixture(pool40, ["ws-1"]);
    mockRerankCandidates.mockImplementation(async (_q: string, c: HybridSearchResult[]) => c);

    await hybridSearchWithRerank("query", "ws-1", 10);

    // Invalid pool → fallback 4 → effectiveLimit = min(10*4, 100) = 40.
    const ftsLimit = mockFtsSearch.mock.calls[0]![2] as number;
    expect(ftsLimit).toBe(80); // 40 * 2
  });
});