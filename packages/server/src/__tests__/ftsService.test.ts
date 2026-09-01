// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { ftsSearch, initPostgreSQLFTS } from "../services/ftsService";

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    $executeRawUnsafe: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import prisma from "../utils/prisma";

/**
 * Pull the SQL text out of the recorded $queryRaw tagged-template call.
 * Under jest, a tagged template arrives as (TemplateStringsArray, ...values):
 * call[0] is the raw strings array. Prisma.raw interpolations ride inside the
 * values slice.
 */
/**
 * Pull the SQL text out of the recorded $queryRaw tagged-template call.
 * Under jest, a tagged template arrives as (TemplateStringsArray, ...values).
 * Nested Prisma.sql fragments (the conditional filter clauses) ride inside the
 * values as Prisma.Sql objects with their own `.strings` — concatenate those
 * too so fragment-level assertions see the composed SQL.
 */
function sqlSegmentsOf(mockQuery: jest.Mock): string {
  let sql = "";
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "object" && Array.isArray((v as { strings?: unknown }).strings)) {
      const sqlObj = v as { strings: string[]; values: unknown[] };
      sql += sqlObj.strings.join("?");
      for (const inner of sqlObj.values) visit(inner);
    }
  };
  const callArgs = mockQuery.mock.calls[0];
  const segs = callArgs[0] as unknown;
  if (Array.isArray(segs)) sql += (segs as string[]).join("?");
  // Visit the interpolated values — nested Prisma.sql/Prisma.raw fragments
  // live there (Prisma.empty contributes nothing).
  for (const v of callArgs.slice(1)) visit(v);
  return sql;
}

/** Interpolated values of the tagged-template call, flattened: nested Prisma.Sql fragments contribute their own bound values (their SQL strings do not). */
function templateValuesOf(mockQuery: jest.Mock): unknown[] {
  const callArgs = mockQuery.mock.calls[0];
  const out: unknown[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "object" && Array.isArray((v as { strings?: unknown }).strings)) {
      for (const inner of (v as { values: unknown[] }).values) visit(inner);
      return;
    }
    out.push(v);
  };
  for (const v of callArgs.slice(1)) visit(v);
  return out;
}

