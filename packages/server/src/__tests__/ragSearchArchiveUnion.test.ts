// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 191 (KNOW-01 D-04/D-09) — rag_search retrieval-union behavioral test.
 *
 * Proves:
 *  - Union shape: with attachedArchiveIds, the workspace call becomes the
 *    ARRAY form hybridSearchWithRerank(q, ["ws-1", "archive:<id>"], 5, ...) —
 *    the workspace string becomes a 2-element array ONLY when archives are
 *    attached; with no attachment the call stays the byte-identical
 *    (query, workspaceId, 5, ...) form.
 *  - Provenance (D-09): mocked results whose metadata.sourceWorkspaceId
 *    starts with "archive:" come back with source: "archive" in
 *    SkillResult.sources; workspace results keep source vector/fts/both and
 *    stay untagged.
 *  - Fallback coexistence (D-04): attached archives returning hits → the
 *    workspace-zero archive-fallback block does NOT fire (bound-archive
 *    search not re-run); everything empty + bound archiveId → fallback fires
 *    exactly as today and fills the empty set.
 *  - Score cutoff (260815-i4s) applies AFTER the union merge so archive legs
 *    are subject to rag_min_score_ratio like the fallback path.
 *
 * Mock skeleton copied from multiWorkspaceHybridSearch.bias.test.ts
 * (ftsService/env/systemConfigService/logger/axios/prisma $queryRaw);
 * ../services/hybridSearchService is jest.mocked to control
 * hybridSearchWithRerank directly (builtinSkills imports it, so the mock
 * intercepts the union call). Importing builtinSkills triggers registerSkill.
 */
import "./helpers/setupEnv";

// Mock Prisma singleton (builtinSkills modules import prisma transitively).
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

