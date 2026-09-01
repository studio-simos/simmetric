// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KB-01 / D-08: wiki_query / wiki_write deterministic archiveId scoping tests.
 *
 * Verifies:
 * - Test 1: wiki_query with params.archiveId (no metadata.archiveId) → success, no "archiveId is required" error
 * - Test 2: wiki_query with metadata.archiveId fallback (no params.archiveId) → success
 * - Test 3: wiki_query params.archiveId wins over metadata.archiveId (IDOR prevention)
 * - Test 4: rag_search INVARIANT (D-07) — ignores params.archiveId, calls hybridSearchWithRerank(query, workspaceId, 5)
 * - Test 5: wiki_write params.archiveId wins over metadata.archiveId
 *
 * TDD RED phase: these tests fail until builtinSkills.ts uses `params.archiveId ?? metadata.archiveId`.
 */
import "./helpers/setupEnv";

// Mock Prisma singleton
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

// Mock hybridSearchService — rag_search + wiki_query RAG fallback path
jest.mock("../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
}));

// Mock archivePageService — wiki_query getPage call
jest.mock("../services/archivePageService", () => ({
  getPage: jest.fn(),
}));

// Mock wikiWriteService — wiki_write generatePreview call
jest.mock("../services/wikiWriteService", () => ({
  generatePreview: jest.fn(),
}));

// Mock env to avoid process.exit on missing vars
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
import { generatePreview } from "../services/wikiWriteService";
import { getSkill } from "../agent/skills";
// Importing builtinSkills triggers registerSkill() side effects for all 5 skills
import "../agent/builtinSkills";

const mockedHybridSearch = hybridSearchWithRerank as unknown as jest.Mock;
const mockedGetPage = getPage as unknown as jest.Mock;
const mockedGeneratePreview = generatePreview as unknown as jest.Mock;
const mockedQueryRaw = prisma.$queryRaw as jest.Mock;

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";

/**
 * Helper: run wiki_query.execute with the given params and return the result.
 * Uses a slug-only path (no query) to avoid the FTS archiveId-required guard,
 * OR uses query + archiveId to test the FTS path.
 * Module-scoped so both the scoping describe and the G-131-17 marker
 * describe can use it.
 */
async function runWikiQuery(params: {
  query?: string;
  slug?: string;
  archiveId?: string;
  metadataArchiveId?: string;
}): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const skill = getSkill("wiki_query");
  if (!skill) throw new Error("wiki_query skill not registered");
  return skill.execute({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    query: params.query,
    metadata: {
      slug: params.slug,
      archiveId: params.metadataArchiveId,
    },
    archiveId: params.archiveId,
  } as any);
}

/**
 * Helper: configure $queryRaw to capture the archiveId argument and return
 * a matching ArchivePage row. The returned row's archiveId echoes the input
 * archiveId so we can verify via getPage which archiveId was used.
 * Module-scoped so both the scoping describe and the G-131-17 marker
 * describe can use it.
 */
