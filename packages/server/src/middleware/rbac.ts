// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { Request, Response, NextFunction } from "express";
import type { PermissionName } from "@simmetric-chat/shared";
import prisma, { withSoftDelete } from "../utils/prisma";
import { getEffectivePermissions, isAdmin } from "../utils/auth";
import { logger } from "../utils/logger";
import { getSetting } from "../services/systemConfigService";

declare global {
  namespace Express {
    interface Request {
      /**
       * Phase 189 (D-11): the workspace role resolved by the graded
       * middlewares / shadow resolver for THIS request. Set by
       * requireWorkspaceRead / requireWorkspaceWriteAccess; never cached
       * across requests (Pitfall 9).
       */
      workspaceRole?: "admin" | "owner" | "editor" | "viewer" | null;
    }
  }
}



/**
 * Check if the authenticated user has the specified permission(s).
 * Admins always pass. Regular users must have the permission in their roles.
 */
export function requirePermission(permission: PermissionName | PermissionName[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // Admins have all permissions
    if (isAdmin(req.user)) {
      return next();
    }

    const permissions = getEffectivePermissions(req.user);
    const required = Array.isArray(permission) ? permission : [permission];
    const hasPermission = required.every((p) => permissions.includes(p));

    if (!hasPermission) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}

/**
 * Check if user is an admin (has the admin settings permission).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (!isAdmin(req.user)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  next();
}

/**
 * IDOR prevention: verify the user has access to a specific project.
 * Admins can access any project. Regular users must be the creator or have explicit access.
 */
export async function requireProjectAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const projectId = req.params.projectId;
  if (!projectId) {
    res.status(400).json({ error: "Project ID required" });
    return;
  }

  // Admins have global access
  if (isAdmin(req.user)) {
    return next();
  }

  const project = await prisma.project.findFirst({
    where: withSoftDelete({ id: projectId as string, deletedAt: null }),
  });

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.createdBy === req.userId) {
    return next();
  }

  const access = await prisma.projectAccess.findFirst({
    where: { userId: req.userId, projectId } as Record<string, unknown>,
  });

  if (!access) {
    res.status(403).json({ error: "Access denied to this project" });
    return;
  }

  next();
}

/**
 * Graded workspace roles resolved by {@link resolveWorkspaceRole} (Phase 189,
 * D-09). "admin" comes from the admin bypass tier; "owner" from either the
 * implicit project.createdBy source (D-08) or an external WorkspaceAccess row
 * with role "owner"; "editor"/"viewer" come from the persisted row or the
 * D-10 ProjectAccess-implied editor.
 */
export type WorkspaceRole = "admin" | "owner" | "editor" | "viewer";

/**
 * Phase 189 (WSIS-02, D-09): THE single role resolver — one code path merging
 * every role source with the pinned precedence:
 *
 *   1. admin bypass tier → "admin" (skippable via opts.skipAdminBypass, D-09 —
 *      the D-04 upload path resolves the admin's underlying grant)
 *   2. project.createdBy === userId → "owner" (D-08 implicit owner, evaluated
 *      BEFORE reading any row — outranks every row role)
 *   3. WorkspaceAccess row role "owner" → "owner" (external promoted users)
 *   4. WorkspaceAccess row role → "editor" | "viewer" (persisted grading)
 *   5. ProjectAccess exists → "editor" (D-10 implied editor, NEVER owner, no
 *      rows materialized)
 *   6. none of the above → null (caller maps to 404 for absent workspace —
 *      existence hiding, SC-4 — vs 403 for no-access)
 *
 * Query shape: at most one workspace (with project) + one workspaceAccess +
 * one projectAccess query per call. Do NOT cache the result anywhere
 * (Pitfall 9: per-request resolution IS the revocation contract).
 */
