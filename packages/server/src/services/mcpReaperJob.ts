// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP Reaper Job — periodically probes active MCP connections with an in-band
 * `listTools()` call and disconnects stale ones (D-05/D-07, T-63-leak).
 *
 * Rationale: toggle/test cycles and external MCP server restarts can leave a
 * socket in `activeConnections` that has already died on the far end. The
 * reaper closes those stale connections every 5 minutes so the socket pool
 * does not grow unbounded (FD-exhaustion DoS).
 *
 * D-05: the probe is a `listTools()` in-band SDK call — NOT an outbound ping.
 * This avoids opening a new connection to air-gap-sensitive deployments and
 * reuses the already-established Client. Probe failure (throw) OR an empty
 * tool list both indicate a stale/dead connection → disconnect delete-first.
 *
 * D-07: disconnect goes through `disconnectMCPServer` which removes the entry
 * from `activeConnections` BEFORE `client.close()` (delete-first) and is
 * serialized per-connectionId by `withConnectionLock` (D-06). The connection
 * lazily reconnects on the next use.
 *
 * Phase 165 (Q-02/Q-03): the in-process timer, overlap guard, and
 * distributed-lock wrap have been REMOVED. The scheduler is now
 * a pg-boss cron job: `createQueue` + `schedule` + `boss.work` registration at
 * boot, with pg-boss's native SKIP LOCKED job dedup supersededing both the
 * overlap guard and the distributed lock (D-02 one-way door). When pg-boss is
 * unavailable (`getBoss() === null`), the init function logs a warn and
 * returns early — there is NO fallback timer (D-02). The server still
 * boots and REST/SSE work normally; only the 8 cron jobs are offline.
 */
import { disconnectMCPServer, connectMCPServer, getActiveConnectionsSnapshot, withConnectionLock, getActiveConnectionState } from "../agent/mcpClient";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "./jobQueue";

// Phase 165 (D-04/D-05): queue name (underscores, not colons — pg-boss 12.28
// assertQueueName rejects ":"); mirrors the Phase 161 lock resource namespace;
// cron expression is the 5-minute cadence the former timer used (verified valid
// via cron-parser — pg-boss uses the same validation).
const QUEUE_NAME = "reaper_mcp";
const CRON_EXPRESSION = "*/5 * * * *";

/**
 * D-05/D-07: Run one reaper cycle.
 *
 * Iterates a snapshot of `activeConnections` (via `getActiveConnectionsSnapshot`)
 * and, for each connected entry, calls `client.listTools()`.
 *   - throw  → disconnect (delete-first, mutex-guarded)
 *   - empty  → disconnect
 *   - tools  → healthy, leave alone
 *
 * Returns counts for observability. Per-connection try/catch keeps one bad
 * entry from aborting the whole cycle.
 */
