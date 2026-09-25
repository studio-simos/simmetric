// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP OAuth Refresh Job (Phase 195, MCPO-01 D-12/D-13) — proactive pg-boss
 * cron that refreshes expiring OAuth tokens every 5 minutes.
 *
 * Copied from the mcpReaperJob.ts idiom (Phase 165): createQueue → schedule →
 * boss.work, getBoss() === null → warn + early return (NO fallback timer —
 * D-12, same D-02 posture as the reaper: connections still work, refresh
 * just doesn't preempt, and the reactive 401 arm covers it).
 *
 * Concurrency (D-12): every per-connection refresh is wrapped in the
 * EXISTING withConnectionLock mutex — concurrent refreshes of the same
 * connection serialize; no new lock primitive.
 *
 * Phase 185 D-09 doctrine (Pitfall 8): jobs run OUTSIDE the request ALS —
 * org is resolved FROM THE ROW (never the ambient tenant-context read);
 * ambient reads in jobs are bugs. Disposition: PLATFORM-LEVEL CROSS-ORG BY
 * DESIGN — runOAuthRefreshCycle selects rows by COLUMN PREDICATES ONLY
 * (authType="oauth", tokenExpiresAt window) across all orgs (token expiry
 * prevention is platform-wide) and writes by PK. MCPConnection rows carry
 * organizationId but no operation here is org-scoped.
 *
 * Failure semantics (D-13): a failed refresh flips oauthStatus="error" +
 * oauthError immediately — NO strike counter; the stale token keeps the tool
 * path alive until it 401s (reactive arm); the cron retries next cycle
 * (self-healing). Per-connection try/catch: one bad row never aborts the
 * cycle.
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "./jobQueue";
import { connectMCPServer, withConnectionLock } from "../agent/mcpClient";
import { resolveProvider, hasClientConfigured, resolveScopes } from "./oauthProviderRegistry";
import { decryptTokenBlob, encryptTokenBlob, refreshAccessToken } from "./oauthTokenLifecycle";
import { getEnv } from "../config/env";

// Phase 195 (D-12): queue name (hyphen legal per the jobQueue charset regex
// /^[a-zA-Z0-9_.\-/]+$/ — NEVER colons, Pitfall 7); cron expression is the
// 5-minute cadence from D-12.
const QUEUE_NAME = "mcp-oauth-refresh";
const CRON_EXPRESSION = "*/5 * * * *";

/** Refresh window: connections whose token expires within 5 minutes. */
const REFRESH_WINDOW_MS = 5 * 60_000;

/**
 * Refresh ONE connection's token (the withConnectionLock body). Per the
 * reaper's per-connection contract, this NEVER throws — every failure path
 * either returns silently (row flipped to error) or logs. Returns true when
 * the token was refreshed.
 */
async function refreshConnection(row: {
  id: string;
  oauthProvider: string | null;
  oauthScopes: string | null;
  credentialsEncrypted: string | null;
}): Promise<boolean> {
  const providerId = row.oauthProvider ?? "";

  // Provider def + client must exist (D-06 gate).
  const def = providerId ? resolveProvider(providerId) : null;
  if (!def || !hasClientConfigured(providerId)) {
    await prisma.mCPConnection.update({
      where: { id: row.id },
      data: { oauthStatus: "error", oauthError: "provider client not configured" },
    });
    return false;
  }

  // Decrypt the existing blob — refresh needs the refreshToken.
  if (!row.credentialsEncrypted) {
    await prisma.mCPConnection.update({
      where: { id: row.id },
      data: { oauthStatus: "error", oauthError: "no stored OAuth credentials — re-authorize required" },
    });
    return false;
  }
  const decoded = decryptTokenBlob(row.credentialsEncrypted);
  if (!decoded.ok || !decoded.blob.refreshToken) {
    await prisma.mCPConnection.update({
      where: { id: row.id },
      data: { oauthStatus: "error", oauthError: "no refresh token available — re-authorize the connection" },
    });
    return false;
  }

  const env = getEnv();
  const clientId = providerId === "google" ? env.GOOGLE_CLIENT_ID ?? "" : env.MICROSOFT_CLIENT_ID ?? "";
  const clientSecret = providerId === "google" ? env.GOOGLE_CLIENT_SECRET ?? "" : env.MICROSOFT_CLIENT_SECRET ?? "";

  const result = await refreshAccessToken(def, {
    refreshToken: decoded.blob.refreshToken,
    clientId,
    clientSecret,
    // The row's stored scopes only — never an amplifiable input (T-195-02).
    scopes: resolveScopes(def, row.oauthScopes ?? undefined),
  });

  if (!result.ok) {
    // D-13: immediate surfacing — oauthStatus=error + oauthError. NO strike
    // counter; the stale token keeps the tool path alive until it 401s.
    // Log provider + status only (T-195-05 — never token material).
    await prisma.mCPConnection.update({
      where: { id: row.id },
      data: { oauthStatus: "error", oauthError: result.errorDescription },
    });
    logger.error("[mcp-oauth-refresh] refresh failed", { connectionId: row.id, provider: providerId });
    return false;
  }

  // Re-encrypt the CURRENT-key blob (rotation chain rides decrypt — spec
  // §9-5); tokenExpiresAt advanced from expires_in (~1h for both providers).
  const tokenExpiresAt = new Date(Date.parse(result.blob.obtainedAt) + 3600 * 1000);
  await prisma.mCPConnection.update({
    where: { id: row.id },
    data: {
      credentialsEncrypted: encryptTokenBlob(result.blob),
      tokenExpiresAt,
      oauthStatus: "authorized",
      oauthError: null,
    },
  });

  // Fire-and-forget reconnect kick (reaper precedent :160-178 — the fresh
  // token reaches the transport without blocking the cycle; a failing
  // external MCP server never breaks the cycle).
  connectMCPServer(row.id).catch((err: unknown) => {
    logger.warn("[mcp-oauth-refresh] reconnect kick failed", {
      connectionId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return true;
}

/**
 * D-12: Run one refresh cycle — testable unit. Selects oauth connections
 * whose tokenExpiresAt falls inside the 5-minute window by COLUMN PREDICATES
 * ONLY (no ambient tenant context — org-from-the-ROW, Pitfall 8), wraps each
 * refresh in withConnectionLock (the EXISTING per-connection mutex —
 * concurrent refreshes of the same connection serialize; this is the
 * concurrency-edge guarantee, no new lock primitive), and isolates failures
 * per-connection (one bad row never aborts the cycle).
 */
export async function runOAuthRefreshCycle(): Promise<{ candidates: number; refreshed: number; failed: number }> {
  // PLATFORM-LEVEL CROSS-ORG BY DESIGN (mcpReaperJob doctrine, :39-48):
  // token-expiry prevention is platform-wide; the cycle iterates ALL orgs'
  // expiring oauth connections by column predicates and writes by PK, outside
  // the request ALS.
  const expiring = await prisma.mCPConnection.findMany({
    where: {
      authType: "oauth",
      tokenExpiresAt: { lt: new Date(Date.now() + REFRESH_WINDOW_MS) },
    },
  });

  let refreshed = 0;
  let failed = 0;

  for (const row of expiring) {
    try {
      // D-12: withConnectionLock serializes concurrent refreshes of the same
      // connection (the reactive 401 arm and this cron contend on the same
      // mutex — no double-refresh race).
      const ok = await withConnectionLock(row.id, () => refreshConnection(row));
      if (ok) refreshed += 1;
      else failed += 1;
    } catch (err: unknown) {
      // Per-connection isolation: one bad row never aborts the cycle.
      failed += 1;
      logger.warn("[mcp-oauth-refresh] connection refresh threw", {
        connectionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { candidates: expiring.length, refreshed, failed };
}

/**
 * D-12: Register the OAuth refresh cron as a pg-boss job — copied from the
 * mcpReaperJob.ts scheduler idiom (createQueue → schedule → boss.work).
 *
 * - getBoss() === null → warn + return, NO fallback timer (D-12/D-02
 *   posture — pg-boss unavailable means the proactive refresh is offline;
   * the reactive 401 arm still covers token expiry).
 * - Pitfall 1: createQueue MUST precede schedule (FK-by-name).
 * - Pitfall 2: the boss.work handler receives a Job[] array — for...of.
 * - Pitfall 3: cycle errors are caught and logged — NEVER re-thrown
 *   (pg-boss retry-storm guard).
 */
export async function initMCPOAuthRefreshScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-12: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[mcp-oauth-refresh] pg-boss unavailable — scheduler offline (D-12)");
    return;
  }

  await createQueue(QUEUE_NAME);
  // Idempotent upsert (pg-boss ON CONFLICT DO UPDATE) — safe on every boot.
  await schedule(QUEUE_NAME, CRON_EXPRESSION);

  await boss.work(QUEUE_NAME, async (jobs) => {
    for (const _job of jobs) {
      try {
        const summary = await runOAuthRefreshCycle();
        if (summary.candidates > 0) {
          logger.info(
            `[mcp-oauth-refresh] Cycle complete: ${summary.candidates} candidate(s), ${summary.refreshed} refreshed, ${summary.failed} failed`,
          );
        }
      } catch (err: unknown) {
        // Log + resolve (success) — do NOT re-throw. Re-throwing would make
        // pg-boss retry the job and could cause a retry storm.
        logger.error("[mcp-oauth-refresh] cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  logger.info(`[mcp-oauth-refresh] scheduler registered (pg-boss cron: ${CRON_EXPRESSION})`);
}