function queryRawEchoesArchiveId() {
  mockedQueryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
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
  // getPage returns a page for any archiveId/slug combination
  mockedGetPage.mockResolvedValue({
    slug: "found-page",
    title: "Found Page",
    frontmatter: {},
    bodyText: "Page body content",
    wikilinks: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: $queryRaw returns empty array (no FTS matches)
  mockedQueryRaw.mockResolvedValue([]);
  // Default: hybridSearchWithRerank returns empty
  mockedHybridSearch.mockResolvedValue([]);
  // Default: getPage returns null (page not found)
  mockedGetPage.mockResolvedValue(null);
});

describe("KB-01 / D-08: wiki_query deterministic archiveId scoping", () => {
  it("Test 1: params.archiveId scopes wiki_query (no metadata.archiveId) — no 'archiveId is required' error", async () => {
    queryRawEchoesArchiveId();

    const result = await runWikiQuery({
      query: "search term",
      archiveId: "archive-X",
      // no metadataArchiveId
    });

    // Must NOT return the "archiveId is required" error — params.archiveId is set
    expect(result.success).toBe(true);
    expect(result.error).not.toBe("archiveId is required for full-text wiki search");
    // ftsArchivePages ran ($queryRaw was called) and getPage was called with "archive-X"
    expect(mockedQueryRaw).toHaveBeenCalled();
    expect(mockedGetPage).toHaveBeenCalled();
    expect(mockedGetPage.mock.calls[0]![0]).toBe("archive-X");
  });

  it("Test 2: metadata.archiveId fallback when params.archiveId is undefined", async () => {
    queryRawEchoesArchiveId();

    const result = await runWikiQuery({
      query: "search term",
      // no params.archiveId
      metadataArchiveId: "archive-Y",
    });

    // Must succeed — metadata.archiveId fallback resolves the archiveId
    expect(result.success).toBe(true);
    expect(result.error).not.toBe("archiveId is required for full-text wiki search");
    // getPage was called with "archive-Y" (from metadata fallback)
    expect(mockedGetPage).toHaveBeenCalled();
    expect(mockedGetPage.mock.calls[0]![0]).toBe("archive-Y");
  });

  it("Test 3: params.archiveId wins over metadata.archiveId (IDOR prevention — no cross-archive leak)", async () => {
    queryRawEchoesArchiveId();

    const result = await runWikiQuery({
      query: "search term",
      archiveId: "archive-X",
      metadataArchiveId: "archive-Y", // LLM tries to force a different archive
    });

    expect(result.success).toBe(true);
    // getPage must be called with "archive-X" (params wins), NOT "archive-Y"
    expect(mockedGetPage).toHaveBeenCalled();
    expect(mockedGetPage.mock.calls[0]![0]).toBe("archive-X");
    expect(mockedGetPage.mock.calls[0]![0]).not.toBe("archive-Y");
  });
});

describe("G-131-17: wiki_query no-content marker", () => {
  it("returns the [WIKI_NO_CONTENT] marker when FTS + RAG fallback + getPage are all empty", async () => {
    // Default mocks: $queryRaw → [] (no FTS), hybridSearchWithRerank → []
    // (no RAG fallback), getPage → null. The empty-result path.
    const result = await runWikiQuery({
      query: "nothing exists",
      archiveId: "archive-X",
    });

    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
    // The distinguishable marker — NOT the plain "No wiki pages found" string
    // the model retried on.
    expect((result.data as string)).toContain("[WIKI_NO_CONTENT]");
  });

  it("does NOT include the marker when content-bearing results exist", async () => {
    queryRawEchoesArchiveId();

    const result = await runWikiQuery({
      query: "search term",
      archiveId: "archive-X",
    });

    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
    expect((result.data as string)).not.toContain("[WIKI_NO_CONTENT]");
    expect((result.data as string)).toContain("Page body content");
  });
});

describe("KB-01 / D-07: rag_search is INVARIANT (workspace-doc scope, NOT archive scope)", () => {  it("Test 4: rag_search ignores params.archiveId — calls hybridSearchWithRerank(query, workspaceId, 5)", async () => {
    mockedHybridSearch.mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        documentName: "Doc 1",
        chunkText: "chunk content",
        score: 0.9,
        source: "vector",
        chunkIndex: 0,
      },
    ]);

    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search skill not registered");

    const result = await skill.execute({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      query: "search query",
      archiveId: "archive-X", // LLM attempts to pass archiveId — must be ignored
    } as any);

    expect(result.success).toBe(true);
    // hybridSearchWithRerank must be called with (query, workspaceId, 5) — NOT with archiveId
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    const callArgs = mockedHybridSearch.mock.calls[0]!;
    expect(callArgs[0]).toBe("search query"); // query
    expect(callArgs[1]).toBe(WORKSPACE_ID); // workspaceId
    expect(callArgs[2]).toBe(5); // limit
    // There must be no 4th argument (archiveId must NOT be threaded)
    expect(callArgs.length).toBe(3);
  });
});

describe("KB-01 / D-08: wiki_write params.archiveId wins over metadata.archiveId", () => {
  it("Test 5: wiki_write uses params.archiveId for generatePreview (deterministic scope)", async () => {
    // Mock user with archive:write permission
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: USER_ID,
      roles: [
        {
          role: {
            permissions: [{ permissionName: "archive:write" }],
          },
        },
      ],
    });
    // Mock generatePreview
    (mockedGeneratePreview as jest.Mock).mockResolvedValue({
      id: "run-1",
      previewJson: { diff: null, destructive: false },
    });

    const skill = getSkill("wiki_write");
    if (!skill) throw new Error("wiki_write skill not registered");

    const result = await skill.execute({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      content: "Page content body",
      metadata: {
        slug: "my-page",
        action: "create",
        archiveId: "archive-Y", // LLM tries to force a different archive
      },
      archiveId: "archive-X", // deterministic chat-scoped archiveId must win
      sendEvent: jest.fn(),
    } as any);

    expect(result.success).toBe(true);
    // generatePreview must be called with archiveId="archive-X" (params wins)
    expect(mockedGeneratePreview).toHaveBeenCalledTimes(1);
    const previewCallArgs = (mockedGeneratePreview as jest.Mock).mock.calls[0];
    expect(previewCallArgs[0]).toBe("archive-X"); // first arg is archiveId
    expect(previewCallArgs[0]).not.toBe("archive-Y");
  });
});