export async function resolveWorkspaceRole(
  userId: string,
  workspaceId: string,
  user: unknown,
  opts?: { skipAdminBypass?: boolean },
): Promise<WorkspaceRole | null> {
  // (a) Admin bypass tier — unless explicitly skipped (D-09/D-04)
  if (isAdmin(user) && !opts?.skipAdminBypass) {
    return "admin";
  }

  // (b) Workspace existence — soft-delete scoped; null → caller maps to 404
  const workspace = await prisma.workspace.findFirst({
    where: withSoftDelete({ id: workspaceId, deletedAt: null }),
    include: { project: { select: { id: true, createdBy: true } } },
  });
  if (!workspace) {
    return null;
  }

  // (c) Implicit owner (D-08) — project.createdBy ALWAYS outranks any row role
  if (workspace.project?.createdBy === userId) {
    return "owner";
  }

  // (d) Persisted row role — "owner" honored for external promoted users
  const access = await prisma.workspaceAccess.findFirst({
    where: { userId, workspaceId },
  });
  if (access) {
    if (access.role === "owner") {
      return "owner";
    }
    return access.role as "editor" | "viewer";
  }

  // (e) ProjectAccess implies editor (D-10) — never owner, no rows materialized
  const projectAccess = await prisma.projectAccess.findFirst({
    where: { userId, projectId: workspace.project?.id },
  });
  if (projectAccess) {
    return "editor";
  }

  // (f) No source grants access
  return null;
}

/**
 * Phase 189 (D-11): the workspaceId for the graded middlewares — the path
 * param (`:workspaceId`) first, then the upload-shaped fallbacks
 * (multipart BODY field on documents.ts /uploads routes; the query param on
 * the drafts pending GET). Upload routes carry the workspaceId in the body
 * because multer consumes the multipart payload BEFORE the chain gates run.
 */
function resolveRequestWorkspaceId(req: Request): string | undefined {
  const fromParams = req.params?.workspaceId;
  if (typeof fromParams === "string" && fromParams) return fromParams;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.workspaceId;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  const fromQuery = req.query?.workspaceId;
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  return undefined;
}

/**
 * Phase 189 (D-11): the graded READ gate (viewer+ on GET routes). Resolves
 * the role ONCE per request, exposes it on req.workspaceRole, and denies
 * ONLY when the workspace itself is absent (null → 404 existence hiding).
 * Any resolved role (viewer+) passes — reads are never role-graded above
 * the binary baseline (plan 189-02 flagged-assumptions read-half deviation:
 * exported for Phase 190/192 consumers, NOT mounted on GET routes in this
 * plan — requireWorkspaceAccess stays the read gate in both modes).
 */
export function requireWorkspaceRead() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const workspaceId = resolveRequestWorkspaceId(req);
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace ID required" });
      return;
    }

    const role = await resolveWorkspaceRole(req.userId, workspaceId, req.user);
    // Single resolution per request — exposed for downstream handlers
    // (Pitfall 9: never cached).
    req.workspaceRole = role;

    if (role === null) {
      // Absent workspace (non-admin) — existence hiding, byte shape matches
      // requireWorkspaceAccess's existing 404.
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    // viewer+ passes — no admin-bypass distinction needed (admin resolves
    // "admin" naturally via the resolver's step (a)).
    next();
  };
}

/**
 * Phase 189 (D-11 + D-04 + D-13): the graded WRITE gate — factory form
 * ({ bypassAdmin?, minRole? } = {}) consuming {@link resolveWorkspaceRole}.
 *
 * Flag-gated enforcement (D-13): `WORKSPACE_ROLE_ENFORCEMENT` is the
 * DB-backed SystemConfig key (DB > ENV > CONFIG_DEFAULTS via getSetting;
 * default "false" = shadow). In SHADOW the middleware resolves + logs +
 * calls next() — the binary requireWorkspaceAccess mounted BEFORE it in
 * every swept chain remains the effective gate (no window with no gate).
 * Enforcement flips in Plan 04 only after parity evidence exists.
 *
 * ENFORCED arm (flag "true"):
 *   - admin + bypassAdmin !== false → next()
 *   - admin + bypassAdmin === false → resolve the admin's UNDERLYING grant
 *     (skipAdminBypass re-resolution, D-04): null → 403 "Access denied to
 *     this workspace" (the pinned byte shape — NOT 404: the workspace
 *     exists, the admin merely lacks access); non-null → role gate as a
 *     non-admin.
 *   - non-admin: owner → next(); editor (and minRole !== "owner") → next();
 *     viewer or below-minRole → 403 "Access denied to this workspace".
 *   - role null on a genuinely absent workspace (non-admin) → 404
 *     "Workspace not found" (existence hiding).
 *
 * Pitfall 2: upload routes mount with `{ bypassAdmin: false }` so the D-04
 * admin-does-not-bypass upload exception survives the sweep.
 */
