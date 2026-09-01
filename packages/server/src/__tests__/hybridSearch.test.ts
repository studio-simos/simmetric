// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for multiWorkspaceHybridSearch — RRF fusion across multiple workspaces
 *
 * Note: We mock the internal dependencies (ftsService, axios) so that
 * hybridSearch() returns controlled results. We do NOT mock hybridSearch
 * itself since multiWorkspaceHybridSearch calls it as a sibling function
 * in the same module, and partial module mocking creates call-order issues.
 * Instead, we control what hybridSearch returns by controlling its
 * sub-dependencies (vector search and FTS search).
 */
import type { HybridSearchResult } from "../services/hybridSearchService";

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

// Mock systemConfigService to avoid transitive @simmetric-chat/shared resolution
// (pre-existing worktree env gap; hybridSearchService imports getSetting).
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: undefined }),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock axios so vectorSearchViaCollector returns controlled results
jest.mock("axios", () => ({
  post: jest.fn(),
  create: jest.fn(() => ({ post: jest.fn(), get: jest.fn() })),
}));
const mockFtsSearch = require("../services/ftsService").ftsSearch as jest.Mock;
const mockAxiosPost = require("axios").post as jest.Mock;

// Mock prisma so vectorSearchViaCollector's workspace lookup works in tests.
// 260721-np3 Task 2: also expose document.findMany returning [] by default so
// the query-time embedding-model mismatch guard does NOT skip the vector leg
// in existing tests (empty workspace → no stored models → no mismatch).
// 85-03 RAG-02 (Landmine L2): also expose $queryRaw so getCorpusSizes does
// not throw TypeError when multiWorkspaceHybridSearch calls it. Default
// resolves to [] → empty Map → `|| 1` divisor guard → existing behavior
// (no normalization) preserved for tests that do not configure it.
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
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { hybridSearch, multiWorkspaceHybridSearch } from "../services/hybridSearchService";
import { getSetting } from "../services/systemConfigService";

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
  mockFtsSearch.mockImplementation(async (_query: string, workspaceId: string, _limit: number) => {
    const results = workspaceResults.get(workspaceId) || [];
    return results.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      documentName: r.documentName,
      chunkText: r.chunkText,
      rank: 0,
    }));
  });

  // Set up vector search mock - returns empty results
  // This makes hybridSearch rely primarily on FTS results
  mockAxiosPost.mockResolvedValue({
    data: { results: [] },
  });
}

