// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 260830-ur9 — hybridSearchService metadata-filter threading + backstop tests.
 *
 * Mock skeleton mirrors hybridSearch.test.ts (ftsService + axios + prisma +
 * env + logger mocked; hybridSearch/multiWorkspaceHybridSearch/hybridSearch-
 * WithRerank run against controlled sub-dependencies).
 *
 * Behaviors (plan <behavior>):
 *  - no filters → collector POST body has NO filters key; ftsSearch keeps its
 *    3-arg call (byte-identical results path)
 *  - filters → POST body carries the normalized filters + ftsSearch 4th arg
 *  - date-only bounds → start-of-day / end-of-day UTC normalization + *Ms mirrors
 *  - backstop: filters active + vector results → findMany gate drops
 *    non-matching documentIds; no filters → no findMany
 *  - archive guard: "archive:*" → no backstop, no filters forwarded
 *  - backstop failure → fail-open warn (results kept)
 *  - multiWorkspaceHybridSearch + hybridSearchWithRerank forward filters
 */
import type { HybridSearchFilters } from "@simmetric-chat/shared";

// Mock ftsService so it returns controlled results.
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
    debug: jest.fn(),
  },
}));

jest.mock("axios", () => ({
  post: jest.fn(),
  create: jest.fn(() => ({ post: jest.fn(), get: jest.fn() })),
}));

jest.mock("../services/rerankService", () => ({
  rerankCandidates: jest.fn(async (_q: string, c: unknown[]) => c),
}));

// Mock prisma: workspace lookup + document.findMany (backstop + model guard).
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

const mockFtsSearch = require("../services/ftsService").ftsSearch as jest.Mock;
const mockAxiosPost = require("axios").post as jest.Mock;
const mockGetSetting = require("../services/systemConfigService").getSetting as jest.Mock;
const mockDocumentFindMany = require("../utils/prisma").default.document.findMany as jest.Mock;

import prisma from "../utils/prisma";
import { hybridSearch, multiWorkspaceHybridSearch, hybridSearchWithRerank } from "../services/hybridSearchService";

/**
 * The backstop findMany is distinguishable from both (a) the embedding-model
 * guard's findMany (where: workspaceId/deletedAt) and (b) enrichDocumentNames'
 * name lookup (where: id but select: { id, name }) by its shape: backstop
 * calls carry `select: { id: true }` ONLY plus a filter-aware where clause.
 */
function backstopCalls(): any[] {
  return mockDocumentFindMany.mock.calls.filter((c: any[]) => {
    const where = c[0]?.where;
    return where?.id?.in !== undefined && c[0]?.select?.name === undefined;
  });
}

const WS_ID = "ws-1";
const DATE_FROM = "2025-01-15T00:00:00.000Z";
const DATE_TO = "2025-06-01T23:59:59.999Z";

function vectorResult(id: string, documentId: string) {
  return {
    id,
    score: 0.9,
    text: `text-${id}`,
    metadata: { documentId, documentName: `Doc ${documentId}`, chunkText: `text-${id}` },
  };
}

beforeEach(() => {
  mockFtsSearch.mockReset();
  mockFtsSearch.mockResolvedValue([]);
  mockAxiosPost.mockReset();
  mockAxiosPost.mockResolvedValue({ data: { results: [] } });
  mockDocumentFindMany.mockReset();
  mockDocumentFindMany.mockResolvedValue([]);
  (mockGetSetting as jest.Mock).mockReset();
  (mockGetSetting as jest.Mock).mockResolvedValue({ value: undefined });
});

describe("hybridSearch — byte-identity without filters (260830-ur9 SC)", () => {
  it("no filters → collector POST body has no filters key; ftsSearch keeps the 3-arg call; no backstop findMany", async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("hello", "ws-1", 10);

    const [, body] = mockAxiosPost.mock.calls[0];
    expect(body).toEqual({
      query: "hello",
      workspaceId: "ws-1",
      workspaceName: "Test Workspace",
      limit: 20,
      embeddingModel: undefined,
    });
    expect(Object.keys(body)).not.toContain("filters");
    expect(mockFtsSearch).toHaveBeenCalledWith("hello", "ws-1", 20);
    expect(backstopCalls()).toHaveLength(0);
  });

  it("explicit undefined filters behaves identically to the no-filters call", async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("hello", "ws-1", 10, undefined);

    const [, body] = mockAxiosPost.mock.calls[0];
    expect(Object.keys(body)).not.toContain("filters");
    expect(backstopCalls()).toHaveLength(0);
  });

  it("empty filters object {} → treated as absent (no filters key, no backstop)", async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("hello", "ws-1", 10, {});

    const [, body] = mockAxiosPost.mock.calls[0];
    expect(Object.keys(body)).not.toContain("filters");
    expect(backstopCalls()).toHaveLength(0);
  });
});

