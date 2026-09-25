// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-03 Task 3, D-15/D-16/D-20, P-7/P-10, T-198-12/13) — the
// connector poll scheduler.
//
// ONE shared setInterval ticker per process (NOT a timer per connector —
// the 25s in-flight long-poll would overlap N ticks; NOT pg-boss — a
// sub-minute cadence is not cron-shaped). Per tick it iterates the enabled
// polling-mode telegram connectors SEQUENTIALLY and skips any whose
// per-connector isRunning flag is set — a 25s long-poll in flight skips
// re-entrant ticks without blocking other connectors (D-15).
//
// Per connector: decrypt token/config → adapter.pollUpdates(offset) →
// route each update through the SAME handleIncomingMessage pipeline as the
// webhook arm (D-16) → advance pollOffset = lastUpdateId + 1 (BigInt —
// no int32 truncation at the update-id horizon) + stamp lastPollAt after
// the batch (D-01).
//
// HEALTH (D-20, inline flip only): a poll error increments a per-connector
// in-memory counter; beyond 3 CONSECUTIVE errors → healthStatus 'error' +
// lastError (method + description only, T-198-10); ANY successful poll
// resets the counter and flips 'healthy'. The connector is NEVER
// auto-disabled (no isEnabled=false write on errors — D-20). A Telegram 409
// webhook-conflict (P-7) rides the same threshold path — no frantic retry
// loop.
//
// Placement: initConnectorPollScheduler() is called in index.ts NEXT TO
// initOcrPipelineScheduler — the dev+prod cluster, OUTSIDE the
// NODE_ENV==="production" pg-boss block (P-10: the poller must be alive in
// dev too).

import prisma from "../../utils/prisma";
import { logger } from "../../utils/logger";
import { getEnv } from "../../config/env";
import { getAdapter } from "./registry";
import { handleIncomingMessage } from "./messageRouter";
import type { ConnectorPipelineRow, IncomingMessage, PollBatch } from "./base";

/** Consecutive-error threshold before healthStatus flips to 'error' (D-15 discretion). */
const ERROR_THRESHOLD = 3;

/** The Telegram platform name (D-15: polling is Telegram-only in 198). */
const TELEGRAM_PLATFORM = "telegram";

/**
 * Per-connector in-flight guard (D-15): connectorId → boolean. A connector
 * whose long-poll is still in flight skips re-entrant ticks; other
 * connectors poll independently.
 */
const pollInFlight = new Map<string, boolean>();

/**
 * Per-connector consecutive-error counters (D-20): connectorId → count.
 * In-memory (the health STATE persists in the DB; the counter is just the
 * flip trigger — a restart resets the count, which is safe: the next
 * success flips healthy, the next failure re-accumulates).
 */
const pollErrorCounts = new Map<string, number>();

/** The module-level ticker handle (stopConnectorPollScheduler clears it). */
let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * The connector-row shape the poller consumes: the full ChatConnector row
 * carries pollOffset (BigInt) + botTokenEncrypted + configEncrypted — the
 * adapter decrypts per call.
 */
type PollableConnector = ConnectorPipelineRow & {
  pollOffset: bigint;
  botTokenEncrypted: string | null;
  configEncrypted: string | null;
  pollMode: string;
  isEnabled: boolean;
};

/** Clear the module Maps + stop the ticker (tests only / graceful shutdown). */
export function resetConnectorPollState(): void {
  pollInFlight.clear();
  pollErrorCounts.clear();
}

/**
 * D-15: start the ONE shared poll scheduler. Idempotent (a second init is a
 * logged no-op — index.ts calls it once, but tests/boot-reloads must not
 * stack tickers).
 */
export function initConnectorPollScheduler(): void {
  if (ticker) {
    logger.debug("[connectors] poll scheduler already initialized — skipping");
    return;
  }
  const intervalMs = getEnv().CONNECTOR_POLL_INTERVAL_MS;
  ticker = setInterval(() => {
    void tick();
  }, intervalMs);
  logger.info("[connectors] poll scheduler initialized", { intervalMs });
}

/**
 * D-15 (additive safety): stop the ticker (graceful shutdown — index.ts
 * calls this; the ocr/synthesis inline schedulers have no stop, the poller's
 * handle is a 25s-long-poll safety so a shutdown does not leave a dangling
 * in-flight poll loop).
 */
export function stopConnectorPollScheduler(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
    logger.info("[connectors] poll scheduler stopped");
  }
}

