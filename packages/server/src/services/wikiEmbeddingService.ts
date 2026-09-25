// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import axios from "axios";
import { Prisma } from "@prisma/client";
import { getEnv } from "../config/env";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import crypto from "crypto";
import { getSetting } from "./systemConfigService";
import { MULTI_CONFIG_TSVECTOR } from "./ftsService";

export async function indexWikiPage(archiveId: string, pageId: string, slug: string, title: string, bodyText: string) {
  const env = getEnv();
  const contentHash = crypto.createHash("sha256").update(bodyText).digest("hex");

  // G-131-17: resolve the current vector provider once per call — SystemConfig
  // wins, env fallback, hard default — mirrors the collector's
  // fetchVectorDbConfig precedence (vectorStore.ts:830). Persisted so the
  // hourly wiki-consistency job can detect provider-switch strandings.
  const currentProvider = (await getSetting("VECTOR_DB_PROVIDER")).value || getEnv().VECTOR_DB_PROVIDER || "lancedb";

  // 260721-lrm (D-01): Read the admin-configured EMBEDDING_MODEL system
  // setting and pass it to the collector so archive wiki pages are embedded
  // with the same model the query side uses (hybridSearchService.ts:296).
  // Restores ingest↔query symmetry — archives were the only ingest path
  // not honoring the admin setting. Missing setting → undefined → collector
  // falls back to its configured default (backward-compat).
  const embeddingModelSetting = await getSetting("EMBEDDING_MODEL");
  const embeddingModel = embeddingModelSetting.value || undefined;

  // 2026-09-21 incident: the old hardcoded 60s aborted large wiki pages
  // mid-embedding (local CPU Xenova), surfacing as hourly
  // "[consistency] Reindex failed ... timeout of 60000ms exceeded" log
  // spam with 0 pages healed. WIKI_EMBED_TIMEOUT_MS (default 30 min;
  // 0 = no cap) mirrors COLLECTOR_INGEST_TIMEOUT_MS's operator posture.
  const wikiTimeoutMs = getEnv().WIKI_EMBED_TIMEOUT_MS;

  await axios.post(`${env.COLLECTOR_URL}/api/ingest/wiki-pages`, {
    archiveId, pageId, slug, title, bodyText, contentHash, embeddingModel,
  }, {
    ...(wikiTimeoutMs > 0 ? { timeout: wikiTimeoutMs } : {}),
    headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
  });

  // Maintain the tsvector FTS column (quick 260811-lxh) — best-effort,
  // non-blocking: the vector index is the primary path; FTS lag is
  // preferable to failing the index call. NUL-byte sanitize first: Postgres
  // rejects 0x00 in text columns (SQLSTATE 22021) and wiki page bodies come
  // from markdown imports that may carry embedded NULs.
  const safeBodyText = bodyText.replaceAll("\u0000", "");
  try {
    await prisma.$executeRaw`
      UPDATE "archive_pages" ap
      SET "searchVector" = to_tsvector('english', ${safeBodyText}),
          "searchVectorMulti" = (
            SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)}
            FROM (SELECT ${safeBodyText}::text AS t) AS t
          )
      WHERE ap."id" = ${pageId}
    `;
  } catch (err: unknown) {
    logger.warn("[wiki-embedding] Failed to update searchVector", {
      pageId,
      error: (err as Error).message,
    });
  }

  await prisma.archivePage.update({
    where: { id: pageId },
    data: { vectorContentHash: contentHash, vectorProvider: currentProvider, lastIndexedAt: new Date() },
  });

  logger.info(`[wiki-embedding] Indexed page ${pageId} for archive ${archiveId}`);
}

export async function indexAllWikiPages(archiveId: string) {
  const pages = await prisma.archivePage.findMany({
    where: { archiveId, deletedAt: null },
    select: { id: true, slug: true, title: true, bodyText: true },
  });

  for (const page of pages) {
    try {
      await indexWikiPage(archiveId, page.id, page.slug, page.title, page.bodyText);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error(`[wiki-embedding] Failed to index page ${page.id}`, { error: message });
    }
  }

  logger.info(`[wiki-embedding] Indexed ${pages.length} pages for archive ${archiveId}`);
}

export async function deleteWikiVectors(pageId: string) {
  const env = getEnv();
  try {
    await axios.delete(`${env.COLLECTOR_URL}/api/ingest/wiki-pages/${pageId}`, {
      timeout: 10000,
      headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[wiki-embedding] Failed to delete vectors for page ${pageId}`, { error: message });
  }
  await prisma.archivePage.update({
    where: { id: pageId },
    data: { vectorContentHash: null, vectorProvider: null, lastIndexedAt: null },
  });
}
