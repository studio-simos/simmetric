// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-02 Task 1, D-08) — the connector session resolver.
//
// Resolves (or creates) the ConnectorSession for a (connectorId,
// platformUserId) pair and its PERSISTENT Chat — chat continuity per
// external user (D-08). NO sessionToken exists on the model (schema 198-01):
// resolution is entirely server-side from the unique pair, mirroring how the
// pipeline receives identity from the platform (never a client-held token).
//
// TTL: expiresAt is a 24h ROLLING window refreshed on every activity
// (widget-internalWidget.ts:613 shape). An EXPIRED session is NOT a new
// identity — resolve-or-create runs against the SAME chat (continuity
// preserved, D-08) and the session row is recreated fresh (counter reset
// rides the new row's messageCount default 0 + lastResetAt default now).
//
// RACE DISCIPLINE (D-09): the create path runs INSIDE the caller's
// withSessionLock — the messageRouter serializes resolves for the same
// (connectorId, platformUserId), so parallel resolves cannot race the Chat
// or session create. This module is therefore deliberately lock-free.

import prisma from "../../utils/prisma";
import { logger } from "../../utils/logger";
import { seedServiceAccount } from "../seedService";

/** Widget TTL parity (internalWidget.ts:613): 24h rolling window. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Chat display-name cap (D-08: `Telegram: <platformUserName>` truncated to 80). */
const CHAT_NAME_MAX = 80;

/**
 * Module-level service-account id cache (D-08: the connector acts AS the
 * widget service account). seedServiceAccount() is idempotent and runs at
 * every boot (index.ts:856), so by the time a connector message arrives the
 * row exists; we cache the resolved id after the first resolve to keep the
 * per-message path at one lookup at most.
 */
let serviceAccountId: string | null = null;

async function getServiceAccountId(): Promise<string> {
  if (serviceAccountId) return serviceAccountId;
  const account = await prisma.user.findFirst({
    where: {
      OR: [{ email: "widget-service@system" }, { username: "widget-service" }],
    },
    select: { id: true },
  });
  if (!account) {
    // seedServiceAccount() runs at every boot before schedulers; a missing
    // account here is a boot-order violation, not a transient failure —
    // fail loudly so the pipeline surfaces it (D-12 single error owner).
    throw new Error("widget-service@system account not found — run seedServiceAccount first");
  }
  serviceAccountId = account.id;
  return account.id;
}

/** Reset the module cache (tests only). */
export function resetServiceAccountIdCache(): void {
  serviceAccountId = null;
}

/**
 * D-08: the Chat name — `Telegram: <platformUserName>`, falling back to the
 * platform user id when no display name is available, truncated to 80 chars.
 * The platform prefix derives from the connector's platform so Phase
 * 199/200 chats read "Discord: …"/"Slack: …" in the admin chat list.
 */
