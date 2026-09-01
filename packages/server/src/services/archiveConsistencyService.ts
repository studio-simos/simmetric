// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { indexWikiPage } from "./wikiEmbeddingService";
import { getSetting } from "./systemConfigService";
import { getEnv } from "../config/env";
import { getBoss, createQueue, schedule } from "./jobQueue";

// NOTE (Phase 180 dead-code sweep): the legacy `checkConsistency()` +
// `runConsistencyCheck()` pair (DB-content-hash vs filesystem drift check
// with auto-heal thresholds) was REMOVED — zero production callers (the
// live hourly job is the pg-boss `runWikiConsistencyCheck` handler below).

// ─── Phase 165 (Q-02/Q-03): wiki-consistency scheduler (pg-boss cron) ──
//
// The hourly wiki-consistency scheduler was previously defined inline in
// index.ts, then lock-wrapped in Phase 161 (DR-01). It is now a pg-boss
// cron job: `createQueue` + `schedule` + `boss.work` registration at boot,
// with pg-boss's native SKIP LOCKED job dedup supersededing both the
// overlap guard and the distributed lock (D-02 one-way door). When pg-boss
// is unavailable (`getBoss() === null`), the init function logs a warn and
// returns early — there is NO fallback timer (D-02). The server still
// boots and REST/SSE work normally; only this cron job is offline.
//
// The dead hourly consistency scheduler that previously occupied this file
// (lines 222-247 pre-Phase-161) was never called — the live scheduler is
// `initWikiConsistencyScheduler`. It has been DELETED to prevent future
// confusion (RESEARCH.md §"Pitfall 1").
//
// Phase 165 (D-04/D-05): queue name (underscores, not colons — pg-boss 12.28
// assertQueueName rejects ":"); mirrors the Phase 161 lock resource namespace;
// cron expression is the hourly cadence the former timer used (verified
// valid via cron-parser — pg-boss uses the same validation).
const QUEUE_NAME = "consistency_archive";
const CRON_EXPRESSION = "0 * * * *";

/**
 * Phase 165 (Q-02/Q-03): Register the wiki-consistency scheduler as a pg-boss
 * cron job.
 *
 * Replaces the former timer + overlap guard + distributed-lock wrap
 * lifecycle with: `createQueue` → `schedule` → `boss.work`. pg-boss's native
 * SKIP LOCKED job dedup supersedes both the overlap guard and the distributed
 * lock (D-02 one-way door — no fallback timer).
 *
 * D-02 graceful degradation: when `getBoss() === null` (Postgres unreachable),
 * this logs a warn and returns early — no `process.exit`, no fallback
 * timer. The server boots and REST/SSE work; only this cron job is
 * offline.
 *
 * Pitfall 1: `createQueue` MUST precede `schedule` (the schedule references
 * the queue by name — foreign-key constraint).
 * Pitfall 2: the `boss.work` handler receives a `Job[]` array, NOT a single
 * job — iterate with `for...of`.
 * Pitfall 3: the work handler catches cycle errors and logs them (resolve =
 * success, no re-throw → no pg-boss retry storm).
 */
export async function initWikiConsistencyScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[wiki-consistency] pg-boss unavailable — scheduler offline (D-02)");
    return;
  }

  // Pitfall 1: queue must exist before schedule references it by name.
  await createQueue(QUEUE_NAME);
  // Idempotent upsert (pg-boss ON CONFLICT DO UPDATE) — safe on every boot,
  // no handle/idempotency guard needed.
  await schedule(QUEUE_NAME, CRON_EXPRESSION);

  // Pitfall 2: handler receives Job[] array, iterate with for...of.
  await boss.work(QUEUE_NAME, async (jobs) => {
    for (const _job of jobs) {
      try {
        const archives = await prisma.archive.findMany({ where: { deletedAt: null, autoIndex: true } });
        let driftedTotal = 0;
        let reindexedTotal = 0;
        for (const archive of archives) {
          const results = await runWikiConsistencyCheck(archive.id);
          const driftedCount = results.filter((r) => r.drifted).length;
          if (driftedCount > 0) {
            logger.info(`[wiki-consistency] Archive ${archive.id}: ${driftedCount} drifted pages`);
            const reindexed = await reindexDriftedPages(archive.id);
            logger.info(`[wiki-consistency] Reindexed ${reindexed} pages for archive ${archive.id}`);
            driftedTotal += driftedCount;
            reindexedTotal += reindexed;
          }
        }
        logger.info(
          `[wiki-consistency] Cycle complete: ${archives.length} archives checked, ${driftedTotal} drifted, ${reindexedTotal} reindexed`,
        );
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        const message = err instanceof Error ? err.message : String(err);
        logger.error("[wiki-consistency] Job failed", { error: message });
      }
    }
  });

  logger.info(`[wiki-consistency] Scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}

export interface WikiConsistencyResult {
  pageId: string;
  slug: string;
  drifted: boolean;
  currentHash: string;
  indexedHash: string | null;
  provider: string | null;
}

export async function runWikiConsistencyCheck(archiveId: string): Promise<WikiConsistencyResult[]> {
  const pages = await prisma.archivePage.findMany({
    where: { archiveId, deletedAt: null },
    select: { id: true, slug: true, bodyText: true, contentHash: true, vectorContentHash: true, vectorProvider: true, lastIndexedAt: true },
  });

  // G-131-17: resolve the current provider once before the loop — SystemConfig
  // wins, env fallback, hard default (mirrors indexWikiPage + the collector's
  // fetchVectorDbConfig precedence). A null/mismatched vectorProvider counts
  // as drift so provider-switch strandings heal via the hourly scheduler.
  const currentProvider = (await getSetting("VECTOR_DB_PROVIDER")).value || getEnv().VECTOR_DB_PROVIDER || "lancedb";

  const results: WikiConsistencyResult[] = [];

  for (const page of pages) {
    const currentHash = crypto.createHash("sha256").update(page.bodyText).digest("hex");
    const drifted = page.vectorContentHash !== currentHash || page.vectorProvider !== currentProvider;
    results.push({
      pageId: page.id,
      slug: page.slug,
      drifted,
      currentHash,
      indexedHash: page.vectorContentHash,
      provider: page.vectorProvider,
    });
  }

  return results;
}

export async function reindexDriftedPages(archiveId: string): Promise<number> {
  const drifted = await runWikiConsistencyCheck(archiveId);
  let reindexed = 0;
  for (const result of drifted) {
    if (result.drifted) {
      try {
        const page = await prisma.archivePage.findUnique({ where: { id: result.pageId } });
        if (page) {
          await indexWikiPage(archiveId, page.id, page.slug, page.title, page.bodyText);
          reindexed++;
        }
      } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
        logger.error(`[consistency] Reindex failed for ${result.pageId}`, { error: message });
      }
    }
  }
  return reindexed;
}
