// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Synthesis Reaper Job — D-14 (KB-04).
 *
 * Periodically sweeps SynthesisRun rows stuck in PROCESSING status whose
 * `expiresAt` timestamp is in the past (i.e., the run was claimed but never
 * reached a terminal state within the 2-hour window). Such rows indicate
 * a process crash (OOM/SIGKILL) where the .finally() of the pipeline did
 * not run, leaving the wiki lock held forever.
 *
 * The reaper flips those rows to FAILED with the prefixed error string
 * "Aborted: orphaned PROCESSING (reaper)" so the user sees an explicit
 * failure rather than a stuck "in progress" status.
 *
 * Phase 165 (Q-02/Q-03): the in-process timer, overlap guard, and
 * distributed-lock wrap have been REMOVED. The scheduler is now
 * a pg-boss cron job: `createQueue` + `schedule` + `boss.work` registration at
 * boot, with pg-boss's native SKIP LOCKED job dedup supersededing both the
 * overlap guard and the distributed lock (D-02 one-way door). When pg-boss is
 * unavailable (`getBoss() === null`), the init function logs a warn and
 * returns early — there is NO fallback timer (D-02). The server still
 * boots and REST/SSE work normally; only this cron job is offline.
 *
 * Threat register: T-64-14 (DoS — stuck PROCESSING lock) mitigated.
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "./jobQueue";

// Phase 165 (D-04/D-05): queue name (underscores, not colons — pg-boss 12.28
// assertQueueName rejects ":"); mirrors the Phase 161 lock resource namespace;
// cron expression is the 15-minute cadence the former timer used (verified
// valid via cron-parser — pg-boss uses the same validation).
const QUEUE_NAME = "reaper_synthesis";
const CRON_EXPRESSION = "*/15 * * * *";

const REAPER_ERROR_STRING = "Aborted: orphaned PROCESSING (reaper)";

/**
 * Run one reaper cycle.
 *
 * Flips every SynthesisRun row with status=PROCESSING AND expiresAt < now
 * to status=FAILED + error=REAPER_ERROR_STRING. Returns the count of reaped
 * rows for observability. Per-row errors are impossible (updateMany is a
 * single SQL statement), so a failure surfaces as a thrown exception caught
 * by the work handler's try/catch.
 */
export async function runSynthesisReaperCycle(): Promise<{ reaped: number }> {
  const result = await prisma.synthesisRun.updateMany({
    where: {
      status: "PROCESSING",
      expiresAt: { lt: new Date() },
    },
    data: {
      status: "FAILED",
      error: REAPER_ERROR_STRING,
    },
  });

  if (result.count > 0) {
    logger.info("[synthesis-reaper] Reaped orphaned runs", {
      module: "synthesis-reaper",
      event: "reaper_sweep",
      reapedCount: result.count,
      threshold: "expiresAt<now",
    });
  }

  return { reaped: result.count };
}

/**
 * Phase 165 (Q-02/Q-03): Register the synthesis reaper as a pg-boss cron job.
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
export async function initSynthesisReaperScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[synthesis-reaper] pg-boss unavailable — scheduler offline (D-02)");
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
        const result = await runSynthesisReaperCycle();
        if (result.reaped > 0) {
          logger.info(`[synthesis-reaper] Sweep reaped ${result.reaped} orphaned run(s)`);
        }
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        const message = err instanceof Error ? err.message : String(err);
        logger.error("[synthesis-reaper] sweep failed", { error: message });
      }
    }
  });

  logger.info(`[synthesis-reaper] Reaper scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}