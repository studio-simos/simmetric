// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 70 — D-02/D-03: single point of truth for the non-admin upload
 * toggle on the Documenti sportelli (`POST /api/uploads` and
 * `POST /api/documents/upload`).
 *
 * Semantics (D-03 OR-inclusive, fail-closed parse):
 *   admin?                              → allowed (bypasses the TOGGLE only)
 *   ALLOW_NON_ADMIN_UPLOAD === "true"   → globalAllowed = true
 *   workspace.allowMemberUploads        → per-workspace toggle
 *   allowed = globalAllowed || workspace.allowMemberUploads
 *
 * The helper does NOT write the HTTP response. The caller owns the WR-01
 * orphan-cleanup ordering: on `false`, the caller MUST call
 * `unlinkUploadIfPresent(req)` BEFORE `res.status(403).json(...)` (multer
 * has already written the file to DRAFTS_DIR/UPLOADS_DIR before the
 * handler ran).
 *
 * `getSetting("ALLOW_NON_ADMIN_UPLOAD")` reads the SystemConfig row fresh
 * on every call (no in-memory cache in `systemConfigService.getSetting`),
 * so the admin toggle flip via `PUT /api/system/settings` takes effect on
 * the very next request with no server restart (SC-4).
 *
 * Admin bypasses the TOGGLE only — workspace access is checked upstream by
 * the route's `assertWorkspaceAccess` (uploads.ts local helper / inline
 * documents.ts:288-302), which does NOT bypass admin (D-07 semantic
 * variation). This helper does NOT re-check workspace access.
 */
import type { Request } from "express";
import { getSetting } from "../services/systemConfigService";
import { isAdmin } from "../utils/auth";

/**
 * Returns `true` when the caller may proceed with the upload stage, `false`
 * when the caller must reject with 403. Does NOT write the response.
 *
 * IN-02 (Phase 70 review follow-up): the previous unused Response parameter
 * was removed — the caller owns the WR-01 cleanup ordering and the 403
 * write. Removing it enforces the contract at the type level (compilers
 * reject callers that pass `res`), rather than relying on the JSDoc alone.
 *
 * @param req Express request (used only to derive the default `admin` flag)
 * @param workspace workspace row with at least `allowMemberUploads`
 * @param admin explicit admin flag; defaults to `isAdmin(req.user)`
 */
export async function assertNonAdminUploadAllowed(
  req: Request,
  workspace: { allowMemberUploads: boolean },
  admin: boolean = isAdmin(req.user),
): Promise<boolean> {
  if (admin) return true;
  // D-03 fail-closed: any value other than the literal "true" denies.
  // "false", "", undefined, "yes", "1", "TRUE" → false (deny).
  const setting = await getSetting("ALLOW_NON_ADMIN_UPLOAD");
  const globalAllowed = setting.value === "true";
  return globalAllowed || workspace.allowMemberUploads;
}