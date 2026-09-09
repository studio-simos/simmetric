// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * tenantContextMiddleware — slots into the chain AFTER auth, BEFORE permission
 * gates (D-09: auth → tenant → permission).
 *
 * Resolution arms (D-01/D-08):
 *  1. Store already present  → defensive re-entry, pass through.
 *  2. req.tenantBypass === true (collector/MCP internal mounts, Plan 02) →
 *     bypassTenantScope(() => next()) — platform surface, D-05.
 *  3. req.tenantOrgCandidate present (API-key path, seeded by Plan 02) → use
 *     it WITHOUT a membership query (D-08: the key's own org column IS the
 *     resolution).
 *  4. JWT path → FIRST live membership (orderBy joinedAt asc — deterministic
 *     D-01 tie-break), server-side only. NEVER from headers/body/query/claims.
 *
 * Fail-closed (D-02): unresolvable membership → 404 { error: "Not found" }
 * (cross-tenant shape — never 500, never fail-open, never a DEFAULT_ORG_ID
 * fallback in the auth path; that fallback exists ONLY inside the extension's
 * absent-store arm). Resolution errors → 404 too (fail-closed, D-07 shape).
 *
 * Admin bypass (unchanged, platform-level): platform admins keep GLOBAL read
 * visibility via the bypass flag while req.organizationId stays set for
 * org-scoped license counting.
 */

import type { NextFunction, Request, Response } from "express";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import {
  bypassTenantScope,
  getTenantContext,
  runInTenant,
  type TenantStore,
} from "../utils/tenantContext";
import { isAdmin } from "../utils/auth";

declare global {
  namespace Express {
    interface Request {
      /** Resolved tenant org (server-side only, D-01). */
      organizationId?: string;
      /** API-key path org candidate (Plan 02 seeds it; consumed WITHOUT a membership query). */
      tenantOrgCandidate?: string;
      /** Collector/MCP internal mounts set this (Plan 02) → bypass arm. */
      tenantBypass?: boolean;
    }
  }
}

/**
 * Resolve the tenant organization for a request.
 * Exported separately for unit testing. Returns null when unresolvable —
 * the middleware 404s (D-02); it never falls back to DEFAULT_ORG_ID.
 */
export async function resolveOrgFor(req: Request): Promise<string | null> {
  // D-08 API-key arm: the candidate is mint-time-pinned on the ApiKey row —
  // no membership query, no client influence.
  const candidate = req.tenantOrgCandidate;
  if (candidate) {
    return candidate;
  }

  // D-01 JWT arm: first LIVE membership, deterministic orderBy joinedAt asc.
  if (req.userId) {
    const membership = await prisma.organizationMember.findFirst({
      where: { userId: req.userId, deletedAt: null },
      orderBy: { joinedAt: "asc" },
      select: { organizationId: true },
    });
    return membership?.organizationId ?? null;
  }

  return null;
}

/**
 * Build the tenant store for a resolved org + request principal.
 * Platform admins keep global read visibility via the bypass flag
 * (unchanged admin bypass — platform-level only, org-scoped license counting
 * keeps working via req.organizationId).
 */
export function tenantStoreFor(req: Request, organizationId: string): TenantStore {
  return { organizationId, bypass: isAdmin(req.user) };
}

export async function tenantContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // (1) Defensive re-entry: already inside a tenant run → pass through.
  if (getTenantContext()) {
    next();
    return;
  }

  // (2) Platform bypass surfaces (collector/MCP mounts set the flag, Plan 02).
  if (req.tenantBypass === true) {
    bypassTenantScope(() => next());
    return;
  }

  try {
    const organizationId = await resolveOrgFor(req);

    if (!organizationId) {
      // D-02 fail-closed: no live membership → cross-tenant 404 shape.
      // Never 500, never fail-open, never DEFAULT_ORG_ID in the auth path.
      res.status(404).json({ error: "Not found" });
      return;
    }

    req.organizationId = organizationId;
    runInTenant(tenantStoreFor(req, organizationId), () => next());
  } catch (err: unknown) {
    // WR-02 (185-05): fail-closed stays (D-02/D-07 shape), but the swallowed
    // error is now logged — a transient Postgres failure must not present as
    // a silent flood of 404s with no server-side signal.
    logger.warn("[tenantContext] org resolution failed — failing closed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(404).json({ error: "Not found" });
  }
}