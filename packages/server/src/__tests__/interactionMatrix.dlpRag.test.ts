// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 194 interaction matrix — pair 1/6: DLP × RAG.
 *
 * ONE owned test (194-CONTEXT D-01/D-02) pinning the INTERACTION seam only:
 * with a workspace whose document chunks are DLP-masked at the storage layer
 * (192 plan-02 contract — fixtures feed MASKED chunkText, the same shape
 * dlpReadPathMatrix Row 6/Row 9 pin) AND a rag_search run carrying
 * attachedArchiveIds per the Phase 191 contract (ragSearchArchiveUnion pins
 * the union shape ALONE), the retrieval union serves:
 *   (a) workspace-leg results carrying the masked chunkText (placeholders
 *       present, original PII values absent) — masking SURVIVES the union
 *       seam (the DLP side);
 *   (b) archive-leg (archive:<id> pseudo-workspace) results NOT DLP-rewritten
 *       (wiki pages are outside document-DLP scope per 192 boundary) and
 *       carrying source:"archive" provenance per the 191 D-09 re-tag;
 *   (c) the union shape otherwise unchanged vs the no-DLP union already
 *       pinned by ragSearchArchiveUnion — same label/merge behavior
 *       ("archive-attached" match label, single union call) — asserted only
 *       for the masked+union combination, never the union alone.
 *
 * Negative (already pinned, NOT re-asserted as owned assertions here):
 * dlpReadPathMatrix Row 9 pins the workspace-only masked arm;
 * ragSearchArchiveUnion pins the unmasked union arms. The value THIS test
 * adds is the masked-content × multi-leg-union combination in one drive.
 *
 * Postgres-free: prisma + hybridSearchService mocked per the established
 * ragSearchArchiveUnion skeleton (mock order discipline per TESTING.md).
 */
import "./helpers/setupEnv";

// Mock Prisma singleton (builtinSkills imports prisma transitively).
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

// Control hybridSearchWithRerank directly — the union call site (Phase 191).
jest.mock("../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
  multiWorkspaceHybridSearch: jest.fn(),
  hybridSearch: jest.fn(),
}));

// Mock archivePageService — wiki_query getPage import (builtinSkills barrel).
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

// DLP fixture vocabulary — mirrors dlpReadPathMatrix's masked-storage shape.
const ORIGINAL_NAME = "Maria Rossi";
const ORIGINAL_ADDRESS = "Via Roma 1";
/** Masked workspace chunk — what the storage layer holds post-scan (192 plan 02). */
const MASKED_CHUNK = "Il firmatario è [PERSON_1] residente in [ADDRESS_1].";
/** Archive-leg content is a WIKI PAGE — outside document-DLP scope (192 boundary). */
const ARCHIVE_PAGE_TEXT = "Setup guide: the integration wizard provisions the workspace.";

/**
 * Workspace-leg fixture: a DLP-masked workspace document chunk (the
 * multiWorkspaceHybridSearch contract stamps sourceWorkspaceId per leg —
 * the workspace leg carries the plain workspace id).
 */
function makeMaskedWorkspaceResult(): HybridSearchResult {
  return {
    chunkId: `${"d0d0d0d0-0000-4000-8000-000000000001"}-0`,
    documentId: "d0d0d0d0-0000-4000-8000-000000000001",
    documentName: "contratto",
    chunkText: MASKED_CHUNK,
    score: 0.9,
    source: "both",
    chunkIndex: 0,
    metadata: { sourceWorkspaceId: WORKSPACE_ID },
  };
}

/**
 * Archive-leg fixture: the archive:<id> pseudo-workspace leg (191 contract —
 * sourceWorkspaceId stamp carries the pseudo-workspace id). Wiki page text
 * is NOT masked — document-DLP never touches the archive corpus.
 */
function makeArchiveLegResult(): HybridSearchResult {
  return {
    chunkId: "arch-doc-1",
    documentId: "arch-doc-1",
    documentName: "Setup Guide",
    chunkText: ARCHIVE_PAGE_TEXT,
    score: 0.5,
    source: "both",
    chunkIndex: 0,
    metadata: { sourceWorkspaceId: `archive:${ARCHIVE_ID}`, pageSlug: "setup-guide" },
  };
}

describe("Phase 194 interaction matrix — DLP × RAG (masked serving through the 191 retrieval union)", () => {
  it("masked workspace chunks + attached archive: the union serves MASKED workspace-leg chunkText, keeps the archive leg untouched with source:'archive' provenance, and preserves the union shape", async () => {
    // ONE union call — the Phase 191 array form [workspaceId, archive:<id>].
    mockedHybridSearch.mockResolvedValueOnce([makeMaskedWorkspaceResult(), makeArchiveLegResult()]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");
    const result = (await skill.execute({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      query: "firmatario",
      attachedArchiveIds: [ARCHIVE_ID],
    } as Partial<SkillParams> as SkillParams)) as SkillResult;

    // Union shape (the RAG side of the seam — mirrors ragSearchArchiveUnion's
    // pinned contract, asserted here only for the masked combination):
    // exactly ONE call in the 2-element array form.
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockedHybridSearch).toHaveBeenCalledWith(
      "firmatario",
      [WORKSPACE_ID, `archive:${ARCHIVE_ID}`],
      5,
    );
    expect(result.success).toBe(true);

    const wsSource = result.sources!.find((s) => s.documentName === "contratto");
    const archSource = result.sources!.find((s) => s.documentName === "Setup Guide");

    // (a) DLP side of the seam: the workspace leg serves MASKED chunkText —
    // placeholders present, original PII values ABSENT through the union.
    expect(wsSource).toBeDefined();
    expect(wsSource!.chunkText).toContain("[PERSON_1]");
    expect(wsSource!.chunkText).toContain("[ADDRESS_1]");
    expect(wsSource!.chunkText).not.toContain(ORIGINAL_NAME);
    expect(wsSource!.chunkText).not.toContain(ORIGINAL_ADDRESS);
    // Workspace results keep their vector/fts/both source and stay untagged.
    expect((wsSource as { source?: string }).source).toBeUndefined();

    // (b) Archive leg: NOT DLP-rewritten (wiki pages outside document-DLP
    // scope per 192) — the raw wiki text flows verbatim, carrying the 191
    // D-09 provenance re-tag + pageSlug.
    expect(archSource).toBeDefined();
    expect(archSource!.chunkText).toBe(ARCHIVE_PAGE_TEXT);
    expect((archSource as { source?: string }).source).toBe("archive");
    expect((archSource as { pageSlug?: string }).pageSlug).toBe("setup-guide");

    // (c) Union shape byte-consistent with the no-DLP union: the
    // archive-attached label + the masked workspace text share the SAME
    // textChunks payload — the masking introduces no new transform.
    expect(result.data).toContain("match: archive-attached");
    expect(result.data).toContain(MASKED_CHUNK);
    expect(result.data).toContain(ARCHIVE_PAGE_TEXT);
    expect(result.data).not.toContain(ORIGINAL_NAME);
    expect(result.data).not.toContain(ORIGINAL_ADDRESS);
    // The D-09 re-tag rides the same map that relays sources — the
    // masked-text assertion above already covers the workspace leg; here we
    // pin that the re-tag did not DLP-transform the archive text.
    expect(result.sources).toHaveLength(2);
  });
});