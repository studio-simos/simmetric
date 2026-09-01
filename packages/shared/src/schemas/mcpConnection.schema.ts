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
  })
  .refine(
    (data) =>
      (data.projectId && !data.workspaceId) ||
      (!data.projectId && data.workspaceId),
    { message: "Exactly one of projectId or workspaceId is required" }
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
  );

export type McpConnectionUpdateInput = z.infer<typeof updateMcpConnectionSchema>;

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