// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Quota Reset Job — hourly pg-boss cron sweeping the recurring 30-day token
 * quota reset (Phase 207 CLOUD-06, D-11). Mirrors connectorHealthCheckJob.ts
 * structurally: createQueue BEFORE schedule (FK pitfall), boss.work handler
 * iterates Job[] (pitfall 2), per-row try/catch (one failing user never
 * aborts the sweep), log + resolve (NEVER re-throw — no pg-boss retry storm,
 * pitfall 3), getBoss() null → warn + return with NO fallback timer (D-02).
 *
 * Sweep contract (D-11): per-user cadence anchored to User.resetAnchorDate
 * (admin-set start date). Due = start + k×30d ≤ now with k maximal. Each due
 * user gets EXACTLY ONE QuotaReset anchor (kind "tokens", triggeredBy
 * "cron") written via quotaService.resetTokenQuota with notBefore=due — the
 * in-transaction latest-anchor re-check makes concurrent ticks/multi-instance
 * runs no-ops, and the (userId, kind, at) unique backstops the residual race.
 *
 * 185 D-09 (org-from-the-ROW doctrine): the sweep resolves everything FROM
 * THE ROW — no ambient tenant-context reads (jobs run OUTSIDE the request
 * ALS). Only kind "tokens" resets — storage is a cap, never reset (D-12).
 * Reset NEVER deletes/zeroes usage rows (D-02, P1 — 203 cost history stays
 * immutable).
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "./jobQueue";
import { resolveTokenQuota, resetTokenQuota, windowStart } from "./quotaService";

// Phase 207 (D-11): queue name underscores-only — assertValidQueueName
// (jobQueue.ts:117-125) rejects ":". Hourly cadence (0 * * * *) — a 30-day
// granularity makes hourly sweeps effectively real-time; the anchor re-check
// makes overlap harmless (Assumption A4 in 207-RESEARCH.md).
const QUEUE_NAME = "quota_reset_sweep";
const CRON_EXPRESSION = "0 * * * *";

/** The recurring period: 30 days (CLOUD-06), computed in UTC. */
const RESET_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** Largest k such that start + k×30d ≤ now, or null when not yet due. */
function dueInstant(start: Date, now: Date): Date | null {
  if (start.getTime() > now.getTime()) return null;
  const elapsed = now.getTime() - start.getTime();
  const k = Math.floor(elapsed / RESET_PERIOD_MS);
  if (k < 1) return null; // start itself is not a reset — the first boundary is start+30d
  return new Date(start.getTime() + k * RESET_PERIOD_MS);
}

/**
 * Run one sweep: users with a reset anchor date + an ACTIVE token quota
 * (override set, or preset configured — resolved via quotaService) get one
 * cron anchor at their due instant. Users WITHOUT resetAnchorDate are never
 * touched (manual reset only — D-09/D-11). tokenQuotaUnlimited users are
 * skipped (nothing to reset).
 */
export async function runQuotaResetSweep(now = new Date()): Promise<{ reset: number; skipped: number; errors: number }> {
  let reset = 0;
  let skipped = 0;
  let errors = 0;

  // Org is resolved FROM THE ROW (185 D-09) — quota fields ride the User row.
  // Note: User has NO deletedAt column (206 D-05 uses disabledAt for the
  // disable lifecycle) — disabled users keep their quota state coherent with
  // usage and stay in the sweep.
  const users = await prisma.user.findMany({
    where: { resetAnchorDate: { not: null }, tokenQuotaUnlimited: false },
    select: { id: true, resetAnchorDate: true },
  });

  for (const user of users) {
    try {
      if (!user.resetAnchorDate) {
        skipped++;
        continue;
      }
      const due = dueInstant(new Date(user.resetAnchorDate), now);
      if (!due) {
        skipped++;
        continue;
      }
      // Only users with an ACTIVE token quota get swept (D-11): override set,
      // or a preset configured. resolveTokenQuota implements the D-08 chain;
      // unlimited/unset → nothing to reset.
      const resolution = await resolveTokenQuota(user.id);
      if (resolution.limit == null) {
        skipped++;
        continue;
      }
      const result = await resetTokenQuota(user.id, "tokens", "cron", { notBefore: due });
      if (result.inserted) {
        reset++;
        logger.info("[quota-reset] Recurring token reset", {
          userId: user.id,
          due: due.toISOString(),
          windowStart: (await windowStart(user.id, "tokens")).toISOString(),
        });
      } else {
        skipped++; // another tick/instance already handled this user
      }
    } catch (err: unknown) {
      // Per-row try/catch: one failing user does not abort the sweep
      // (connectorHealthCheckJob per-row doctrine). Message only.
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[quota-reset] Failed to reset quota for user", { userId: user.id, error: message });
      errors++;
    }
  }

  return { reset, skipped, errors };
}

/**
 * Register the quota reset as a pg-boss cron job (D-11, mirroring
 * initConnectorHealthCheckScheduler). D-02 graceful degradation: when
 * `getBoss() === null`, this logs a warn and returns early — NO fallback
 * timer, NO process.exit. The server boots and REST/SSE work; only this
 * cron is offline.
 */
export async function initQuotaResetScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    logger.warn("[quota-reset] pg-boss unavailable — scheduler offline (D-02)");
    return;
  }

  // Pitfall 1: queue must exist before schedule references it by name (FK).
  await createQueue(QUEUE_NAME);
  // Idempotent upsert (pg-boss ON CONFLICT DO UPDATE) — safe on every boot.
  await schedule(QUEUE_NAME, CRON_EXPRESSION);

  // Pitfall 2: the work handler receives a Job[] array, NOT a single job —
  // iterate with for...of.
  await boss.work(QUEUE_NAME, async (jobs) => {
    for (const _job of jobs) {
      try {
        const result = await runQuotaResetSweep();
        logger.info(
          `[quota-reset] Sweep complete: ${result.reset} reset, ${result.skipped} skipped, ${result.errors} errors`,
        );
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        const message = err instanceof Error ? err.message : String(err);
        logger.error("[quota-reset] Sweep cycle failed", { error: message });
      }
    }
  });

  logger.info(`[quota-reset] Scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}