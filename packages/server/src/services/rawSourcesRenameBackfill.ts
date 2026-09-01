// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * rawSourcesRenameBackfill — idempotent startup task (WIKI-02 D-02).
 *
 * Mirrors `archivePageTitleBackfill`: runs once at server startup, best-effort
 * per archive, non-blocking, idempotent (skip if raw_sources/ already exists).
 *
 * Goal: migrate existing on-disk archives from the legacy `raw/` directory
 * naming to the canonical `raw_sources/` naming established by D-01. Without
 * this backfill, pre-existing archives keep their `raw/` directory on disk
 * while every code path (OCR/URL write, fidelity read, orphan cleanup) now
 * targets `raw_sources/` — silent data divergence.
 *
 * Idempotency contract: if `raw_sources/` already exists, the archive is
 * skipped (whether or not a legacy `raw/` also exists — the rename is a
 * no-op once the canonical dir is present). Re-execution after the first run
 * therefore returns `renamed: 0`.
 *
 * Non-blocking contract (D-02): per-archive `try/catch` swallows all errors.
 * `fs.rename` failure (EBUSY, EACCES, …) logs a warning and continues. The
 * function NEVER throws — boot must not block on a best-effort migration.
 */
import fs from "fs/promises";
import path from "path";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");

/**
 * Scan all non-deleted archives and rename legacy `raw/` to `raw_sources/`.
 *
 * @returns `{ renamed, skipped }` — count of dirs renamed and count skipped
 *          (already-migrated, no-raw, or rename-failed archives).
 */
export async function renameRawToRawSources(): Promise<{
  renamed: number;
  skipped: number;
}> {
  const archives = await prisma.archive.findMany({
    where: { deletedAt: null },
    select: { slug: true },
  });

  let renamed = 0;
  let skipped = 0;

  for (const archive of archives) {
    const archiveDir = path.join(ARCHIVES_BASE, archive.slug);
    const rawDir = path.join(archiveDir, "raw");
    const rawSourcesDir = path.join(archiveDir, "raw_sources");

    // Idempotency: skip if raw_sources/ already exists.
    try {
      await fs.access(rawSourcesDir);
      skipped++;
      continue;
    } catch {
      // raw_sources/ absent — check for legacy raw/ below.
    }

    try {
      await fs.access(rawDir);
      // Legacy raw/ exists — rename to raw_sources/.
      await fs.rename(rawDir, rawSourcesDir);
      renamed++;
      logger.info("[backfill] Renamed raw/ -> raw_sources/", {
        archiveSlug: archive.slug,
      });
    } catch (err: unknown) {
      // No raw/ dir (nothing to migrate) OR rename failure (best-effort).
      // D-02: never throw — log and continue.
      const message = err instanceof Error ? err.message : String(err);
      // ENOENT just means no raw/ dir — not a warning. Other errors → warn.
      if (!message.includes("ENOENT")) {
        logger.warn("[backfill] raw/ -> raw_sources/ rename failed", {
          archiveSlug: archive.slug,
          error: message,
        });
      }
      skipped++;
    }
  }

  logger.info("[backfill] raw_sources rename complete", {
    renamed,
    skipped,
  });

  return { renamed, skipped };
}