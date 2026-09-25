// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Connector token resolver (Phase 196, MCPO-04 D-04/D-07) —
 * tool-time OAuth credential access for the first-party connector skills
 * (gdrive_* / graph_*).
 *
 * Deliberately NOT `resolveConnectionHeaders` (mcpClient.ts): that helper
 * serves the MCP-transport path and writes connection errors into the
 * `connectionErrors`/`activeConnections` runtime Maps as a side effect of the
 * transport lifecycle — tool execution must never mutate those Maps
 * (196-RESEARCH Anti-Pattern 1). This module is a pure resolver: query →
 * org assert → decrypt.
 *
 * Tenancy posture (T-196-02, T-185-10 fail-closed):
 * - The workspace→organizationId lookup is the org SOURCE (server-side data,
 *   never client input).
 * - `scopeToOrg(org, …)` explicitly AND-merges the org filter into the
 *   findFirst so tenancy holds even when the chat tenant ALS is absent.
 *   MCPConnection is in TENANT_READ_MODELS (utils/scopedPrisma.ts), so when
 *   the ALS IS open the tenantScope extension AND-merges again —
 *   belt-and-braces, never the only guard.
 * - Scope selection is deterministic: ONE findFirst in Prisma's stable
 *   default order resolves exactly one connection when multiple authorized
 *   same-provider rows exist; the others are ignored (MCPO-04/adjacency —
 *   same-provider connections never collide, merge, or double-resolve).
 *
 * No token material ever leaves this module on a failure path — structured
 * failures carry only descriptions (decryptTokenBlob posture, T-196-01).
 */

import prisma from "../../utils/prisma";
import { scopeToOrg } from "../../utils/tenantContext";
import { decryptTokenBlob, type OAuthTokenBlob } from "../../services/oauthTokenLifecycle";

/**
 * The connection row fields the resolver needs. credentialsEncrypted rides
 * through decryptTokenBlob and never leaves the resolver except inside the
 * decrypted blob — callers receive `blob`, not ciphertext.
 */
interface ConnectorConnection {
  id: string;
  name: string;
  oauthProvider: string | null;
  organizationId: string;
  credentialsEncrypted: string | null;
}

export type ConnectorResolution =
  | { ok: true; connection: ConnectorConnection; blob: OAuthTokenBlob }
  | { ok: false; error: string };

/**
 * Resolve the authorized OAuth connection for `providerId` visible to
 * `workspaceId` (workspace-scoped OR global both-null scope), decrypt its
 * credential blob, and return both. Fail-closed on every gating branch:
 * missing workspace, no authorized row, missing ciphertext, decrypt failure —
 * each carries a clear error string and NO token material.
 */
export async function resolveConnectorConnection(
  workspaceId: string,
  providerId: string,
): Promise<ConnectorResolution> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  if (!ws) {
    return { ok: false, error: "Workspace not found" };
  }

  // Single findFirst → deterministic one-of-N selection when multiple
  // authorized same-provider connections exist (MCPO-04/adjacency).
  // NOTE (Rule 1 deviation vs the 196-RESEARCH sketch): scopeToOrg merges
  // org into the WHERE clause (the chatAgentConfig.ts/archiveSearch.ts
  // idiom) — the sketch's arg-level placement would put organizationId as a
  // sibling of `where`, which Prisma ignores, silently dropping the
  // tenancy filter the plan demands.
  const row = await prisma.mCPConnection.findFirst({
    where: scopeToOrg(ws.organizationId, {
      authType: "oauth",
      oauthStatus: "authorized",
      oauthProvider: providerId,
      enabled: true,
      // Workspace-scoped OR global both-null scope (D-14 semantics
      // mirrored from getMCPToolsForWorkspace — project-scoped rows are
      // excluded from workspace-chat tool resolution).
      OR: [{ workspaceId }, { workspaceId: null, projectId: null }],
    }),
  });
  if (!row || !row.credentialsEncrypted) {
    return {
      ok: false,
      error: `No authorized ${providerId} connection for this workspace — connect it in Settings → MCP Connections first`,
    };
  }

  const decoded = decryptTokenBlob(row.credentialsEncrypted);
  if (!decoded.ok) {
    return { ok: false, error: decoded.errorDescription };
  }

  return {
    ok: true,
    connection: {
      id: row.id,
      name: row.name,
      oauthProvider: row.oauthProvider,
      organizationId: row.organizationId,
      credentialsEncrypted: row.credentialsEncrypted,
    },
    blob: decoded.blob,
  };
}

/**
 * Boolean-shaped resolver for the palette gate (D-04): true iff at least one
 * authorized `providerId` connection exists for the workspace (same where
 * shape as resolveConnectorConnection — same tenancy posture). Never decrypts
 * (availability only — the blob is not needed to decide palette inclusion).
 */
export async function hasAuthorizedProviderConnection(
  workspaceId: string,
  providerId: string,
): Promise<boolean> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  if (!ws) return false;

  const row = await prisma.mCPConnection.findFirst({
    where: scopeToOrg(ws.organizationId, {
      authType: "oauth",
      oauthStatus: "authorized",
      oauthProvider: providerId,
      enabled: true,
      OR: [{ workspaceId }, { workspaceId: null, projectId: null }],
    }),
    select: { id: true },
  });
  return row !== null;
}

/**
 * Scope-coverage check (D-08 fail-closed): split the granted blob scope
 * string (space-joined provider strings) and require every `required` scope
 * to be present. Returns null when fully covered, else a "missing scope"
 * error naming the missing scope(s) — the error text carries scope NAMES,
 * never token material.
 */
export function assertScopesGranted(
  grantedScope: string,
  required: string[],
): string | null {
  const granted = new Set(grantedScope.split(/\s+/).filter((s) => s.length > 0));
  const missing = required.filter((s) => !granted.has(s));
  if (missing.length === 0) return null;
  return `The connected provider account is missing required scope(s): ${missing.join(", ")}. Reauthorize the connection with the required scopes in Settings → MCP Connections.`;
}