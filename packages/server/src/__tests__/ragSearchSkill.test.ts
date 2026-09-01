// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * rag_search skill tests — 260721-np3 Task 3
 *
 * Verifies the archive fallback: when the workspace yields 0 results AND the
 * chat has a bound archiveId (D-08 deterministic, threaded from Chat.archiveId
 * via the orchestrator), rag_search falls back to hybridSearchWithRerank(query,
 * `archive:${archiveId}`, 5) and re-tags the fallback results with
 * source: "archive" so citations distinguish archive content from workspace
 * content. Strictly conditional — never "always archives".
 */
// NOTE: mock fn lives INSIDE the factory to avoid TDZ under @swc/jest.
jest.mock("../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
  // Re-export the type union as a cast-free any for test-side type usage.
  // The production code imports `HybridSearchResult` only as a type, so this
  // mock value is never read at runtime.
}));
const mockHybridSearch = require("../services/hybridSearchService").hybridSearchWithRerank as jest.Mock;

// builtinSkills.ts imports getPage (archivePageService) and generatePreview
// (wikiWriteService) at module load time. They are used by wiki_query and
// wiki_write respectively, NOT by rag_search — no-op mocks are sufficient to
// satisfy the import graph.
jest.mock("../services/archivePageService", () => ({
  getPage: jest.fn(),
}));
jest.mock("../services/wikiWriteService", () => ({
  generatePreview: jest.fn(),
}));

// 260815-i4s — rag_search reads rag_min_score_ratio from SystemConfig.
// Default mock returns "0.2" (the CONFIG_DEFAULTS value); per-test overrides
// use (getSetting as jest.Mock).mockResolvedValueOnce(...).
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: "0.2" }),
}));
const { getSetting } = require("../services/systemConfigService") as { getSetting: jest.Mock };

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    workspace: { findUnique: jest.fn() },
    document: { findMany: jest.fn().mockResolvedValue([]) },
    systemConfig: { upsert: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    archivePage: { findFirst: jest.fn() },
  },
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-secret",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  })),
}));

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Import builtinSkills FIRST so the rag_search skill registers on the
// module's skill registry, then import getSkill from skills to retrieve it.
import "../agent/builtinSkills";
import { getSkill } from "../agent/skills";
import type { SkillParams, SkillResult } from "../agent/skills";
import type { HybridSearchResult } from "../services/hybridSearchService";

const ragSearch = getSkill("rag_search");

function makeWorkspaceResult(chunkId: string, documentId: string, documentName: string): HybridSearchResult {
  return {
    chunkId,
    documentId,
    documentName,
    chunkText: `workspace content ${chunkId}`,
    score: 0.5,
    source: "both",
    chunkIndex: 0,
    metadata: {},
  };
}

function makeArchiveResult(chunkId: string, documentId: string, documentName: string): HybridSearchResult {
  return {
    chunkId,
    documentId,
    documentName,
    chunkText: `archive content ${chunkId}`,
    score: 0.4,
    source: "both",
    chunkIndex: 0,
    metadata: {},
  };
}

function baseParams(overrides: Partial<SkillParams> = {}): SkillParams {
  return {
    workspaceId: "ws-1",
    userId: "user-1",
    query: "test query",
    ...overrides,
  };
}

describe("rag_search skill — archive fallback (260721-np3 Task 3)", () => {
  beforeEach(() => {
    mockHybridSearch.mockReset();
  });

  it("returns workspace results and does NOT call the archive fallback when the workspace has hits", async () => {
    const workspaceHits = [
      makeWorkspaceResult("ws-chunk-1", "doc-1", "Workspace Doc 1"),
    ];
    mockHybridSearch.mockResolvedValueOnce(workspaceHits);

    const result = (await ragSearch!.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources![0]!.documentName).toBe("Workspace Doc 1");
    // Only the first hybridSearchWithRerank call fired (workspace). The archive
    // fallback MUST NOT fire when the workspace yields results.
    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockHybridSearch).toHaveBeenCalledWith("test query", "ws-1", 5);
  });

  it("falls back to hybridSearchWithRerank(query, 'archive:'+archiveId, 5) when workspace yields 0 results AND archiveId is present", async () => {
    // First call (workspace) returns 0 results.
    mockHybridSearch.mockResolvedValueOnce([]);
    // Second call (archive fallback) returns archive hits.
    const archiveHits = [
      makeArchiveResult("arch-chunk-1", "arch-doc-1", "Archive Doc 1"),
      makeArchiveResult("arch-chunk-2", "arch-doc-2", "Archive Doc 2"),
    ];
    mockHybridSearch.mockResolvedValueOnce(archiveHits);

    const result = (await ragSearch!.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    // Both hybridSearchWithRerank calls fired.
    expect(mockHybridSearch).toHaveBeenCalledTimes(2);
    expect(mockHybridSearch).toHaveBeenNthCalledWith(1, "test query", "ws-1", 5);
    expect(mockHybridSearch).toHaveBeenNthCalledWith(2, "test query", "archive:arch-1", 5);
    // Archive-fallback results are returned as sources.
    expect(result.sources).toHaveLength(2);
    expect(result.sources![0]!.documentName).toBe("Archive Doc 1");
    expect(result.sources![1]!.documentName).toBe("Archive Doc 2");
  });

  it("tags archive-fallback results with source: 'archive' in the returned textChunks", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);
    mockHybridSearch.mockResolvedValueOnce([
      makeArchiveResult("arch-chunk-1", "arch-doc-1", "Archive Doc 1"),
    ]);

    const result = (await ragSearch!.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    // The returned textChunks string must contain the archive-fallback tag so
    // the LLM can distinguish archive content from workspace content.
    expect(typeof result.data).toBe("string");
    expect(result.data as string).toContain("archive-fallback");
  });

  it("returns the 'No relevant documents found' message when workspace yields 0 results AND no archiveId is present", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);

    const result = (await ragSearch!.execute(baseParams({ archiveId: undefined }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockHybridSearch).toHaveBeenCalledWith("test query", "ws-1", 5);
    // The existing "No relevant documents found" message fires when both
    // workspace AND archive fallback (absent archiveId) yield 0.
    expect(result.sources).toEqual([]);
    expect(typeof result.data).toBe("string");
    expect(result.data as string).toContain("No relevant documents found");
  });

  it("returns the 'No relevant documents found' message when workspace AND archive fallback both yield 0", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);
    mockHybridSearch.mockResolvedValueOnce([]);

    const result = (await ragSearch!.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(mockHybridSearch).toHaveBeenCalledTimes(2);
    expect(result.sources).toEqual([]);
    expect(result.data as string).toContain("No relevant documents found");
  });

  it("returns the 'No relevant documents found' message when archive fallback throws (graceful degrade)", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);
    mockHybridSearch.mockRejectedValueOnce(new Error("collector timeout"));

    const result = (await ragSearch!.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(mockHybridSearch).toHaveBeenCalledTimes(2);
    expect(result.sources).toEqual([]);
    expect(result.data as string).toContain("No relevant documents found");
  });
});

