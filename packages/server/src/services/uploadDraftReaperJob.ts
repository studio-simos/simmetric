// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Upload Draft Reaper Job — Phase 69 (DST-05, D-69-07).
 *
 * Periodically sweeps `UploadDraft` rows whose `expiresAt` is in the past,
 * soft-deletes them (`deletedAt = now()`), and best-effort unlinks their
 * staged file from `storage/uploads/drafts/`. Completed drafts
 * (`parseStatus = "done"`) are excluded — their files belong to the
 * Document/Archive lifecycle (Invariant 2).
 *
 * Trust boundary: the cleanup path. The A5 prefix guard is reborn in key
 * space via `isDraftStorageKey` (Phase 184 D-08): the new-layout arm's
 * trailing-sep rule (`…/uploads/drafts/`) prevents a `drafts-evil`
 * sibling-prefix match (Pitfall 5 / T-69-05) and the legacy arm delegates
 * to `isDraftsPath` — backfilled rows keep the exact A5 resolve semantics
 * (path.resolve + trailing path.sep). The guard is load-bearing even though
 * the key is server-generated (never client-controllable, D-06): a DB
 * corruption scenario still cannot escape the drafts contract (T-184-11).
 *
 * Idempotency: the soft-delete (`prisma.uploadDraft.update({ deletedAt })`)
 * runs BEFORE the best-effort `fs.unlinkSync`. A failed unlink is logged
 * but does not roll back the soft-delete — the row is already marked and
 * will not be re-selected on the next cycle (T-69-05e).
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
import { getBoss, createQueue, schedule } from "./jobQueue";
import { getSetting } from "./systemConfigService";
import { getStorageProvider } from "./storageProvider";
import { isDraftStorageKey } from "../utils/fileUtils";

// Phase 165 (D-04/D-05): queue name (underscores, not colons — pg-boss 12.28
// assertQueueName rejects ":"); mirrors the Phase 161 lock resource namespace;
// cron expression is the daily 03:00 UTC cadence the former timer honoured
// functionally via an "ms until next 03:00" delay plus a 24h repeat
// (verified valid via cron-parser — pg-boss uses the same validation,
// default tz='UTC').
// 260829-kkn: the cron is now configurable via the upload_draft_reaper_cron
// system-config key; DEFAULT_CRON_EXPRESSION is the fallback used when the
// configured value is invalid or empty (never crash boot — warn + default).
const QUEUE_NAME = "reaper_upload-draft";
const DEFAULT_CRON_EXPRESSION = "0 3 * * *";

/**
 * D-69-07 / Pitfall 5: run one reaper cycle.
 *
 * Selector: `expiresAt < now() AND deletedAt: null AND parseStatus != "done"`.
 * Completed drafts are excluded — their files belong to the Document /
 * Archive lifecycle (Invariant 2).
 *
 * Phase 184 (SAAS-03, D-08): the guard + cleanup are KEY-BASED. The select
 * now carries `storageKey` + `organizationId` so no row is invisible to the
 * sweep (T-184-12); per row, `key = storageKey ?? filePath` and the
 * isDraftStorageKey contract (trailing-sep new-layout arm + isDraftsPath
 * legacy delegation) replaces the inline A5 resolve check — the corrupted-key
 * skip semantics are preserved (rejected key → skipped += 1 + warn log, NO
 * soft-delete, row stays visible for operator triage). Deletion goes through
 * the provider (per-row org resolution — row's-org rule); legacy rows
 * (backfilled path-as-key) resolve through the LocalFS legacy arm — the same
 * path.resolve+unlink today's A5 performed, byte-identical.
 *
 * For each expired draft:
 *   1. Apply the isDraftStorageKey guard. Reject any key outside the
 *      drafts contract (T-69-05 / T-184-11). Skip the row (no soft-delete)
 *      so an operator can inspect the corrupted key value — deleting would
 *      be destructive, soft-deleting would hide the evidence.
 *   2. Soft-delete FIRST (`deletedAt = now()`). If delete fails the row
 *      is still marked and won't be re-selected (idempotent, T-69-05e).
 *   3. Best-effort `provider.delete(key)` (LocalFS delete = existence-checked
 *      unlink — byte-identical legacy behavior; S3 keys delete in the
 *      tenant's bucket). Failure is logged but does not roll back the
 *      soft-delete — the object leak is bounded by the next operator
 *      intervention, but the DB row is correctly marked.
 *
 * Returns counts for observability:
 *   - `reaped`:  soft-deleted AND deleted successfully
 *   - `skipped`: isDraftStorageKey guard rejected the key (no soft-delete)
 *   - `errors`:  soft-deleted but delete failed (best-effort)
 *
 * Phase 165 (Pitfall 8): the per-cycle running-flag mutex has been REMOVED.
 * pg-boss delivers one job at a time and its SKIP LOCKED dedup supersedes
 * the in-process guard; concurrent manual invocations from tests now both
 * run (the guard was dead code under the pg-boss delivery model).
 */
