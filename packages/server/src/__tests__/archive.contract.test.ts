// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * E2E-03 / D-06: archive contract tests — schema-level safeParse +
 * multiWorkspaceHybridSearch scoping boundary.
 *
 * Focus (RESEARCH.md Open Question 1 — recommendation (b)):
 *   - Gruppo 1: `archive.schema.ts` safeParse contracts (createArchiveSchema,
 *     archiveSearchQuerySchema, archiveConfigSchema). Edge cases non coperti
 *     da altri file.
 *   - Gruppo 2: `multiWorkspaceHybridSearch` API contract pinning — the
 *     function signature is `(query, workspaceIds, limit)` and does NOT accept
 *     `archiveId`. The workspace-level IDOR prevention is via the
 *     `workspaceIds[]` array (only whitelisted workspaces are queried);
 *     archive-level scoping is enforced at the SKILL layer
 *     (`rag_search` D-07 invariant, `wiki_query` `ftsArchivePages` filter)
 *     covered by `wikiQueryArchiveScope.test.ts`.
 *
 * Rule 1 deviation from PLAN.md (see SUMMARY.md "Deviation from Plan"):
 *   - The plan's Gruppo 1 referenced `archiveSearchQuerySchema.archiveId` and
 *     `archiveConfigSchema.localLLMOnly` fields that do NOT exist in the actual
 *     `packages/shared/src/schemas/archive.schema.ts`. Tests adapted to the
 *     real schema fields (`query`, `limit`, `category` for search;
 *     `namingConvention`, `lintRules`, etc. for config).
 *   - The plan's Gruppo 2 expected `multiWorkspaceHybridSearch` to accept an
 *     `archiveId` parameter and filter by it. The actual signature is
 *     `(query, workspaceIds, limit=10)` — there is no archiveId parameter, and
 *     archive-level scoping happens at the skill layer (rag_search invariant,
 *     wiki_query ftsArchivePages), not at the hybridSearchService layer. Tests
 *     adapted to pin the actual API contract + workspace-level IDOR prevention
 *     via `workspaceIds[]`.
 *
 * scoping rag_search/wiki_query covered by wikiQueryArchiveScope.test.ts (Phase 64).
 */

import {
  createArchiveSchema,
  archiveSearchQuerySchema,
  archiveConfigSchema,
} from "@simmetric-chat/shared";

// --- Mocks for Gruppo 2 (multiWorkspaceHybridSearch scoping) ---------------
// Pattern: hybridSearch.test.ts — mock hybridSearch's sub-dependencies so we
// can control what hybridSearch returns per workspace, then let
// multiWorkspaceHybridSearch run for real and assert on the sub-calls.

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

// Mock prisma workspace lookup (used by vectorSearchViaCollector).
// 260721-np3 Task 2 added getWorkspaceEmbeddingModels() -> prisma.document.findMany
// inside hybridSearch(); expose document.findMany returning [] (empty workspace ->
// mismatch guard no-op -> vector leg runs) so the archiveId-scoping contract tests
// are not broken by the new embedding-model mismatch guard.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ name: "Test Workspace" }),
    },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

// Import AFTER mocks are set up so the real multiWorkspaceHybridSearch runs
// against mocked sub-dependencies.
import { multiWorkspaceHybridSearch } from "../services/hybridSearchService";

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Gruppo 1: archive.schema.ts safeParse contracts ──────────────────────

