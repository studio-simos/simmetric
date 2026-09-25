// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";
import { permissionNameSchema } from "../constants/permissions";

// ===== Role & Permission Schemas =====

export const createRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  permissionNames: z.array(permissionNameSchema).optional().default([]),
});

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  permissionNames: z.array(permissionNameSchema).optional(),
});

const assignRoleSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  roleId: z.string().uuid("Invalid role ID"),
});

export const grantWorkspaceAccessSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  workspaceId: z.string().uuid("Invalid workspace ID").optional(),
  role: z.enum(["owner", "editor", "viewer"]).default("viewer"),
});

export const grantProjectAccessSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  projectId: z.string().uuid("Invalid project ID"),
});

// WR-01 (Phase 70 review follow-up): UUID validation for the `:roleId` path
// parameter on GET /:roleId and PUT /:roleId. Reuses the same message used by
// `assignRoleSchema.roleId` for consistency. Applied at the route handler entry
// so a non-UUID `roleId` (e.g. "me") returns 400 `{ error, details }` instead
// of leaking the Prisma error via the 500 catch-all. Also resolves IN-05 as a
// side-effect: GET /api/roles/me now returns 400 (the `/me/menu-sections`
// route is declared above `/:roleId` and takes precedence, but other non-UUID
// values hit this guard).
export const roleIdParamSchema = z.string().uuid("Invalid role ID");
type RoleIdParam = z.infer<typeof roleIdParamSchema>;

// ===== Phase 206 (VIS-01 D-14/D-16): per-role settings-section visibility =====
// Admin toggle payload for PUT /api/roles/:roleId/visibility. sectionKey
// values: SETTINGS_TAB_PERMISSIONS keys (profile/llm/appearance/security/
// advanced) for settings sections; MENU_SECTIONS keys for menu sections.
// Absent rows = permission-OR default (fail-open to CURRENT behavior).
/** @latentByDesign — consumer = plan 03 PUT /api/roles/:roleId/visibility (VIS-01 D-14/D-16). */
export const roleSectionVisibilitySchema = z.object({
  sections: z
    .array(
      z.object({
        sectionKey: z.string().min(1).max(100),
        visible: z.boolean(),
      }),
    )
    .min(1, "At least one section entry is required"),
});
/** @latentByDesign — paired type; consumer = plan 03 visibility PUT. */
export type RoleSectionVisibilityInput = z.infer<typeof roleSectionVisibilitySchema>;

type CreateRoleInput = z.infer<typeof createRoleSchema>;
type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
type AssignRoleInput = z.infer<typeof assignRoleSchema>;
type GrantWorkspaceAccessInput = z.infer<typeof grantWorkspaceAccessSchema>;
type GrantProjectAccessInput = z.infer<typeof grantProjectAccessSchema>;