export async function runReaperCycle(): Promise<{ reaped: number; skipped: number; errors: number }> {
  // D-69-07 selector — done drafts excluded (Invariant 2).
  // Phase 184 (T-184-12): the select now carries storageKey + organizationId
  // so every expired row is key-resolvable and provider-cleanable — no row
  // is invisible to the sweep.
  const expired = await prisma.uploadDraft.findMany({
    where: {
      expiresAt: { lt: new Date() },
      deletedAt: null,
      parseStatus: { not: "done" },
    },
    select: { id: true, filePath: true, storageKey: true, organizationId: true },
  });

  let reaped = 0;
  let skipped = 0;
  let errors = 0;

  for (const draft of expired) {
    // Phase 184 (D-08): key = storageKey ?? filePath — backfilled rows carry
    // storageKey = filePath so the fallback covers pre-backfill nulls.
    const key = draft.storageKey ?? draft.filePath;
    if (!isDraftStorageKey(key)) {
      // T-69-05 / T-184-11: the key-space A5 guard rejected. Do NOT
      // soft-delete — the corrupted key must remain visible for operator
      // triage (trailing-sep arm rejects drafts-evil siblings and URL
      // sentinels; the legacy arm rejects non-drafts paths).
      logger.warn("[upload-draft-reaper] A5 prefix guard rejected key", {
        draftId: draft.id,
        key,
      });
      skipped += 1;
      continue;
    }

    // T-69-05e: soft-delete BEFORE delete. If delete fails the row is
    // still marked and won't be re-selected on the next cycle.
    await prisma.uploadDraft.update({
      where: { id: draft.id },
      data: { deletedAt: new Date() },
    });

    try {
      // Row's-org rule: the provider resolves per-row via
      // draft.organizationId. For legacy keys the LocalFS legacy arm
      // resolves the exact physical path today's fs.unlinkSync removed —
      // byte-identical; the existence-checked best-effort delete absorbs
      // the reaper try/catch-warn shape.
      await (await getStorageProvider(draft.organizationId)).delete(key);
      reaped += 1;
    } catch (e) {
      // Best-effort — soft-delete already happened. The disk/object leak is
      // bounded and surfaces in logs for operator follow-up.
      logger.warn("[upload-draft-reaper] delete failed (best-effort)", {
        draftId: draft.id,
        error: (e as Error).message,
      });
      errors += 1;
    }
  }

  if (reaped > 0 || skipped > 0 || errors > 0) {
    logger.info("[upload-draft-reaper] Cycle complete", {
      reaped,
      skipped,
      errors,
    });
  }

  return { reaped, skipped, errors };
}

/**
 * Phase 165 (Q-02/Q-03): Register the upload-draft reaper as a pg-boss
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
 *
 * 260829-kkn: config-driven scheduling. `upload_draft_reaper_enabled`
 * ("true" = enabled, fail-closed) gates registration; `upload_draft_reaper_cron`
 * overrides the cadence (pg-boss validates it — an invalid value logs a warn
 * and falls back to the default, never crashing boot). The disabled path
 * best-effort unschedules any stale pg-boss row from a prior enabled boot
 * (T-KKN-03), and the work handler re-reads the toggle per job (D-15
 * read-every-tick pattern) so a disable takes effect without a restart.
 */