describe("ftsService — PostgreSQL tsvector", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sanitizes tsquery special characters", async () => {
    const mockQuery = jest.fn().mockResolvedValue([]);
    (prisma.$queryRaw as any) = mockQuery;

    await ftsSearch("hello & world", "ws-1", 10);
    const callArgs = mockQuery.mock.calls[0];
    // Prisma 7 tagged template: $queryRaw`...` arrives at the driver as
    // (strings, ...values) — i.e. an array of SQL segments with `?` placeholders,
    // followed by the interpolated values as separate positional arguments.
    const sqlSegments = callArgs[0];
    expect(Array.isArray(sqlSegments)).toBe(true);
    // Phase 151 (RAG-01): the query side uses the OR-ed 7-config
    // websearch_to_tsquery fragment against searchVectorMulti — the
    // english-only literal is gone from the read path.
    expect(sqlSegments.join("?")).toContain('"searchVectorMulti"');
    // The multi-config fragment arrives as a Prisma.raw interpolation value.
    const values = callArgs.slice(1);
    const fragment = values.find(
      (v: unknown) =>
        typeof v === "object" &&
        v !== null &&
        Array.isArray((v as { strings?: unknown }).strings),
    ) as { strings: string[] } | undefined;
    expect(fragment).toBeDefined();
    const fragmentSql = fragment!.strings.join("?");
    expect(fragmentSql).toContain("websearch_to_tsquery('english', q)");
    expect(fragmentSql).toContain("websearch_to_tsquery('italian', q)");
    expect(fragmentSql).toContain("websearch_to_tsquery('simple', q)");
    // ING-02: SELECT must include d."name" as documentName so FTS-only citations
    // show the real document name instead of "Unknown". The stronger
    // quoted-alias assertions below (D-03) supersede this check — kept here
    // as a breadcrumb for the ING-02 history.
    // D-03 (FTS alias fix — LOCKED): PostgreSQL folds unquoted aliases to
    // lowercase, so `as chunkId` becomes `chunkid` and the camelCase mapping
    // at ftsService.ts:65-72 reads `r.chunkId` → `String(undefined)` = "undefined".
    // The fix is to double-quote every camelCase alias so Prisma $queryRaw
    // preserves the key casing. This is the regression guard: unquoted aliases
    // would fail these five assertions.
    expect(sqlSegments.join("?")).toContain('as "chunkId"');
    expect(sqlSegments.join("?")).toContain('as "documentId"');
    expect(sqlSegments.join("?")).toContain('as "workspaceId"');
    expect(sqlSegments.join("?")).toContain('as "documentName"');
    expect(sqlSegments.join("?")).toContain('as "chunkText"');
    // The first real interpolated value (callArgs[2]) is the sanitized query:
    // special chars (&|!():*"'><-\) are replaced with spaces, then tokens are
    // joined by ' & ' to form a valid tsquery. "hello & world" stays as
    // "hello & world" because the lone & is now the AND operator between the
    // two terms.
    expect(callArgs[2]).toBe("hello & world");
  });

  it("strips phrasal/distance metacharacters (<, >, -) so hyphenated queries do not break to_tsquery (WR-08)", async () => {
    const mockQuery = jest.fn().mockResolvedValue([]);
    (prisma.$queryRaw as any) = mockQuery;

    await ftsSearch("a-b foo<bar>baz", "ws-1", 10);
    const callArgs = mockQuery.mock.calls[0];
    // The first interpolated value (callArgs[2]) is the sanitized query: `-`,
    // `<`, `>` are replaced with spaces, so `a-b` → `a b` and `foo<bar>baz`
    // → `foo bar baz`, then joined by ' & ' → "a & b & foo & bar & baz".
    expect(callArgs[2]).toBe("a & b & foo & bar & baz");
  });

  it("returns empty array for empty safe query", async () => {
    const result = await ftsSearch("!!!", "ws-1", 10);
    expect(result).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns formatted FTS results", async () => {
    const mockQuery = jest.fn().mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentName: "Doc 1",
        chunkText: "test content",
        rank: 0.5,
      },
    ]);
    (prisma.$queryRaw as any) = mockQuery;

    const result = await ftsSearch("test", "ws-1", 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      chunkId: "chunk-1",
      documentId: "doc-1",
      workspaceId: "ws-1",
      documentName: "Doc 1",
      chunkText: "test content",
      rank: 0.5,
    });
  });

  it("returns empty array on query failure", async () => {
    (prisma.$queryRaw as any) = jest.fn().mockRejectedValue(new Error("DB error"));
    const result = await ftsSearch("test", "ws-1", 10);
    expect(result).toEqual([]);
  });

  // D-03 regression guard: after the alias fix, PostgreSQL returns camelCase
  // keys (chunkId/chunkText/documentName/etc.) and the mapping must produce
  // real strings — NOT "undefined" (which is what happened when unquoted
  // aliases folded to lowercase and r.chunkId became String(undefined)).
  // Strict equality (not toMatchObject) so a future regression to "undefined"
  // fails loudly.
  it("FTS results carry real chunkId/chunkText/documentName (not 'undefined') when Prisma returns quoted-alias casing", async () => {
    const mockQuery = jest.fn().mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentName: "Doc 1",
        chunkText: "test content",
        rank: 0.5,
      },
    ]);
    (prisma.$queryRaw as any) = mockQuery;

    const result = await ftsSearch("test", "ws-1", 10);
    expect(result).toHaveLength(1);
    const first = result[0]!;
    expect(first.chunkId).toBe("chunk-1");
    expect(first.documentId).toBe("doc-1");
    expect(first.workspaceId).toBe("ws-1");
    expect(first.documentName).toBe("Doc 1");
    expect(first.chunkText).toBe("test content");
    expect(first.rank).toBe(0.5);
  });

  it("initializes pg_trgm extension", async () => {
    await initPostgreSQLFTS();
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
    );
  });

  // ─── 260830-ur9: optional metadata-filter predicates ─────────────────────

  it("no filters → SQL is the exact current template (no d.type/d.createdAt fragments)", async () => {
    const mockQuery = jest.fn().mockResolvedValue([]);
    (prisma.$queryRaw as any) = mockQuery;

    await ftsSearch("test", "ws-1", 10);

    const sql = sqlSegmentsOf(mockQuery);
    expect(sql).not.toContain('d."type"::text = ANY');
    expect(sql).not.toContain('d."createdAt"');
  });

  it("documentTypes filter appends parameterized d.type ANY predicate (never string-interpolated)", async () => {
    const mockQuery = jest.fn().mockResolvedValue([]);
    (prisma.$queryRaw as any) = mockQuery;

    await ftsSearch("test", "ws-1", 10, { documentTypes: ["pdf", "md"] });

    const sql = sqlSegmentsOf(mockQuery);
    expect(sql).toContain('d."type"::text = ANY');
    // Date fragments absent
    expect(sql).not.toContain('d."createdAt"');
    // The documentTypes value is bound as a tagged-template parameter.
    const values = templateValuesOf(mockQuery);
    expect(values).toContainEqual(["pdf", "md"]);
  });

  it("dateFrom/dateTo filters append parameterized timestamptz predicates", async () => {
    const mockQuery = jest.fn().mockResolvedValue([]);
    (prisma.$queryRaw as any) = mockQuery;
    const from = "2025-01-15T00:00:00.000Z";
    const to = "2025-06-01T23:59:59.999Z";

    await ftsSearch("test", "ws-1", 10, { dateFrom: from, dateTo: to });

    const sql = sqlSegmentsOf(mockQuery);
    expect(sql).toContain('d."createdAt" >=');
    expect(sql).toContain('d."createdAt" <=');
    expect(sql).toContain("::timestamptz");
    expect(sql).not.toContain('d."type"::text');
    const values = templateValuesOf(mockQuery);
    expect(values).toContainEqual(from);
    expect(values).toContainEqual(to);
  });

  it("combined documentTypes + date range appends all three predicates", async () => {
    const mockQuery = jest.fn().mockResolvedValue([]);
    (prisma.$queryRaw as any) = mockQuery;

    await ftsSearch("test", "ws-1", 10, {
      documentTypes: ["md"],
      dateFrom: "2025-01-15T00:00:00.000Z",
      dateTo: "2025-06-01T23:59:59.999Z",
    });

    const sql = sqlSegmentsOf(mockQuery);
    expect(sql).toContain('d."type"::text = ANY');
    expect(sql).toContain('d."createdAt" >=');
    expect(sql).toContain('d."createdAt" <=');
    const values = templateValuesOf(mockQuery);
    expect(values).toContainEqual(["md"]);
  });

  it("empty filters object compiles to the current SQL (no extra fragments)", async () => {
    const mockQuery = jest.fn().mockResolvedValue([]);
    (prisma.$queryRaw as any) = mockQuery;

    await ftsSearch("test", "ws-1", 10, {});

    expect(sqlSegmentsOf(mockQuery)).not.toContain('d."type"');
    expect(sqlSegmentsOf(mockQuery)).not.toContain('d."createdAt"');
  });
});