// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-02 Task 2, D-09/D-10/D-11/D-18/D-19/D-20) — the message
// router: the platform-independent heart of the external-connector pipeline.
//
// Pipeline order is FIXED (D-11):
//   parse guards (private-only) → /start welcome → dedup (first DB write) →
//   session resolve → per-session lock → rate limit (rolling window) →
//   non-text guard → typing (D-19) → connectorChatService → reply → out log
//
// Inbound rows (ConnectorMessage direction "in") are the FIRST DB write of
// the pipeline — the @@unique([connectorId, platformMessageId]) constraint is
// BOTH the dedup arbiter and the analytics log (D-11, spec §7.2-3). A P2002
// on that insert is an EXPECTED FLOW (already-processed duplicate, P-9): the
// message is skipped SILENTLY — no reply, no error log, no health flip.
//
// Per-session ordering (D-09): withSessionLock is the withConnectionLock
// pattern (mcpClient.ts:96-117) keyed `${connectorId}:${platformUserId}` —
// messages from the SAME external user process strictly sequentially;
// different users run in parallel. Single-instance v1 assumption (in-process
// Map; the optional Redis scale layer is NOT a dependency, repo rule).

import prisma from "../../utils/prisma";
import { logger } from "../../utils/logger";
import { getAdapter } from "./registry";
import type { IncomingMessage, ConnectorPipelineRow } from "./base";
import { resolveSession } from "./sessionResolver";
import { runConnectorChatTurn } from "./connectorChatService";

// ===== Constants (the agent's discretion, D-18/D-19/D-12 defaults) =====

/** Widget hourly parity default (internalWidget.ts:666) — D-10. */
const DEFAULT_RATE_LIMIT = 20;

/** Rolling rate-limit window (P-6): the counter resets 1h after lastResetAt. */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * WR-02 daily-limit window: a rolling 24h window on the ConnectorMessage
 * in-row log (D-08: no state outside the DB — the append-only log IS the
 * daily counter; restart-safe, unlike an in-memory marker). Enforced inside
 * the D-09 lock, before the hourly check.
 */
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Session daily limit reached reply (WR-02 — mirrors the D-10 throttle shape). */
const SESSION_LIMIT_REACHED_TEXT =
  "You've reached your message limit for today. Please try again tomorrow.";

/** Telegram typing TTL — re-send once past ~5s of in-flight turn (D-19). */
const TYPING_RESEND_MS = 5000;

/** Session TTL (D-08): rides the same counter update. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** /start welcome default (sensible EN default; connector column wins). */
const WELCOME_DEFAULT =
  "Hello! I'm your assistant. Send me a question and I'll answer from the knowledge base.";

/** Non-text-only politeness fallback (D-18: never a silent ignore). */
const ATTACHMENTS_NOT_SUPPORTED =
  "Attachments are not supported in this version — please send your question as text.";

/** Agent-failure fallback default (mirrors the Widget default, D-12). */
const FALLBACK_DEFAULT = "I don't have an answer for that. Please contact us for more help.";

/** Rate-limit throttled reply (D-10). */
const LIMIT_REACHED_TEXT =
  "You've reached the message limit for now. Please try again a bit later.";

// ===== D-09: per-session ordered queue =====

/**
 * D-09: the chain-tail Map — the withConnectionLock pattern (mcpClient.ts:
 * 96-117) keyed `${connectorId}:${platformUserId}`. Each entry is the
 * in-flight gate Promise for that session; a message for the same key awaits
 * the prior gate (ordering only, not the prior result) before running.
 * Deleted in the finally block — no leak across messages.
 */
const sessionLocks = new Map<string, Promise<void>>();

/**
 * D-09: Serialize an async operation against a (connectorId, platformUserId)
 * session. Same-key messages process strictly sequentially; different keys
 * proceed concurrently. Errors in the prior operation do NOT poison the
 * queue (ordering-only guarantee — the swallowed catch).
 */
export async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = sessionLocks.get(key);
  if (existing) {
    await existing.catch(() => {
      // Swallow — we only need the ordering guarantee, not the prior result.
    });
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionLocks.set(key, gate);
  try {
    return await fn();
  } finally {
    release();
    sessionLocks.delete(key);
  }
}

