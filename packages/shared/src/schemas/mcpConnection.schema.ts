// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== MCP Connection Schemas =====
// Per BACK-03: Zod validation for MCP connection CRUD routes.
// Per D-01: Transport type enum restricted to sse and streamable-http only (stdio excluded).
// Per D-05: Scope fields (projectId, workspaceId) are mutually exclusive, exactly one required.
// Per D-07/D-08: Schema names follow camelCase convention, type names use Input suffix.

// Internal transport type enum -- D-01: stdio excluded at schema level
const mcpTransportTypeEnum = z.enum(["sse", "streamable-http"]);

// Health status enum -- D-04: operational status of MCP server connectivity
const healthStatusSchema = z.enum(["healthy", "stale", "down"]);
type HealthStatus = z.infer<typeof healthStatusSchema>;

// Verification tier enum -- D-06: trust signal for catalog entries
const verificationTierSchema = z.enum(["official", "verified_community", "unverified"]);
type VerificationTier = z.infer<typeof verificationTierSchema>;

// --- OAuth Schemas (Phase 195, MCPO-01 D-03) ---

// Internal auth type enum -- D-01: "none" = no header semantics (legacy rows
// never backfilled to "static", spec §9-4); "static" = explicit headers;
// "oauth" = connection-level OAuth 2.0 authorization-code flow.
const mcpAuthTypeEnum = z.enum(["none", "static", "oauth"]);
type McpAuthType = z.infer<typeof mcpAuthTypeEnum>;

// OAuth lifecycle status -- D-01: mirrors the MCPConnection.oauthStatus
// column. EXPORTED for the Phase 196 UI badges (authorized/error/pending).
// @latentByDesign — Phase 196 shipped the badges rendering the status
// inline; the named schema awaits the badge-type wiring (195-01 intent).
export const oauthStatusSchema = z.enum(["none", "pending", "authorized", "error"]);
/** @latentByDesign — paired inferred type of oauthStatusSchema (Phase 196 UI). */
export type OauthStatus = z.infer<typeof oauthStatusSchema>;

// OAuth start response -- D-07: the shape of POST /:connectionId/oauth/start.
// Phase 196 UI consumers open { authorizeUrl } in the browser/popup.
// @latentByDesign — the start route validates inline today; the named shape
// is the 195-01 cross-phase contract for the deferred UI consumer.
export const oauthStartResponseSchema = z.object({
  authorizeUrl: z.string().min(1),
});
/** @latentByDesign — paired inferred type of oauthStartResponseSchema. */
export type OauthStartResponse = z.infer<typeof oauthStartResponseSchema>;

// --- Create Schema ---

export const createMcpConnectionSchema = z
  .object({
    name: z.string().min(1, "Connection name is required").max(200),
    url: z.string().url("Invalid MCP connection URL"),
    transportType: mcpTransportTypeEnum.default("sse"),
    projectId: z.string().uuid("Invalid project ID").optional(),
    workspaceId: z.string().uuid("Invalid workspace ID").optional(),
    headers: z.record(z.string(), z.string()).optional().default({}),
    enabled: z.boolean().optional().default(true),
    // Phase 195 (D-03): optional OAuth fields. oauthScopes is a
    // space-separated string resolved through the server-side registry
    // (scope-reduce-only — the registry may only REDUCE provider defaults).
    authType: mcpAuthTypeEnum.optional(),
    oauthProvider: z.string().optional(),
    oauthScopes: z.string().optional(),
    oauthClientId: z.string().optional(),
  })
  .refine(
    (data) =>
      (data.projectId && !data.workspaceId) ||
      (!data.projectId && data.workspaceId),
    { message: "Exactly one of projectId or workspaceId is required" }
  )
  // Phase 195 (D-03): authType "oauth" requires a provider (registry key).
  .refine(
    (data) => data.authType !== "oauth" || (data.oauthProvider !== undefined && data.oauthProvider.length > 0),
    { message: "oauthProvider is required when authType is oauth" }
  )
  // Phase 195 (D-03): spurious oauth fields are only meaningful with
  // authType "oauth". CREATE treats an ABSENT authType as its "none" default
  // (Prisma column default), so oauth fields with no authType are spurious —
  // oauth fields are allowed ONLY when authType === "oauth".
  .refine(
    (data) =>
      data.authType === "oauth" ||
      (data.oauthProvider === undefined && data.oauthScopes === undefined && data.oauthClientId === undefined),
    { message: "oauth fields are only allowed when authType is oauth" }
  );

