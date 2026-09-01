// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Vector Cleanup Job — reliable collector vector purge with retry (D-08).
 *
 * Soft-deleted documents have their chunk rows hard-deleted in PostgreSQL
 * (D-07, in the DELETE route's $transaction), but the vector half of the
 * hybrid RAG pipeline lives in LanceDB/Qdrant via the collector. The
 * initial fire-and-forget DELETE to the collector may fail (transient
 * outage, network error). This retry job polls every 5 minutes for
 * documents where `deletedAt` is set but `vectorCleanupAt` is still null
 * (pending cleanup), re-attempts the collector purge, and marks
 * `vectorCleanupAt` on 2xx success.
 *
 * Phase 165 (Q-02/Q-03): the in-process timer, overlap guard, and
 * distributed-lock wrap have been REMOVED. The scheduler is now
 * a pg-boss cron job: `createQueue` + `schedule` + `boss.work` registration at
 * boot, with pg-boss's native SKIP LOCKED job dedup supersededing both the
 * overlap guard and the distributed lock (D-02 one-way door). When pg-boss is
 * unavailable (`getBoss() === null`), the init function logs a warn and
 * returns early — there is NO fallback timer (D-02). The server still
 * boots and REST/SSE work normally; only this cron job is offline.
 */

import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "./jobQueue";

// ─── Retry bounds (IN-02) ──────────────────────────────────────────────────
//
// A document whose collector purge persistently fails (e.g. collector
// permanently misconfigured for that workspace) used to be retried every
// 5 minutes forever, generating unbounded log volume. We now bound attempts:
// after MAX_VECTOR_CLEANUP_ATTEMPTS failed purges the job sets the
// `vectorCleanupFailedAt` tombstone and skips the doc, surfacing stuck
// purges to ops instead of spamming the log.
const MAX_VECTOR_CLEANUP_ATTEMPTS = 10;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a single vector-cleanup cycle.
 *
 * Queries all soft-deleted documents with `vectorCleanupAt: null` and no
 * `vectorCleanupFailedAt` tombstone (pending collector purge, not yet given
 * up on), sends a DELETE to the collector for each, and marks
 * `vectorCleanupAt` on 2xx. Non-2xx responses and network errors increment
 * `vectorCleanupAttempts`; once it reaches MAX_VECTOR_CLEANUP_ATTEMPTS the
 * doc is tombstoned (`vectorCleanupFailedAt` set) and skipped on future
 * cycles. The `failed` counter counts failed attempts in this cycle.
 *
 * @returns { purged: number; failed: number } — counts of successful and
 *   failed purge attempts in this cycle.
 */
export async function runVectorCleanupCycle(): Promise<{
  purged: number;
  failed: number;
}> {
  const env = getEnv();

  const pending = await prisma.document.findMany({
    where: {
      deletedAt: { not: null },
      vectorCleanupAt: null,
      vectorCleanupFailedAt: null, // IN-02: skip tombstoned docs
    },
    select: { id: true, workspaceId: true, vectorCleanupAttempts: true },
  });

  if (pending.length === 0) {
    return { purged: 0, failed: 0 };
  }

  let purged = 0;
  let failed = 0;

  // IN-02: record a failed purge attempt. Increments the counter and, once
  // it reaches the cap, sets the `vectorCleanupFailedAt` tombstone so the doc
  // is skipped on future cycles. Returns the new attempt count and whether
  // the doc was tombstoned in this call (for structured logging).
  const recordPurgeFailure = async (
    doc: { id: string; vectorCleanupAttempts: number | null },
  ): Promise<{ attempts: number; tombstoned: boolean }> => {
    const attempts = (doc.vectorCleanupAttempts ?? 0) + 1;
    const tombstoned = attempts >= MAX_VECTOR_CLEANUP_ATTEMPTS;
    await prisma.document.update({
      where: { id: doc.id },
      data: {
        vectorCleanupAttempts: attempts,
        ...(tombstoned ? { vectorCleanupFailedAt: new Date() } : {}),
      },
    });
    return { attempts, tombstoned };
  };

  for (const doc of pending) {
    const purgeUrl = `${env.COLLECTOR_URL}/api/ingest/${encodeURIComponent(doc.id)}?workspaceId=${encodeURIComponent(doc.workspaceId)}`;
    // WR-03: 30s AbortController so a hung collector can't stall the sequential
    // cycle (the overlap guard would then also block the next 5-minute
    // cycle). Cleared in a `finally` after the await resolves.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      const resp = await fetch(purgeUrl, {
        method: "DELETE",
        headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
        signal: controller.signal,
      });

      if (resp.ok) {
        await prisma.document.update({
          where: { id: doc.id },
          data: { vectorCleanupAt: new Date() },
        });
        purged++;
      } else {
        // IN-02: bound retries — increment attempts, tombstone at the cap.
        const { attempts, tombstoned } = await recordPurgeFailure(doc);
        logger.warn("[vector-cleanup] collector non-2xx", {
          documentId: doc.id,
          status: resp.status,
          attempts,
          tombstoned,
        });
        failed++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const { attempts, tombstoned } = await recordPurgeFailure(doc);
      logger.warn("[vector-cleanup] collector purge failed", {
        documentId: doc.id,
        error: msg,
        attempts,
        tombstoned,
      });
      failed++;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { purged, failed };
}

// Phase 165 (D-04/D-05): queue name (underscores, not colons — pg-boss 12.28
// assertQueueName rejects ":"); mirrors the Phase 161 lock resource namespace;
// cron expression is the 5-minute cadence the former timer used (verified
// valid via cron-parser — pg-boss uses the same validation).
const QUEUE_NAME = "cleanup_vector";
const CRON_EXPRESSION = "*/5 * * * *";

/**
 * Phase 165 (Q-02/Q-03): Register the vector cleanup as a pg-boss cron job.
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
export async function initVectorCleanupScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[vector-cleanup] pg-boss unavailable — scheduler offline (D-02)");
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
        const result = await runVectorCleanupCycle();
        if (result.purged > 0 || result.failed > 0) {
          logger.info(
            `[vector-cleanup] Cycle complete: ${result.purged} purged, ${result.failed} failed`,
          );
        }
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        const message = err instanceof Error ? err.message : String(err);
        logger.error("[vector-cleanup] Cycle failed", { error: message });
      }
    }
  });

  logger.info(`[vector-cleanup] Scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}