describe("hybridSearch — filter threading (260830-ur9)", () => {
  it("with filters: collector POST body carries normalized filters (ISO + *Ms mirrors) and ftsSearch receives them", async () => {
    mockAxiosPost.mockResolvedValue({ data: { result: [] } });
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("hello", "ws-1", 10, {
      documentTypes: ["pdf", "md"],
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      dateFromMs: new Date(DATE_FROM).getTime(),
      dateToMs: new Date(DATE_TO).getTime(),
    });

    const [, body] = mockAxiosPost.mock.calls[0];
    expect(body.filters).toEqual({
      documentTypes: ["pdf", "md"],
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      dateFromMs: new Date(DATE_FROM).getTime(),
      dateToMs: new Date(DATE_TO).getTime(),
    });
    expect(mockFtsSearch).toHaveBeenCalledWith("hello", "ws-1", 20, {
      documentTypes: ["pdf", "md"],
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      dateFromMs: new Date(DATE_FROM).getTime(),
      dateToMs: new Date(DATE_TO).getTime(),
    });
  });

  it("date-only inputs are normalized: dateFrom start-of-day, dateTo end-of-day UTC (+ *Ms mirrors)", async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("hello", "ws-1", 10, { dateFrom: "2025-01-15", dateTo: "2025-06-01" });

    const [, body] = mockAxiosPost.mock.calls[0];
    expect(body.filters.dateFrom).toBe(DATE_FROM);
    expect(body.filters.dateTo).toBe("2025-06-01T23:59:59.999Z");
    expect(body.filters.dateFromMs).toBe(new Date(DATE_FROM).getTime());
    expect(body.filters.dateToMs).toBe(new Date("2025-06-01T23:59:59.999Z").getTime());
  });

  it("partial filters (only documentTypes / only dateFrom) carry only the provided keys", async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await hybridSearch("hello", "ws-1", 10, { dateFrom: "2025-01-15" });

    const [, body] = mockAxiosPost.mock.calls[0];
    expect(body.filters).toEqual({ dateFrom: DATE_FROM, dateFromMs: new Date(DATE_FROM).getTime() });
  });

  it("invalid date input throws (400-style TypeError for the caller's try/catch)", async () => {
    await expect(
      hybridSearch("hello", "ws-1", 10, { dateFrom: "not-a-date" }),
    ).rejects.toThrow(/invalid date/i);
  });

  it("multiWorkspaceHybridSearch forwards filters to every per-workspace hybridSearch", async () => {
    mockDocumentFindMany.mockResolvedValue([]);
    await multiWorkspaceHybridSearch("q", ["ws-1", "ws-2"], 5, { documentTypes: ["csv"] });

    // ftsSearch runs once per workspace; the 4th arg carries the filters.
    const wsIds = mockFtsSearch.mock.calls.map((c: any[]) => c[1]);
    expect(wsIds).toEqual(["ws-1", "ws-2"]);
    for (const call of mockFtsSearch.mock.calls as any[][]) {
      expect(call[3]).toEqual({ documentTypes: ["csv"] });
    }
  });

  it("hybridSearchWithRerank (disabled path) forwards filters", async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === "rag_reranker_enabled" ? { value: "false" } : { value: undefined },
    );
    mockFtsSearch.mockReset();
    mockFtsSearch.mockResolvedValue([]);

    await hybridSearchWithRerank("q", "ws-1", 5, { documentTypes: ["pdf"] });

    expect(mockFtsSearch).toHaveBeenCalledWith(
      "q",
      "ws-1",
      10,
      expect.objectContaining({ documentTypes: ["pdf"] }),
    );
  });

  it("hybridSearchWithRerank (enabled path) applies filters BEFORE over-fetch (over-fetched FTS limit carries filters)", async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === "rag_reranker_enabled" ? { value: "true" } : { value: "4" },
    );
    mockFtsSearch.mockReset();
    mockFtsSearch.mockResolvedValue([]);

    await hybridSearchWithRerank("q", "ws-1", 5, { documentTypes: ["pdf"] });

    // limit 5 → effectiveLimit = min(5*4, 100) = 20 → ftsSearch limit 40.
    const [q, wsId, ftsLimit, filters] = mockFtsSearch.mock.calls[0];
    expect(ftsLimit).toBe(40);
    expect(filters).toEqual({ documentTypes: ["pdf"] });
  });
});