export type McpConnectionCreateInput = z.infer<typeof createMcpConnectionSchema>;

// --- Update Schema ---
// Per Pitfall 4: Do NOT use .partial() to derive from create schema.
// .partial() strips .refine() calls. Define as its own z.object with all fields optional.

export const updateMcpConnectionSchema = z
  .object({
    name: z.string().min(1, "Connection name is required").max(200).optional(),
    url: z.string().url("Invalid MCP connection URL").optional(),
    transportType: mcpTransportTypeEnum.optional(),
    projectId: z.string().uuid("Invalid project ID").optional(),
    workspaceId: z.string().uuid("Invalid workspace ID").optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    // Phase 195 (D-03): same optional OAuth fields as create (no .partial()).
    authType: mcpAuthTypeEnum.optional(),
    oauthProvider: z.string().optional(),
    oauthScopes: z.string().optional(),
    oauthClientId: z.string().optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: "At least one field must be provided for update" }
  )
  .refine(
    (data) => {
      // If neither scope field is present in the update, skip mutual exclusivity check
      // (allows updating name/url without touching scope -- D-06)
      if (data.projectId === undefined && data.workspaceId === undefined) return true;
      // Exactly one of projectId or workspaceId must be set
      return (
        (data.projectId !== undefined && data.workspaceId === undefined) ||
        (data.projectId === undefined && data.workspaceId !== undefined)
      );
    },
    { message: "Exactly one of projectId or workspaceId is required" }
  )
  // Phase 195 (D-03): authType "oauth" requires a provider (skipped when
  // authType is absent so unrelated updates never trip it).
  .refine(
    (data) => data.authType !== "oauth" || (data.oauthProvider !== undefined && data.oauthProvider.length > 0),
    { message: "oauthProvider is required when authType is oauth" }
  )
  // Phase 195 (D-03): spurious oauth fields rejected on non-oauth authType
  // (skipped when authType is absent — the row keeps its current value, which
  // may legitimately already be "oauth" via the dedicated authorize flow).
  .refine(
    (data) =>
      !(data.authType !== undefined && data.authType !== "oauth") ||
      (data.oauthProvider === undefined && data.oauthScopes === undefined && data.oauthClientId === undefined),
    { message: "oauth fields are only allowed when authType is oauth" }
  );

export type McpConnectionUpdateInput = z.infer<typeof updateMcpConnectionSchema>;

// --- Catalog Entry Schemas (Phase 197, MCPO-03 D-04) ---

// Catalog entries are "none" | "oauth" — entries never carry "static":
// static auth rides the headers column (D-04 column comment parity).
const mcpCatalogAuthTypeEnum = z.enum(["none", "oauth"]);

export const createMcpCatalogEntrySchema = z
  .object({
    name: z.string().min(1).max(200),
    url: z.string().url("Invalid MCP connection URL"),
    transportType: mcpTransportTypeEnum.default("sse"),
    description: z.string().optional(),
    category: z.string().optional(),
    version: z.string().optional(),
    author: z.string().optional(),
    verificationTier: verificationTierSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // Phase 197 (D-04): additive OAuth fields — catalog entries are
    // none|oauth (static lives in the headers column; no "static" authType
    // on entries).
    authType: mcpCatalogAuthTypeEnum.optional(),
    oauthProvider: z.string().optional(),
  })
  // Phase 197 (D-04, 195 D-03 refine conventions): oauth requires a provider.
  .refine(
    (data) => data.authType !== "oauth" || (data.oauthProvider !== undefined && data.oauthProvider.length > 0),
    { message: "oauthProvider is required when authType is oauth" }
  )
  // Phase 197 (D-04, 195 D-03 refine conventions): spurious oauth field on a
  // non-oauth entry is rejected (absent authType resolves to the "none"
  // column default — provider with no oauth flag is spurious).
  .refine(
    (data) => data.authType === "oauth" || data.oauthProvider === undefined,
    { message: "oauthProvider is only allowed when authType is oauth" }
  );

