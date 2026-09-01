// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import type { HybridSearchFilters } from "@simmetric-chat/shared";

/**
 * Phase 151 (RAG-01) — multi-locale FTS SQL fragments (Model C, D-01).
 *
 * Single source of truth for the 7-config concatenated tsvector and its
 * OR-ed query equivalents. All write sites and read sites import these
 * constants so the expression is identical everywhere (CI grep gate
 * enforces that no other `'english'`-only FTS literal exists outside this
 * file).
 *
 * Substitution contract: the fragments are parameterized on the column
 * alias `t` (write side) and the query placeholder `q` (read side). Callers
 * embed the fragment via `Prisma.raw(...)` inside a correlated subquery that
 * binds the alias — e.g.:
 *
 *   `SET "searchVectorMulti" = (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)}
 *    FROM (SELECT ${bodyText}::text AS t) AS t)`
 *
 *   `WHERE "searchVectorMulti" @@ (SELECT ${Prisma.raw(MULTI_CONFIG_TSQUERY)}
 *    FROM (SELECT ${safeQuery}::text AS q) AS q)`
 *
 * The subquery form keeps the indexed column bare in the `@@` predicate
 * (GIN-usable — RESEARCH Pitfall 7: wrapping the column in an expression
 * forces a seq scan). The fragment itself contains no bound values — the
 * caller's tagged template supplies them.
 *
 * CJK limitation (RESEARCH Pitfall 5): the `simple` config gives whole-run
 * token matching only for CJK text — semantic recall for zh comes from the
 * vector leg.
 */
export const MULTI_CONFIG_TSVECTOR = `to_tsvector('english', t) || to_tsvector('italian', t) || to_tsvector('german', t) || to_tsvector('french', t) || to_tsvector('spanish', t) || to_tsvector('russian', t) || to_tsvector('simple', t)`;

export const MULTI_CONFIG_TSQUERY = `websearch_to_tsquery('english', q) || websearch_to_tsquery('italian', q) || websearch_to_tsquery('german', q) || websearch_to_tsquery('french', q) || websearch_to_tsquery('spanish', q) || websearch_to_tsquery('russian', q) || websearch_to_tsquery('simple', q)`;

export const MULTI_CONFIG_PLAINTO_TSQUERY = `plainto_tsquery('english', q) || plainto_tsquery('italian', q) || plainto_tsquery('german', q) || plainto_tsquery('french', q) || plainto_tsquery('spanish', q) || plainto_tsquery('russian', q) || plainto_tsquery('simple', q)`;

export interface FTSResult {
  chunkId: string;
  documentId: string;
  workspaceId: string;
  documentName: string;
  chunkText: string;
  rank: number;
}

/**
 * D-11 typed $queryRaw row for the document_chunks FTS projection. Field
 * names match the SELECT aliases exactly (camelCase preserved by Postgres
 * quoted identifiers per RESEARCH Pitfall 3). `rank` is a Postgres
 * `real`/`double precision` → typed as `number` (Prisma raw returns JS
 * numbers for real/double).
 */
interface FtsResultRow {
  chunkId: string;
  documentId: string;
  workspaceId: string;
  documentName: string;
  chunkText: string;
  rank: number;
}

// D-02: Initialize pg_trgm extension for fuzzy/partial matching backup
export async function initPostgreSQLFTS(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    logger.info("[fts] PostgreSQL extensions initialized (pg_trgm)");
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[fts] Failed to initialize extensions: ${message}`);
  }
}

// D-01: Replace SQLite full-text search with PostgreSQL tsvector/tsquery.
// 260830-ur9: optional `filters` appends parameterized predicate fragments on
// the joined `documents d` row ONLY when the corresponding key is present.
// Absent/empty filters → the SQL is the exact current template (no extra
// fragments, no Prisma.empty noise). All values are tagged-template
// parameters — never string-interpolated.
export async function ftsSearch(
  query: string,
  workspaceId: string,
  limit: number = 20,
  filters?: HybridSearchFilters,
): Promise<FTSResult[]> {
  try {
    // WR-08: strip the full set of `to_tsquery` metacharacters. The previous
    // set `[&|!():*"']` missed `<`, `>`, `-` (phrasal / distance operators).
    // A user query like `a-b` or `foo<bar>baz` survived sanitization and was
    // joined into `a & - & b` / `foo<bar>baz`, which to_tsquery parses as a
    // phrasal/distance operator → either a syntax error (caught → returns [])
    // or a semantically wrong query, silently degrading hybrid search to
    // vector-only. No SQL injection risk (Prisma parameterizes via tagged
    // template); this only protects legitimate queries containing hyphens /
    // angle brackets from returning zero FTS results.
    const safeQuery = query
      .replace(/[&|!():*"'><\\-]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" & ");

    if (!safeQuery) return [];

    // 260830-ur9: build the optional filter fragments (parameterized only —
    // Prisma.sql composes the tagged template; values stay bound). When the
    // fragment is Prisma.empty the SQL template is the exact current shape.
    const documentTypes =
      Array.isArray(filters?.documentTypes) && filters!.documentTypes!.length > 0
        ? filters!.documentTypes
        : undefined;
    const typeClause = documentTypes
      ? Prisma.sql`AND d."type"::text = ANY(${documentTypes})`
      : Prisma.empty;
    const dateFrom = typeof filters?.dateFrom === "string" ? filters.dateFrom : undefined;
    const dateTo = typeof filters?.dateTo === "string" ? filters.dateTo : undefined;
    const dateFromClause = dateFrom
      ? Prisma.sql`AND d."createdAt" >= ${dateFrom}::timestamptz`
      : Prisma.empty;
    const dateToClause = dateTo
      ? Prisma.sql`AND d."createdAt" <= ${dateTo}::timestamptz`
      : Prisma.empty;

    const results: Array<FtsResultRow> = await prisma.$queryRaw<Array<FtsResultRow>>`
      SELECT
        dc."id" as "chunkId",
        dc."documentId" as "documentId",
        d."workspaceId" as "workspaceId",
        d."name" as "documentName",
        dc."chunkText" as "chunkText",
        ts_rank(dc."searchVectorMulti", (SELECT ${Prisma.raw(MULTI_CONFIG_TSQUERY)} FROM (SELECT ${safeQuery}::text AS q) AS q)) as rank
      FROM "document_chunks" dc
      JOIN "documents" d ON d."id" = dc."documentId"
      WHERE dc."searchVectorMulti" @@ (SELECT ${Prisma.raw(MULTI_CONFIG_TSQUERY)} FROM (SELECT ${safeQuery}::text AS q) AS q)
        AND d."workspaceId" = ${workspaceId}
        AND d."deletedAt" IS NULL
        ${typeClause}
        ${dateFromClause}
        ${dateToClause}
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    return results.map((r) => ({
      chunkId: String(r.chunkId),
      documentId: String(r.documentId),
      workspaceId: String(r.workspaceId),
      documentName: String(r.documentName),
      chunkText: String(r.chunkText),
      rank: Number(r.rank),
    }));
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[fts] Search failed: ${message}`);
    return [];
  }
}
