// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 93-02 Task 1 — rerankCandidates (post-RRF) unit tests.
 *
 * Behaviors (mirrors 93-02-PLAN.md `<behavior>`):
 *  1. default OFF (SC1): getSetting('rag_reranker_enabled') → { value: 'false' }
 *     → rerankCandidates returns candidates byte-identical (same order, same
 *    scores); axios.post NOT called.
 *  2. enabled calls collector: getSetting → { value: 'true' } → axios.post
 *    called with `${COLLECTOR_URL}/api/ingest/rerank` + body { query, candidates };
 *    response.data.results returned (reranked order, score = sigmoid).
 *  3. graceful fallback (D-07): axios.post rejects with ECONNREFUSED →
 *    rerankCandidates returns original candidates (RRF order preserved) +
 *    logger.warn called; NOT a throw.
 *  4. RRF-untouched regression (SC2): multiWorkspaceHybridSearch output is
 *    byte-identical when rag_reranker_enabled=false — the rerank function is
 *    never called inside multiWorkspaceHybridSearch (Pitfall 4 guard).
 *  5. over-fetch trim (D-03): the candidate pool ratio is read from
 *    rag_reranker_candidate_pool; the caller (hybridSearchWithRerank wrapper,
 *    Task 2) does the over-fetch + trim. This test asserts rerankCandidates
 *    itself is agnostic to the pool size — it just reranks whatever candidates
 *    it receives (the over-fetch/trim is the wrapper's job, D-03 separation).
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

const mockGetSetting = require("../services/systemConfigService").getSetting as jest.Mock;
const mockAxiosPost = require("axios").post as jest.Mock;
const mockLogger = require("../utils/logger").logger as { warn: jest.Mock };

// Import after mocks
import { rerankCandidates } from "../services/rerankService";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RRF_CANDIDATES: HybridSearchResult[] = [
  {
    chunkId: "doc-a-0",
    documentId: "doc-a",
    documentName: "Doc A",
    chunkText: "alpha content",
    score: 0.0164, // RRF score
    source: "fts",
    chunkIndex: 0,
    metadata: {},
  },
  {
    chunkId: "doc-b-1",
    documentId: "doc-b",
    documentName: "Doc B",
    chunkText: "beta content",
    score: 0.0161,
    source: "fts",
    chunkIndex: 1,
    metadata: {},
  },
  {
    chunkId: "doc-c-2",
    documentId: "doc-c",
    documentName: "Doc C",
    chunkText: "gamma content",
    score: 0.0159,
    source: "fts",
    chunkIndex: 2,
    metadata: {},
  },
];

// Reranker reorders to [C, A, B] with sigmoid scores (D-05).
const RERANKED: HybridSearchResult[] = [
  { ...RRF_CANDIDATES[2]!, score: 0.92 },
  { ...RRF_CANDIDATES[0]!, score: 0.71 },
  { ...RRF_CANDIDATES[1]!, score: 0.43 },
];

describe("rerankCandidates (Phase 93-02 Task 1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: disabled. Each test may override.
    mockGetSetting.mockResolvedValue({ value: "false" });
  });

  // ─── Behavior 1: default OFF (SC1) ─────────────────────────────────────────
  it("SC1: when rag_reranker_enabled='false', returns candidates byte-identical and does NOT call axios.post", async () => {
    const result = await rerankCandidates("test query", RRF_CANDIDATES);

    // Byte-identical: same array, same order, same scores.
    expect(result).toBe(RRF_CANDIDATES); // same reference (no copy when disabled)
    expect(result).toEqual(RRF_CANDIDATES);
    // axios.post MUST NOT be called when disabled — zero behavior change at rest.
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ─── Behavior 1b: missing setting (undefined) also treated as disabled ─────
  it("SC1: when getSetting returns { value: undefined } (key not seeded yet), treats as disabled", async () => {
    mockGetSetting.mockResolvedValue({ value: undefined });
    const result = await rerankCandidates("test query", RRF_CANDIDATES);
    expect(result).toEqual(RRF_CANDIDATES);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ─── Behavior 2: enabled calls collector ──────────────────────────────────
  it("enabled: calls axios.post with COLLECTOR_URL/api/ingest/rerank + { query, candidates } body, returns reranked results", async () => {
    mockGetSetting.mockResolvedValue({ value: "true" });
    mockAxiosPost.mockResolvedValueOnce({ data: { results: RERANKED } });

    const result = await rerankCandidates("alpha query", RRF_CANDIDATES);

    // Called once against the collector rerank endpoint.
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockAxiosPost.mock.calls[0]!;
    expect(url).toBe("http://localhost:3210/api/ingest/rerank");
    expect(body.query).toBe("alpha query");
    // candidates are passed through (chunkId + documentId + chunkText + score + source + chunkIndex + metadata).
    expect(body.candidates).toHaveLength(3);
    expect(body.candidates[0]).toMatchObject({
      chunkId: "doc-a-0",
      documentId: "doc-a",
      chunkText: "alpha content",
      source: "fts",
      chunkIndex: 0,
    });
    // 30s timeout per the plan action.
    expect(opts).toMatchObject({ timeout: 30000 });
    // Returns the reranked order (D-05 sigmoid scores).
    expect(result).toEqual(RERANKED);
    expect(result.map((r) => r.chunkId)).toEqual(["doc-c-2", "doc-a-0", "doc-b-1"]);
  });

  // ─── Behavior 3: graceful fallback (D-07) ──────────────────────────────────
  it("D-07: on ECONNREFUSED, returns original RRF-ordered candidates + logger.warn, NOT a throw", async () => {
    mockGetSetting.mockResolvedValue({ value: "true" });
    const connErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3210"), {
      code: "ECONNREFUSED",
    });
    mockAxiosPost.mockRejectedValueOnce(connErr);

    const result = await rerankCandidates("alpha query", RRF_CANDIDATES);

    // Returns the ORIGINAL candidates in RRF order — graceful fallback.
    expect(result).toEqual(RRF_CANDIDATES);
    expect(result.map((r) => r.chunkId)).toEqual(["doc-a-0", "doc-b-1", "doc-c-2"]);
    // logger.warn called with the error message (T-93-06: no query/candidate text leaked).
    expect(mockLogger.warn).toHaveBeenCalled();
    const warnMsg = mockLogger.warn.mock.calls[0]![0] as string;
    expect(warnMsg).toContain("[rerank]");
    expect(warnMsg).toContain("ECONNREFUSED");
  });

  it("D-07: on collector 500, returns RRF order + logger.warn, NOT a throw", async () => {
    mockGetSetting.mockResolvedValue({ value: "true" });
    mockAxiosPost.mockRejectedValueOnce(new Error("Request failed with status code 500"));

    const result = await rerankCandidates("alpha query", RRF_CANDIDATES);

    expect(result).toEqual(RRF_CANDIDATES);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  // ─── Behavior 5: pool-size agnostic (D-03 separation) ───────────────────────
  it("D-03: rerankCandidates is agnostic to pool size — it just reranks whatever it receives (over-fetch/trim is the wrapper's job)", async () => {
    mockGetSetting.mockResolvedValue({ value: "true" });
    // 40 candidates (the over-fetch pool the wrapper would produce for K=10, pool=4).
    const pool: HybridSearchResult[] = Array.from({ length: 40 }, (_, i) => ({
      chunkId: `doc-x-${i}`,
      documentId: "doc-x",
      documentName: "Doc X",
      chunkText: `chunk ${i}`,
      score: 0.001,
      source: "fts" as const,
      chunkIndex: i,
      metadata: {},
    }));
    const rerankedPool: HybridSearchResult[] = [...pool].reverse().map((r, i) => ({
      ...r,
      score: 1 - i * 0.01,
    }));
    mockAxiosPost.mockResolvedValueOnce({ data: { results: rerankedPool } });

    const result = await rerankCandidates("pool query", pool);

    // All 40 are passed through to the collector (the wrapper did the over-fetch).
    expect(mockAxiosPost.mock.calls[0]![1].candidates).toHaveLength(40);
    // rerankCandidates returns whatever the collector sent back — it does NOT trim.
    // The wrapper (Task 2) trims to final K via .slice(0, limit).
    expect(result).toHaveLength(40);
    expect(result).toEqual(rerankedPool);
  });

  // ─── Behavior: empty candidates short-circuit ──────────────────────────────
  it("returns empty array unchanged when candidates is empty (no collector call even if enabled)", async () => {
    mockGetSetting.mockResolvedValue({ value: "true" });
    const result = await rerankCandidates("query", []);
    expect(result).toEqual([]);
    // Collector is not called for an empty candidate list — saves a hop.
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});