export type CreateMcpCatalogEntryInput = z.infer<typeof createMcpCatalogEntrySchema>;

// Per Pitfall 4 (195 D-03): do NOT derive with .partial() — it strips
// .refine() calls. Define as its own z.object with all fields optional.
// Shape parity + future PUT support; no route consumes it yet (UI-SPEC §5
// create-only — no PUT route is invented).
export const updateMcpCatalogEntrySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    url: z.string().url("Invalid MCP connection URL").optional(),
    transportType: mcpTransportTypeEnum.optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    version: z.string().optional(),
    author: z.string().optional(),
    verificationTier: verificationTierSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    authType: mcpCatalogAuthTypeEnum.optional(),
    oauthProvider: z.string().optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: "At least one field must be provided for update" }
  )
  .refine(
    (data) => data.authType !== "oauth" || (data.oauthProvider !== undefined && data.oauthProvider.length > 0),
    { message: "oauthProvider is required when authType is oauth" }
  )
  .refine(
    (data) =>
      !(data.authType !== undefined && data.authType !== "oauth") || data.oauthProvider === undefined,
    { message: "oauthProvider is only allowed when authType is oauth" }
  );

/**
 * @latentByDesign — 197-02 shipped this update schema deliberately (own
 * z.object, never .partial(), 15 tests) with NO PUT route yet: the marketplace
 * is create-only per UI-SPEC §5 (197-VERIFICATION "Latent only"). It becomes
 * the live gate when the catalog-update route lands.
 */
export type UpdateMcpCatalogEntryInput = z.infer<typeof updateMcpCatalogEntrySchema>;

// --- Toggle Schema (D-01) ---

export const toggleMcpConnectionSchema = z.object({
  enabled: z.boolean(),
});
type ToggleMcpConnectionInput = z.infer<typeof toggleMcpConnectionSchema>;

// --- Connection ID Param Schema (D-02) ---

export const mcpConnectionIdParamSchema = z.object({
  connectionId: z.string().uuid("Invalid connection ID"),
});
type McpConnectionIdParam = z.infer<typeof mcpConnectionIdParamSchema>;

// --- Catalog Entry ID Param Schema ---

export const mcpCatalogEntryIdParamSchema = z.object({
  entryId: z.string().uuid("Invalid catalog entry ID"),
});
type McpCatalogEntryIdParam = z.infer<typeof mcpCatalogEntryIdParamSchema>;

// --- Install Schema (MCP-03, per D-01, D-02) ---

export const installMcpServerSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  name: z.string().min(1).max(200).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
type InstallMcpServerInput = z.infer<typeof installMcpServerSchema>;

// --- Uninstall Schema (MCP-05, per D-06) ---

export const uninstallMcpServerSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
});
type UninstallMcpServerInput = z.infer<typeof uninstallMcpServerSchema>;

// --- MCP Headers Schema (D-12) ---
// Per D-12: hop-by-hop blocklist + name regex + size limits.
// Mitigates T-63-hopbyhop (header injection) and T-63-oversize (DoS).
// This schema is the trust boundary for MCP connection header config —
// Plan 02 wires it into mcpClient.ts read-side and mcp.ts write-side routes.

const HOP_BY_HOP_BLOCKLIST = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "upgrade",
]);

const headerNameRegex = /^[A-Za-z0-9-]+$/;

export const mcpHeadersSchema = z
  .record(z.string(), z.string())
  .refine((rec) => Object.keys(rec).length <= 20, { message: "Max 20 headers" })
  .refine((rec) => Object.keys(rec).every((k) => headerNameRegex.test(k)), {
    message: "Header names must match ^[A-Za-z0-9-]+$",
  })
  .refine((rec) => Object.values(rec).every((v) => v.length <= 4096), {
    message: "Header values max 4096 chars",
  })
  .refine(
    (rec) => !Object.keys(rec).some((k) => HOP_BY_HOP_BLOCKLIST.has(k.toLowerCase())),
    { message: "Hop-by-hop headers are blocked" }
  );

export type McpHeaders = z.infer<typeof mcpHeadersSchema>;