/**
 * D-09 key: `${connectorId}:${platformUserId}` — the ONLY unit of
 * serialization. Different users (or connectors) never serialize.
 */
export function sessionKey(connectorId: string, platformUserId: string): string {
  return `${connectorId}:${platformUserId}`;
}

// ===== D-10: throttled limit-reply window flags =====

/**
 * Module-level, single-instance v1 (D-10): sessionId → timestamp of the last
 * "limit reached" notification. The flag rides the rolling window: a reset
 * of lastResetAt (P-6) invalidates the flag. In-memory is the widget-parity
 * v1 choice (spec §7.2-4 single-instance assumption).
 */
const limitNotifiedWindows = new Map<string, number>();

/** Clear the throttle flags (tests only — module Maps persist across tests). */
export function resetLimitNotifications(): void {
  limitNotifiedWindows.clear();
}

// ===== Pipeline =====

/**
 * The FIXED pipeline (D-11 order — proven by messageRouter.test.ts):
 *  1. non-private chatType → silent return (NO row, NO counters — D-18)
 *  2. /start → welcome path (resolveSession + welcomeMessage + in-row, NO agent — D-18)
 *  3. dedup insert ConnectorMessage(in) — FIRST DB write; P2002 → silent skip (P-9)
 *  4. resolveSession (inside the lock — D-09 serializes same-key resolves)
 *  5. rate limit (rolling window reset P-6 → check → throttled reply max 1/window — D-10)
 *  6. increment counters + TTL refresh (D-08 rides the same update)
 *  7. non-text-only → politeness fallback (D-18)
 *  8. typing indicator (D-19) → connectorChatService → reply → out-row (D-11)
 *  9. agent failure → fallbackMessage + healthStatus error, stays ENABLED (D-12/D-20)
 */