// Control hybridSearchWithRerank directly — the union call site.
jest.mock("../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
  multiWorkspaceHybridSearch: jest.fn(),
  hybridSearch: jest.fn(),
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

import { hybridSearchWithRerank } from "../services/hybridSearchService";
import { getSkill } from "../agent/skills";
// Importing builtinSkills triggers registerSkill() side effects for all skills.
import "../agent/builtinSkills";
import type { HybridSearchResult } from "../services/hybridSearchService";
import type { SkillParams, SkillResult } from "../agent/skills";

const mockedHybridSearch = hybridSearchWithRerank as unknown as jest.Mock;

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";
const ARCHIVE_ID = "a1a1a1a1-1111-1111-1111-111111111111";

function makeWorkspaceResult(chunkId: string, score = 0.5): HybridSearchResult {
  return {
    chunkId,
    documentId: `doc-${chunkId}`,
    documentName: `Workspace Doc ${chunkId}`,
    chunkText: `workspace content ${chunkId}`,
    score,
    source: "both",
    chunkIndex: 0,
    metadata: { sourceWorkspaceId: WORKSPACE_ID },
  };
}

function makeArchiveUnionResult(chunkId: string, score = 0.4): HybridSearchResult {
  // Shape multiWorkspaceHybridSearch emits for archive: legs — the
  // sourceWorkspaceId stamp carries the pseudo-workspace id.
  return {
    chunkId,
    documentId: `arch-doc-${chunkId}`,
    documentName: `Archive Doc ${chunkId}`,
    chunkText: `archive content ${chunkId}`,
    score,
    source: "both",
    chunkIndex: 0,
    metadata: { sourceWorkspaceId: `archive:${ARCHIVE_ID}`, pageSlug: "setup-guide" },
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
  mockedHybridSearch.mockResolvedValue([]);
});

describe("Phase 191 rag_search retrieval union (D-04)", () => {
  it("no attachment → the call stays the byte-identical (query, workspaceId, 5) string form", async () => {
    mockedHybridSearch.mockResolvedValueOnce([makeWorkspaceResult("ws-1")]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockedHybridSearch).toHaveBeenCalledWith("test query", WORKSPACE_ID, 5);
    expect(result.sources![0]!.documentName).toBe("Workspace Doc ws-1");
  });

  it("attached archive → the workspace string becomes [workspaceId, archive:<id>] (2-element array)", async () => {
    mockedHybridSearch.mockResolvedValueOnce([makeWorkspaceResult("ws-1"), makeArchiveUnionResult("arch-1")]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ attachedArchiveIds: [ARCHIVE_ID] }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockedHybridSearch).toHaveBeenCalledWith(
      "test query",
      [WORKSPACE_ID, `archive:${ARCHIVE_ID}`],
      5,
    );
  });

  it("union provenance (D-09): archive-leg results carry source: 'archive' in sources; workspace results stay untagged", async () => {
    mockedHybridSearch.mockResolvedValueOnce([makeWorkspaceResult("ws-1"), makeArchiveUnionResult("arch-1")]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ attachedArchiveIds: [ARCHIVE_ID] }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(2);
    const wsSource = result.sources!.find((s) => s.documentName === "Workspace Doc ws-1");
    const archSource = result.sources!.find((s) => s.documentName === "Archive Doc arch-1");
    expect(archSource).toBeDefined();
    expect((archSource as { source?: string }).source).toBe("archive");
    // Workspace result keeps its vector/fts/both source and stays untagged.
    expect((wsSource as { source?: string }).source).toBeUndefined();
    expect((archSource as { pageSlug?: string }).pageSlug).toBe("setup-guide");
  });

  it("multiple attached archives → one array leg per archive, order preserved", async () => {
    const A2 = "a2a2a2a2-2222-2222-2222-222222222222";
    mockedHybridSearch.mockResolvedValueOnce([]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    await skill.execute(baseParams({ attachedArchiveIds: [ARCHIVE_ID, A2] })) as SkillResult;

    expect(mockedHybridSearch).toHaveBeenCalledWith(
      "test query",
      [WORKSPACE_ID, `archive:${ARCHIVE_ID}`, `archive:${A2}`],
      5,
    );
  });

  it("fallback coexistence (D-04): attached archives returning hits → the workspace-zero fallback does NOT fire", async () => {
    mockedHybridSearch.mockResolvedValueOnce([makeArchiveUnionResult("arch-1")]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ archiveId: "bound-arch", attachedArchiveIds: [ARCHIVE_ID] }))) as SkillResult;

    expect(result.success).toBe(true);
    // Exactly ONE call — the union; the bound-archive fallback (a second
    // hybridSearchWithRerank with "archive:bound-arch") never fires because
    // results.length > 0.
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockedHybridSearch).toHaveBeenCalledWith(
      "test query",
      [WORKSPACE_ID, `archive:${ARCHIVE_ID}`],
      5,
    );
    expect(result.sources).toHaveLength(1);
  });

  it("fallback coexistence (D-04): everything empty + bound archiveId → fallback fires exactly as today", async () => {
    // Union call returns [] (no workspace hits, no attached-archive hits),
    // then the fallback arm makes the second call for the bound archive.
    mockedHybridSearch
      .mockResolvedValueOnce([]) // union call
      .mockResolvedValueOnce([
        { ...makeWorkspaceResult("fb-1"), source: "both", metadata: {} },
      ]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ archiveId: "bound-arch" }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(mockedHybridSearch).toHaveBeenCalledTimes(2);
    expect(mockedHybridSearch).toHaveBeenNthCalledWith(1, "test query", WORKSPACE_ID, 5);
    expect(mockedHybridSearch).toHaveBeenNthCalledWith(2, "test query", "archive:bound-arch", 5);
    expect(result.sources).toHaveLength(1);
    // Fallback results keep the "archive-fallback" label (not the union label).
    expect((result.sources![0] as { source?: string }).source).toBe("archive");
  });

  it("empty attachedArchiveIds array behaves byte-identically to absent (string call form)", async () => {
    mockedHybridSearch.mockResolvedValueOnce([makeWorkspaceResult("ws-1")]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    await skill.execute(baseParams({ attachedArchiveIds: [] })) as SkillResult;

    expect(mockedHybridSearch).toHaveBeenCalledWith("test query", WORKSPACE_ID, 5);
  });

  it("score cutoff (260815-i4s) applies AFTER the union merge — low-scoring archive legs are dropped like workspace hits", async () => {
    // The ratio cutoff drops results scoring < ratio * topScore. With a
    // 0.9 workspace hit and a 0.1 archive hit, the default 0.2 ratio
    // (threshold 0.18) drops the archive leg.
    mockedHybridSearch.mockResolvedValueOnce([
      makeWorkspaceResult("ws-top", 0.9),
      makeArchiveUnionResult("arch-low", 0.1),
    ]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ attachedArchiveIds: [ARCHIVE_ID] }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources![0]!.documentName).toBe("Workspace Doc ws-top");
  });

  it("union hits are labeled 'archive-attached' in textChunks; fallback label unchanged", async () => {
    mockedHybridSearch.mockResolvedValueOnce([makeArchiveUnionResult("arch-1")]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute(baseParams({ attachedArchiveIds: [ARCHIVE_ID] }))) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.data).toContain("match: archive-attached");
    expect(result.data).not.toContain("match: archive-fallback");
  });
});