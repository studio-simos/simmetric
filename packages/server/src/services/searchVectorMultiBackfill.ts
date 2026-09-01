// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * searchVectorMultiBackfill — idempotent startup backfill (Phase 151, RAG-01).
 *
 * Populates the `searchVectorMulti` column (7-config concatenated tsvector:
 * english||italian||german||french||spanish||russian||simple) on
 * `document_chunks` and `archive_pages` for rows where it is still NULL.
 * Mirrors `archivePageTitleBackfill` (D-11 pattern): runs once at server
 * startup, only touches rows that need correction, and is a no-op when
 * there is nothing to fix.
 *
 * Idempotency contract: the `WHERE "searchVectorMulti" IS NULL` guard means
 * re-execution after the first run returns `{ chunks: 0, pages: 0 }`.
 *
 * Batching: each statement is bounded by `LIMIT 500` (T-151-03 — keeps every
 * UPDATE bounded; the loop repeats until zero rows are affected).
 *
 * Soft-delete alignment: `DocumentChunk` has NO `deletedAt` column
 * (soft-delete lives on `Document` — excluded at query time by the existing
 * JOIN filter in ftsService.ts). `ArchivePage` HAS `deletedAt` — tombstoned
 * pages are never modified (mirrors archivePageTitleBackfill.ts:41).
 *
 * The multi-config expression is the shared `MULTI_CONFIG_TSVECTOR` fragment
 * from ftsService.ts (single source of truth — identical at all 9 sites).
 * The fragment is parameterized on the column alias `t`; the correlated
 * subquery binds the row's text column to `t` so the expression is evaluated
 * per-row by Postgres.
 */
import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { MULTI_CONFIG_TSVECTOR } from "./ftsService";

const BATCH_SIZE = 500;

/**
 * Backfill `searchVectorMulti` for all rows where it is NULL, in bounded
 * batches, until no rows remain. Startup-synchronous (measured ~2 ms compute
 * for the full live corpus — RESEARCH Pattern 2).
 *
 * @returns `{ chunks, pages }` — rows updated per table.
 */
export async function backfillSearchVectorMulti(): Promise<{
  chunks: number;
  pages: number;
}> {
  let chunks = 0;
  let pages = 0;

  // DocumentChunk: no deletedAt — backfill all chunks; soft-deleted docs are
  // excluded at query time by the existing JOIN filter (ftsService.ts).
  for (;;) {
    const res = await prisma.$executeRaw`
      UPDATE "document_chunks" dc
      SET "searchVectorMulti" = (
        SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)}
        FROM (SELECT dc."chunkText"::text AS t) AS t
      )
      WHERE dc."id" IN (
        SELECT id FROM "document_chunks"
        WHERE "searchVectorMulti" IS NULL
        LIMIT ${BATCH_SIZE}
      )
    `;
    if (res === 0) break;
    chunks += res;
    logger.info(`[backfill] searchVectorMulti chunks batch: ${res} rows (total ${chunks})`);
  }

  // ArchivePage: HAS deletedAt — tombstoned pages are never modified.
  for (;;) {
    const res = await prisma.$executeRaw`
      UPDATE "archive_pages" ap
      SET "searchVectorMulti" = (
        SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)}
        FROM (SELECT ap."bodyText"::text AS t) AS t
      )
      WHERE ap."id" IN (
        SELECT id FROM "archive_pages"
        WHERE "searchVectorMulti" IS NULL
          AND "deletedAt" IS NULL
        LIMIT ${BATCH_SIZE}
      )
    `;
    if (res === 0) break;
    pages += res;
    logger.info(`[backfill] searchVectorMulti pages batch: ${res} rows (total ${pages})`);
  }

  logger.info("[backfill] searchVectorMulti backfill complete", {
    module: "backfill",
    event: "search_vector_multi_backfill",
    chunksUpdated: chunks,
    pagesUpdated: pages,
  });

  return { chunks, pages };
}