export async function handleIncomingMessage(
  connector: ConnectorPipelineRow,
  msg: IncomingMessage
): Promise<void> {
  // (1) D-18 private-only guard — group/supergroup/channel updates are
  // dropped at the parse boundary BEFORE dedup/session/agent: no DB write,
  // no counter churn, no reply (T-198-07 prompt-injection mitigation).
  if (msg.chatType !== "private") {
    return;
  }

  // (2) D-18 /start command: welcome path — NO agent run.
  if (msg.isCommand === "start" || msg.text === "/start") {
    await handleStart(connector, msg);
    return;
  }

  // Dedup insert: (connectorId, platformMessageId) unique. A null
  // platformMessageId skips dedup semantics naturally in Postgres (D-11).
  // The session row must exist first (the in-row carries sessionId), so
  // resolution precedes the dedup insert; the RESOLVE itself is idempotent
  // (a TTL-refreshing update, not a message counter) so a replayed update
  // re-resolving is safe.
  let session: Awaited<ReturnType<typeof resolveSession>>;
  try {
    session = await resolveSession(connector, msg.platformUserId, msg.platformUserName);
  } catch (err: unknown) {
    logPipelineError("session resolution failed", connector.id, err);
    await failHealth(connector, `session resolution failed: ${errString(err)}`);
    return;
  }

  // (3) D-11 dedup — the in-row is the first pipeline WRITE. P2002 on THIS
  // insert only = already-processed → skip SILENTLY (P-9: no reply, no error
  // log, no health flip).
  try {
    await prisma.connectorMessage.create({
      data: {
        connectorId: connector.id,
        sessionId: session.id,
        direction: "in",
        platformMessageId: msg.platformMessageId,
        charCount: msg.text?.length ?? 0,
      },
    });
  } catch (err: unknown) {
    if (isP2002(err)) {
      return;
    }
    logPipelineError("inbound message persist failed", connector.id, err);
    await failHealth(connector, `inbound persist failed: ${errString(err)}`);
    return;
  }

  // (3b) Phase 199 (OQ-1 option (b), D-04): the created-flag welcome arm —
  // a FIRST DM from a NEW Discord platform user gets the connector welcome
  // and consumes THIS message's reply budget (no agent run that turn). The
  // arm is DISCORD-GATED (D-04's recorded scope): /start does not exist on
  // Discord, so the created flag is Discord's only first-contact signal —
  // Telegram keeps its command-shaped /start arm byte-identical (the platform
  // gate precedes the flag branch, so the 198 E2E matrix is untouched).
  // Guard rails: the arm keys on the returned flag (no extra session-exists
  // pre-query, no TOCTOU window); a replayed first message P2002-skips at
  // dedup ABOVE before the arm runs; created is false on every refresh /
  // expired-recreate resolve, so a welcome can never re-send.
  if (session.created === true && connector.platform === "discord") {
    try {
      const text = connector.welcomeMessage ?? WELCOME_DEFAULT;
      await sendAndLogReply(connector, session.id, msg.platformUserId, text);
      logger.debug("[connectors] discord first-DM welcome sent", { connectorId: connector.id });
    } catch (err: unknown) {
      // handleStart parity: a welcome-send failure flips health (D-20 —
      // adapter errors map to healthStatus='error'; the connector stays
      // ENABLED) and logs — the pipeline never crashes on it.
      logPipelineError("discord welcome send failed", connector.id, err);
      await failHealth(connector, `discord welcome failed: ${errString(err)}`);
    }
    return; // welcome owns the first contact — no agent turn for THIS message
  }

  // (4)-(9): everything downstream is serialized per session (D-09) —
  // same-key messages never interleave agent calls.
  await withSessionLock(sessionKey(connector.id, msg.platformUserId), async () => {
    // 198-04 (Rule 1, D-10 correctness under the fire-and-forget webhook
    // arm): resolveSession ran OUTSIDE the lock, so N concurrent messages
    // for the same session each captured the SAME stale messageCount — the
    // limit check inside the lock then saw only its own +1 and the 21st
    // message never tripped. Re-read the counter INSIDE the lock (the D-09
    // serialization point) so the window arithmetic observes every
    // same-session increment that already landed.
    const freshCount = await prisma.connectorSession.findUnique({
      where: { id: session.id },
      select: { messageCount: true, lastResetAt: true },
    });
    if (freshCount) {
      session = {
        ...session,
        messageCount: freshCount.messageCount,
        lastResetAt: freshCount.lastResetAt,
      };
    }

    // (5) Rolling-window reset BEFORE the check (P-6 — the widget has no
    // reset; the connector defines the window explicitly, D-10).
    const now = Date.now();
    if (now - session.lastResetAt.getTime() >= RATE_WINDOW_MS) {
      await prisma.connectorSession.update({
        where: { id: session.id },
        data: { messageCount: 0, lastResetAt: new Date() },
      });
      session = { ...session, messageCount: 0, lastResetAt: new Date(now) };
      limitNotifiedWindows.delete(session.id); // fresh window → fresh throttle flag
    }

    // (5) Rate limit: widget hourly parity 20/h default + connector override
    // (D-10). The inbound row is ALREADY persisted (step 3 — D-10 contract:
    // the inbound message is still persisted + logged, just not forwarded).
    //
    // Tri-state translation (CR-01, widget precedent
    // widget/middleware/rateLimit.ts:111-116): a stored 0 means UNLIMITED per
    // the schema contract (connector.schema.ts:53-58) — express-rate-limit
    // blocks all on max=0, and `messageCount >= 0` would blackout every
    // message, so 0 → Infinity (the agent is always reached, no limit reply).
    const rawLimit = connector.rateLimitPerMinute;
    const limit =
      rawLimit === 0 ? Number.POSITIVE_INFINITY : (rawLimit ?? DEFAULT_RATE_LIMIT);
    if (session.messageCount >= limit) {
      const notifiedAt = limitNotifiedWindows.get(session.id);
      // `>=` (not `>`): a notification timestamped in the same millisecond as
      // the window start is still within this window (clock-resolution safe).
      const alreadyNotified =
        notifiedAt !== undefined && notifiedAt >= session.lastResetAt.getTime();
      if (!alreadyNotified) {
        await sendAndLogReply(connector, session.id, msg.platformUserId, LIMIT_REACHED_TEXT);
        limitNotifiedWindows.set(session.id, now);
      }
      return; // never forwarded to the agent (D-10)
    }

    // (5b) sessionLimitPerDay enforcement — previously accepted +
    // persisted but never read (dead admin knob). Rolling 24h window over
    // the ConnectorMessage in-row log (restart-safe, D-08). Stored 0 =
    // UNLIMITED (CR-01 lesson — never repeat the blackout hazard) and
    // short-circuits BEFORE the count query.
    // WR-03 (code review 199): the window is PER-SESSION (sessionId filter) —
    // the knob's name and the throttle-flag key are session-scoped, so the
    // count must be too; a connector-wide count would make user B's budget
    // user A's shared pool.
    const rawDaily = connector.sessionLimitPerDay;
    if (rawDaily !== null && rawDaily !== undefined && rawDaily !== 0) {
      const inRowsLast24h = await prisma.connectorMessage.count({
        where: {
          sessionId: session.id,
          direction: "in",
          createdAt: { gt: new Date(now - DAY_WINDOW_MS) },
        },
      });
      if (inRowsLast24h >= rawDaily) {
        const notifiedAt = limitNotifiedWindows.get(`${session.id}:daily`);
        if (notifiedAt === undefined || notifiedAt < now - DAY_WINDOW_MS) {
          await sendAndLogReply(
            connector,
            session.id,
            msg.platformUserId,
            SESSION_LIMIT_REACHED_TEXT
          );
          limitNotifiedWindows.set(`${session.id}:daily`, now);
        }
        return; // never forwarded to the agent
      }
    }

    // (6) Increment counters + rolling TTL refresh (D-08 rides the same
    // update).
    await prisma.connectorSession.update({
      where: { id: session.id },
      data: {
        messageCount: { increment: 1 },
        lastMessageAt: new Date(),
        expiresAt: new Date(now + 24 * 60 * 60 * 1000),
      },
    });
    session = { ...session, messageCount: session.messageCount + 1 };

    // (7) D-18 non-text-only guard: photo/voice/document without usable text
    // gets the politeness fallback + the in-row (persisted in step 3) —
    // never a silent ignore (the user must know the bot heard them).
    if (!msg.text || msg.text.trim() === "") {
      await sendAndLogReply(connector, session.id, msg.platformUserId, ATTACHMENTS_NOT_SUPPORTED);
      return;
    }

    // (8) D-19 typing coordinator + agent turn (D-12 fallback ownership).
    await runAgentTurn(connector, session, msg);
  });
}

