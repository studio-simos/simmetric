// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Chat Message Reaper Job — Phase 84 (SEED-002/003/004, D-01, D-04..D-15).
 *
 * Two-pass daily reaper for chat-message retention:
 *
 *   Pass 1 (soft-delete, D-04): tombstones old messages of ACTIVE chats only.
 *     `where: { deletedAt: null, createdAt: { lt: now - retentionDays*d },
 *               chat: { deletedAt: null } }`
 *     The `chat: { deletedAt: null }` relation filter is LOAD-BEARING
 *     (SEED-004c) — it ensures a non-explicitly-deleted message of an
 *     active chat is NEVER hard-purged: Pass 1 only soft-deletes, and only
 *     for active chats; Pass 2 only matches already-tombstoned rows.
 *
 *   Pass 2 (hard-purge, D-05): deletes tombstoned rows past the 7-day grace.
 *     `where: { deletedAt: { not: null, lt: now - GRACE_PERIOD_DAYS*d } }`
 *     NO `chat` relation filter — matches SEED-002 SQL verbatim. Pass 2
 *     runs REGARDLESS of retention config (D-15): a tombstoned row past
 *     grace is purged even when retention is OFF, honouring explicit
 *     deletion and preventing PII leak (T-84-02-T7).
 *
 * Audit (D-13/D-14): every tick emits
 *   `logEvent("chat", "system", "reaper.run", null,
 *              { softDeleted, hardPurged, retentionDays, graceDays: 7 })`
 * including no-op ticks (T-84-02-T6).
 *
 * Config (D-15): `getSetting("chat_message_retention_days")` is read every
 * tick. null/""/non-numeric/<=0 → Pass 1 is a no-op (retentionDays: null).
 * The value is writable only via the audited `PUT /api/system/chat-retention`
 * route (D-08/D-09); the cache is refreshed on write, so per-tick reads pick
 * up admin changes without a restart.
 *
 * Pitfall 5 (documented inline): Pass 1 vs concurrent insert race is
 * naturally guarded by `createdAt < now - retentionDays` — a message
 * inserted after `now` cannot satisfy the cutoff. Do NOT add a spurious
 * lock.
 *
 * Phase 165 (Q-02/Q-03): the in-process daily alignment timer, the
 * cycle-internal overlap guard, and the distributed-lock wrap have been
 * REMOVED. The scheduler is now a pg-boss cron job whose `0 3 * * *`
 * expression handles the 03:00 UTC alignment natively (Pattern 2 — the
 * former "ms until next 03:00" initial-delay plus a 24h repeating timer
 * are gone). The per-cycle running-flag mutex (Pitfall 8) is removed too:
 * pg-boss's native SKIP LOCKED job dedup supersedes both the overlap guard
 * and the distributed lock (D-02 one-way door). When pg-boss is
 * unavailable (`getBoss() === null`), the init function logs a warn and
 * returns early — there is NO fallback timer (D-02). The server still
 * boots and REST/SSE work normally; only the cron job is offline.
 */
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getSetting } from "./systemConfigService";
import { logEvent } from "./eventLogService";
import { getBoss, createQueue, schedule } from "./jobQueue";

// D-01 — hardcoded, NOT a config key (prevents misconfiguration from
// shrinking grace below the soft-delete lead time). Surfaced in audit
// metadata as `graceDays: 7`.
const GRACE_PERIOD_DAYS = 7;
const GRACE_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 86_400_000;

// Phase 165 (D-04/D-05): queue name (underscores, not colons — pg-boss 12.28
// assertQueueName rejects ":"); mirrors the Phase 161 lock resource namespace;
// cron expression is the daily 03:00 UTC cadence the former timer honoured
// functionally via an "ms until next 03:00" delay plus a 24h repeat
// (verified valid via cron-parser — pg-boss uses the same validation,
// default tz='UTC').
const QUEUE_NAME = "reaper_chat-message";
const CRON_EXPRESSION = "0 3 * * *";

/**
 * D-04/D-05/D-15: run one reaper cycle.
 *
 * Returns counts for observability:
 *   - `softDeleted`: rows tombstoned by Pass 1 (0 when retention is OFF)
 *   - `hardPurged`:  rows deleted by Pass 2 (runs regardless of retention)
 *
 * Phase 165 (Pitfall 8): the per-cycle running-flag mutex has been REMOVED.
 * pg-boss delivers one job at a time and its SKIP LOCKED dedup supersedes
 * the in-process guard; concurrent manual invocations from tests now both
 * run (the guard was dead code under the pg-boss delivery model).
 */
