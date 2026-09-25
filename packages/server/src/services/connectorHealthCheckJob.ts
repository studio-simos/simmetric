// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Connector Health-Check Job — daily pg-boss cron sweeping every enabled
 * ChatConnector across ALL FOUR platforms (telegram/discord/slack/whatsapp)
 * via the shared single-arg `validateBotToken(token)` adapter contract and
 * flipping ONLY the health fields (Phase 200, D-09 — mirrors
 * mcpHealthCheckJob.ts; NO auto-disable: 198 D-20 overrides spec §4.8, so
 * the sweep NEVER writes isEnabled, D-09).
 *
 * Per-platform notes (INFO-2, Plan 02's pinned arms): slack's auth.test and
 * whatsapp's token-only `GET {base}/me` probe both fit the single-arg
 * signature — the cron needs NO per-platform branching. The whatsapp 24h-
 * window 131047 arm is a SEND-failure path the cron does not exercise (the
 * cron validates tokens, not the 24h window).
 *
 * Phase 165 doctrine (inherited): pg-boss cron via `createQueue` + `schedule`
 * + `boss.work`; when pg-boss is unavailable (`getBoss() === null`), the init
 * function logs a warn and returns early — there is NO fallback timer (D-02),
 * no process.exit. pg-boss stopJobQueue drains the workers at shutdown (no
 * per-scheduler stop, 165 precedent).
 *
 * 185 D-09 (org-from-the-ROW doctrine, mcpHealthCheckJob.ts:29-37 header):
 * jobs run OUTSIDE the request ALS — the sweep resolves everything FROM THE
 * ROW; ambient tenant-context reads in jobs are bugs (Pitfall 8). No secret
 * material is ever logged (tokens/decrypted values never enter a log line —
 * T-198-03 posture).
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "./jobQueue";
import { getAdapter } from "./connectors/registry";
import { decrypt } from "./encryptionService";

// Phase 200 (D-09): queue name underscores-only — assertValidQueueName
// (jobQueue.ts:117-125) rejects ":". Cron cadence daily 04:00 UTC
// (planner discretion per D-09; mcpHealthCheck runs every 30min, this sweep
// is far cheaper per row — a single validateBotToken probe).
const QUEUE_NAME = "healthcheck_connectors";
const CRON_EXPRESSION = "0 4 * * *";

// ─── Health-Check Sweep ────────────────────────────────────────────────────

/**
 * Run one sweep across all enabled non-deleted connectors (ALL FOUR
 * platforms — the where clause carries no platform filter).
 *
 * Per row: adapter lookup (fail-closed skip when unimplemented) → decrypt
 * botToken PER CALL (never cached) → adapter.validateBotToken(token) →
 * success flips healthStatus "healthy" + clears lastError; failure flips
 * "error" + persists lastError. A tokenless row is skipped SILENTLY (no
 * error spam — a polling connector without a token yet is a normal state).
 *
 * NO isEnabled write EVER (no auto-disable — 198 D-20 / D-09): a failed
 * validation flips health only; the admin (or the UI) owns enablement.
 */
export async function runConnectorHealthSweep(): Promise<{
  healthy: number;
  error: number;
  skipped: number;
}> {
  let healthy = 0;
  let error = 0;
  let skipped = 0;

  // Org is resolved FROM THE ROW (185 D-09) — no tenant-context read here.
  // The explicit deletedAt filter rides the where clause (the request-scoped
  // soft-delete extension does NOT apply to job-context reads — absent-store
  // semantics outside ALS).
  const connectors = await prisma.chatConnector.findMany({
    where: { isEnabled: true, deletedAt: null },
  });

  for (const connector of connectors) {
    try {
      // Fail-closed adapter lookup (D-03): an unimplemented platform has no
      // adapter — skip, never crash the sweep.
      const adapter = getAdapter(connector.platform);
      if (!adapter) {
        skipped++;
        continue;
      }

      // Decrypt PER CALL (never cache a decrypted token). A tokenless row is
      // a normal pre-token state (e.g. OAuth connector not yet installed) —
      // skip silently, no error spam.
      const enc = (connector as { botTokenEncrypted?: string | null }).botTokenEncrypted;
      if (!enc || typeof enc !== "string" || enc.length === 0) {
        skipped++;
        continue;
      }
      let token: string;
      try {
        token = decrypt(enc);
      } catch {
        // Un-decryptable token — treat as tokenless (skip, health untouched).
        skipped++;
        continue;
      }

      // The shared single-arg probe (INFO-2): slack auth.test / whatsapp
      // GET {base}/me / telegram getMe / discord GET /users/@me all fit.
      const result = await adapter.validateBotToken(token);
      if (result.valid) {
        await prisma.chatConnector.update({
          where: { id: connector.id },
          data: { healthStatus: "healthy", lastError: null },
        });
        healthy++;
      } else {
        await prisma.chatConnector.update({
          where: { id: connector.id },
          data: { healthStatus: "error", lastError: "token validation failed" },
          // NO isEnabled write — NO auto-disable (198 D-20, D-09).
        });
        error++;
      }
    } catch (err: unknown) {
      // Per-row try/catch: one failing row does not abort the sweep
      // (mcpHealthCheckJob per-connection doctrine). Message only — no
      // secret material ever reaches a log (T-198-03).
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[connector-health] Failed to health-check connector", {
        connectorId: connector.id,
        platform: connector.platform,
        error: message,
      });
      skipped++;
    }
  }

  return { healthy, error, skipped };
}

// ─── Scheduler ─────────────────────────────────────────────────────────────

/**
 * Register the connector health-check as a pg-boss cron job (D-09, mirroring
 * initMCPHealthCheckScheduler :316-351).
 *
 * D-02 graceful degradation: when `getBoss() === null` (pg-boss unavailable),
 * this logs a warn and returns early — NO fallback timer, NO process.exit.
 * The server boots and REST/SSE work; only this cron is offline.
 *
 * Pitfall 1: `createQueue` MUST precede `schedule` (the schedule references
 * the queue by name — foreign-key constraint).
 * Pitfall 2: the `boss.work` handler receives a `Job[]` array, NOT a single
 * job — iterate with `for...of`.
 * Pitfall 3: the work handler catches sweep errors and logs them (resolve =
 * success, no re-throw → no pg-boss retry storm).
 */
export async function initConnectorHealthCheckScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[connector-health] pg-boss unavailable — scheduler offline (D-02)");
    return;
  }

  // Pitfall 1: queue must exist before schedule references it by name.
  await createQueue(QUEUE_NAME);
  // Idempotent upsert (pg-boss ON CONFLICT DO UPDATE) — safe on every boot.
  await schedule(QUEUE_NAME, CRON_EXPRESSION);

  // Pitfall 2: handler receives Job[] array, iterate with for...of.
  await boss.work(QUEUE_NAME, async (jobs) => {
    for (const _job of jobs) {
      try {
        const result = await runConnectorHealthSweep();
        logger.info(
          `[connector-health] Cycle complete: ${result.healthy} healthy, ${result.error} error, ${result.skipped} skipped`,
        );
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        const message = err instanceof Error ? err.message : String(err);
        logger.error("[connector-health] Health-check cycle failed", {
          error: message,
        });
      }
    }
  });

  logger.info(`[connector-health] Health-check scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}