/** One ticker pass: iterate enabled polling-mode connectors sequentially. */
async function tick(): Promise<void> {
  try {
    const connectors = (await prisma.chatConnector.findMany({
      where: {
        platform: TELEGRAM_PLATFORM,
        isEnabled: true,
        deletedAt: null,
        pollMode: "polling",
      },
    })) as unknown as PollableConnector[];

    for (const connector of connectors) {
      if (pollInFlight.get(connector.id)) {
        // 25s long-poll still in flight — skip this re-entrant tick for
        // THIS connector only (D-15; other connectors keep polling).
        continue;
      }
      pollInFlight.set(connector.id, true);
      // Fire-and-forget per connector with the guard released in finally —
      // a slow long-poll for connector A never delays connector B.
      void pollConnector(connector).finally(() => {
        pollInFlight.delete(connector.id);
      });
    }
  } catch (err: unknown) {
    // A tick-level failure (DB outage) is logged and retried next tick —
    // the scheduler itself never crashes (ocr-scheduler precedent).
    logger.error("[connectors] poll scheduler tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Poll ONE connector: adapter.pollUpdates(offset) → route each update
 * through handleIncomingMessage (D-16 — the same pipeline as webhook) →
 * advance pollOffset to lastUpdateId + 1 (BigInt) + stamp lastPollAt (D-01).
 * Health flip per D-20 on the per-connector error counter.
 */
async function pollConnector(connector: PollableConnector): Promise<void> {
  const adapter = getAdapter(connector.platform);
  if (!adapter || typeof adapter.pollUpdates !== "function") {
    // Fail-closed (D-03): no adapter registered — nothing to poll. Not an
    // error (the registry is process-global); logged once per tick.
    return;
  }

  try {
    const batch = await adapter.pollUpdates(connector);
    // WR-06 shape support: adapters may return a bare message array (legacy
    // test fakes) or the { messages, maxUpdateId } batch — normalize here so
    // the cursor advance below always has a batch-wide max available.
    const legacyMessages = Array.isArray(batch)
      ? (batch as (IncomingMessage & { updateId?: bigint })[])
      : null;
    const messages = legacyMessages ?? (batch as PollBatch).messages;
    const batchMaxUpdateId = legacyMessages ? null : (batch as PollBatch).maxUpdateId;

    // Route each update through the SAME pipeline as the webhook arm (D-16).
    // A per-message failure (dedup, agent, fallback) is owned INSIDE
    // handleIncomingMessage (D-12 single error owner) — it must not abort
    // the batch's offset advance (the update is already consumed on the
    // platform side once getUpdates returned it).
    for (const message of messages) {
      try {
        await handleIncomingMessage(connector, message);
      } catch (err: unknown) {
        logger.error("[connectors] inbound message failed (poll arm)", {
          connectorId: connector.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // D-01/D-15/D-13: advance the offset to lastUpdateId + 1 (BigInt
    // arithmetic — no int32 truncation at the update-id horizon) and stamp
    // lastPollAt after the batch.
    //
    // WR-06: the cursor max rides the ADAPTER's batch-wide maxUpdateId
    // (computed over ALL returned update_ids BEFORE the private-filter) —
    // the per-message max below only fills in when an older-shape adapter
    // returns a bare array.
    let lastUpdateId: bigint | null = null;
    if (batchMaxUpdateId !== null && batchMaxUpdateId !== undefined) {
      lastUpdateId = batchMaxUpdateId;
    } else {
      for (const m of messages) {
        if (m.updateId !== undefined && (lastUpdateId === null || m.updateId > lastUpdateId)) {
          lastUpdateId = m.updateId;
        }
      }
    }
    const nextOffset = lastUpdateId !== null ? lastUpdateId + 1n : connector.pollOffset;
    await prisma.chatConnector.update({
      where: { id: connector.id },
      data: {
        pollOffset: nextOffset,
        lastPollAt: new Date(),
      },
    });

    // D-20: ANY successful poll resets the counter AND flips healthy.
    pollErrorCounts.delete(connector.id);
    await markHealthy(connector.id);
  } catch (err: unknown) {
    // T-198-10: the error text carries method + description only (the
    // TelegramApiError shape) — never the token.
    const description = err instanceof Error ? err.message : String(err);
    const count = (pollErrorCounts.get(connector.id) ?? 0) + 1;
    pollErrorCounts.set(connector.id, count);

    if (count >= ERROR_THRESHOLD) {
      // D-20: flip healthStatus 'error' + lastError. The connector STAYS
      // ENABLED (no isEnabled write — auto-disable is rejected, D-20).
      // P-7: a 409 webhook-conflict lands here too — the threshold keeps
      // it a throttled health flip, not a frantic retry loop.
      await prisma.chatConnector
        .update({
          where: { id: connector.id },
          data: {
            healthStatus: "error",
            lastError: description.slice(0, 500),
          },
        })
        .catch((dbErr: unknown) => {
          logger.error("[connectors] health flip failed", {
            connectorId: connector.id,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        });
      logger.warn("[connectors] poll error threshold reached — health flipped", {
        connectorId: connector.id,
        consecutiveErrors: count,
        error: description,
      });
    } else {
      // Below the threshold: log, no flip (the connector may recover on its
      // own — e.g. a transient 5xx).
      logger.debug("[connectors] poll error (below threshold)", {
        connectorId: connector.id,
        consecutiveErrors: count,
        error: description,
      });
    }
  }
}

/**
 * D-20: the next successful interaction flips 'healthy'. Cheap idempotent
 * write per successful poll (only when the row is not already healthy).
 */
async function markHealthy(connectorId: string): Promise<void> {
  try {
    await prisma.chatConnector.updateMany({
      where: { id: connectorId, healthStatus: { not: "healthy" } },
      data: { healthStatus: "healthy", lastError: null },
    });
  } catch (err: unknown) {
    logger.error("[connectors] healthy flip failed", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}