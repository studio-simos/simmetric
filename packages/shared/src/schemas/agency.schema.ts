// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";
import { permissionNameSchema } from "../constants/permissions";

// ===== Phase 206 — Agency sub-user contracts (AGENCY-01..04) =====
// Shared source of truth — routes safeParse these; the frontend reuses the
// inferred types. NO re-declaration in consuming packages (repo convention).

// Sub-user creation (AGENCY-01). Permissions field is intentionally ABSENT
// in v1 create: plan 04 adds updateSubUserPermissionsSchema for the lattice
// flow — create lands with the Utente Cloud default role only (D-20).
export const createSubUserSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(100)
    .regex(/^[a-z0-9_.-]+$/, "Username may only contain a-z, 0-9, _ . -"),
  email: z.email("Invalid email address").max(254),
  // Optional: the agency may omit it → server generates a temp password and
  // returns it ONCE (D-06 out-of-band relay contract).
  password: z.string().min(8, "Password must be at least 8 characters").max(200).optional(),
});
export type CreateSubUserInput = z.infer<typeof createSubUserSchema>;

// D-06: agency-triggered password reset — temp password + mustChangePassword.
/** @latentByDesign — consumer = plan 04 POST /api/agency/users/:id/reset-password. */
export const resetSubUserPasswordSchema = z.object({
  newPassword: z.string().min(8, "New password must be at least 8 characters").max(200).optional(),
});
/** @latentByDesign — paired type; consumer = plan 04 reset route. */
export type ResetSubUserPasswordInput = z.infer<typeof resetSubUserPasswordSchema>;

// Disable/enable lifecycle arm (D-05). enabled/disabled are separate POST
// routes; the body stays minimal.
/** @latentByDesign — consumer = plan 04 disable/enable routes. */
export const updateSubUserSchema = z.object({
  disabled: z.boolean().optional(),
});
/** @latentByDesign — paired type; consumer = plan 04 lifecycle routes. */
export type UpdateSubUserInput = z.infer<typeof updateSubUserSchema>;