describe("hybridSearch — post-retrieval documentIds backstop (260830-ur9)", () => {
  it("filters active: vector result whose documentId misses the findMany match is dropped; FTS results unaffected", async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          { id: "doc-a-0", score: 0.9, text: "a0", metadata: { documentId: "doc-a" } },
          { id: "doc-b-0", score: 0.8, text: "b0", metadata: { documentId: "doc-b" } },
        ],
      },
    });
    mockFtsSearch.mockResolvedValue([
      {
        chunkId: "doc-c-0",
        documentId: "doc-c",
        workspaceId: "ws-1",
        documentName: "Doc C",
        chunkText: "c0",
        rank: 0.5,
      },
    ]);
    // Backstop: only doc-a passes the metadata match in the authoritative table.
    mockDocumentFindMany.mockResolvedValue([{ id: "doc-a" }]);

    const results = await hybridSearch("hello", "ws-1", 10, {
      documentTypes: ["pdf"],
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      dateFromMs: 1,
      dateToMs: 2,
    } as HybridSearchFilters);

    const docIds = results.map((r) => r.documentId);
    expect(docIds).toContain("doc-a");
    expect(docIds).not.toContain("doc-b"); // vector-sourced, failed the backstop
    expect(docIds).toContain("doc-c"); // FTS-sourced — untouched by the backstop

    // ONE batched findMany with the filter-aware where clause.
    expect(backstopCalls()).toHaveLength(1);
    const where = backstopCalls()[0][0].where;
    expect(where.id.in).toEqual(expect.arrayContaining(["doc-a", "doc-b", "doc-c"]));
    expect(where.type).toEqual({ in: ["pdf"] });
    expect(where.createdAt).toEqual({ gte: new Date(DATE_FROM), lte: new Date(DATE_TO) });
  });

  it("archive pseudo-workspace: backstop skipped, filters NOT forwarded", async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [{ id: "w-0", score: 0.9, text: "w0", metadata: { documentId: "page-1" } }],
      },
    });

    await hybridSearch("hello", "archive:abc-123", 10, {
      documentTypes: ["pdf"],
      dateFrom: DATE_FROM,
      dateFromMs: 1,
      dateToMs: 2,
    });

    const [, body] = mockAxiosPost.mock.calls[0];
    expect(Object.keys(body)).not.toContain("filters");
    expect(mockFtsSearch).toHaveBeenCalledWith("hello", "archive:abc-123", 20);
    expect(backstopCalls()).toHaveLength(0);
  });

  it("backstop failure → fail-open: results kept + one warn", async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [{ id: "doc-a-0", score: 0.9, text: "a0", metadata: { documentId: "doc-a" } }],
      },
    });
    // Only the backstop-shaped findMany (id.in + select id-only) fails — the
    // embedding-model guard's and enrichDocumentNames' findMany still resolve.
    mockDocumentFindMany.mockImplementation(async (args: any) => {
      if (args?.where?.id?.in !== undefined && args?.select?.name === undefined) {
        throw new Error("DB down");
      }
      return [];
    });

    const { logger } = await import("../utils/logger");

    const results = await hybridSearch("hello", "ws-1", 10, { documentTypes: ["pdf"] });

    // Fail-open: the vector result survives (FTS leg was/ is SQL-filtered by
    // providers that pre-filter; graceful degradation discipline).
    expect(results.map((r) => r.documentId)).toEqual(["doc-a"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("metadata-filter backstop"),
    );
  });
});