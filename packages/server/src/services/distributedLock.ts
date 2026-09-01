// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Distributed lock service (TEC-03d, D-04) — redlock-based replacement for the
 * Phase 104-03 hand-rolled SET NX EX + Lua lock, extracted from
 * backupSchedulerService.ts.
 *
 * Phase 180 dead-code sweep: the backup-mutex half of this module
 * (acquireBackupMutex / releaseBackupMutex / acquireRedisLock /
 * releaseRedisLock) was REMOVED — its importers moved to the enterprise
 * plugin with the Phase 146 backup extraction, and the enterprise package
 * carries its own createBackupMutex implementation. Only
 * withDistributedLock survives (used by scripts/smoke-multi-instance.ts
 * and the reapers) plus the getRedlock() singleton it depends on.
 *
 * Heartbeat (OQ3 / T-121-06):
 *  - Reaper bodies use withDistributedLock → redlock.using() auto-extension.
 *
 * T-121-07 (Pitfall 6): with retryCount 0, ResourceLockedError is EXPECTED on
 * every contended acquire — the redlock "error" listener ignores it and logs
 * only non-busy errors, so no warning storm.
 */

import Redlock, { ResourceLockedError, ExecutionError } from "redlock";
import { logger } from "../utils/logger";
import { getRedis } from "./redisService";

/**
 * Redlock 5.0.0-beta.2 surfaces a CONTENDED acquire (retryCount 0) as an
 * `ExecutionError` whose per-attempt stats' `votesAgainst` carry the
 * underlying `ResourceLockedError` — the classic error type is only thrown
 * inside `_attemptOperationOnClient` and then aggregated into the
 * ExecutionError. A ResourceLockedError vote means the operation was applied
 * to 0 resources because ANOTHER instance holds the lock — the skip contract.
 * A connection failure surfaces as a different error class and MUST rethrow.
 * (Phase 124-01 smoke-multi-instance A3 uncovered the gap: the Phase 121 unit
 * tests mocked redlock and never exercised the real ExecutionError path.)
 */
async function isResourceLocked(err: unknown): Promise<boolean> {
  if (err instanceof ResourceLockedError) return true;
  if (err instanceof ExecutionError && Array.isArray(err.attempts) && err.attempts.length > 0) {
    const stats = await Promise.all(err.attempts);
    return (
      stats.length > 0 &&
      stats.every(
        (st) =>
          st.votesAgainst.size > 0 &&
          [...st.votesAgainst.values()].every((e) => e instanceof ResourceLockedError),
      )
    );
  }
  return false;
}

// ─── Redlock singleton ───────────────────────────────────────────────────────

let redlockInstance: Redlock | null = null;
let redlockInitAttempted = false;

/**
 * Lazy singleton Redlock over the shared getRedis() connection. Returns null
 * when Redis is absent (graceful degradation — callers fall back to
 * in-process/PG behavior). retryCount 0 = skip-on-busy, no queueing (D-04).
 * Intentionally not exported — internal dependency of withDistributedLock
 * (Phase 180 sweep).
 */
function getRedlock(): Redlock | null {
  if (redlockInitAttempted) return redlockInstance;
  redlockInitAttempted = true;

  const redis = getRedis();
  if (!redis) return null;

  const instance = new Redlock([redis], {
    driftFactor: 0.01,
    retryCount: 0,
    retryDelay: 200,
    retryJitter: 200,
    automaticExtensionThreshold: 500,
  });

  // T-121-07 (Pitfall 6): ResourceLockedError is EXPECTED with retryCount 0
  // and must not be logged as a warning storm; everything else is logged.
  instance.on("error", (err: Error) => {
    if (err instanceof ResourceLockedError) return;
    logger.warn("[distributed-lock] redlock error", { error: err.message });
  });

  redlockInstance = instance;
  return redlockInstance;
}

/**
 * Run `routine` under a distributed lock on `resource` for `durationMs`.
 * Returns null ONLY on ResourceLockedError (another instance holds the lock —
 * skip). When Redis is absent, runs the routine locally (the caller's
 * isRunning / PG fallbacks stay authoritative).
 *
 * Uses redlock.using() — auto-extension heartbeat (Pitfall 2): while the
 * routine runs, redlock extends the lock and sets the AbortSignal on
 * extension failure.
 */
export async function withDistributedLock<T>(
  resource: string,
  durationMs: number,
  routine: (signal: AbortSignal & { error?: Error }) => Promise<T>,
): Promise<T | null> {
  const redlock = getRedlock();
  if (!redlock) {
    // Local run — no distributed lock available. The caller's own guards
    // (isRunning, PG mutex) remain authoritative in single-instance mode.
    return routine({ aborted: false } as AbortSignal & { error?: Error });
  }
  try {
    return await redlock.using([resource], durationMs, { retryCount: 0 }, routine);
  } catch (err: unknown) {
    // T-121-07: retryCount 0 makes a contended acquire throw ExecutionError
    // (with the ResourceLockedError inside attempts[].stats.votesAgainst).
    // Both map to the documented "skip — another instance holds the lock"
    // null contract. Any other error rethrows.
    if (await isResourceLocked(err)) return null;
    throw err;
  }
}
