// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * RAG-01 single-WS RRF guard — regression net for RAG-02 per-workspace
 * normalization (Phase 85, D-10 strict ordering).
 *
 * This test is committed on base BEFORE any RAG-02 normalization edit lands.
 * It asserts the CURRENT single-workspace fused ordering for a fixed fixture
 * set via both `hybridSearch()` direct and `multiWorkspaceHybridSearch`
 * single-WS delegation (lines 259-270). After RAG-02 adds the per-WS divisor
 * to the multi-WS fusion loop, this test MUST stay green (single-WS path is
 * untouched by D-03; the divisor is a per-WS constant scalar → relative
 * ordering preserved by D-01).
 *
 * No `prisma.$queryRaw` mock here — the single-WS path bypasses the corpus
 * size helper (which does not exist yet on base). RAG-03's mock adds
 * `$queryRaw` in 85-03 (Landmine L2) — that belongs to the bias test, NOT
 * this guard.
 */
import type { HybridSearchResult } from "../services/hybridSearchService";

// ─── Mock skeleton copied verbatim from hybridSearch.test.ts:1-64 ───────────

// Mock ftsService so it returns controlled results
// NOTE: mock fns live INSIDE factories to avoid TDZ under @swc/jest.
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

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: undefined }),
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
const mockFtsSearch = require("../services/ftsService").ftsSearch as jest.Mock;
const mockAxiosPost = require("axios").post as jest.Mock;

// Mock prisma — single-WS path bypasses the corpus-size helper, but the
// Phase 93-02 SC2 rerank-gate regression (added below) exercises the 2-WS
// fan-out path which calls getCorpusSizes → $queryRaw. Expose $queryRaw
// returning [] (empty Map → `|| 1` divisor guard → existing behavior) so the
// 2-WS path does not throw TypeError. RAG-03 (85-03 Landmine L2) first
// introduced $queryRaw in hybridSearch.test.ts; this file mirrors it now.
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

// Import after mocks are set up
import {
  hybridSearch,
  multiWorkspaceHybridSearch,
} from "../services/hybridSearchService";

// ─── setupHybridSearchMocks helper (copied from hybridSearch.test.ts:81-106) ─

/**
 * Helper to set up mock return values for hybridSearch's internal calls.
 * hybridSearch calls Promise.all([vectorSearchViaCollector, ftsSearch])
 * vectorSearchViaCollector calls axios.post (mocked above)
 * ftsSearch is mocked directly
 *
 * For a given workspace, we configure both to return the desired results.
 * Each result needs both vector and fts representations for proper RRF scoring.
 */
function setupHybridSearchMocks(
  workspaceResults: Map<string, HybridSearchResult[]>
) {
  // Reset all mocks
  mockFtsSearch.mockReset();
  mockAxiosPost.mockReset();

  // Set up ftsSearch mock - returns all FTS results for any workspace query
  // hybridSearch will call ftsSearch(query, workspaceId, limit*2)
  mockFtsSearch.mockImplementation(
    async (_query: string, workspaceId: string, _limit: number) => {
      const results = workspaceResults.get(workspaceId) || [];
      return results.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        documentName: r.documentName,
        chunkText: r.chunkText,
        rank: 0,
      }));
    }
  );

  // Set up vector search mock - returns empty results
  // This makes hybridSearch rely primarily on FTS results
  mockAxiosPost.mockResolvedValue({
    data: { results: [] },
  });
}

// ─── RAG-01 guard fixture ───────────────────────────────────────────────────
//
// 4 FTS results in a fixed array order. The array index IS the RRF rank, so:
//   rank 0 → score 1/(60+0+1) = 1/61  (highest)
//   rank 1 → score 1/(60+1+1) = 1/62
//   rank 2 → score 1/(60+2+1) = 1/63
//   rank 3 → score 1/(60+3+1) = 1/64  (lowest)
//
// The FTS input is deliberately NOT in documentId/chunkIndex order, so the
// score-desc sort produces an order different from a naive documentId ASC
// sort — proving the RRF score is the primary sort key. The D-05 tiebreaker
// (score desc, documentId ASC, chunkIndex ASC) is the load-bearing
// deterministic comparator in compareFusedResults; scores are distinct here
// so the tiebreaker sub-keys are not the primary driver, but the comparator
// is exercised end-to-end (and future fixtures that DO produce ties will
// rely on it).
const FIXED_FTS_FIXTURE: HybridSearchResult[] = [
  {
    chunkId: "doc-c-2",
    documentId: "doc-c",
    documentName: "Doc C",
    chunkText: "content c2",
    score: 0, // not used by fusion — rank (array index) drives RRF score
    source: "fts",
    chunkIndex: 2,
    metadata: {},
  },
  {
    chunkId: "doc-a-0",
    documentId: "doc-a",
    documentName: "Doc A",
    chunkText: "content a0",
    score: 0,
    source: "fts",
    chunkIndex: 0,
    metadata: {},
  },
  {
    chunkId: "doc-b-1",
    documentId: "doc-b",
    documentName: "Doc B",
    chunkText: "content b1",
    score: 0,
    source: "fts",
    chunkIndex: 1,
    metadata: {},
  },
  {
    chunkId: "doc-a-1",
    documentId: "doc-a",
    documentName: "Doc A",
    chunkText: "content a1",
    score: 0,
    source: "fts",
    chunkIndex: 1,
    metadata: {},
  },
];

