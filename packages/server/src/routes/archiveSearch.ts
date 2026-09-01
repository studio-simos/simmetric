// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../middleware/auth";
import { archiveSearchQuerySchema } from "@simmetric-chat/shared";
import type { ArchiveSearchQuery } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { MULTI_CONFIG_TSQUERY } from "../services/ftsService";

const router = Router();

// GET /:archiveId/search — Full-text search across archive pages via PostgreSQL tsvector
router.get("/:archiveId/search", authMiddleware, async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    // Validate query params with archiveSearchQuerySchema
    const result = archiveSearchQuerySchema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid search parameters",
        details: result.error.flatten().fieldErrors,
      });
      return;
    }

    const validatedData: ArchiveSearchQuery = result.data;
    const { query, limit, category } = validatedData;

    // Sanitize query for tsquery: replace special chars with space, join terms with &
    // Phase 151 (RAG-01): extended to the WR-08 set (adds <, >, -) — the query
    // now feeds websearch_to_tsquery, where a raw hyphen becomes a phrase/distance
    // query that regresses recall (RESEARCH Pitfall 1).
    const sanitizedQuery = query
      .replace(/[&|!():*"'><\\-]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" & ");

    // If query after sanitization is empty (e.g., user typed only special characters), return empty array
    if (!sanitizedQuery) {
      res.json([]);
      return;
    }

    // Build the FTS query with optional category filter.
    // D-09 (KB-02 audit): JOIN archives a with a."deletedAt" IS NULL enforces the
    // cascata logica — a page belonging to a tombstoned archive is effectively
    // deleted even if the page row itself is not tombstoned. Without the JOIN,
    // the raw SQL would leak tombstoned-archive pages via search (AI-SPEC
    // critical failure mode 4: PHI must never be queryable after tombstone).
    //
    // Rule 1 fix: replaced the nested `prisma.$queryRaw` conditional (which
    // produced an invalid `$4` placeholder when category was undefined) with
    // `Prisma.sql` / `Prisma.empty`. The previous form was broken and every
    // search request returned 500 — pre-existing bug surfaced by the new
    // integration test.
    const categoryClause = category
      ? Prisma.sql`AND ap."category" = ${category}`
      : Prisma.empty;
    // D-08/D-11 (TYP-02): typed $queryRaw row. Quoted camelCase aliases are
    // preserved verbatim by Postgres (Pitfall 3); the unquoted `rank` alias is
    // lowercased. `frontmatter` is Json? on ArchivePage — typed as `unknown`
    // since the row is forwarded verbatim to res.json (no field access).
    interface ArchiveSearchRow {
      id: string;
      title: string;
      slug: string;
      category: string;
      frontmatter: unknown;
      rank: number;
    }
    const results: Array<ArchiveSearchRow> = await prisma.$queryRaw<Array<ArchiveSearchRow>>`
      SELECT
        ap."id",
        ap."title",
        ap."slug",
        ap."category",
        ap."frontmatter",
        ts_rank(ap."searchVectorMulti", (SELECT ${Prisma.raw(MULTI_CONFIG_TSQUERY)} FROM (SELECT ${sanitizedQuery}::text AS q) AS q)) as rank
      FROM "archive_pages" ap
      JOIN "archives" a ON a."id" = ap."archiveId" AND a."deletedAt" IS NULL
      WHERE ap."archiveId" = ${archiveId}
        AND ap."searchVectorMulti" @@ (SELECT ${Prisma.raw(MULTI_CONFIG_TSQUERY)} FROM (SELECT ${sanitizedQuery}::text AS q) AS q)
        AND ap."deletedAt" IS NULL
        ${categoryClause}
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    logger.debug("[archiveSearch] Search completed", {
      archiveId,
      queryLength: query.length,
      resultCount: results.length,
    });

    res.json(results);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archiveSearch] Error searching archive pages", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
