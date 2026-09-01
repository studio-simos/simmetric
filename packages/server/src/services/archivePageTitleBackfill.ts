// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * archivePageTitleBackfill — idempotent startup task (D-11).
 *
 * Mirrors `seedBootstrapAdmin`: runs once at server startup, only touches
 * rows that need correction, and is a no-op when there is nothing to fix.
 *
 * Goal: repair ArchivePage rows whose `title` is a UUID, empty, or a
 * placeholder string (`Untitled`, `New Page`, `Untitled Page`). Such titles
 * break the wiki chain-of-custody (AI-SPEC "chain-of-custody della pagina
 * wiki") and compound across re-synthesis cycles. The corrective backfill
 * uses the same `deriveTitle` function that `createPage` uses preventively
 * (D-10), so preventive and corrective paths share one derivation source.
 *
 * Idempotency contract (T-64-09): `isTitleDerivable(title)` guards every
 * update. Pages with already-readable titles are skipped. Re-execution
 * after the first run therefore returns `updated: 0`.
 *
 * Soft-delete alignment (T-64-10, KB-02): the scan filters
 * `where: { deletedAt: null }` — tombstoned pages are never modified.
 *
 * Per-row updates (NOT batch $executeRaw) — safer for idempotency and to
 * attribute each update in structured logs (PATTERNS.md note).
 */
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { deriveTitle, isTitleDerivable } from "../utils/deriveTitle";

/**
 * Scan all non-tombstoned ArchivePage rows and derive a readable title for
 * any whose title is UUID / empty / placeholder. No-op on the second and
 * subsequent runs.
 *
 * @returns `{ updated, scanned }` — count of titles corrected and count of
 *          live pages inspected.
 */
export async function backfillArchivePageTitles(): Promise<{
  updated: number;
  scanned: number;
}> {
  const pages = await prisma.archivePage.findMany({
    where: { deletedAt: null },
    select: { id: true, title: true, bodyText: true, slug: true },
  });

  let updated = 0;
  for (const p of pages) {
    // Idempotency guard: skip pages whose title is already readable.
    if (!isTitleDerivable(p.title)) continue;

    const derived = deriveTitle(p.bodyText || "", p.slug);
    // Only write when the derived title differs — avoids unnecessary DB
    // writes on a no-op run (defense-in-depth on idempotency).
    if (derived && derived !== p.title) {
      await prisma.archivePage.update({
        where: { id: p.id },
        data: { title: derived },
      });
      updated++;
    }
  }

  logger.info("[backfill] Archive page titles derived", {
    module: "backfill",
    event: "title_backfill",
    updatedCount: updated,
    scannedCount: pages.length,
  });

  return { updated, scanned: pages.length };
}