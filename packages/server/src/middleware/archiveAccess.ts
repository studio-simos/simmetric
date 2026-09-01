// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 70 — D-06: fail-closed archive-ownership check for
 * `POST /api/uploads/:id/assign` when the destination includes KB
 * (`kb=true` with an `archiveId`).
 *
 * DRIFT correction (RESEARCH.md Pitfall 1): the `Archive` model is GLOBAL —
 * it has NO `workspaceId` field (`schema.prisma:313-333`). There is NO
 * `workspaceAccess` / `projectAccess` path for archives. The correct
 * ownership rule mirrors `archiveImport.ts:286`:
 *
 *   owned = archive.createdBy === userId  OR  isAdmin(user)
 *
 * D-06a (sub-decision, security-sensitive): admin BYPASSES the
 * archive-ownership check (consistency with `archiveImport.ts:286` where
 * admin sees everyone's jobs). This is defense-in-depth on `archiveId` for
 * NON-admin callers, NOT an admin restriction. The divergence from D-07
 * (where admin does NOT bypass workspace access on the assign route) is
 * intentional: workspace access is a per-workspace containment boundary,
 * archive ownership is a global-entity ownership check.
 *
 * Return shape `{ ok, reason }` lets the caller distinguish 404 (missing
 * or soft-deleted) from 403 (exists but not owned) without a second
 * `findUnique` round-trip. T-70-07 accepts the 404-vs-403 existence
 * signal: enumeration of UUID archives is not guessable, low-value target.
 *
 * The helper does NOT write the HTTP response. The caller maps:
 *   reason === "missing" → 404 `{ error: "Archive not found" }`
 *   reason === "denied"  → 403 `{ error: "Access denied to this archive" }`
 */
import prisma from "../utils/prisma";
import { isAdmin } from "../utils/auth";

export type ArchiveAccessResult =
  | { ok: true; reason: "ok" }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "denied" };

/**
 * @param archiveId UUID of the target archive (never trusted from the body
 *   alone — always re-verified via `prisma.archive.findUnique`)
 * @param userId authenticated caller userId
 * @param user `req.user` (used for `isAdmin`)
 */
export async function assertArchiveAccess(
  archiveId: string,
  userId: string,
  user: unknown,
): Promise<ArchiveAccessResult> {
  // IN-01 (Phase 70 review follow-up): soft-delete check manuale.
  //
  // CLAUDE.md (root) prescribes `withSoftDelete()` from `utils/prisma.ts` to
  // auto-add `deletedAt: null` to Prisma queries on soft-deletable entities.
  // However `withSoftDelete()` is a Prisma client extension that injects the
  // filter into `findMany`/`findFirst`/`findFirstOrThrow` — it does NOT
  // affect `findUnique`, whose `where` argument must match a unique
  // constraint exactly (Prisma rejects non-unique fields in `findUnique`'s
  // `where`). Migrating to `findFirst` to pick up the centralized filter
  // would change the semantics from a unique-id lookup to a filtered scan
  // and is out of scope for an advisory-only fix.
  //
  // The manual `archive.deletedAt !== null` check below is the strongest
  // form of the soft-delete filter available for `findUnique` on a unique
  // id. This aligns with the CLAUDE.md server convention "All queries on
  // soft-deletable entities must include `where: { deletedAt: null }`" in
  // the only shape `findUnique` permits.
  const archive = await prisma.archive.findUnique({
    where: { id: archiveId },
  });
  // Soft-delete: Archive has `deletedAt` (schema.prisma:319). Missing or
  // soft-deleted → 404 (fail-closed, no existence leak beyond UUID guess).
  if (!archive || archive.deletedAt !== null) {
    return { ok: false, reason: "missing" };
  }
  if (archive.createdBy === userId) {
    return { ok: true, reason: "ok" };
  }
  if (isAdmin(user)) {
    // D-06a: admin bypasses archive-ownership (defense-in-depth is non-admin only)
    return { ok: true, reason: "ok" };
  }
  return { ok: false, reason: "denied" };
}