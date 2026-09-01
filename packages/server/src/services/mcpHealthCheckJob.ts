// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP Health-Check Job — periodically tests connectivity to installed+enabled
 * MCP connections and updates McpCatalogEntry health status in the database.
 *
 * Uses pg-boss cron scheduling (Phase 165) to poll every 30 minutes. Each ping
 * uses a lightweight Client + SSEClientTransport (skips full tool discovery).
 * Implements D-03 exponential backoff retry logic (1s, 2s, 4s) and three-tier
 * staleness detection (healthy -> stale -> down).
 *
 * Phase 165 (Q-02/Q-03): the in-process timer, overlap guard, and
 * distributed-lock wrap have been REMOVED. The scheduler is now
 * a pg-boss cron job: `createQueue` + `schedule` + `boss.work` registration at
 * boot, with pg-boss's native SKIP LOCKED job dedup supersededing both the
 * overlap guard and the distributed lock (D-02 one-way door). When pg-boss is
 * unavailable (`getBoss() === null`), the init function logs a warn and
 * returns early — there is NO fallback timer (D-02).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "./jobQueue";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Lightweight connectivity-only ping to an MCP server.
 * Creates a Client, connects via SSE transport, then closes.
 * Does NOT call listTools() — just verifies the SSE transport is reachable.
 *
 * @param url - The MCP server URL to test
 * @param headers - Optional HTTP headers for the SSE request
 * @param timeoutMs - Timeout in milliseconds (default: 10000)
 * @returns { ok: true } on success, { ok: false, error } on failure
 */