export async function runReaperCycle(): Promise<{ softDeleted: number; hardPurged: number }> {
  const now = new Date();

  // D-15 — read config every tick. null/""/non-numeric/<=0 → null (Pass 1 no-op).
  const setting = await getSetting("chat_message_retention_days");
  const raw = setting.value;
  const parsed = raw ? Number(raw) : NaN;
  const retentionDays =
    Number.isFinite(parsed) && parsed > 0 ? parsed : null;

  // Pass 1 (D-04): soft-delete old messages of ACTIVE chats only.
  // The `chat: { deletedAt: null }` relation filter is load-bearing
  // (SEED-004c) — trashed-chat messages are NOT touched here.
  let softDeleted = 0;
  if (retentionDays !== null) {
    const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
    const r1 = await prisma.chatMessage.updateMany({
      where: {
        deletedAt: null,
        createdAt: { lt: cutoff },
        chat: { deletedAt: null },
      },
      data: { deletedAt: now },
    });
    softDeleted = r1.count;
  }

  // Pass 2 (D-05): hard-purge tombstoned rows past grace. NO `chat`
  // relation filter (matches SEED-002 SQL verbatim). Runs REGARDLESS of
  // retention config (D-15) — a tombstoned row past grace is purged even
  // when retention is OFF (honours explicit deletion, T-84-02-T7).
  //
  // Phase 97 (MEM-04 D-07 — Pitfall 3 no orphan PII): query the IDs BEFORE
  // delete so we can cascade-purge derived Memories and audit the count. The
  // FK `Memory.sourceMessageId` `onDelete: Cascade` already guarantees no
  // orphan PII at the DB level; the explicit `Memory.deleteMany` is
  // defense-in-depth + GDPR audit trail (we need the count for the audit).
  const graceCutoff = new Date(now.getTime() - GRACE_MS);
  const toPurge = await prisma.chatMessage.findMany({
    where: { deletedAt: { not: null, lt: graceCutoff } },
    select: { id: true },
  });
  const purgedIds = toPurge.map((m) => m.id);
  let memoryPurged = 0;
  if (purgedIds.length > 0) {
    const r2 = await prisma.chatMessage.deleteMany({ where: { id: { in: purgedIds } } });
    const memoryResult = await prisma.memory.deleteMany({ where: { sourceMessageId: { in: purgedIds } } });
    memoryPurged = memoryResult.count;
    const hardPurged = r2.count;
    // D-13/D-14 — audit every tick (including no-op ticks).
    await logEvent("chat", "system", "reaper.run", null, {
      softDeleted,
      hardPurged,
      memoryPurged,
      retentionDays,
      graceDays: GRACE_PERIOD_DAYS,
    });
    // MEM-04 SC1 — explicit memory.reaper.purge audit when Memory rows cascaded.
    if (memoryPurged > 0) {
      await logEvent("memory", "system", "reaper.purge", null, { memoryPurged });
    }
    if (softDeleted > 0 || hardPurged > 0) {
      logger.info("[chat-message-reaper] Cycle complete", {
        softDeleted,
        hardPurged,
        memoryPurged,
        retentionDays,
      });
    }
    return { softDeleted, hardPurged };
  }
  const hardPurged = 0;
  // D-13/D-14 — audit every tick (including no-op ticks).
  await logEvent("chat", "system", "reaper.run", null, {
    softDeleted,
    hardPurged,
    memoryPurged: 0,
    retentionDays,
    graceDays: GRACE_PERIOD_DAYS,
  });
  if (softDeleted > 0 || hardPurged > 0) {
    logger.info("[chat-message-reaper] Cycle complete", {
      softDeleted,
      hardPurged,
      retentionDays,
    });
  }

  return { softDeleted, hardPurged: 0 };
}

/**
 * Phase 165 (Q-02/Q-03): Register the chat-message reaper as a pg-boss
 * cron job.
 *
 * Replaces the former daily-alignment timer (a one-shot delay until the
 * next 03:00 plus a 24h repeating timer), the cycle-internal running-flag
 * overlap guard (Pitfall 8), and the distributed-lock wrap with:
 * `createQueue` → `schedule` → `boss.work`. The `0 3 * * *` cron
 * expression handles the 03:00 UTC alignment natively (Pattern 2 — no
 * "ms until next 03:00" delay). pg-boss's native SKIP LOCKED job dedup
 * supersedes both the overlap guard and the distributed lock (D-02
 * one-way door — no fallback timer).
 *
 * D-02 graceful degradation: when `getBoss() === null` (Postgres
 * unreachable), this logs a warn and returns early — no
 * `process.exit`, no fallback timer. The server boots and REST/SSE
 * work; only this cron job is offline.
 *
 * Pitfall 1: `createQueue` MUST precede `schedule` (the schedule
 * references the queue by name — foreign-key constraint).
 * Pitfall 2: the `boss.work` handler receives a `Job[]` array, NOT a
 * single job — iterate with `for...of`.
 * Pitfall 3: the work handler catches cycle errors and logs them
 * (resolve = success, no re-throw → no pg-boss retry storm).
 */
export async function initChatMessageReaperScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[chat-message-reaper] pg-boss unavailable — scheduler offline (D-02)");
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
        logger.info("[chat-message-reaper] Starting reaper cycle...");
        const summary = await runReaperCycle();
        logger.info(
          `[chat-message-reaper] Cycle complete: ${summary.softDeleted} soft-deleted, ${summary.hardPurged} hard-purged`,
        );
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        logger.error("[chat-message-reaper] Reaper cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  logger.info(`[chat-message-reaper] Reaper scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}