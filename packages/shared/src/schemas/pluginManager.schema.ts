// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-01/03/05) — plugin-manager contracts.
 *
 * Single source of truth shared by the server (routes/plugins.ts +
 * pluginManagerService/managedLoader in 202-02/03) and the frontend
 * (PluginPage / usePlugins). No business logic — pure Zod schemas +
 * inferred types (shared AGENTS.md).
 *
 * pluginRowSchema is the SECRETS-STRIPPED serialized row shape (RESEARCH
 * Pattern 3): licenseKeyEncrypted and packageJson are NEVER part of the
 * whitelisted surface — the API list/detail responses serialize through
 * this shape (P4 prohibition: license material must not appear in any
 * API response; presence booleans only, connectors.ts idiom).
 */

import { z } from "zod";

/** Row status: the loader writes loaded/failed; install writes installed. */
const pluginStatusSchema = z.enum(["installed", "loaded", "failed", "disabled"]);

/** D6 license modes — none/self are never license-gated (P3). */
const pluginLicenseModeSchema = z.enum(["none", "platform", "self"]);

/** Closed-enum verify reasons (pluginLicenseService resolve arm). */
const pluginLicenseStatusSchema = z.enum([
  "verified",
  "invalid",
  "expired",
  "missing",
  "plugin_mismatch",
]);

/** Where the loader found the plugin at boot. */
const pluginSourceSchema = z.enum(["native", "managed"]);

/**
 * One serialized PluginInstall row — DateTime fields as ISO strings
 * (RESEARCH Pattern 3 pins all serialized dates as ISO strings).
 */
export const pluginRowSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  packageName: z.string().min(1),
  displayName: z.string().nullable(),
  version: z.string().nullable(),
  apiVersion: z.number().int(),
  enabled: z.boolean(),
  status: pluginStatusSchema,
  lastError: z.string().nullable(),
  licenseMode: pluginLicenseModeSchema,
  licenseStatus: pluginLicenseStatusSchema.nullable(),
  licenseCheckedAt: z.string().nullable(), // ISO string — serialized DateTime
  source: pluginSourceSchema,
  createdAt: z.string(), // ISO string
  updatedAt: z.string(), // ISO string
})
  // P4 hard gate: a row carrying licenseKeyEncrypted (or any other secret
  // column) must REJECT, not silently strip — Zod's default strips unknown
  // keys, which would hide a serialization leak behind a 200. .strict() turns
  // the whitelisted shape into a contract: route serializers that add the
  // encrypted column back into a response payload fail loudly.
  .strict();

export type PluginRow = z.infer<typeof pluginRowSchema>;

/** GET /api/plugins response — restartMode is server-owned (RESEARCH A1). */
export const pluginListResponseSchema = z.object({
  restartMode: z.enum(["supervisor", "manual"]),
  plugins: z.array(pluginRowSchema),
});

export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;

/** PUT /api/plugins/:id body — enable/disable toggle (D-08 route contract: DELETE only on disabled rows). */
export const updatePluginSchema = z.object({
  enabled: z.boolean(),
});

/** PUT /api/plugins/:id/license body — the license JWT (write-only material, never echoed back). */
export const setPluginLicenseSchema = z.object({
  licenseKey: z.string().min(1),
});

/** POST /api/plugins/:id/verify-license body — probe-only re-verification (no invalidation). */
export const verifyPluginLicenseSchema = z.object({
  licenseKey: z.string().min(1),
});

/** :id route param guard (uuid PK per schema.prisma @default(uuid())). */
export const pluginIdParamSchema = z.object({
  id: z.string().uuid("Invalid plugin ID"),
});