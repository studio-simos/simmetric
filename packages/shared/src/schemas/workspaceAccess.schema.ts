// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Workspace Access Route Schemas (Phase 189, WSIS-03) =====

/**
 * Phase 189 (D-18): route-specific grant schema WITHOUT the optional
 * workspaceId — the route takes it from the URL param
 * (`req.params.workspaceId`), fixing the spec §5.8 schema confusion.
 * `grantWorkspaceAccessSchema` in role.schema.ts stays byte-untouched for
 * general reuse.
 */
export const grantWorkspaceAccessRouteSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  role: z.enum(["owner", "editor", "viewer"]).default("viewer"),
});

/**
 * Phase 189 (D-17): bulk grant body — one or more users, single transaction
 * server-side. Result shape `{ granted: N, failed: [{userId, error}] }` is
 * fixed by the endpoint contract.
 */
export const bulkGrantWorkspaceAccessSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1),
  role: z.enum(["owner", "editor", "viewer"]).default("viewer"),
});

/**
 * Phase 189 (D-15): list-entry wire shape for GET /:workspaceId/access —
 * grantedAt serializes to string over JSON; grantedBy is null for legacy rows
 * (D-12 audit marker) and set for admin-granted rows. The list ROUTE reshapes
 * the Prisma rows inline (workspaces.ts grants.map) — this schema stays
 * unexported as the pinned wire-shape contract (shared schemas.test.ts
 * parses it; no runtime consumer — knip sweep quick-260921-o5z).
 */
const workspaceAccessListEntrySchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  role: z.enum(["owner", "editor", "viewer"]),
  grantedAt: z.string(),
  grantedBy: z.string().nullable(),
});

// Phase 189 (D-16) revoke path-param schema DELETED (knip sweep
// quick-260921-o5z): no route ever imported it — the revoke handler reads
// req.params.userId directly and Prisma's FK error maps to 404/400 there.