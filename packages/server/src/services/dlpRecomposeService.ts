// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP chat re-composition service (Phase 192 plan 03 — D-08/D-09).
 *
 * At stream end (exactly once — never per-token), the server re-composes
 * [CLASS_N] placeholders in the assistant answer for users holding
 * `dlp:unmask` in a DLP-on workspace, gated by the citing/attached
 * documents' IDs. Widget visitors NEVER receive re-composed text (hard
 * never — the entity map is structurally never loaded for widget requests,
 * T-192-12). Masked text remains the persisted canonical (A4); the done
 * payload carries the per-request re-composed text.
 *
 * Gate ladder (evaluation order is load-bearing — cheapest and hardest
 * gates first):
 *   1. widget hard-never (isWidgetSource → unchanged, NO entity-map load)
 *   2. workspace DLP toggle (dlpDocumentScanEnabled off → unchanged)
 *   3. permission (resolveWorkspaceRole + dlp:unmask via the single
 *      resolver — Phase 189 D-07, never a parallel role check)
 *   4. cited/attached documentIds (empty → unchanged, no map load)
 *   5. entity map load (buildRecompositionMap over the deduped union)
 *   6. tolerant per-placeholder substitution
 *
 * Any gate failure returns the input text UNCHANGED — masking stays; a
 * re-composition failure never breaks the chat (fail-closed, never throws).
 *
 * Encryption discipline (V7 no-PII, T-192-13): decrypted originals flow
 * ONLY into the substituted string. Logger calls carry counts/classes/
 * placeholders — never entity values, never the decrypted text.
 *
 * Prisma singleton from ../utils/prisma (repo hard rule — never
 * `new PrismaClient()`).
 */
import prisma from "../utils/prisma";
import type { SourceCitation } from "@simmetric-chat/shared";
// Phase 192 plan 04 unification: buildPlaceholderRegex is OWNED by
// dlpEntityService.ts (the plan-03 local copy was a wave-3 merge-order
// hand-off; behavior pinned by dlpRecompose.test.ts and the identical
// regex lives in the single export now).
import {
  buildRecompositionMap,
  buildPlaceholderRegex,
} from "./dlpEntityService";
import { resolveWorkspaceRole } from "../middleware/rbac";
import { getEffectivePermissions } from "../utils/auth";
import { logger } from "../utils/logger";

// Plan-03 public surface kept: dlpRecompose.test.ts (and any consumer) can
// keep importing buildPlaceholderRegex from THIS module — the single
// definition lives in dlpEntityService.ts.
export { buildPlaceholderRegex };

/** Options for recomposeForUser — all provenance + gate inputs. */
export interface RecomposeOptions {
  /** Citing documents from result.sources (SourceCitation[].documentId). */
  citedDocumentIds: string[];
  /** Attached-document path (ragContext injection; chat.ts:848-860). */
  attachedDocumentIds: string[];
  userId: string;
  workspaceId: string;
  /** req.user — threaded to resolveWorkspaceRole + getEffectivePermissions. */
  user: unknown;
  /** D-08 hard never — widget requests are structurally excluded. */
  isWidgetSource: boolean;
}

/**
 * Extract + dedupe documentIds from the run's citations (D-08
 * citation-gating input). Filter Boolean (pageSlug-carrying archive
 * citations have no documentId) + Set dedupe (multiple chunks cite the
 * same document). Empty when sources are absent — the attached-document
 * path carries provenance separately via attachedDocumentIds.
 */