// ─── 260815-i4s: rag_search relative score cutoff ─
// Off-topic questions surfaced unrelated low-relevance sources because
// rag_search returned top-N regardless of score. The fix adds a relative
// score floor: drop results whose score < rag_min_score_ratio * topScore.
// Default 0.2; "0" disables (backward-compat). Applied AFTER the archive
// fallback so archive results are also subject to the cutoff.
describe("rag_search skill — relative score cutoff (260815-i4s)", () => {
  beforeEach(() => {
    mockHybridSearch.mockReset();
    (getSetting as jest.Mock).mockReset();
    // Default ratio 0.2.
    (getSetting as jest.Mock).mockResolvedValue({ value: "0.2" });
  });

  it("filters out results below rag_min_score_ratio * topScore (default 0.2)", async () => {
    // Scores: [0.5, 0.4, 0.05]. topScore=0.5, threshold=0.2*0.5=0.1.
    // 0.05 < 0.1 → filtered. 0.5, 0.4 >= 0.1 → kept. Result: 2 sources.
    mockHybridSearch.mockResolvedValue([
      { chunkId: "c1", documentId: "d1", documentName: "Doc 1", chunkText: "high relevance content alpha", score: 0.5, source: "both", chunkIndex: 0, metadata: {} },
      { chunkId: "c2", documentId: "d2", documentName: "Doc 2", chunkText: "medium relevance content beta", score: 0.4, source: "both", chunkIndex: 0, metadata: {} },
      { chunkId: "c3", documentId: "d3", documentName: "Doc 3", chunkText: "OFFTOPIC low relevance content gamma", score: 0.05, source: "both", chunkIndex: 0, metadata: {} },
    ]);

    const result = (await ragSearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(2);
    // The filtered-out result's chunkText must NOT appear in the returned data.
    expect(result.data as string).not.toContain("OFFTOPIC low relevance content gamma");
    expect(result.data as string).toContain("high relevance content alpha");
  });

  it("returns 'No relevant documents found' when ALL results are filtered out", async () => {
    // ratio "1.1" → threshold = 1.1 * 0.5 = 0.55 > 0.5 → all filtered.
    (getSetting as jest.Mock).mockResolvedValue({ value: "1.1" });
    mockHybridSearch.mockResolvedValue([
      { chunkId: "c1", documentId: "d1", documentName: "Doc 1", chunkText: "below cutoff content", score: 0.5, source: "both", chunkIndex: 0, metadata: {} },
      { chunkId: "c2", documentId: "d2", documentName: "Doc 2", chunkText: "also below content", score: 0.4, source: "both", chunkIndex: 0, metadata: {} },
    ]);

    const result = (await ragSearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.data as string).toContain("No relevant documents found");
  });

  it("disables filtering when rag_min_score_ratio is '0' (backward-compat)", async () => {
    (getSetting as jest.Mock).mockResolvedValue({ value: "0" });
    mockHybridSearch.mockResolvedValue([
      { chunkId: "c1", documentId: "d1", documentName: "Doc 1", chunkText: "high content", score: 0.5, source: "both", chunkIndex: 0, metadata: {} },
      { chunkId: "c2", documentId: "d2", documentName: "Doc 2", chunkText: "tiny content", score: 0.0001, source: "both", chunkIndex: 0, metadata: {} },
    ]);

    const result = (await ragSearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    // ratio 0 → no filtering → both pass.
    expect(result.sources).toHaveLength(2);
  });

  it("applies the cutoff to archive-fallback results too", async () => {
    // Workspace returns 0 → archive fallback fires with score 0.4 (top) and
    // 0.01 (below 0.2*0.4=0.08 → filtered). Result: 1 source.
    mockHybridSearch.mockResolvedValueOnce([]); // workspace
    mockHybridSearch.mockResolvedValueOnce([
      { chunkId: "a1", documentId: "ad1", documentName: "Arch Doc 1", chunkText: "archive high content", score: 0.4, source: "both", chunkIndex: 0, metadata: {} },
      { chunkId: "a2", documentId: "ad2", documentName: "Arch Doc 2", chunkText: "archive low content", score: 0.01, source: "both", chunkIndex: 0, metadata: {} },
    ]);

    const result = (await ragSearch!.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources![0]!.documentName).toBe("Arch Doc 1");
  });
});