export function requireWorkspaceWriteAccess(options?: { bypassAdmin?: boolean; minRole?: "editor" | "owner" }) {
  const bypassAdmin = options?.bypassAdmin ?? true;
  const minRole = options?.minRole ?? "editor";
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const workspaceId = resolveRequestWorkspaceId(req);
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace ID required" });
      return;
    }

    // Flag read ONCE per request (getSetting resolves DB > ENV > default).
    const flagEntry = await getSetting("WORKSPACE_ROLE_ENFORCEMENT");
    const enforced = flagEntry.value === "true";

    const role = await resolveWorkspaceRole(req.userId, workspaceId, req.user);
    // Single resolution per request — exposed for downstream handlers
    // (Pitfall 9: never cached anywhere).
    req.workspaceRole = role;

    if (!enforced) {
      // SHADOW (D-13): log the graded decision and fall through — the binary
      // requireWorkspaceAccess gate earlier in the chain stays effective.
      // 260919: debug level — shadow fires on EVERY write-shaped request and
      // flooded production info logs (hundreds of identical lines/hour).
      logger.debug("[workspace-access] shadow decision", {
        userId: req.userId,
        workspaceId,
        role,
        middleware: "requireWorkspaceWriteAccess",
      });
      next();
      return;
    }

    // ENFORCED arm.
    if (role === null) {
      // Non-admin resolution of a genuinely absent workspace (existence
      // hiding) — the admin sub-arm below re-resolves with skipAdminBypass,
      // so admin-without-grant never lands on this 404 (D-04 pin shape).
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    if (isAdmin(req.user)) {
      if (bypassAdmin !== false) {
        return next();
      }
      // D-04: bypassAdmin:false — resolve the admin's underlying grant.
      const underlying = await resolveWorkspaceRole(req.userId, workspaceId, req.user, {
        skipAdminBypass: true,
      });
      if (underlying === null) {
        res.status(403).json({ error: "Access denied to this workspace" });
        return;
      }
      // Gate the admin AS its underlying grant role.
      if (underlying === "owner" || (underlying === "editor" && minRole !== "owner")) {
        return next();
      }
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }

    if (role === "owner") {
      return next();
    }
    if (role === "editor" && minRole !== "owner") {
      return next();
    }
    res.status(403).json({ error: "Access denied to this workspace" });
  };
}

/**
 * IDOR prevention: verify the user has access to a specific workspace.
 * Admins can access any workspace. Regular users must have explicit access or own the parent project.
 *
 * Phase 189 (D-13 step 1): runs {@link resolveWorkspaceRole} in SHADOW mode —
 * the graded decision is logged but enforcement stays byte-identical to the
 * pre-phase binary chain below (same 401/400/404/403 shapes, same admin
 * bypass, same fallback chain). The graded middlewares land in a follow-up
 * plan after route-matrix parity evidence accrues.
 */
export async function requireWorkspaceAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const workspaceId = req.params.workspaceId as string;
  if (!workspaceId) {
    res.status(400).json({ error: "Workspace ID required" });
    return;
  }

  // Phase 189 (D-13 step 1): shadow-mode graded decision — log only, no gating.
  // 260919: debug level (shadow fires per-request; info flooded prod logs).
  resolveWorkspaceRole(req.userId, workspaceId, req.user)
    .then((role) => {
      logger.debug("[workspace-access] shadow decision", {
        userId: req.userId,
        workspaceId,
        role,
      });
    })
    .catch((err: unknown) => {
      logger.warn("[workspace-access] shadow decision failed (non-blocking)", {
        userId: req.userId,
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // Admins have global access
  if (isAdmin(req.user)) {
    return next();
  }

  const workspace = await prisma.workspace.findFirst({
    where: withSoftDelete({ id: workspaceId as string, deletedAt: null }),
    include: { project: true },
  });

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  // Check if user owns the parent project
  if (workspace.project?.createdBy === req.userId) {
    return next();
  }

  // Check explicit workspace access
  const access = await prisma.workspaceAccess.findFirst({
    where: { userId: req.userId!, workspaceId },
  });

  if (!access) {
    // Also check project-level access
    const projectAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: workspace.project?.id },
    });

    if (!projectAccess) {
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }
  }

  next();
}