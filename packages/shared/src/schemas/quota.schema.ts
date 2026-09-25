// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Phase 207 — Quota engine contracts (CLOUD-03/04/06) =====
// Shared source of truth — routes safeParse these; the frontend reuses the
// inferred types. NO re-declaration in consuming packages (repo convention).

/** Quota kinds riding the reset ledger. Only "tokens" resets (D-12 — storage
 * is a cap, not a rolling allowance). */
export const quotaKindSchema = z.enum(["tokens", "storage"]);
export type QuotaKindInput = z.infer<typeof quotaKindSchema>;

/**
 * The structured quota breach family (D-04): { error, quota: "<kind>" }.
 * "users" is included because the 206 ceiling (agencyUserService.ts:108)
 * shares the family — one contract the frontend/widget/connector handlers
 * key on. Advisory fields (limit/used/resetAt) are allowed for UX but are
 * NOT the contract — error + quota always ride the payload.
 */
export const quotaBreachPayloadSchema = z.object({
  error: z.string().min(1),
  quota: z.enum(["tokens", "storage", "users"]),
  limit: z.number().int().nonnegative().optional(),
  used: z.number().int().nonnegative().optional(),
  windowStart: z.string().datetime().optional(),
  resetAt: z.string().datetime().optional(),
});
export type QuotaBreachPayload = z.infer<typeof quotaBreachPayloadSchema>;

/** Admin per-user quota column update (D-07/D-09). Blank = inherit (null);
 * limits are bounded (zod V5 — no absurd values). */
export const updateQuotaInputSchema = z.object({
  tokenQuotaLimit: z
    .number()
    .int("Token quota must be a whole number of tokens")
    .min(0, "Token quota cannot be negative")
    .max(1_000_000_000_000, "Token quota exceeds the maximum (1e12)")
    .nullable(),
  storageQuotaGb: z
    .number()
    .min(0, "Storage quota cannot be negative")
    .max(1_000_000, "Storage quota exceeds the maximum (1e6 GB)")
    .nullable(),
  tokenQuotaUnlimited: z.boolean(),
  storageQuotaUnlimited: z.boolean(),
  resetAnchorDate: z.string().datetime().nullable(),
});
export type UpdateQuotaInput = z.infer<typeof updateQuotaInputSchema>;

/** Admin manual reset body (D-09). Storage is rejected server-side (D-12);
 * the schema only admits the resettable kind. */
export const manualResetSchema = z.object({
  kind: z.literal("tokens"),
});
export type ManualResetInput = z.infer<typeof manualResetSchema>;

/** Install-level preset write (D-08, Plan 04 system-config UI). "0"/"" = not
 * configured (chain falls through to unlimited). */
export const quotaPresetSchema = z.object({
  QUOTA_TOKEN_DEFAULT: z
    .string()
    .regex(/^$|^0$|^[1-9][0-9]*$/, "Token preset must be empty, 0 (unset), or a positive integer"),
  QUOTA_STORAGE_GB_DEFAULT: z
    .string()
    .regex(/^$|^(0|[0-9]+(\.[0-9]{1,2})?)$/, "Storage preset must be empty, 0 (unset), or a GB number (≤2 decimals)"),
});
export type QuotaPresetInput = z.infer<typeof quotaPresetSchema>;

/** Admin usage read payload (GET /api/quota/:userId) — the read Plan 04's UI
 * and Phase 209 consume. */
export const quotaUsageSchema = z.object({
  userId: z.string().uuid(),
  tokens: z.object({
    limit: z.number().int().nonnegative().nullable(),
    used: z.number().int().nonnegative(),
    windowStart: z.string().datetime(),
    nextResetAt: z.string().datetime().nullable(),
    source: z.enum(["override", "preset", "unlimited", "unset"]),
  }),
  storage: z
    .object({
      limitGb: z.number().nullable(),
      usedBytes: z.number().int().nonnegative(),
      source: z.enum(["override", "preset", "unlimited", "unset"]),
    })
    .nullable(),
});
export type QuotaUsage = z.infer<typeof quotaUsageSchema>;