export async function runReaperCycle(): Promise<{ probed: number; stale: number }> {
  const snapshot = getActiveConnectionsSnapshot();
  let probed = 0;
  let stale = 0;

  for (const { id, state } of snapshot) {
    // Skip entries that are already flagged disconnected.
    if (!state.connected) continue;

    probed += 1;
    // WR-07: acquire withConnectionLock around the probe so the reaper honors
    // the D-06 invariant ("connect/disconnect/probe acquire the same lock").
    // Without this, a skill's `execute` closure could fire a `callTool` on the
    // same Client while the reaper is mid-`listTools`, and the SDK Client is
    // not documented as safe for concurrent listTools + callTool.
    try {
      const staleDetected = await withConnectionLock(id, async () => {
        // Re-check connected inside the lock: a concurrent disconnect may
        // have torn down the client before we acquired the lock.
        const current = getActiveConnectionState(id);
        if (!current || !current.connected) return false;

        const result = await state.client.listTools();
        const tools = (result?.tools) ?? [];
        if (!tools || tools.length === 0) {
          return true; // empty -> stale
        }
        return false; // healthy
      });

      if (staleDetected) {
        // Empty tool list — treat as stale per D-05.
        logger.warn("[mcp-reaper] Empty tool list, disconnecting stale connection", {
          connectionId: id,
        });
        await disconnectMCPServer(id);
        stale += 1;
      }
      // Healthy: tools present, leave the connection alone.
    } catch (err: unknown) {
      // D-05: probe failure → disconnect delete-first. The mutex inside
      // disconnectMCPServer prevents a concurrent toggle from double-closing.
      logger.warn("[mcp-reaper] Probe failed, disconnecting", {
        connectionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await disconnectMCPServer(id);
        stale += 1;
      } catch (disconnectErr: unknown) {
        // disconnectMCPServer swallows close errors internally, but guard the
        // call itself so the cycle never aborts on a single bad disconnect.
        logger.warn("[mcp-reaper] disconnect after probe failure threw", {
          connectionId: id,
          error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        });
      }
    }
  }

  return { probed, stale };
}

/**
 * Auto-reconnect sweep — complements the reaper (D-05) and startup init
 * (`initializeMCPConnections`). The reaper disconnects stale/dead connections
 * and startup init connects enabled ones once; NEITHER reconnects a reachable
 * connection that was disconnected later (reaper probe failure, transient
 * startup failure, remote server restart). `resolveSkillsForChat` only reads
 * the skill registry populated at connect time, so a disconnected connection
 * silently yields 0 tools to the agent forever — until an admin manually
 * toggles/tests it.
 *
 * This sweep (same 5-min cadence as the reaper) closes that gap: for every
 * enabled connection not currently `connected`, fire-and-forget a
 * `connectMCPServer`. Fire-and-forget is intentional — a dead/slow host must
 * not stall the sweep. `connectMCPServer` is mutex-guarded, idempotent
 * (`ensureConnected` short-circuits an already-healthy connection), and never
 * throws on connect failure (it catches internally → `{ tools: [] }` +
 * `connectionErrors`), so a background rejection here is defensive only.
 */
export async function runReconnectCycle(): Promise<{ candidates: number }> {
  const enabled = await prisma.mCPConnection.findMany({
    where: { enabled: true },
    select: { id: true, name: true },
  });

  let candidates = 0;
  for (const conn of enabled) {
    const state = getActiveConnectionState(conn.id);
    if (state && state.connected) continue; // already healthy — skip
    candidates += 1;
    // Fire-and-forget: dead/slow hosts do not block the sweep or the next cycle.
    connectMCPServer(conn.id)
      .then((r) => {
        if (r.tools.length > 0) {
          logger.info("[mcp-reaper] Reconnected MCP connection", {
            connectionId: conn.id,
            name: conn.name,
            tools: r.tools.length,
          });
        }
      })
      .catch((err: unknown) => {
        logger.warn("[mcp-reaper] Reconnect attempt failed", {
          connectionId: conn.id,
          name: conn.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  if (candidates > 0) {
    logger.info(`[mcp-reaper] Reconnect sweep: ${candidates} enabled connection(s) not connected — reconnect attempted`);
  }
  return { candidates };
}

/**
 * Phase 165 (Q-02/Q-03): Register the MCP reaper as a pg-boss cron job.
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
 * Pitfall 1: `createQueue` MUST precede `schedule` (the schedule references the
 * queue by name — foreign-key constraint).
 * Pitfall 2: the `boss.work` handler receives a `Job[]` array, NOT a single
 * job — iterate with `for...of`.
 * Pitfall 3: the work handler catches cycle errors and logs them (resolve =
 * success, no re-throw → no pg-boss retry storm). Reconnect failures are
 * caught separately so a reconnect error never fails the job.
 */
export async function initMCPReaperScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[mcp-reaper] pg-boss unavailable — scheduler offline (D-02)");
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
        logger.info("[mcp-reaper] Starting reaper cycle...");
        const summary = await runReaperCycle();
        logger.info(
          `[mcp-reaper] Cycle complete: ${summary.probed} probed, ${summary.stale} stale disconnected`,
        );
        // Pitfall 3: separate try/catch so a reconnect failure never fails the
        // pg-boss job (resolve = success, no retry storm).
        try {
          await runReconnectCycle();
        } catch (err: unknown) {
          logger.warn("[mcp-reaper] Reconnect sweep failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        logger.error("[mcp-reaper] Reaper cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  logger.info(`[mcp-reaper] Reaper scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}