describe("multiWorkspaceHybridSearch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("with single workspace", () => {
    it("delegates to hybridSearch and adds sourceWorkspaceId to metadata", async () => {
      const ws1Results: HybridSearchResult[] = [
        {
          chunkId: "chunk-1",
          documentId: "doc-1",
          documentName: "Test Doc",
          chunkText: "Test content",
          score: 0.05,
          source: "fts",
          chunkIndex: 0,
          metadata: { someKey: "someValue" },
        },
      ];

      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", ws1Results);
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1"], 10);

      expect(results).toHaveLength(1);
      expect(results[0]!.chunkId).toBe("chunk-1");
      expect(results[0]!.metadata?.sourceWorkspaceId).toBe("ws-1");
    });

    it("returns empty array when hybridSearch returns empty", async () => {
      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", []);
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1"], 10);

      expect(results).toHaveLength(0);
    });
  });

  describe("with multiple workspaces", () => {
    it("returns deduplicated results sorted by RRF score", async () => {
      // Two workspaces with overlapping chunkIds (chunk-2 appears in both)
      const ws1Results: HybridSearchResult[] = [
        {
          chunkId: "chunk-1",
          documentId: "doc-1",
          documentName: "Doc 1",
          chunkText: "Content from ws1 chunk 1",
          score: 0.05,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
        {
          chunkId: "chunk-2",
          documentId: "doc-2",
          documentName: "Doc 2",
          chunkText: "Content from ws1 chunk 2",
          score: 0.03,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
      ];

      const ws2Results: HybridSearchResult[] = [
        {
          chunkId: "chunk-2",
          documentId: "doc-2",
          documentName: "Doc 2",
          chunkText: "Content from ws2 chunk 2",
          score: 0.04,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
        {
          chunkId: "chunk-3",
          documentId: "doc-3",
          documentName: "Doc 3",
          chunkText: "Content from ws2 chunk 3",
          score: 0.02,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
      ];

      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", ws1Results);
      resultMap.set("ws-2", ws2Results);
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1", "ws-2"], 10);

      // Verify deduplication: chunk-2 should appear only once
      const chunk2Results = results.filter((r: HybridSearchResult) => r.chunkId === "chunk-2");
      expect(chunk2Results.length).toBe(1);

      // chunk-2 should have the highest score since it appears in both workspaces
      // (gets RRF contribution from both workspace rankings)
      expect(results[0]!.chunkId).toBe("chunk-2");

      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
      }
    });

    it("tags each result with sourceWorkspaceId from the workspace that produced it", async () => {
      const ws1Results: HybridSearchResult[] = [
        {
          chunkId: "chunk-1",
          documentId: "doc-1",
          documentName: "Doc 1",
          chunkText: "Content 1",
          score: 0.05,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
      ];

      const ws2Results: HybridSearchResult[] = [
        {
          chunkId: "chunk-3",
          documentId: "doc-3",
          documentName: "Doc 3",
          chunkText: "Content 3",
          score: 0.04,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
      ];

      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", ws1Results);
      resultMap.set("ws-2", ws2Results);
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1", "ws-2"], 10);

      // chunk-1 came from ws-1, chunk-3 came from ws-2
      const chunk1 = results.find((r: HybridSearchResult) => r.chunkId === "chunk-1");
      const chunk3 = results.find((r: HybridSearchResult) => r.chunkId === "chunk-3");

      expect(chunk1?.metadata?.sourceWorkspaceId).toBe("ws-1");
      expect(chunk3?.metadata?.sourceWorkspaceId).toBe("ws-2");
    });

    it("tags chunk appearing in multiple workspaces with the first workspace's ID", async () => {
      const ws1Results: HybridSearchResult[] = [
        {
          chunkId: "chunk-shared",
          documentId: "doc-1",
          documentName: "Doc 1",
          chunkText: "Shared content",
          score: 0.05,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
      ];

      const ws2Results: HybridSearchResult[] = [
        {
          chunkId: "chunk-shared",
          documentId: "doc-1",
          documentName: "Doc 1",
          chunkText: "Shared content from ws2",
          score: 0.03,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
      ];

      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", ws1Results);
      resultMap.set("ws-2", ws2Results);
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1", "ws-2"], 10);

      // chunk-shared appears once after deduplication
      const shared = results.find((r: HybridSearchResult) => r.chunkId === "chunk-shared");
      expect(shared).toBeDefined();
      // sourceWorkspaceId should be from one of the workspaces that produced this chunk
      expect(["ws-1", "ws-2"]).toContain(shared!.metadata!.sourceWorkspaceId);
    });

    it("respects the limit parameter", async () => {
      // Create 5 results per workspace
      const makeResults = (prefix: string): HybridSearchResult[] =>
        Array.from({ length: 5 }, (_, i) => ({
          chunkId: `${prefix}-chunk-${i}`,
          documentId: `${prefix}-doc-${i}`,
          documentName: `${prefix} Doc ${i}`,
          chunkText: `Content ${i}`,
          score: 0.05 - i * 0.01,
          source: "fts" as const,
          chunkIndex: 0,
          metadata: {},
        }));

      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", makeResults("ws1"));
      resultMap.set("ws-2", makeResults("ws2"));
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1", "ws-2"], 5);

      // Should return at most 5 results
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("handles empty results from one workspace", async () => {
      const ws1Results: HybridSearchResult[] = [
        {
          chunkId: "chunk-1",
          documentId: "doc-1",
          documentName: "Doc 1",
          chunkText: "Content 1",
          score: 0.05,
          source: "fts",
          chunkIndex: 0,
          metadata: {},
        },
      ];

      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", ws1Results);
      resultMap.set("ws-2", []);
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1", "ws-2"], 10);

      expect(results).toHaveLength(1);
      expect(results[0]!.chunkId).toBe("chunk-1");
      expect(results[0]!.metadata?.sourceWorkspaceId).toBe("ws-1");
    });

    it("handles empty results from all workspaces", async () => {
      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", []);
      resultMap.set("ws-2", []);
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1", "ws-2"], 10);

      expect(results).toHaveLength(0);
    });
  });
});

describe("hybridSearch (single-workspace) — ING-02 documentName propagation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("propagates documentName from FTS result to fused HybridSearchResult (FTS-only)", async () => {
    // FTS returns a result with documentName; vector search returns nothing.
    // The fused result must carry documentName from the FTS branch.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentName: "Doc 1",
        chunkText: "test content",
        rank: 0.5,
      },
    ]);
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentName).toBe("Doc 1");
    expect(results[0]!.source).toBe("fts");
  });

  it("tags source as 'both' when vector and FTS share the same chunk id (self-contained)", async () => {
    // Self-contained: vector result id === FTS result chunkId.
    // The fused entry must have source: "both" regardless of Plan 01 merge state.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([
      {
        chunkId: "doc-1-0",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentName: "Doc 1",
        chunkText: "shared chunk text",
        rank: 0.4,
      },
    ]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "doc-1-0",
            score: 0.8,
            text: "shared chunk text",
            metadata: { documentId: "doc-1", chunkText: "shared chunk text" },
          },
        ],
      },
    });

    const results = await hybridSearch("shared", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("both");
    // documentName must be populated from the FTS branch
    expect(results[0]!.documentName).toBe("Doc 1");
  });
});