// ===== /start welcome path (D-18) =====

/**
 * D-18 /start: resolve the session (so the persistent Chat exists for
 * continuity), persist the in-row (dedup applies — a replayed /start is
 * skipped like any duplicate), send the welcome message, log the out-row,
 * and NEVER invoke the agent.
 */
async function handleStart(
  connector: ConnectorPipelineRow,
  msg: IncomingMessage
): Promise<void> {
  try {
    const session = await resolveSession(connector, msg.platformUserId, msg.platformUserName);

    try {
      await prisma.connectorMessage.create({
        data: {
          connectorId: connector.id,
          sessionId: session.id,
          direction: "in",
          platformMessageId: msg.platformMessageId,
          charCount: msg.text?.length ?? 0,
        },
      });
    } catch (err: unknown) {
      if (isP2002(err)) return; // duplicate /start — silent skip (P-9)
      throw err;
    }

    const text = connector.welcomeMessage ?? WELCOME_DEFAULT;
    await sendAndLogReply(connector, session.id, msg.platformUserId, text);
    logger.debug("[connectors] welcome sent", { connectorId: connector.id });
  } catch (err: unknown) {
    logPipelineError("welcome path failed", connector.id, err);
    await failHealth(connector, `welcome failed: ${errString(err)}`);
  }
}

// ===== D-19 typing coordinator + agent turn (D-12 fallback ownership) =====

/**
 * D-19: single-shot typing BEFORE the agent run, plus AT MOST ONE mid-run
 * re-send if the turn is still in flight after ~5s (Telegram's typing TTL).
 * The timer is cleared in a finally — it can NEVER fire after completion.
 * Typing-send failures are logged at DEBUG only: the indicator is an
 * auxiliary affordance and must never fail the turn.
 *
 * The adapter method is existence-guarded (pre-198-03 no adapter is
 * registered, and `getAdapter()` fails closed — D-03).
 */
