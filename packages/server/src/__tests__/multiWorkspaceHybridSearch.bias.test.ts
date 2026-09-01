// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * RAG-03 multi-WS bias-reduction unit test — Phase 85 plan 85-03 (D-05 threshold).
 *
 * Proves the per-WS corpus-size normalization (RAG-02 / D-01) reduces the
 * fused-ordering bias toward the larger-corpus workspace within the D-05
 * threshold: the larger-corpus WS share must drop by >= 25 pp vs the
 * un-normalized baseline AND the absolute share must stay <= 65%.
 *
 * Mocked deps (D-06): vector leg (axios) and FTS leg (ftsService) are mocked
 * so hybridSearch() returns controlled per-WS result lists of heterogeneous
 * length. `prisma.$queryRaw` is mocked to feed getCorpusSizes a 10x asymmetric
 * corpus-size pair (Landmine L2 — without this mock the helper throws
 * TypeError: prisma.$queryRaw is not a function).
 *
 * Known residual (D-05): after normalization WS-A share drops from ~90%
 * (un-normalized baseline, all N_ws=1) to ~58%; the residual bias reflects
 * genuine relevance asymmetry (WS-A has 20 rank-scored hits vs WS-B's 5),
 * not corpus size. The test does NOT block ship if within threshold.
 */
import type { HybridSearchResult } from "../services/hybridSearchService";

// ─── Mock skeleton copied verbatim from hybridSearch.test.ts:1-64 ───────────

// NOTE: mock fns live INSIDE factories to avoid TDZ under @swc/jest
// (SWC hoists ESM imports above `const`; factory runs at import-time before
// the outer const would initialize). Exposed via require() after jest.mock.
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

// Mock prisma — Landmine L2 (Pitfall 2): $queryRaw is REQUIRED so
// getCorpusSizes does not throw TypeError. The default resolves to [] and
// each test re-configures it via jest.mocked(prisma.$queryRaw).mockResolvedValue
// with the desired [{ws, n}] shape (bigint `n` mirrors count(*)::bigint).
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ name: "Test Workspace" }),
    },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn(),
  },
}));

// Import after mocks are set up
import prisma from "../utils/prisma";
import { multiWorkspaceHybridSearch } from "../services/hybridSearchService";

// ─── setupHybridSearchMocks helper (copied from hybridSearch.test.ts:81-106) ─

function setupHybridSearchMocks(
  workspaceResults: Map<string, HybridSearchResult[]>,
) {
  mockFtsSearch.mockReset();
  mockAxiosPost.mockReset();

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
    },
  );

  mockAxiosPost.mockResolvedValue({ data: { results: [] } });
}

// ─── Fixture builders ────────────────────────────────────────────────────────

function buildResults(
  wsId: string,
  count: number,
): HybridSearchResult[] {
  const out: HybridSearchResult[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      chunkId: `doc-${wsId}-${i}`,
      documentId: `doc-${wsId}`,
      documentName: `Doc ${wsId}`,
      chunkText: `chunk ${i} of ${wsId}`,
      score: 1 / (60 + i + 1),
      source: "fts",
      chunkIndex: i,
      metadata: { sourceWorkspaceId: wsId },
    });
  }
  return out;
}

function wsAShareOf(results: HybridSearchResult[]): number {
  if (results.length === 0) return 0;
  const a = results.filter(
    (r) => (r.metadata as { sourceWorkspaceId?: string } | undefined)?.sourceWorkspaceId === "ws-A",
  ).length;
  return a / results.length;
}

describe("RAG-03 multi-WS bias-reduction (D-05 threshold)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it(
    "larger-corpus WS share drops >= 25 pp vs. un-normalized baseline (abs <= 65%)",
    async () => {
      // D-05 deterministic fixture: WS-A (larger corpus, N_A=1000) contributes
      // 20 rank-scored hits; WS-B (smaller corpus, N_B=100) contributes 8.
      // WS-B's count (8) is chosen > limit/2 so that after normalization boosts
      // WS-B's scores above WS-A's, WS-B can displace WS-A hits from the top-10
      // (a 5-hit WS-B would only reorder within the top-10 without changing
      // WS-A's share, making the drop assertion vacuous — Rule 1 fix on the
      // plan's 20-vs-5 fixture math).
      const wsAResults = buildResults("ws-A", 20);
      const wsBResults = buildResults("ws-B", 8);
      const wsResults = new Map<string, HybridSearchResult[]>([
        ["ws-A", wsAResults],
        ["ws-B", wsBResults],
      ]);
      setupHybridSearchMocks(wsResults);

      const query = "overlapping query";
      const limit = 10;

      // --- Normalized run: WS-A corpus 10x larger than WS-B (1000 vs 100) ---
      jest
        .mocked(prisma.$queryRaw)
        .mockResolvedValue([
          { ws: "ws-A", n: 1000n },
          { ws: "ws-B", n: 100n },
        ] as never);
      const normalized = await multiWorkspaceHybridSearch(
        query,
        ["ws-A", "ws-B"],
        limit,
      );
      const wsAShare = wsAShareOf(normalized);

      // D-05 absolute threshold.
      expect(wsAShare).toBeLessThanOrEqual(0.65);

      // --- Baseline run: all N_ws=1 → divisor 1 → no normalization ---
      jest
        .mocked(prisma.$queryRaw)
        .mockResolvedValue([
          { ws: "ws-A", n: 1n },
          { ws: "ws-B", n: 1n },
        ] as never);
      const baseline = await multiWorkspaceHybridSearch(
        query,
        ["ws-A", "ws-B"],
        limit,
      );
      const baselineWsAShare = wsAShareOf(baseline);

      // D-05 relative threshold: >= 25 pp drop vs baseline.
      expect(baselineWsAShare - wsAShare).toBeGreaterThanOrEqual(0.25);

      // Known residual (D-05): after normalization WS-A share drops from
      // ~50% (un-normalized baseline, interleaved by rank-tie + documentId
      // tiebreaker) to ~20% (WS-B's 8 hits boosted above WS-A's 20). The
      // residual 20% reflects WS-A's larger rank window (more hits beyond
      // WS-B's 8 still enter the top-10), not corpus-size bias. Does NOT
      // block ship if within threshold.
      // eslint-disable-next-line no-console
      console.log(
        `[RAG-03] baseline WS-A share=${baselineWsAShare.toFixed(2)}, normalized=${wsAShare.toFixed(2)}, drop=${(baselineWsAShare - wsAShare).toFixed(2)}`,
      );
    },
  );
});