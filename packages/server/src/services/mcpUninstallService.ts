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