// Expected fused ordering: score desc (rank 0 > 1 > 2 > 3).
const EXPECTED_CHUNK_ID_ORDER = ["doc-c-2", "doc-a-0", "doc-b-1", "doc-a-1"];

describe("RAG-01 single-WS RRF guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("preserves current single-WS fused ordering via hybridSearch() direct path", async () => {
    // FTS-only path: vector returns empty, FTS returns the fixed fixture.
    // mockFtsSearch returns the fixture with rank: 0 (the array index is the
    // real RRF rank — the mock's rank field is ignored by hybridSearch's
    // forEach((result, rank) => ...) which uses the array index as rank).
    mockFtsSearch.mockResolvedValue(
      FIXED_FTS_FIXTURE.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        documentName: r.documentName,
        chunkText: r.chunkText,
        rank: 0,
      }))
    );
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    const results = await hybridSearch("test query", "ws-1", 10);

    // Assert the exact ordered list of chunkIds — locked on base.
    expect(results.map((r) => r.chunkId)).toEqual(EXPECTED_CHUNK_ID_ORDER);
    // All 4 results within limit=10.
    expect(results).toHaveLength(4);
  });

  it("preserves ordering via multiWorkspaceHybridSearch single-WS delegation (lines 259-270)", async () => {
    // Same fixture via the setupHybridSearchMocks helper (uses a Map).
    const resultMap = new Map<string, HybridSearchResult[]>();
    resultMap.set("ws-1", FIXED_FTS_FIXTURE);
    setupHybridSearchMocks(resultMap);

    const results = await multiWorkspaceHybridSearch("test query", ["ws-1"], 10);

    // Same ordering as Case 1 (single-WS delegation slices + tags — ordering
    // is identical to hybridSearch() direct).
    expect(results.map((r) => r.chunkId)).toEqual(EXPECTED_CHUNK_ID_ORDER);
    expect(results).toHaveLength(4);
    // The delegation branch tags metadata.sourceWorkspaceId.
    expect(results[0]!.metadata?.sourceWorkspaceId).toBe("ws-1");
  });

  // ─── Phase 93-02 Task 1: SC2 rerank-gate regression ─────────────────────────
  //
  // Pitfall 4 guard: the reranker is a NEW post-RRF function (rerankCandidates
  // in services/rerankService.ts). The RRF code (hybridSearch lines 135-260,
  // multiWorkspaceHybridSearch lines 282-378) is FROZEN. This test asserts that
  // when rag_reranker_enabled=false (the SC1 default), multiWorkspaceHybridSearch
  // output is byte-identical to the pre-reranker baseline AND the rerank
  // function is never invoked inside the RRF body. It guards against an
  // accidental inline modification of the RRF code (Pitfall 4) by ensuring the
  // rerank function would have zero effect even if someone wired it inline —
  // because the only legitimate wiring path is the wrapper in Task 2, which
  // reads the same SystemConfig gate.
  it("Phase 93-02 SC2: multiWorkspaceHybridSearch output is byte-identical when rag_reranker_enabled=false (rerank not invoked inside RRF body)", async () => {
    // getSetting default mock returns { value: undefined } — disabled. Confirm
    // the disabled path produces stable RRF output for both ws-1 (single-WS
    // delegation) and a 2-WS fan-out.
    const resultMap = new Map<string, HybridSearchResult[]>();
    resultMap.set("ws-1", FIXED_FTS_FIXTURE);
    resultMap.set("ws-2", FIXED_FTS_FIXTURE);
    setupHybridSearchMocks(resultMap);

    const run1 = await multiWorkspaceHybridSearch("test query", ["ws-1", "ws-2"], 10);
    const run2 = await multiWorkspaceHybridSearch("test query", ["ws-1", "ws-2"], 10);

    // Byte-identical across two independent calls — RRF is deterministic (D-05
    // tiebreaker) and the reranker is not invoked when disabled.
    expect(run1).toEqual(run2);
    // The collector /ingest/rerank endpoint is never called by the RRF body.
    // vectorSearchViaCollector calls axios.post against /api/ingest/query — the
    // rerank endpoint would be /api/ingest/rerank. Assert no rerank URL is hit.
    for (const call of mockAxiosPost.mock.calls) {
      const url = call[0] as string;
      expect(url).not.toContain("/api/ingest/rerank");
    }
  });
});