async function runAgentTurn(
  connector: ConnectorPipelineRow,
  session: Awaited<ReturnType<typeof resolveSession>>,
  msg: IncomingMessage
): Promise<void> {
  const adapter = getAdapter(connector.platform);
  const canType = typeof adapter?.sendTypingIndicator === "function";
  const sendTyping = async (): Promise<void> => {
    if (canType) {
      try {
        await adapter!.sendTypingIndicator(connector, msg.platformUserId);
      } catch (err: unknown) {
        // D-19 auxiliary affordance — debug level, never fails the turn.
        logger.debug("[connectors] typing indicator failed (ignored)", {
          error: errString(err),
        });
      }
    }
  };

  let resendFired = false; // at-most-one re-send guard (D-19)
  let resendTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Single-shot BEFORE the run (D-19).
    await sendTyping();

    const turn = runConnectorChatTurn(connector, session, msg.text!);

    // Mid-run re-send timer: fire ONCE if the turn is still in flight after
    // ~5s; cleared in the finally below so it can never fire after
    // completion (D-19: no repeat loop).
    resendTimer = setTimeout(() => {
      if (!resendFired) {
        resendFired = true;
        void sendTyping();
      }
    }, TYPING_RESEND_MS);

    const result = await turn;

    // D-12: an empty reply is a failure path — same fallback semantics as a
    // thrown agent error (connectorChatService already throws on empty, this
    // belt-and-braces guard covers adapter-shaped results too).
    if (!result.replyText || result.replyText.trim() === "") {
      throw new Error("agent returned an empty response");
    }

    // Reply (adapter owns splitting/formatting, Plan 03).
    await sendAndLogReply(connector, session.id, msg.platformUserId, result.replyText);
  } catch (err: unknown) {
    // (9) D-12/D-20: agent failure → fallback message + health flip; the
    // connector STAYS ENABLED (never auto-disable).
    logPipelineError("agent turn failed", connector.id, err);
    try {
      await sendAndLogReply(
        connector,
        session.id,
        msg.platformUserId,
        connector.fallbackMessage ?? FALLBACK_DEFAULT
      );
    } catch (sendErr: unknown) {
      logPipelineError("fallback send failed", connector.id, sendErr);
    }
    await failHealth(connector, `agent turn failed: ${errString(err)}`);
  } finally {
    // D-19: the timer can NEVER fire after completion.
    if (resendTimer) {
      clearTimeout(resendTimer);
      resendTimer = undefined;
    }
  }
}

// ===== Reply + logging helpers (D-11 out-rows) =====

/**
 * Send via the fail-closed adapter lookup (D-03) and log the ConnectorMessage
 * out-row (D-11) with the platform message id when the send provides one.
 * The out-row failure is analytics-only — it never fails the user-visible
 * reply (logged, swallowed).
 */
async function sendAndLogReply(
  connector: ConnectorPipelineRow,
  sessionId: string,
  platformUserId: string,
  text: string
): Promise<void> {
  const adapter = getAdapter(connector.platform);
  if (!adapter) {
    logger.warn("[connectors] no adapter registered for platform — reply dropped", {
      platform: connector.platform,
    });
    return;
  }
  try {
    const sent = await adapter.sendMessage(connector, platformUserId, text);
    try {
      await prisma.connectorMessage.create({
        data: {
          connectorId: connector.id,
          sessionId,
          direction: "out",
          platformMessageId: sent?.platformMessageId ?? null,
          charCount: text.length,
        },
      });
    } catch (logErr: unknown) {
      if (!isP2002(logErr)) {
        logPipelineError("outbound log failed", connector.id, logErr);
      }
    }
  } catch (err: unknown) {
    logPipelineError("platform send failed", connector.id, err);
    throw err;
  }
}

// ===== Health flip (D-12/D-20) =====

/**
 * D-12/D-20: agent/adapter failure → healthStatus='error' + lastError
 * persisted; the connector STAYS ENABLED (no isEnabled touch — auto-disable
 * is rejected, spec default).
 */
async function failHealth(connector: { id: string }, errorMessage: string): Promise<void> {
  try {
    await prisma.chatConnector.update({
      where: { id: connector.id },
      data: { healthStatus: "error", lastError: errorMessage.slice(0, 500) },
    });
  } catch (err: unknown) {
    logPipelineError("health flip failed", connector.id, err);
  }
}

// ===== Error helpers =====

function isP2002(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002"
  );
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logPipelineError(context: string, connectorId: string, err: unknown): void {
  logger.error(`[connectors] ${context}`, {
    connectorId,
    error: errString(err),
  });
}