export async function initUploadDraftReaperScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[upload-draft-reaper] pg-boss unavailable — scheduler offline (D-02)");
    return;
  }

  // 260829-kkn: read both reaper knobs from the system-config store
  // (DB > ENV > Default via getSetting). Fail-closed enabled parse — only
  // the literal "true" enables (mirrors the ALLOW_NON_ADMIN_UPLOAD parse
  // in uploadGate.ts); any other value ("false", "", "TRUE", "1") disables.
  const [enabledSetting, cronSetting] = await Promise.all([
    getSetting("upload_draft_reaper_enabled"),
    getSetting("upload_draft_reaper_cron"),
  ]);
  const enabled = enabledSetting.value === "true";
  if (!enabled) {
    logger.info(
      "[upload-draft-reaper] disabled via upload_draft_reaper_enabled — scheduler not registered (removing stale schedule row)",
    );
    // T-KKN-03: clean up a schedule row left by a prior enabled boot so the
    // queue is silent. Best-effort — cleanup failure must never block boot.
    try {
      await boss.unschedule(QUEUE_NAME);
    } catch (err: unknown) {
      logger.warn("[upload-draft-reaper] stale schedule-row cleanup failed (non-blocking)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // 260829-kkn: requested cadence — trim; empty/whitespace falls back to the
  // default (shape validation lives at the schedule seam: pg-boss validates
  // the cron via cron-parser BEFORE persisting, and throws on invalid values).
  const requestedCron = cronSetting.value.trim() || DEFAULT_CRON_EXPRESSION;

  // Pitfall 1: queue must exist before schedule references it by name.
  await createQueue(QUEUE_NAME);
  // Idempotent upsert (pg-boss ON CONFLICT DO UPDATE) — safe on every boot,
  // no handle/idempotency guard needed. T-KKN-01: a rejected schedule means
  // pg-boss's cron-parser deemed the value unusable — warn (naming both the
  // rejected value and the fallback) and retry with the DEFAULT cadence so
  // a corrupted config value can never take down boot.
  let effectiveCron = requestedCron;
  try {
    await schedule(QUEUE_NAME, requestedCron);
  } catch (err: unknown) {
    logger.warn(
      `[upload-draft-reaper] invalid upload_draft_reaper_cron "${requestedCron}" rejected by pg-boss (${err instanceof Error ? err.message : String(err)}) — falling back to default cadence "${DEFAULT_CRON_EXPRESSION}"`,
    );
    effectiveCron = DEFAULT_CRON_EXPRESSION;
    await schedule(QUEUE_NAME, DEFAULT_CRON_EXPRESSION);
  }

  // Pitfall 2: handler receives Job[] array, iterate with for...of.
  await boss.work(QUEUE_NAME, async (jobs) => {
    for (const _job of jobs) {
      try {
        // 260829-kkn: per-job runtime toggle (chatMessageReaperJob D-15
        // read-every-tick pattern — 1 read/day at the default cadence,
        // Redis-cached in prod). Disabling takes effect for the next
        // scheduled job without a restart; not "true" → skip (fail-closed).
        const toggle = await getSetting("upload_draft_reaper_enabled");
        if (toggle.value !== "true") {
          logger.info(
            "[upload-draft-reaper] disabled via upload_draft_reaper_enabled — skipping reaper cycle",
          );
          continue;
        }
        logger.info("[upload-draft-reaper] Starting reaper cycle...");
        const summary = await runReaperCycle();
        logger.info(
          `[upload-draft-reaper] Cycle complete: ${summary.reaped} reaped, ${summary.skipped} skipped, ${summary.errors} errors`,
        );
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        logger.error("[upload-draft-reaper] Reaper cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  logger.info(
    `[upload-draft-reaper] Reaper scheduler registered (pg-boss cron: ${effectiveCron})`,
  );
}