describe("archive schema contracts", () => {
  it("createArchiveSchema accepts a valid payload", () => {
    const result = createArchiveSchema.safeParse({
      name: "Archive 1",
      description: "desc",
    });
    expect(result.success).toBe(true);
  });

  it("createArchiveSchema rejects an empty name with an issue on `name`", () => {
    const result = createArchiveSchema.safeParse({
      name: "",
      description: "desc",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors;
      expect(fieldErrors).toHaveProperty("name");
    }
  });

  it("createArchiveSchema rejects a name longer than 200 characters", () => {
    const result = createArchiveSchema.safeParse({
      name: "x".repeat(201),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors;
      expect(fieldErrors).toHaveProperty("name");
    }
  });

  it("archiveSearchQuerySchema accepts a valid query with limit + category", () => {
    const result = archiveSearchQuerySchema.safeParse({
      query: "test",
      limit: 10,
      category: "entities",
    });
    expect(result.success).toBe(true);
  });

  it("archiveSearchQuerySchema rejects a query longer than 500 characters", () => {
    const result = archiveSearchQuerySchema.safeParse({
      query: "x".repeat(501),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors;
      expect(fieldErrors).toHaveProperty("query");
    }
  });

  it("archiveSearchQuerySchema applies the default limit=20 when limit is omitted", () => {
    const result = archiveSearchQuerySchema.safeParse({ query: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it("archiveSearchQuerySchema rejects an invalid category enum value", () => {
    const result = archiveSearchQuerySchema.safeParse({
      query: "test",
      category: "invalid-category",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors;
      expect(fieldErrors).toHaveProperty("category");
    }
  });

  it("archiveConfigSchema safeParse accepts an empty object (all fields optional)", () => {
    const result = archiveConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("archiveConfigSchema accepts a full config payload with all optional fields", () => {
    const result = archiveConfigSchema.safeParse({
      namingConvention: { pattern: "^[a-z0-9-]+$", message: "lowercase only" },
      requiredFrontmatter: {
        title: { type: "string", required: true },
      },
      lintRules: [
        { type: "max-length", severity: "warning", config: { max: 500 } },
      ],
      linkingDensity: { min: 0, max: 10 },
      agentPersona: "balanced",
      maintenanceSchedule: "weekly",
      purpose: "Knowledge base for project X",
      scope: "internal",
    });
    expect(result.success).toBe(true);
  });

  it("archiveConfigSchema rejects an invalid agentPersona enum value", () => {
    const result = archiveConfigSchema.safeParse({
      agentPersona: "invalid-persona",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors;
      expect(fieldErrors).toHaveProperty("agentPersona");
    }
  });

  it("archiveConfigSchema rejects an invalid lintRules severity (must be error|warning)", () => {
    const result = archiveConfigSchema.safeParse({
      lintRules: [
        { type: "max-length", severity: "critical", config: { max: 500 } },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Gruppo 2: multiWorkspaceHybridSearch archiveId scoping boundary ──────
// scoping rag_search/wiki_query covered by wikiQueryArchiveScope.test.ts (Phase 64)

describe("multiWorkspaceHybridSearch archiveId scoping", () => {
  /**
   * Rule 1 deviation: the actual `multiWorkspaceHybridSearch` signature is
   * `(query, workspaceIds, limit=10)`. There is NO `archiveId` parameter;
   * archive-level scoping is enforced at the skill layer (rag_search D-07
   * invariant, wiki_query ftsArchivePages filter) — see
   * `wikiQueryArchiveScope.test.ts` Tests 1-5. The IDOR prevention at THIS
   * layer is via the `workspaceIds[]` array: only whitelisted workspaces are
   * queried, and archives are scoped within a single workspace, so
   * cross-archive IDOR is impossible at this seam.
   */

  /**
   * Helper: configure mockFtsSearch to return different chunks per workspace.
   * Vector search (axios.post) returns empty so hybridSearch relies on FTS
   * results only — same pattern as hybridSearch.test.ts riga 72-97.
   */
  function setupPerWorkspaceFtsResults(
    workspaceResults: Map<string, Array<{ chunkId: string; documentId: string; documentName: string; chunkText: string }>>,
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

    // Vector search returns empty — hybridSearch falls back to FTS-only path.
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });
  }

  it("API contract: multiWorkspaceHybridSearch signature is (query, workspaceIds, limit) — no archiveId parameter", () => {
    // The function arity is 2 (query, workspaceIds) — `limit` has a default
    // value so Function.prototype.length excludes it. archiveId is NOT a
    // parameter — callers cannot inject a cross-archive filter at this seam.
    // Pinning T-66-02 scoping boundary: archive-level IDOR prevention lives at
    // the skill layer, not at hybridSearchService.
    expect(multiWorkspaceHybridSearch.length).toBe(2);
  });

  it("workspaceIds[] is the scoping mechanism: only passed workspaces are queried (workspace-level IDOR prevention)", async () => {
    const ws1Results = [
      {
        chunkId: "chunk-ws1-1",
        documentId: "doc-1",
        documentName: "Doc 1",
        chunkText: "content ws-1",
      },
    ];
    const ws2Results = [
      {
        chunkId: "chunk-ws2-1",
        documentId: "doc-2",
        documentName: "Doc 2",
        chunkText: "content ws-2",
      },
    ];

    const resultMap = new Map<string, typeof ws1Results>();
    resultMap.set("ws-1", ws1Results);
    resultMap.set("ws-2", ws2Results);
    setupPerWorkspaceFtsResults(resultMap);

    // Call multiWorkspaceHybridSearch with only ws-1 — ws-2 must NOT be queried.
    const results = await multiWorkspaceHybridSearch("query", ["ws-1"], 10);

    // ftsSearch was called with ws-1 only — ws-2 was never queried.
    const queriedWorkspaceIds = mockFtsSearch.mock.calls.map(
      (call: unknown[]) => call[1],
    );
    expect(queriedWorkspaceIds).toContain("ws-1");
    expect(queriedWorkspaceIds).not.toContain("ws-2");

    // All returned chunks come from ws-1 (workspace-level IDOR prevention).
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((r: any) => r.metadata?.sourceWorkspaceId === "ws-1"),
    ).toBe(true);
    // Specifically, no chunk-ws2-1 leaks into the result set.
    expect(results.find((r: any) => r.chunkId === "chunk-ws2-1")).toBeUndefined();
  });

  it("workspace-level IDOR prevention: workspaceIds NOT passed receive zero results (T-66-02 boundary)", async () => {
    const allowedResults = [
      {
        chunkId: "chunk-allowed-1",
        documentId: "doc-allowed",
        documentName: "Allowed Doc",
        chunkText: "allowed content",
      },
    ];
    // ws-denied has its own chunks, but since the caller does NOT pass it in
    // workspaceIds[], multiWorkspaceHybridSearch must never query it.
    const deniedResults = [
      {
        chunkId: "chunk-denied-1",
        documentId: "doc-denied",
        documentName: "Denied Doc",
        chunkText: "denied content",
      },
    ];

    const resultMap = new Map<string, typeof allowedResults>();
    resultMap.set("ws-allowed", allowedResults);
    resultMap.set("ws-denied", deniedResults);
    setupPerWorkspaceFtsResults(resultMap);

    // Caller passes ONLY ws-allowed — ws-denied is NOT in the array.
    const results = await multiWorkspaceHybridSearch("query", ["ws-allowed"], 10);

    // ftsSearch was called with ws-allowed only — ws-denied was NEVER queried.
    const queriedWorkspaceIds = mockFtsSearch.mock.calls.map(
      (call: unknown[]) => call[1],
    );
    expect(queriedWorkspaceIds).toContain("ws-allowed");
    expect(queriedWorkspaceIds).not.toContain("ws-denied");

    // All returned chunks come from ws-allowed — no cross-workspace IDOR leak.
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((r: any) => r.metadata?.sourceWorkspaceId === "ws-allowed"),
    ).toBe(true);
    // Specifically, no chunk-denied-1 leaks into the result set.
    expect(results.find((r: any) => r.chunkId === "chunk-denied-1")).toBeUndefined();
  });

  it("archiveId is NOT threaded to hybridSearch sub-calls — archive-level scoping is enforced at the skill layer (Phase 64 D-07 invariant)", async () => {
    // Even if a caller bypasses TypeScript and passes an extra archiveId
    // argument, multiWorkspaceHybridSearch ignores it — no archiveId filter
    // is applied to the hybridSearch sub-calls. Archive-level scoping lives at
    // rag_search (D-07 invariant — ignores params.archiveId, calls
    // hybridSearch(query, workspaceId, 5)) and wiki_query (D-08 — uses
    // ftsArchivePages with explicit archiveId filter), pinned by
    // wikiQueryArchiveScope.test.ts Tests 4 and 1-3 respectively.
    setupPerWorkspaceFtsResults(new Map());

    // Bypass TypeScript with an extra 4th argument (archiveId) — JS allows it.
    await (multiWorkspaceHybridSearch as any)(
      "query",
      ["ws-1"],
      10,
      "archive-malicious",
    );

    // ftsSearch was called with (query, wsId, limit*2) — 3 positional args.
    // archiveId is NOT threaded as a 4th argument. The skill layer enforces
    // archive scoping, NOT hybridSearchService.
    expect(mockFtsSearch).toHaveBeenCalled();
    const ftsCallArgs = mockFtsSearch.mock.calls[0]!;
    expect(ftsCallArgs[0]).toBe("query");
    expect(ftsCallArgs[1]).toBe("ws-1");
    // 3 positional args — archiveId is NOT threaded to the sub-call.
    expect(ftsCallArgs.length).toBe(3);
    // limit over-fetch: multiWorkspaceHybridSearch(limit=10) → hybridSearch(20)
    // → ftsSearch(40) because hybridSearch itself over-fetches by 2x.
    expect(ftsCallArgs[2]).toBe(40);
  });
});