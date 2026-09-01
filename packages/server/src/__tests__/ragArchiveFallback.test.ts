// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ARCH-LINK-03 / D-14 (server-side): rag_search archive fallback + source
 * re-tag threading through the sources mapper.
 *
 * Verifies:
 *  - Test 1: rag_search archive fallback when workspace=0 AND archiveId set
 *    → sources carry `source: "archive"` (D-14 — the mapper must thread it).
 *  - Test 2: rag_search NO fallback when workspace has results → sources[0].source
 *    is undefined (not "archive") AND archive collection NOT queried.
 *  - Test 3: rag_search NO fallback when archiveId is undefined (workspace=0)
 *    → no archive query, sources empty.
 *  - Test 4: wiki_query uses params.archiveId to scope ftsArchivePages.
 *  - Test 5: wiki_query prefers params.archiveId over metadata.archiveId
 *    (T-80-05 IDOR mitigation lock).
 *  - Test 6: sources mapper propagates `source: "archive"` field from
 *    HybridSearchResult onto the SourceCitation payload (D-14 server side).
 *
 * TDD RED phase: Tests 1 and 6 fail because the builtinSkills.ts:68-73 sources
 * mapper currently drops the `source` field. GREEN arrives once the mapper
 * spreads `source: "archive" as const` for archive-fallback results.
 */
import "./helpers/setupEnv";

// Mock Prisma singleton (wiki_query uses $queryRaw for ftsArchivePages).
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

// Mock hybridSearchService — rag_search workspace + archive fallback calls.
jest.mock("../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
}));

// Mock archivePageService — wiki_query getPage import.
jest.mock("../services/archivePageService", () => ({
  getPage: jest.fn(),
}));

// Mock wikiWriteService — wiki_write generatePreview import (no-op here).
jest.mock("../services/wikiWriteService", () => ({
  generatePreview: jest.fn(),
}));

// Mock env to avoid process.exit on missing vars.
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret",
    EMBEDDING_MODEL: "test-model",
  })),
}));

import prisma from "../utils/prisma";
import { hybridSearchWithRerank } from "../services/hybridSearchService";
import { getPage } from "../services/archivePageService";
import { getSkill } from "../agent/skills";
// Importing builtinSkills triggers registerSkill() side effects for all 5 skills.
import "../agent/builtinSkills";
import type { HybridSearchResult } from "../services/hybridSearchService";
import type { SkillParams, SkillResult } from "../agent/skills";

/**
 * Local view of SourceCitation that includes the D-14 `source` provenance tag.
 * The server's `SourceCitation` in `agent/skills.ts` does not yet carry the
 * field (planning miss — Plan 01 widened only the shared type, not the server's
 * local re-declaration). We cast here so the RED test fails at the assertion
 * level (mapper drops the field) rather than at compile time. GREEN will widen
 * the server's `SourceCitation` and thread the field through the mapper.
 */
type SourceCitationWithSource = NonNullable<SkillResult["sources"]>[number] & {
  source?: "archive" | "workspace";
};

function getSource(s: NonNullable<SkillResult["sources"]>[number]): string | undefined {
  return (s as SourceCitationWithSource).source;
}

const mockedHybridSearch = hybridSearchWithRerank as unknown as jest.Mock;
const mockedGetPage = getPage as unknown as jest.Mock;
const mockedQueryRaw = prisma.$queryRaw as jest.Mock;

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";

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
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    query: "test query",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: $queryRaw returns empty array (no FTS matches).
  mockedQueryRaw.mockResolvedValue([]);
  // Default: hybridSearchWithRerank returns empty.
  mockedHybridSearch.mockResolvedValue([]);
  // Default: getPage returns null (page not found).
  mockedGetPage.mockResolvedValue(null);
});

describe("ARCH-LINK-03: rag_search archive fallback (workspace=0 → archive:<id>)", () => {
  it("Test 1: workspace=0 AND archiveId set → falls back to archive collection, sources tagged source: 'archive'", async () => {
    // Workspace search returns 0 results; archive fallback returns 1 hit.
    mockedHybridSearch
      .mockResolvedValueOnce([]) // workspace call
      .mockResolvedValueOnce([
        makeArchiveResult("arch-chunk-1", "arch-doc-1", "Archive Doc 1"),
      ]); // archive fallback call

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    // Both calls fired: workspace first, archive fallback second.
    expect(mockedHybridSearch).toHaveBeenCalledTimes(2);
    expect(mockedHybridSearch).toHaveBeenNthCalledWith(1, "test query", WORKSPACE_ID, 5);
    expect(mockedHybridSearch).toHaveBeenNthCalledWith(2, "test query", "archive:arch-1", 5);
    // Archive-fallback sources MUST carry `source: "archive"` (D-14 — the
    // mapper must thread it through to the SSE citations event).
    expect(result.sources).toHaveLength(1);
    expect(result.sources![0]!.documentName).toBe("Archive Doc 1");
    expect(getSource(result.sources![0]!)).toBe("archive");
  });

  it("Test 2: workspace has results → NO archive fallback, sources[0].source is undefined (not 'archive')", async () => {
    mockedHybridSearch.mockResolvedValueOnce([
      makeWorkspaceResult("ws-chunk-1", "doc-1", "Workspace Doc 1"),
    ]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    // Only the workspace hybridSearchWithRerank call fired — archive collection NOT queried.
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockedHybridSearch).toHaveBeenCalledWith("test query", WORKSPACE_ID, 5);
    // Workspace sources have NO `source: "archive"` tag (the re-tag only fires
    // on archive-fallback results at builtinSkills.ts:50).
    expect(result.sources).toHaveLength(1);
    expect(result.sources![0]!.documentName).toBe("Workspace Doc 1");
    expect(getSource(result.sources![0]!)).toBeUndefined();
  });

  it("Test 3: workspace=0 AND archiveId undefined → no archive query, sources empty", async () => {
    mockedHybridSearch.mockResolvedValueOnce([]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ archiveId: undefined }))) as SkillResult;

    expect(result.success).toBe(true);
    // Only the workspace hybridSearchWithRerank call fired — no archive fallback.
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockedHybridSearch).toHaveBeenCalledWith("test query", WORKSPACE_ID, 5);
    // Sources empty (workspace=0, no archive fallback).
    expect(result.sources).toEqual([]);
  });
});

