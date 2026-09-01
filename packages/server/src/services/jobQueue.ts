// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// pg-boss job-queue singleton service (Phase 164, SCALE-04).
//
// Mirrors the module-level singleton pattern from `redisService.ts`
// (initAttempted guard, null-when-unavailable, on("error") handler):
//
//   - D-01: pg-boss receives the `DATABASE_URL` connection string directly and
//     manages its OWN `pg.Pool` (default `max: 10`). It does NOT touch the
//     Prisma adapter's internal pool, and it does NOT implement the Prisma
//     `db` interface. The two pools are intentionally separate so Prisma and
//     pg-boss never share connection-accounting state.
//   - D-02: pg-boss uses its DEFAULT `pgboss` schema (no custom name). `start()`
//     auto-creates + auto-migrates the schema — this is NOT a Prisma migration
//     and does not affect `pnpm audit:migrations`.
//   - D-05: if Postgres is unreachable, `start()` throws; the try/catch logs an
//     error, leaves `bossInstance = null`, and returns normally. The server
//     continues booting (REST/SSE unaffected). `getBoss() === null` is the
//     graceful-degradation contract — Phase 165 callers check null and fall
//     back to `setInterval` (same shape as `getRedis() === null`).
//
// Phase 164 is FOUNDATION ONLY: `schedule()` and `createQueue()` are exported
// as thin delegators for Phase 165 to call, but are NOT invoked in this phase
// (scope fence — see 164-01-PLAN.md prohibitions).

import { PgBoss } from "pg-boss";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

let bossInstance: PgBoss | null = null;
let initAttempted = false;

/**
 * Start the pg-boss job queue. Constructs `new PgBoss(getEnv().DATABASE_URL)`,
 * registers the `error` event handler (logs at `warn` — pg-boss errors are
 * operational, not fatal; the queue retries internally), and awaits
 * `boss.start()` which auto-creates + auto-migrates the `pgboss` schema.
 *
 * Idempotent: a second call returns early once `initAttempted` is true (mirrors
 * `redisService.ts`).
 *
 * Graceful degradation (D-05): on any failure (PG unreachable, schema error,
 * etc.) the catch logs at `error`, sets `bossInstance = null`, and returns
 * normally. This function NEVER throws and NEVER calls `process.exit` — the
 * job queue is a scale feature, not a boot-critical dependency.
 */
export async function startJobQueue(): Promise<void> {
  if (initAttempted) return;
  initAttempted = true;

  try {
    const boss = new PgBoss(getEnv().DATABASE_URL);
    boss.on("error", (err: Error) => {
      // pg-boss errors are operational (connection drops, schema drift). The
      // queue retries internally — log at warn, never crash the server.
      logger.warn("[jobQueue] pg-boss error", { error: err.message });
    });
    boss.on("stopped", () => {
      logger.info("[jobQueue] pg-boss stopped event");
    });
    await boss.start(); // auto-creates + auto-migrates the pgboss schema
    bossInstance = boss;
    logger.info("[jobQueue] pg-boss started");
  } catch (err: unknown) {
    logger.error("[jobQueue] pg-boss start failed — job scheduling unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    bossInstance = null;
  }
}

/**
 * Returns the singleton `PgBoss` instance, or `null` when the queue has not
 * been started, failed to start (PG unavailable), or has already been stopped.
 * Phase 165 callers check `getBoss() === null` and fall back to `setInterval`.
 */
export function getBoss(): PgBoss | null {
  return bossInstance;
}

/**
 * Gracefully drain in-flight jobs and stop the queue (D-04).
 *
 * Calls `boss.stop({ graceful: true, timeout: 4500 })` — the 4.5s timeout
 * leaves a 500ms buffer for the rest of the 5s graceful-shutdown race at
 * `index.ts` (Promise.race against a 5s hard timeout). The call is null-safe:
 * a no-op when the queue was never started or has already been stopped.
 *
 * After stopping, `bossInstance` is reset to `null` so a second call is a
 * no-op (matches the `distributedLock.ts` null-guard-on-release pattern).
 */
export async function stopJobQueue(): Promise<void> {
  if (!bossInstance) return;
  try {
    await bossInstance.stop({ graceful: true, timeout: 4500 });
    logger.info("[jobQueue] pg-boss stopped");
  } catch (err: unknown) {
    logger.warn("[jobQueue] pg-boss stop failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    bossInstance = null;
  }
}

/**
 * Validate a queue name against pg-boss 12.28's `assertQueueName` charset
 * ([a-zA-Z0-9_-./]). pg-boss's AssertionError escapes as an unhandled
 * rejection at boot (uncaughtException from a promise), so the guard here
 * fails fast with an actionable message instead (Q-02 fix: colon-named
 * queues like "healthcheck:mcp" crash the server).
 */
function assertValidQueueName(name: string): void {
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(name)) {
    throw new Error(
      `[jobQueue] invalid queue name "${name}" — pg-boss only allows ` +
        `alphanumerics, underscores, hyphens, periods, and slashes. ` +
        `Use "_" instead of ":" (e.g. "healthcheck_mcp").`,
    );
  }
}

/**
 * Thin delegator to `boss.schedule(name, cron, data)`. Throws if the queue is
 * unavailable (Phase 165 callers should guard with `getBoss() !== null` first
 * when graceful degradation is desired). Phase 164 does NOT call this.
 *
 * NOTE (RESEARCH Pitfall 7): the queue `name` must exist first — call
 * `createQueue(name)` before `schedule(name, ...)`.
 */
export async function schedule(
  name: string,
  cron: string,
  data?: object | null,
): Promise<void> {
  assertValidQueueName(name);
  const boss = getBoss();
  if (!boss) {
    throw new Error("[jobQueue] pg-boss not available — cannot schedule");
  }
  await boss.schedule(name, cron, data);
}

/**
 * Thin delegator to `boss.createQueue(name)`. Phase 165 calls this before
 * `schedule(name, ...)` (RESEARCH Pitfall 7: a schedule references a queue by
 * name; the queue must exist first). Phase 164 does NOT call this.
 */
export async function createQueue(name: string): Promise<void> {
  assertValidQueueName(name);
  const boss = getBoss();
  if (!boss) {
    throw new Error("[jobQueue] pg-boss not available — cannot create queue");
  }
  await boss.createQueue(name);
}