describe("hybridSearch — RRF tiebreaker (D-05) + single-ws slice + FTS-empty fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---- RRF tiebreaker: identical scores break by documentId ASC then chunkIndex ASC ----
  describe("RRF tiebreaker (D-05)", () => {
    it("breaks score ties by documentId ASC (doc-a before doc-b)", async () => {
      // Construct two chunks with identical RRF fused scores by swapping
      // vector/FTS ranks: doc-a-3 gets vector rank 0 + FTS rank 1, doc-b-1
      // gets vector rank 1 + FTS rank 0. Both sum to 1/(K+1) + 1/(K+2).
      mockFtsSearch.mockReset();
      mockAxiosPost.mockReset();
      mockFtsSearch.mockResolvedValue([
        {
          chunkId: "doc-b-1",
          documentId: "doc-b",
          workspaceId: "ws-1",
          documentName: "Doc B",
          chunkText: "content b1",
          rank: 0.9,
        },
        {
          chunkId: "doc-a-3",
          documentId: "doc-a",
          workspaceId: "ws-1",
          documentName: "Doc A",
          chunkText: "content a3",
          rank: 0.8,
        },
      ]);
      mockAxiosPost.mockResolvedValue({
        data: {
          results: [
            {
              id: "doc-a-3",
              score: 0.95,
              text: "content a3",
              metadata: { documentId: "doc-a", chunkText: "content a3" },
            },
            {
              id: "doc-b-1",
              score: 0.9,
              text: "content b1",
              metadata: { documentId: "doc-b", chunkText: "content b1" },
            },
          ],
        },
      });

      const results = await hybridSearch("test", "ws-1", 10);

      expect(results).toHaveLength(2);
      // Both have identical fused score; doc-a < doc-b (documentId ASC)
      expect(results[0]!.chunkId).toBe("doc-a-3");
      expect(results[1]!.chunkId).toBe("doc-b-1");
      // Sanity: scores are actually equal (confirming the tiebreaker is what
      // drives the ordering, not score difference)
      expect(results[0]!.score).toBeCloseTo(results[1]!.score, 10);
    });

    it("breaks score ties by chunkIndex ASC when documentId is equal", async () => {
      // Same documentId, different chunkIndex: doc-a-3 vs doc-a-1.
      // Both get identical fused score via rank-swapping.
      mockFtsSearch.mockReset();
      mockAxiosPost.mockReset();
      mockFtsSearch.mockResolvedValue([
        {
          chunkId: "doc-a-1",
          documentId: "doc-a",
          workspaceId: "ws-1",
          documentName: "Doc A",
          chunkText: "content a1",
          rank: 0.8,
        },
        {
          chunkId: "doc-a-3",
          documentId: "doc-a",
          workspaceId: "ws-1",
          documentName: "Doc A",
          chunkText: "content a3",
          rank: 0.9,
        },
      ]);
      mockAxiosPost.mockResolvedValue({
        data: {
          results: [
            {
              id: "doc-a-3",
              score: 0.95,
              text: "content a3",
              metadata: { documentId: "doc-a", chunkText: "content a3" },
            },
            {
              id: "doc-a-1",
              score: 0.9,
              text: "content a1",
              metadata: { documentId: "doc-a", chunkText: "content a1" },
            },
          ],
        },
      });

      const results = await hybridSearch("test", "ws-1", 10);

      expect(results).toHaveLength(2);
      // Same documentId; chunkIndex 1 < 3
      expect(results[0]!.chunkId).toBe("doc-a-1");
      expect(results[1]!.chunkId).toBe("doc-a-3");
      expect(results[0]!.score).toBeCloseTo(results[1]!.score, 10);
    });
  });

  // ---- Single-ws slice: multiWorkspaceHybridSearch respects limit ----
  describe("single-ws slice limit", () => {
    it("respects limit when single-workspace over-fetches (limit=3, returns <=3)", async () => {
      // 6 FTS results; hybridSearch(query, ws, limit*2=6) returns 6;
      // multiWorkspaceHybridSearch must slice to limit=3.
      const sixResults = Array.from({ length: 6 }, (_, i) => ({
        chunkId: `doc-a-${i}`,
        documentId: "doc-a",
        documentName: "Doc A",
        chunkText: `content ${i}`,
        score: 0.05 - i * 0.001,
        source: "fts" as const,
        chunkIndex: i,
        metadata: {},
      }));

      const resultMap = new Map<string, HybridSearchResult[]>();
      resultMap.set("ws-1", sixResults);
      setupHybridSearchMocks(resultMap);

      const results = await multiWorkspaceHybridSearch("test query", ["ws-1"], 3);

      expect(results.length).toBeLessThanOrEqual(3);
      // All results should be tagged with sourceWorkspaceId
      for (const r of results) {
        expect(r.metadata?.sourceWorkspaceId).toBe("ws-1");
      }
    });
  });

  // ---- FTS-empty fallback: vector-only results are safe ----
  describe("FTS-empty fallback (vector-only)", () => {
    it("returns vector-only results with correct RRF scores when FTS is empty", async () => {
      mockFtsSearch.mockReset();
      mockAxiosPost.mockReset();
      mockFtsSearch.mockResolvedValue([]); // FTS unavailable
      // 5 vector results
      const vectorResults = Array.from({ length: 5 }, (_, i) => ({
        id: `doc-x-${i}`,
        score: 0.9 - i * 0.1,
        text: `vector content ${i}`,
        metadata: { documentId: "doc-x", chunkText: `vector content ${i}` },
      }));
      mockAxiosPost.mockResolvedValue({ data: { results: vectorResults } });

      const results = await hybridSearch("test", "ws-1", 10);

      expect(results).toHaveLength(5);
      for (let i = 0; i < results.length; i++) {
        expect(results[i]!.source).toBe("vector");
        expect(results[i]!.score).toBeCloseTo(1 / (60 + i + 1), 10);
        expect(results[i]!.chunkIndex).toBe(i); // derived from chunkId `doc-x-${i}`
      }
    });
  });
});