describe("ARCH-LINK-03: wiki_query archiveId scoping (ftsArchivePages)", () => {
  /**
   * Helper: configure $queryRaw to capture the archiveId argument and return
   * a matching ArchivePage row. The returned row's archiveId echoes the input
   * archiveId so we can verify via getPage which archiveId was used.
   */
  function queryRawEchoesArchiveId() {
    mockedQueryRaw.mockImplementation(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      // Phase 151 (RAG-01): ftsArchivePages now interpolates
      // [query, Prisma.raw fragment, query, Prisma.raw fragment, archiveId, limit]
      // (the OR-ed multi-config query is embedded twice via Prisma.raw).
      // The archiveId is the second-to-last value; limit is last.
      const archiveId = (values[values.length - 2] as string) || "unknown";
      return [
        {
          id: "page-1",
          slug: "found-page",
          title: "Found Page",
          category: "general",
          frontmatter: {},
          bodyText: "Page body content",
          wikilinks: [],
          archiveId,
          rank: 1,
        },
      ];
    });
    mockedGetPage.mockResolvedValue({
      slug: "found-page",
      title: "Found Page",
      frontmatter: {},
      bodyText: "Page body content",
      wikilinks: [],
    });
  }

  it("Test 4: wiki_query uses params.archiveId to scope ftsArchivePages", async () => {
    queryRawEchoesArchiveId();

    const skill = getSkill("wiki_query");
    if (!skill) throw new Error("wiki_query skill not registered");
    const result = await skill.execute({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      query: "search term",
      archiveId: "archive-params",
    } as SkillParams);

    expect(result.success).toBe(true);
    // ftsArchivePages ran ($queryRaw was called).
    expect(mockedQueryRaw).toHaveBeenCalled();
    // getPage was called with the params.archiveId value ("archive-params").
    expect(mockedGetPage).toHaveBeenCalled();
    expect(mockedGetPage.mock.calls[0]![0]).toBe("archive-params");
  });

  it("Test 5: wiki_query prefers params.archiveId over metadata.archiveId (T-80-05 IDOR mitigation)", async () => {
    queryRawEchoesArchiveId();

    const skill = getSkill("wiki_query");
    if (!skill) throw new Error("wiki_query skill not registered");
    const result = await skill.execute({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      query: "search term",
      archiveId: "archive-params",
      metadata: { archiveId: "archive-metadata-llm" },
    } as SkillParams);

    expect(result.success).toBe(true);
    // getPage must be called with "archive-params" (params wins), NOT
    // "archive-metadata-llm" (LLM-passed metadata would enable cross-archive IDOR).
    expect(mockedGetPage).toHaveBeenCalled();
    expect(mockedGetPage.mock.calls[0]![0]).toBe("archive-params");
    expect(mockedGetPage.mock.calls[0]![0]).not.toBe("archive-metadata-llm");
  });
});

describe("D-14 (server side): sources mapper propagates `source` field onto SourceCitation", () => {
  it("Test 6: archive-fallback HybridSearchResult with source: 'archive' → SourceCitation carries source === 'archive'", async () => {
    // Workspace=0, archive fallback returns a result that builtinSkills.ts:50
    // re-tags with `source: "archive" as const`. The mapper at lines 68-73 must
    // then spread that field onto the SourceCitation payload that rides the
    // SSE `citations` event downstream.
    mockedHybridSearch
      .mockResolvedValueOnce([]) // workspace=0
      .mockResolvedValueOnce([
        makeArchiveResult("arch-chunk-1", "arch-doc-1", "Archive Doc 1"),
      ]); // archive fallback

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ archiveId: "arch-1" }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    // The source field MUST be threaded through (D-14). Today the mapper drops
    // it — this assertion fails RED until the mapper spreads the field.
    expect(getSource(result.sources![0]!)).toBe("archive");
    // Sanity: the other SourceCitation fields are still populated.
    expect(result.sources![0]!.documentId).toBe("arch-doc-1");
    expect(result.sources![0]!.documentName).toBe("Archive Doc 1");
  });
});