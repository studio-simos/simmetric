// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 191 (KNOW-01/02) — chat-attached archive attachment service.
 *
 * D-03 (IDOR safety): `resolveAttachedArchives` validates each requested
 * archive ID against ORG-SCOPED access and silently filters to the found
 * subset. Unknown IDs, cross-org IDs, and soft-deleted IDs yield zero
 * retrieval and zero persistence — NEVER a 4xx oracle mid-chat (an attacker
 * must not learn which archive IDs exist by probing the chat endpoint).
 * The widget path never reaches this code with IDs: the D-08 invariant holds
 * at BOTH hops — widgetChatRequestSchema strips attachedArchiveIds at the
 * proxy re-parse, and the internal route's seam (internalWidget.ts) deletes
 * it from the raw body it forwards to handleChatStream (whose
 * chatRequestSchema re-parse would otherwise accept it).
 *
 * D-05 (KNOW-02): `syncChatAttachment` mirrors the validated selection onto
 * the Chat row (server record = source of truth; the frontend localStorage
 * key is only a draft cache). Never throws mid-chat — a mirror failure is
 * logged and the union proceeds with what was resolved.
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

/**
 * Resolve the requested archive IDs to the org-scoped, non-deleted subset
 * (D-03). Order-preserving (caller's order feeds the retrieval union),
 * deduplicated, silent on unknown/cross-org/soft-deleted IDs.
 *
 * Empty input short-circuits to [] WITHOUT a DB round-trip.
 *
 * @param requestedIds   Client-supplied IDs (already schema-validated as
 *                       UUIDs; capped at 5 by chatRequestSchema .max(5)).
 * @param organizationId The request's tenant org (fail-closed: empty/null → []).
 */
export async function resolveAttachedArchives(
  requestedIds: string[],
  organizationId: string | null | undefined,
): Promise<string[]> {
  // Dedupe via Set — the resolver fans out one hybridSearch leg per ID, so
  // duplicate client IDs must never double the fan-out (T-191-03).
  const uniqueIds = Array.from(new Set(requestedIds));
  if (uniqueIds.length === 0) return [];
  // Fail-closed org guard: without an org there is nothing the caller can be
  // scoped to — return no archives rather than widening the query.
  if (!organizationId) return [];

  // Org-scoped silent filter: unknown IDs, cross-org IDs, and soft-deleted
  // rows simply do not come back — the caller proceeds with the subset.
  // No error, no 4xx (D-03 — never an existence oracle).
  const found = await prisma.archive.findMany({
    where: { id: { in: uniqueIds }, organizationId, deletedAt: null },
    select: { id: true },
  });
  const foundIds = new Set(found.map((a: { id: string }) => a.id));
  // Order-preserving filter to the found subset.
  return uniqueIds.filter((id) => foundIds.has(id));
}

/**
 * Mirror the validated selection onto the Chat row (D-05). Compares sorted
 * JSON copies so an unchanged selection never triggers a pointless UPDATE,
 * and writes the VALIDATED subset (never the raw client array).
 *
 * Never throws mid-chat: a mirror failure is logged and the retrieval union
 * proceeds with what was resolved (persistence is a convenience mirror, not
 * a gate on answering).
 *
 * @param chatId     The chat row ID (resolved or just created).
 * @param currentIds The chat row's current mirror (null when the row never
 *                   carried one — treated as []).
 * @param nextIds    The org-validated subset from resolveAttachedArchives.
 */
export async function syncChatAttachment(
  chatId: string,
  currentIds: string[] | null | undefined,
  nextIds: string[],
): Promise<void> {
  try {
    const current = JSON.stringify([...(currentIds ?? [])].sort());
    const next = JSON.stringify([...nextIds].sort());
    if (current === next) return;
    await prisma.chat.update({
      where: { id: chatId },
      data: { attachedArchiveIds: nextIds },
    });
  } catch (err: unknown) {
    logger.warn(
      `[archiveAttachment] failed to mirror attachedArchiveIds on chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}