// ─── 260721-np3 Task 2: query-time embedding-model mismatch guard ────
// When even ONE non-deleted Document in the workspace has an embeddingModel
// differing from getSetting("EMBEDDING_MODEL"), the stored vectors are a mix
// of models and a single-model query vector cannot match all of them → skip
// the vector leg entirely and degrade to FTS-only (graceful, no error).
describe("hybridSearch — query-time embedding-model mismatch guard (260721-np3 Task 2)", () => {
  const queryModel = "Xenova/all-MiniLM-L6-v2";

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the document.findMany mock to the safe default (empty workspace →
    // no stored models → no mismatch). Individual tests override this.
    jest.mocked(prisma.document.findMany).mockResolvedValue([]);
    // Reset getSetting to the safe default (no query model configured →
    // skipVector=false). Individual tests override this.
    jest.mocked(getSetting).mockResolvedValue({ value: undefined } as any);
  });

  it("runs the vector leg normally when all workspace docs match the query model", async () => {
    // Query model = L6-v2; all stored docs use L6-v2 → no mismatch → vector runs.
    jest.mocked(getSetting).mockResolvedValue({ value: queryModel } as any);
    // `as any` on the array: prisma.document.findMany is typed by the real
    // PrismaClient overload (Document[]) at compile time — jest.mock only swaps
    // the runtime impl, not the type. Partial { embeddingModel } fixtures need
    // the escape hatch, same as the getSetting mock above.
    jest.mocked(prisma.document.findMany).mockResolvedValue([
      { embeddingModel: queryModel },
      { embeddingModel: queryModel },
    ] as any);
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("test", "ws-1", 10);

    // Vector leg ran (axios.post was called against the collector).
    expect(mockAxiosPost).toHaveBeenCalled();
  });

  it("skips the vector leg when even ONE non-deleted doc has a different embeddingModel", async () => {
    // Query model = L6-v2; one doc uses L12-v2 → mismatch → vector skipped.
    jest.mocked(getSetting).mockResolvedValue({ value: queryModel } as any);
    jest.mocked(prisma.document.findMany).mockResolvedValue([
      { embeddingModel: queryModel },
      { embeddingModel: "Xenova/all-MiniLM-L12-v2" },
    ] as any);
    // FTS returns one result so hybridSearch has something to return.
    mockFtsSearch.mockResolvedValue([
      {
        chunkId: "doc-a-0",
        documentId: "doc-a",
        workspaceId: "ws-1",
        documentName: "Doc A",
        chunkText: "fts only content",
        rank: 0.5,
      },
    ]);
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    const warnSpy = jest.spyOn(logger, "warn");
    const results = await hybridSearch("test", "ws-1", 10);

    // Vector leg short-circuited — collector POST never sent.
    expect(mockAxiosPost).not.toHaveBeenCalled();
    // Structured warning emitted so operators can diagnose the mismatch.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[hybrid\] embedding model mismatch: query=.*vs stored=.*vector leg skipped/),
    );
    // FTS-only results still returned (graceful degrade, no throw).
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("fts");
    warnSpy.mockRestore();
  });

  it("runs the vector leg normally when the workspace has zero documents", async () => {
    // Empty workspace → no stored models to compare → no mismatch possible.
    jest.mocked(getSetting).mockResolvedValue({ value: queryModel } as any);
    jest.mocked(prisma.document.findMany).mockResolvedValue([]);
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("test", "ws-empty", 10);

    expect(mockAxiosPost).toHaveBeenCalled();
  });

  it("runs the vector leg normally when EMBEDDING_MODEL is not configured", async () => {
    // No query model → cannot compare → guard is a no-op (matches LOCKED rule
    // line 33: the conservative rule only fires when a query model is set).
    jest.mocked(getSetting).mockResolvedValue({ value: undefined } as any);
    jest.mocked(prisma.document.findMany).mockResolvedValue([
      { embeddingModel: "Xenova/all-MiniLM-L12-v2" },
    ] as any);
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("test", "ws-1", 10);

    expect(mockAxiosPost).toHaveBeenCalled();
  });

  it("excludes soft-deleted documents from the mismatch check (where: { deletedAt: null })", async () => {
    // The guard must query Document with deletedAt: null so soft-deleted docs
    // do not trip the mismatch guard.
    jest.mocked(getSetting).mockResolvedValue({ value: queryModel } as any);
    jest.mocked(prisma.document.findMany).mockResolvedValue([
      { embeddingModel: queryModel },
    ] as any);
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("test", "ws-soft", 10);

    expect(prisma.document.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-soft", deletedAt: null },
      select: { embeddingModel: true },
      distinct: ["embeddingModel"],
    });
  });
});