export async function pingMCPServer(
  url: string,
  headers?: Record<string, string>,
  timeoutMs: number = 10000,
): Promise<{ ok: boolean; error?: string }> {
  let client: Client | null = null;
  let transport: SSEClientTransport | null = null;

  try {
    const transportOptions =
      headers && Object.keys(headers).length > 0
        ? { requestInit: { headers: new Headers(headers) } }
        : undefined;

    transport = new SSEClientTransport(new URL(url), transportOptions);
    client = new Client(
      { name: "simmetric-chat-health-check", version: "0.1.0" },
      { capabilities: {} },
    );

    // Race connection against a timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs),
    );

    await Promise.race([client.connect(transport), timeoutPromise]);

    return { ok: true };
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message || "Unknown connection error",
    };
  } finally {
    // Always attempt to close, ignore errors on already-failed connections
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ─── Retry-with-Backoff Helpers ────────────────────────────────────────────

interface PingRetryResult {
  succeeded: boolean;
  /** Combined error messages from all failed retries, joined with "; " */
  lastError: string | null;
}

/**
 * Ping a server with up to 3 retries and exponential backoff (1s, 2s, 4s).
 * Returns { succeeded: true } if ANY retry succeeds.
 * Returns { succeeded: false } only if ALL 3 retries fail.
 */
async function pingWithRetries(
  url: string,
  headers?: Record<string, string>,
): Promise<PingRetryResult> {
  const errors: string[] = [];

  // Attempt 1 (immediate)
  const r1 = await pingMCPServer(url, headers);
  if (r1.ok) return { succeeded: true, lastError: null };
  errors.push(r1.error || "ping failed");

  // Backoff 1s before attempt 2
  await delay(1000);
  const r2 = await pingMCPServer(url, headers);
  if (r2.ok) return { succeeded: true, lastError: null };
  errors.push(r2.error || "ping failed");

  // Backoff 2s before attempt 3
  await delay(2000);
  const r3 = await pingMCPServer(url, headers);
  if (r3.ok) return { succeeded: true, lastError: null };
  errors.push(r3.error || "ping failed");

  return {
    succeeded: false,
    lastError: errors.join("; "),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Health-Check Cycle ────────────────────────────────────────────────────

/**
 * Run a full health-check cycle against all installed+enabled MCP connections.
 *
 * For each connection, pings with up to 3 retries (1s, 2s, 4s delays per D-03).
 * The retry-exhausted outcome drives staleness counter updates on McpCatalogEntry:
 *   - Retry-exhausted success → reset to "healthy", counter = 0
 *   - Retry-exhausted failure, 0 prior failures → "stale", counter = 1
 *   - Retry-exhausted failure, 1 prior failure → still "stale", counter = 2
 *   - Retry-exhausted failure, 2+ prior failures → "down", counter increments
 *
 * @returns Summary counts of { healthy, stale, down }
 */
export async function runHealthCheckCycle(): Promise<{
  healthy: number;
  stale: number;
  down: number;
}> {
  let healthy = 0;
  let stale = 0;
  let down = 0;

  // Only query installed+enabled connections that are linked to a catalog entry
  const connections = await prisma.mCPConnection.findMany({
    where: { enabled: true, catalogEntryId: { not: null } },
    select: {
      id: true,
      name: true,
      url: true,
      headers: true,
      catalogEntryId: true,
    },
  });

  for (const conn of connections) {
    // Guard: skip entries with no catalogEntryId (should not happen due to query filter, but belt-and-suspenders)
    if (!conn.catalogEntryId) continue;

    try {
      // Parse headers from JSON string
      let parsedHeaders: Record<string, string> | undefined;
      try {
        if (conn.headers) {
          const parsed = JSON.parse(conn.headers);
          if (
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            Object.keys(parsed).length > 0
          ) {
            parsedHeaders = parsed;
          }
        }
      } catch {
        // Invalid JSON — proceed without custom headers
      }

      // Retry-with-backoff ping (D-03)
      const retryResult = await pingWithRetries(conn.url, parsedHeaders);

      // Fetch current catalog entry state
      const entry = await prisma.mcpCatalogEntry.findUnique({
        where: { id: conn.catalogEntryId },
      });
      if (!entry) continue;

      const currentFailures = entry.consecutiveFailures || 0;
      const now = new Date();

      if (retryResult.succeeded) {
        // Retry-exhausted success: reset to healthy
        await prisma.mcpCatalogEntry.update({
          where: { id: conn.catalogEntryId },
          data: {
            healthStatus: "healthy",
            lastHealthCheck: now,
            lastHealthError: null,
            consecutiveFailures: 0,
          },
        });
        healthy++;
      } else {
        // Retry-exhausted failure: apply staleness transitions
        const newFailures = currentFailures + 1;

        if (currentFailures === 0) {
          // First failure cycle → transition to stale
          await prisma.mcpCatalogEntry.update({
            where: { id: conn.catalogEntryId },
            data: {
              healthStatus: "stale",
              lastHealthCheck: now,
              lastHealthError: retryResult.lastError,
              consecutiveFailures: 1,
            },
          });
          stale++;
        } else if (currentFailures === 1) {
          // Second consecutive failure → stay stale, counter = 2
          await prisma.mcpCatalogEntry.update({
            where: { id: conn.catalogEntryId },
            data: {
              lastHealthCheck: now,
              lastHealthError: retryResult.lastError,
              consecutiveFailures: 2,
            },
          });
          stale++;
        } else {
          // currentFailures >= 2 → third+ consecutive failure → "down"
          await prisma.mcpCatalogEntry.update({
            where: { id: conn.catalogEntryId },
            data: {
              healthStatus: "down",
              lastHealthCheck: now,
              lastHealthError: retryResult.lastError,
              consecutiveFailures: newFailures,
            },
          });
          down++;
        }
      }
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      // Per-connection try/catch: a single bad entry does not abort the cycle
      logger.error("[mcp-health] Failed to health-check connection", {
        connectionId: conn.id,
        connectionName: conn.name,
        error: message,
      });
    }
  }

  return { healthy, stale, down };
}

// ─── Scheduler ─────────────────────────────────────────────────────────────

// Phase 165 (D-04/D-05): queue name (underscores, not colons — pg-boss 12.28
// assertQueueName rejects ":"); mirrors the Phase 161 lock resource namespace;
// cron expression is the 30-minute cadence the former timer used (verified
// valid via cron-parser — pg-boss uses the same validation).
const QUEUE_NAME = "healthcheck_mcp";
const CRON_EXPRESSION = "*/30 * * * *";

/**
 * Phase 165 (Q-02/Q-03): Register the MCP health-check as a pg-boss cron job.
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
export async function initMCPHealthCheckScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[mcp-health] pg-boss unavailable — scheduler offline (D-02)");
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
        logger.info("[mcp-health] Starting health-check cycle...");
        const result = await runHealthCheckCycle();
        logger.info(
          `[mcp-health] Cycle complete: ${result.healthy} healthy, ${result.stale} stale, ${result.down} down`,
        );
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        const message = err instanceof Error ? err.message : String(err);
        logger.error("[mcp-health] Health-check cycle failed", {
          error: message,
        });
      }
    }
  });

  logger.info(`[mcp-health] Health-check scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}
