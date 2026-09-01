// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { PermissionName } from "@simmetric-chat/shared";
import { PERMISSION_NAMES } from "@simmetric-chat/shared";

/**
 * Minimal user shape carrying the role + permission graph needed by the
 * permission-extraction helpers. Declared locally (D-08 "concrete type")
 * because the Prisma-generated `User` type does not include the `roles` /
 * `role.permissions` relations by default — callers build this via Prisma
 * `include` and pass the resulting payload. Fields read here: `user.roles`
 * (array of `{ role: { permissions: { permissionName: PermissionName }[] } }`).
 * The optional index signature keeps the interface permissive for callers
 * that pass the full Prisma `User & { roles: ... }` payload (which carries
 * additional fields like `id`, `email`, `passwordHash`, etc.).
 */
interface UserWithPermissions {
  // Prisma returns `permissionName` as a broad `string` (the column is a
  // string, not an enum); the `PERMISSION_NAMES.includes(...)` allowlist
  // check below narrows to `PermissionName` at use-site. Typing the field as
  // `string` here keeps the interface assignable from the Prisma payload
  // (`{ role: { permissions: { permissionName: string; ... }[] } }[]`).
  roles?: Array<{ role: { permissions: Array<{ permissionName: string }> } }>;
  [key: string]: unknown;
}

/**
 * Extract all effective permissions from a user's roles.
 *
 * Canonical implementation (D-03): the single source of truth for permission
 * extraction. Imported by rbac.ts and the document/workspace/project routes
 * that previously held private copies.
 *
 * Validates each permission name against the `PERMISSION_NAMES` allowlist so
 * unknown rows (e.g. from stale seeds or future migrations) are silently
 * dropped instead of leaking into authorization checks.
 */
export function getEffectivePermissions(user: unknown): PermissionName[] {
  const permSet = new Set<PermissionName>();

  // D-08: callers pass `req.user` (typed `unknown` in Express middlewares) or
  // the Prisma user payload. Narrow defensively — anything without a
  // `roles` array degrades to "no permissions" (fail-closed).
  const u = user as UserWithPermissions | null | undefined;
  if (!u?.roles) return [];

  for (const userRole of u.roles) {
    for (const rp of userRole.role.permissions) {
      if (PERMISSION_NAMES.includes(rp.permissionName as PermissionName)) {
        permSet.add(rp.permissionName as PermissionName);
      }
    }
  }

  return Array.from(permSet);
}

/**
 * Check if a user is an admin (has the `admin:settings` permission).
 *
 * Semantic-preserving extraction of the inline `permissions.includes("admin:settings")`
 * check (D-01). This helper only returns the boolean; any semantic variation
 * (e.g. D-04 "admin requires workspace access") lives in the route handlers,
 * NOT here, so callers keep their existing behavior.
 */
export function isAdmin(user: unknown): boolean {
  return getEffectivePermissions(user).includes("admin:settings");
}