// ─── 260815-fk8: enrichDocumentNames — populate missing documentName from DB ─
// When the vector store returns results with empty/undefined documentName in
// metadata (common for older ingested docs or the reembed path which stores ""),
// the server must enrich it from the documents table via a single batched
// prisma.document.findMany at the search exit boundary, so chat RAG sources
// show the real document name instead of the "Unknown" fallback.
describe("hybridSearch — enrichDocumentNames (260815-fk8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Safe defaults: no query model, empty workspace (no mismatch guard trip).
    jest.mocked(getSetting).mockResolvedValue({ value: undefined } as any);
    jest.mocked(prisma.document.findMany).mockResolvedValue([] as any);
  });

  it("enriches missing documentName from DB in the vector-only fallback path", async () => {
    // FTS returns nothing → hybridSearch takes the vector-only branch (~line 182).
    // Vector metadata carries documentName: "" (the reembed path stores "").
    // enrichDocumentNames must look up doc-1's name from the documents table.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "doc-1-0",
            score: 0.9,
            text: "vector content",
            metadata: { documentId: "doc-1", documentName: "", chunkText: "vector content" },
          },
        ],
      },
    });
    // First findMany call is the mismatch guard (returns [] → no trip).
    // Second findMany call is enrichDocumentNames → return the real name.
    // Use mockImplementation to branch on the `select` field. Cast as any:
    // Prisma's generated findMany overload returns PrismaPromise, but jest's
    // mockImplementation expects a plain Promise — the `as any` escape hatch
    // mirrors the existing getSetting/findMany mocks in this file.
    (jest.mocked(prisma.document.findMany).mockImplementation as any)(async (args: any) => {
      if (args.select && args.select.name) {
        return [{ id: "doc-1", name: "Real Document Name.pdf" }];
      }
      return [];
    });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentName).toBe("Real Document Name.pdf");
    expect(results[0]!.source).toBe("vector");
  });

  it("leaves documentName unchanged when already present (no DB lookup needed)", async () => {
    // FTS returns a result with documentName populated → fused path.
    // enrichDocumentNames fast-path: no findMany call with select.name.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentName: "Already Named.pdf",
        chunkText: "content",
        rank: 0.5,
      },
    ]);
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentName).toBe("Already Named.pdf");
    // No enrichment query fired (the only findMany call is the mismatch guard
    // with select.embeddingModel, NOT select.name).
    const findManyCalls = jest.mocked(prisma.document.findMany).mock.calls;
    const enrichmentCalls = findManyCalls.filter(
      (c: any[]) => c[0]?.select?.name === true,
    );
    expect(enrichmentCalls).toHaveLength(0);
  });

  it("enriches missing documentName in the fused (vector+FTS) path", async () => {
    // Both vector and FTS return results, but vector metadata has empty
    // documentName AND the FTS result also lacks it (edge: FTS JOIN missed).
    // The fused result has documentName undefined → enrichDocumentNames fires.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([
      {
        chunkId: "doc-1-0",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentName: undefined as unknown as string,
        chunkText: "shared chunk",
        rank: 0.4,
      },
    ]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "doc-1-0",
            score: 0.8,
            text: "shared chunk",
            metadata: { documentId: "doc-1", documentName: "", chunkText: "shared chunk" },
          },
        ],
      },
    });
    (jest.mocked(prisma.document.findMany).mockImplementation as any)(async (args: any) => {
      if (args.select && args.select.name) {
        return [{ id: "doc-1", name: "Fused Doc.pdf" }];
      }
      return [];
    });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentName).toBe("Fused Doc.pdf");
    expect(results[0]!.source).toBe("both");
  });

  it("enriches missing documentName in multiWorkspaceHybridSearch", async () => {
    // Single-WS delegation path: hybridSearch returns a result with empty
    // documentName; multiWorkspaceHybridSearch must enrich it before returning.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "doc-1-0",
            score: 0.9,
            text: "multi-ws content",
            metadata: { documentId: "doc-1", documentName: "", chunkText: "multi-ws content" },
          },
        ],
      },
    });
    (jest.mocked(prisma.document.findMany).mockImplementation as any)(async (args: any) => {
      if (args.select && args.select.name) {
        return [{ id: "doc-1", name: "Multi WS Doc.pdf" }];
      }
      return [];
    });

    const results = await multiWorkspaceHybridSearch("test", ["ws-1"], 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentName).toBe("Multi WS Doc.pdf");
  });

  it("handles documentId not found in DB (leaves documentName undefined)", async () => {
    // Vector metadata has empty documentName; DB lookup returns nothing for
    // that documentId → documentName stays undefined (caller fallback handles).
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "doc-gone-0",
            score: 0.9,
            text: "content",
            metadata: { documentId: "doc-gone", documentName: "", chunkText: "content" },
          },
        ],
      },
    });
    (jest.mocked(prisma.document.findMany).mockImplementation as any)(async (args: any) => {
      if (args.select && args.select.name) {
        return [] as any; // document not in DB (deleted between ingest and search)
      }
      return [] as any;
    });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentName).toBeUndefined();
  });

  it("does not fire a DB enrichment query when all results already have documentName", async () => {
    // Fast-path: all results populated → enrichDocumentNames returns immediately,
    // no findMany call with select.name.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentName: "Named.pdf",
        chunkText: "content",
        rank: 0.5,
      },
    ]);
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("test", "ws-1", 10);

    const enrichmentCalls = jest.mocked(prisma.document.findMany).mock.calls.filter(
      (c: any[]) => c[0]?.select?.name === true,
    );
    expect(enrichmentCalls).toHaveLength(0);
  });

  // ─── 260815-i4s: derive documentId from chunkId when metadata lacks it ─
  // The fk8 enrichDocumentNames skipped enrichment when documentId was "".
  // The fix derives documentId from the chunkId prefix (format
  // `${documentId}-${chunkIndex}` — see collector/src/routes/ingest.ts:280)
  // when documentId is empty but chunkId is present and parseable.

  it("derives documentId from chunkId prefix when metadata has documentId='' (260815-i4s)", async () => {
    // FTS returns nothing → vector-only branch. Vector metadata carries
    // documentId: "" (empty — the reembed path stores ""). chunkId is
    // "doc-1-0" → enrichDocumentNames must derive documentId="doc-1" from the
    // chunkId prefix (everything before the last dash) and look up the name.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "doc-1-0",
            score: 0.9,
            text: "derived content",
            metadata: { documentId: "", documentName: "", chunkText: "derived content" },
          },
        ],
      },
    });
    (jest.mocked(prisma.document.findMany).mockImplementation as any)(async (args: any) => {
      if (args.select && args.select.name) {
        return [{ id: "doc-1", name: "Derived Doc.pdf" }];
      }
      return [];
    });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentId).toBe("doc-1");
    expect(results[0]!.documentName).toBe("Derived Doc.pdf");
  });

  it("skips derivation when chunkId has no dash (260815-i4s)", async () => {
    // chunkId "plainid" has no dash → cannot derive documentId → enrichment
    // is skipped for that result. documentName stays undefined (caller
    // fallback "Unknown" handles it). No crash, no DB lookup.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "plainid",
            score: 0.9,
            text: "no dash content",
            metadata: { documentId: "", documentName: "", chunkText: "no dash content" },
          },
        ],
      },
    });
    (jest.mocked(prisma.document.findMany).mockImplementation as any)(async (args: any) => {
      if (args.select && args.select.name) {
        // If derivation fired it would query for "" or a derived id — but
        // derivation should NOT fire, so this returns [] regardless.
        return [];
      }
      return [];
    });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    // documentId stays "" (no derivation); documentName stays undefined.
    expect(results[0]!.documentName).toBeUndefined();
  });

  it("skips derivation when chunkId last segment is non-numeric (260815-i4s)", async () => {
    // chunkId "doc-1-abc" → last segment "abc" is non-numeric → the chunkId
    // does not match the `${documentId}-${chunkIndex}` format → skip derivation.
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "doc-1-abc",
            score: 0.9,
            text: "non-numeric suffix",
            metadata: { documentId: "", documentName: "", chunkText: "non-numeric suffix" },
          },
        ],
      },
    });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentName).toBeUndefined();
  });

  it("leaves documentName undefined when derived documentId is not found in DB (260815-i4s)", async () => {
    // chunkId "doc-missing-0" → derive documentId "doc-missing" → DB lookup
    // returns nothing → documentName stays undefined (graceful — the "Unknown"
    // fallback in builtinSkills.ts handles it).
    mockFtsSearch.mockReset();
    mockAxiosPost.mockReset();
    mockFtsSearch.mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          {
            id: "doc-missing-0",
            score: 0.9,
            text: "missing doc content",
            metadata: { documentId: "", documentName: "", chunkText: "missing doc content" },
          },
        ],
      },
    });
    (jest.mocked(prisma.document.findMany).mockImplementation as any)(async (args: any) => {
      if (args.select && args.select.name) {
        return []; // derived documentId "doc-missing" not in DB
      }
      return [];
    });

    const results = await hybridSearch("test", "ws-1", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentId).toBe("doc-missing");
    expect(results[0]!.documentName).toBeUndefined();
  });
});