function buildChatName(platform: string, platformUserId: string, platformUserName?: string): string {
  const raw = `${capitalize(platform)}: ${platformUserName ?? platformUserId}`;
  return raw.length > CHAT_NAME_MAX ? `${raw.slice(0, CHAT_NAME_MAX - 3)}...` : raw;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** now + 24h (the rolling TTL value, shared by the refresh + create paths). */
function nextExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

/**
 * D-08: resolve-or-create the ConnectorSession for (connector, platformUserId)
 * and its persistent Chat.
 *
 * (a) Find the session by the (connectorId, platformUserId) unique pair.
 * (b) Found + NOT expired: rolling refresh — expiresAt = now+24h,
 *     lastMessageAt = now, platformUserName updated when provided — and
 *     return (fast path, one update).
 * (c) Missing or EXPIRED (expired → continuity preserved: resolve against
 *     the SAME chat): resolve-or-create the Chat — an existing session's
 *     chatId is reused; a first-ever user creates a Chat owned by the
 *     service account with titleSource "user" (skips title generation,
 *     Chat model comment :380-382) and name `<Platform>: <platformUserName>`
 *     truncated to 80 (D-08; the prefix derives from connector.platform —
 *     Phase 199 Pitfall-6 fix: no hardcoded platform literal).
 * (d) Create the session row pointing at the resolved chat.
 * (e) Return the session (chatId non-null) + `created: boolean` — Phase
 *     199 (OQ-1/D-08): true ONLY when THIS call's session insert succeeded
 *     (the first-ever resolve); the fast-path refresh and the
 *     expired-session recreate path return false (continuity is not a new
 *     identity — the flag keys Plan 199-03's welcome arm on genuinely first
 *     contact only).
 *
 * Caller contract: the messageRouter serializes same-key resolves via the
 * D-09 per-session lock, so the create path cannot race.
 */
export async function resolveSession(
  connector: { id: string; workspaceId: string; platform: string },
  platformUserId: string,
  platformUserName?: string
): Promise<{
  id: string;
  connectorId: string;
  platformUserId: string;
  platformUserName: string | null;
  chatId: string | null;
  messageCount: number;
  lastMessageAt: Date | null;
  lastResetAt: Date;
  expiresAt: Date;
  /** Phase 199 (OQ-1): true ONLY when THIS call's INSERT succeeded (first-ever resolve). */
  created: boolean;
}> {
  const existing = await prisma.connectorSession.findUnique({
    where: {
      connectorId_platformUserId: {
        connectorId: connector.id,
        platformUserId,
      },
    },
  });

  // (b) Fast path: live session → rolling TTL refresh + identity update.
  // created: false — a refreshed session is not a new identity.
  if (existing && existing.expiresAt > new Date()) {
    const refreshed = await prisma.connectorSession.update({
      where: { id: existing.id },
      data: {
        expiresAt: nextExpiry(),
        lastMessageAt: new Date(),
        ...(platformUserName !== undefined && platformUserName !== existing.platformUserName
          ? { platformUserName }
          : {}),
      },
    });
    return {
      ...(refreshed as unknown as Awaited<ReturnType<typeof resolveSession>>),
      created: false,
    };
  }

  // (c) Missing or expired. The chat id survives expiry via the prior
  // session row (chat continuity, D-08) — a deleted chat (chatId null via
  // SetNull) falls through to a fresh Chat.
  const priorChatId = existing?.chatId ?? null;

  let chatId: string;
  if (priorChatId) {
    // Continuity: reuse the existing chat if it still exists (SetNull
    // already severed the FK otherwise — belt-and-braces findUnique).
    const chat = await prisma.chat.findUnique({ where: { id: priorChatId }, select: { id: true } });
    if (chat) {
      chatId = chat.id;
    } else {
      chatId = await createChat(connector, platformUserId, platformUserName);
    }
  } else {
    chatId = await createChat(connector, platformUserId, platformUserName);
  }

  // (d) Create the session row. The expired prior row is left in place (the
  // unique pair blocks a second insert) — an expired session is REPLACED via
  // upsert semantics: update the existing row (fresh TTL, zeroed counter,
  // same-or-new chatId). This keeps one row per (connectorId, platformUserId)
  // forever (the @@unique contract). created: false — an expired-session
  // recreate is NOT a first contact (continuity, OQ-1).
  if (existing) {
    const recreated = await prisma.connectorSession.update({
      where: { id: existing.id },
      data: {
        chatId,
        messageCount: 0,
        lastMessageAt: new Date(),
        lastResetAt: new Date(),
        expiresAt: nextExpiry(),
        ...(platformUserName !== undefined ? { platformUserName } : {}),
      },
    });
    return {
      ...(recreated as unknown as ReturnType<typeof resolveSession> extends Promise<infer T> ? T : never),
      created: false,
    };
  }

  // 198-04 (Rule 1, D-08/D-09 race-safety under the fire-and-forget webhook
  // arm): two concurrent same-key resolves can BOTH observe missing → both
  // take the create path → the loser hits P2002 on the
  // connectorId_platformUserId unique. That race surfaced in the 198-04 E2E
  // (21-message webhook burst): the loser previously surfaced as a pipeline
  // error ("session resolution failed" → health flip + message dropped).
  // The create is the completion of the resolve-or-create contract — catch
  // the unique-violation and RETURN the winner's row (the resolve stays
  // idempotent under concurrency).
  try {
    const created = await prisma.connectorSession.create({
      data: {
        connectorId: connector.id,
        platformUserId,
        platformUserName: platformUserName ?? null,
        chatId,
        messageCount: 0,
        lastMessageAt: new Date(),
        expiresAt: nextExpiry(),
        // lastResetAt defaults to now() (schema) — the rolling rate-limit
        // window starts at session creation.
      },
    });
    // Phase 199 (OQ-1): THIS call's insert succeeded — genuinely first
    // contact (the flag Plan 199-03's welcome arm keys on).
    return {
      ...(created as unknown as ReturnType<typeof resolveSession> extends Promise<infer T> ? T : never),
      created: true,
    };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002"
    ) {
      // The concurrent resolve won the create — re-fetch and return its row.
      // The winner's INSERT may still be in flight (the loser can hit the
      // constraint the instant the winner commits) — retry briefly before
      // failing (3 attempts, 10ms apart — bounded, no busy-wait).
      for (let attempt = 0; attempt < 3; attempt++) {
        const winner = await prisma.connectorSession.findUnique({
          where: { connectorId_platformUserId: { connectorId: connector.id, platformUserId } },
        });
        if (winner) {
          // Phase 199 (OQ-1): THIS call lost the insert race — the winner
          // created the session, so this resolve is not the creator.
          return { ...(winner as unknown as ReturnType<typeof resolveSession> extends Promise<infer T> ? T : never), created: false };
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    throw err;
  }
}

/**
 * Create the persistent Chat for a first-contact (or chat-deleted) session
 * (D-08): workspace = connector's bound workspace, org = the workspace's
 * organizationId (one chained query), owner = the widget service account,
 * titleSource "user" (skips title generation), name truncated to 80. The
 * name prefix derives from connector.platform (Phase 199 Pitfall-6 fix —
 * `Discord: <user>` for discord connectors; the former hardcoded
 * "telegram" literal is gone).
 */
async function createChat(
  connector: { workspaceId: string; platform: string },
  platformUserId: string,
  platformUserName?: string
): Promise<string> {
  // Org identity from the workspace chain (SAAS-01b: the sentinel default on
  // Chat.organizationId would silently misfile the row; the workspace's real
  // org is one select away).
  const workspace = await prisma.workspace.findUnique({
    where: { id: connector.workspaceId },
    select: { organizationId: true },
  });

  const serviceUserId = await getServiceAccountId();

  const chat = await prisma.chat.create({
    data: {
      workspaceId: connector.workspaceId,
      // CR-03: explicit org stamp (resolved from the connector's workspace
      // row — NEVER from any input-supplied identifier, T-198-06).
      organizationId: workspace?.organizationId ?? undefined,
      titleSource: "user", // skips title generation (Chat model comment)
      name: buildChatName(connector.platform, platformUserId, platformUserName),
    },
  });
  logger.debug("[connectors] chat created for connector session", {
    chatId: chat.id,
    serviceUserId,
  });
  return chat.id;
}