export function extractCitedDocumentIds(
  sources: SourceCitation[] | undefined,
): string[] {
  const ids = (sources ?? [])
    .map((s) => s.documentId)
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

/**
 * Substitute mapped placeholders into `text` with the tolerant per-
 * placeholder regex (Pitfall 3(a): case-insensitive, whitespace-tolerant —
 * "[ PERSON_1 ]", "[person_1]", "[Person_1]" all resolve). Unmapped
 * placeholders (document not cited / gate failed / decrypt dropped)
 * stay as the literal token — partial masking, never an error.
 *
 * Substituted output is NOT re-scanned: plaintext is substituted for
 * placeholders in one pass per placeholder, so double-substitution is
 * structurally impossible (mask∘unmask∘unmask = unmask once — a second
 * call finds no remaining mapped placeholder tokens and is a no-op).
 */
function substituteFromMap(text: string, map: Map<string, string>): string {
  let out = text;
  let remaining = map.size;
  for (const [placeholder, original] of map) {
    // Cheap pre-check avoids a regex compile + scan per entry for large maps.
    if (!out.includes(placeholder.slice(1, -1))) { remaining -= 1; continue; }
    out = out.replace(buildPlaceholderRegex(placeholder), original);
    remaining -= 1;
    // Early exit: every mapped placeholder resolved — no more passes needed.
    if (remaining === 0) break;
  }
  return out;
}

/**
 * Whether the requesting user holds `dlp:unmask` in this workspace.
 * Resolved through the Phase 189 single-resolver contract:
 * resolveWorkspaceRole (admin bypass rides its admin arm) + the
 * dlp:unmask permission from the SAME req.user payload
 * (getEffectivePermissions) — never a parallel role check.
 */
async function canUnmask(
  userId: string,
  workspaceId: string,
  user: unknown,
): Promise<boolean> {
  const role = await resolveWorkspaceRole(userId, workspaceId, user);
  if (!role) return false;
  const perms = getEffectivePermissions(user);
  return perms.includes("dlp:unmask");
}

/**
 * Re-compose DLP placeholders in `text` for the requesting user (D-08).
 *
 * Returns the input text UNCHANGED when any gate fails (widget source,
 * toggle off, permission missing, no cited/attached documents) or when
 * the map load/substitution throws — masking stays, the chat continues
 * (fail-closed: re-composition is a presentation courtesy, never a
 * correctness requirement).
 *
 * T-192-12 (widget PII leak): the isWidgetSource hard gate sits BEFORE
 * any entity-map load — buildRecompositionMap is never called for widget
 * requests (pinned by the negative test asserting zero calls).
 * T-192-13 (re-composition IDOR): the map is built ONLY over the
 * cited/attached documentIds the request itself surfaced; a forged
 * documentId yields no entity rows (empty map → text unchanged).
 */
export async function recomposeForUser(
  text: string,
  opts: RecomposeOptions,
): Promise<string> {
  try {
    // Gate 1 — widget hard-never (D-08): no entity load, no DB touch.
    if (opts.isWidgetSource) {
      return text;
    }

    // Gate 2 — cited/attached documents (D-08 provenance): without any
    // document anchor there is nothing to resolve (no map, no cost).
    const documentIds = [...new Set([...opts.citedDocumentIds, ...opts.attachedDocumentIds])];
    if (documentIds.length === 0) {
      return text;
    }

    // Gate 3 — workspace DLP toggle (D-08): one read, only for chat
    // requests that cite documents.
    const workspace = await prisma.workspace.findUnique({
      where: { id: opts.workspaceId },
      select: { dlpDocumentScanEnabled: true },
    });
    if (!workspace?.dlpDocumentScanEnabled) {
      return text;
    }

    // Gate 4 — permission (Phase 189 D-07 single resolver + dlp:unmask).
    if (!(await canUnmask(opts.userId, opts.workspaceId, opts.user))) {
      return text;
    }

    // Gate 5 — entity map over the deduped cited∪attached union.
    const map = await buildRecompositionMap(documentIds);
    if (map.size === 0) {
      return text;
    }

    const recomposed = substituteFromMap(text, map);
    const resolvedCount = map.size;
    logger.info("[dlp-recompose] stream-end re-composition applied", {
      workspaceId: opts.workspaceId,
      documentCount: documentIds.length,
      resolvedPlaceholders: resolvedCount,
      // Counts/classes only — NEVER the decrypted values (V7 no-PII).
    });
    return recomposed;
  } catch (err: unknown) {
    // Fail-closed: any gate/DB/decrypt error returns the masked text —
    // a re-composition failure must never break the chat stream.
    logger.warn("[dlp-recompose] re-composition skipped (fail-closed)", {
      workspaceId: opts.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return text;
  }
}