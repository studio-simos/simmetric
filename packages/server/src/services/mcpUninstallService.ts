// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP Uninstall Service — atomically disconnects, unregisters skills, and hard-deletes
 * an MCP connection installed from the marketplace.
 *
 * Design decisions:
 * - D-05: Hard delete — no soft-delete, no tombstone.
 * - D-06: Lookup by catalogEntryId + workspaceId.
 * - D-07: Reinstall = just call install again (record no longer exists).
 * - D-12: Pins survive — this function does NOT touch the ChatMCPPin table.
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { disconnectMCPServer } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";
import {
  resolveProvider,
} from "../services/oauthProviderRegistry";
import {
  decryptTokenBlob,
  revokeProviderToken,
} from "../services/oauthTokenLifecycle";

/** Minimal row shape the revoke+wipe helper needs (D-08). */
export interface McpConnectionForRevokeWipe {
  id: string;
  authType?: string | null;
  oauthProvider?: string | null;
  credentialsEncrypted?: string | null;
}

/**
 * Phase 197 (MCPO-03 D-08): revoke + wipe the credential blob before a
 * hard delete. Given a row that is authType='oauth' AND carries a stored
 * blob AND a provider key:
 *   resolveProvider → decryptTokenBlob → revokeProviderToken (best-effort).
 *
 * Fail-open-to-wipe contract:
 * - revokeProviderToken NEVER throws by its own contract (oauthTokenLifecycle
 *   D-14) — failures log provider + status text only, never token material.
 * - A decrypt failure, unknown provider, or a non-oauth / no-blob row logs
 *   and proceeds — the caller then hard-deletes the row, and the blob dies
 *   with the row (no explicit null-write on delete paths; that is the
 *   revoke-without-delete route's distinct shape).
 * NEVER wrapped in a throwing try/catch: failing to revoke provider-side
 * must not block the wipe (T-197-08).
 */
export async function revokeAndWipeCredentials(
  connection: McpConnectionForRevokeWipe,
): Promise<void> {
  if (connection.authType !== "oauth" || !connection.credentialsEncrypted || !connection.oauthProvider) {
    logger.debug("[mcpUninstall] Revoke+wipe skipped — not an oauth row with a stored blob", {
      connectionId: connection.id,
    });
    return;
  }

  const def = resolveProvider(connection.oauthProvider);
  if (!def) {
    logger.warn("[mcpUninstall] Revoke+wipe skipped — unknown oauth provider", {
      connectionId: connection.id,
      provider: connection.oauthProvider,
    });
    return;
  }

  const decoded = decryptTokenBlob(connection.credentialsEncrypted);
  if (!decoded.ok) {
    logger.warn("[mcpUninstall] Revoke+wipe — credential blob could not be decrypted; proceeding to wipe", {
      connectionId: connection.id,
      provider: def.id,
    });
    return;
  }

  // NEVER throws (D-14 contract): no revokeUrl → { ok, skipped }; transport
  // failures → { ok, errorDescription }. Failure to revoke provider-side
  // must not block the wipe — no try/catch here by design (fail-open).
  await revokeProviderToken(def, decoded.blob.accessToken);
}

export interface McpUninstallResult {
  success: boolean;
  connectionId: string;
  connectionName: string;
}

/**
 * Uninstall an MCP server from a workspace.
 *
 * Performs the atomic uninstall sequence:
 * 1. Find MCPConnection by catalogEntryId + workspaceId + source: "marketplace"
 * 2. Disconnect the runtime connection (close transport, remove from activeConnections)
 * 3. Unregister all skills for this connection (remove from skills Map by prefix)
 * 4. Hard-delete the database record
 *
 * IDOR protection: validates catalogEntryId matches the route param :entryId.
 * Only marketplace-installed connections (source: "marketplace") are eligible.
 *
 * D-05: Hard delete — no soft-delete, no tombstone.
 * D-06: Lookup by catalogEntryId + workspaceId.
 * D-07: Reinstall = just call install again (record no longer exists).
 * D-12: Pins survive — this function does NOT touch the ChatMCPPin table.
 *
 * @param catalogEntryId — UUID of the McpCatalogEntry being uninstalled
 * @param workspaceId — UUID of the workspace to uninstall from
 * @returns McpUninstallResult with connectionId and connectionName
 * @throws Error if no connection found for the given catalogEntryId + workspaceId
 */
export async function uninstallMcpServer(
  catalogEntryId: string,
  workspaceId: string,
): Promise<McpUninstallResult> {
  // Step 1: Find the marketplace-installed connection
  // IDOR protection: findFirst requires catalogEntryId === entryId AND source === "marketplace"
  // This prevents uninstalling a manually-created connection that happens to share a URL
  const connection = await prisma.mCPConnection.findFirst({
    where: {
      catalogEntryId,
      workspaceId,
      source: "marketplace",
    },
  });

  if (!connection) {
    throw new Error(
      "No installed connection found for this catalog entry in the specified workspace.",
    );
  }

  const connectionId = connection.id;
  const connectionName = connection.name;

  logger.info("[mcpUninstall] Starting uninstall", {
    catalogEntryId,
    workspaceId,
    connectionId,
    connectionName,
  });

  // Step 2: Disconnect the runtime connection
  // disconnectMCPServer closes the MCP client transport and removes from activeConnections Map
  try {
    await disconnectMCPServer(connectionId);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.warn("[mcpUninstall] Disconnect had non-fatal error", {
      connectionId,
      error: message,
    });
    // Continue with cleanup — the MCPClient may already be disconnected
  }

  // Step 3: Unregister all skills registered for this connection
  // D-13: unregisterSkillsForConnection removes all Map entries with prefix "mcp_{connectionId}_"
  // using connection.id (UUID) — collision-free prefix matching (T-63-spoof mitigated).
  unregisterSkillsForConnection(connectionId);

  // Step 3.5 (Phase 197 MCPO-03 D-08): revoke provider-side (best-effort,
  // fail-open-to-wipe) BEFORE the hard delete — the blob dies with the row.
  await revokeAndWipeCredentials(connection);

  // Step 4: Hard-delete the database record
  // D-05: hard delete, no soft-delete. D-07: record fully removed, so reinstall = just install again
  // D-12: ChatMCPPin records are NOT cascade-deleted (onDelete: NoAction on connection FK)
  await prisma.mCPConnection.delete({
    where: { id: connectionId },
  });

  logger.info("[mcpUninstall] Uninstall complete", {
    catalogEntryId,
    workspaceId,
    connectionId,
    connectionName,
  });

  return {
    success: true,
    connectionId,
    connectionName,
  };
}
