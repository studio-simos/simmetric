// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { createMcpConnectionSchema, updateMcpConnectionSchema, toggleMcpConnectionSchema, mcpConnectionIdParamSchema, mcpHeadersSchema } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { connectMCPServer, disconnectMCPServer, getConnectionStatuses, testMCPServerConnection, clearConnectionError } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";
import { logEvent } from "../services/eventLogService";

const router = Router();

// All MCP connection management requires admin access
router.use(authMiddleware, requireAdmin);

// Route 1: GET / — List all MCP connections
router.get("/", async (_req: Request, res: Response) => {
  try {
    const connections = await prisma.mCPConnection.findMany({
      orderBy: { createdAt: "desc" } as const,
    });
    res.json(connections.map(c => ({ ...c, headers: JSON.parse(c.headers) })));
  } catch (err: unknown) {
    logger.error("[mcp] Error listing connections", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route 2: GET /statuses — Live connection status (MUST be before /:connectionId)
router.get("/statuses", async (_req: Request, res: Response) => {
  try {
    const connections = await prisma.mCPConnection.findMany({
      orderBy: { createdAt: "desc" } as const,
    });
    const runtimeStatuses = getConnectionStatuses();

    const enriched = connections.map(c => {
      const runtime = runtimeStatuses.get(c.id);
      return {
        id: c.id,
        name: c.name,
        url: c.url,
        transportType: c.transportType,
        enabled: c.enabled,
        projectId: c.projectId,
        workspaceId: c.workspaceId,
        liveStatus: runtime?.liveStatus ?? "disconnected",
        toolCount: runtime?.toolCount ?? 0,
        lastError: runtime?.lastError ?? null,
        lastSyncAt: c.lastSyncAt,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });

    res.json(enriched);
  } catch (err: unknown) {
    logger.error("[mcp] Error getting statuses", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route 3: POST / — Create MCP connection
router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createMcpConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    // D-12 write-side: validate headers against mcpHeadersSchema (hop-by-hop blocklist,
    // name regex, size limits) before persisting. Mitigates T-63-hopbyhop / T-63-oversize.
    if (parsed.data.headers && Object.keys(parsed.data.headers).length > 0) {
      const hdr = mcpHeadersSchema.safeParse(parsed.data.headers);
      if (!hdr.success) {
        res.status(400).json({
          error: "Invalid MCP headers",
          details: hdr.error.issues.map((i) => i.message),
        });
        return;
      }
    }

    const { name, url, transportType, projectId, workspaceId, headers, enabled } = parsed.data;

    const connection = await prisma.mCPConnection.create({
      data: {
        name,
        url,
        transportType,
        projectId: projectId ?? null,
        workspaceId: workspaceId ?? null,
        headers: headers ? JSON.stringify(headers) : "{}",
        enabled: enabled ?? true,
      },
    });

    // Auto-connect if enabled
    if (connection.enabled) {
      connectMCPServer(connection.id).catch((err: unknown) => {
        logger.error("[mcp] Auto-connect failed", { connectionId: connection.id, error: (err instanceof Error ? err.message : String(err)) });
      });
    }

    res.status(201).json({
      ...connection,
      headers: JSON.parse(connection.headers),
    });
  } catch (err: unknown) {
    logger.error("[mcp] Error creating connection", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route 4: PUT /:connectionId — Update MCP connection
router.put("/:connectionId", async (req: Request, res: Response) => {
  try {
    const paramResult = mcpConnectionIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connection ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { connectionId } = paramResult.data;

    const parsed = updateMcpConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    // D-12 write-side: validate headers if present in the update payload.
    if (parsed.data.headers !== undefined && Object.keys(parsed.data.headers).length > 0) {
      const hdr = mcpHeadersSchema.safeParse(parsed.data.headers);
      if (!hdr.success) {
        res.status(400).json({
          error: "Invalid MCP headers",
          details: hdr.error.issues.map((i) => i.message),
        });
        return;
      }
    }

    const existing = await prisma.mCPConnection.findUnique({ where: { id: connectionId } });
    if (!existing) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    const updateData: Record<string, unknown> = { ...parsed.data };

    // Serialize headers if present in update
    if (updateData.headers) {
      updateData.headers = JSON.stringify(updateData.headers);
    }

    // If existing connection is enabled, disconnect before updating.
    // WR-06: skill unregistration is deferred until AFTER the Prisma update
    // succeeds. Previously it ran before the update, so a Prisma failure left
    // the DB row reflecting `enabled: true` while the skills were already gone
    // from the registry — the next chat found no MCP tools and only a server
    // restart re-registered them. Disconnect still runs first (correct
    // delete-first ordering for the Map entry); only the registry mutation is
    // reordered to after the DB write.
    if (existing.enabled) {
      await disconnectMCPServer(connectionId);
    }

    const updated = await prisma.mCPConnection.update({
      where: { id: connectionId },
      data: updateData,
    });

    // WR-06: only unregister skills once the DB update has committed.
    if (existing.enabled) {
      unregisterSkillsForConnection(existing.id);
    }

    // If the updated connection should be enabled, reconnect
    if (updated.enabled) {
      clearConnectionError(connectionId);
      try {
        await connectMCPServer(connectionId);
      } catch (err: unknown) {
        logger.error("[mcp] Reconnect failed", { connectionId, error: (err instanceof Error ? err.message : String(err)) });
        // Keep DB update, do NOT auto-disable, return response with warning
        res.json({
          ...updated,
          headers: JSON.parse(updated.headers),
          _warning: `Reconnect failed: ${(err instanceof Error ? err.message : String(err))}`,
        });
        return;
      }
    }

    res.json({
      ...updated,
      headers: JSON.parse(updated.headers),
    });
  } catch (err: unknown) {
    logger.error("[mcp] Error updating connection", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route 5: DELETE /:connectionId — Delete MCP connection
router.delete("/:connectionId", async (req: Request, res: Response) => {
  try {
    const paramResult = mcpConnectionIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connection ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { connectionId } = paramResult.data;

    const connection = await prisma.mCPConnection.findUnique({ where: { id: connectionId } });
    if (!connection) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    await disconnectMCPServer(connectionId);
    unregisterSkillsForConnection(connection.id);

    // IN-02: emit audit event for admin-initiated hard delete. The toggle route
    // logs mcp.enabled/mcp.disabled and the marketplace uninstall route logs
    // mcp.uninstalled, but the generic DELETE route previously left no audit
    // trail — a marketplace-installed connection deleted here would be invisible
    // in the event log when audit_log_immutable is enabled.
    await logEvent("mcp_connection", connectionId, "mcp.deleted", req.userId!, {
      workspaceId: connection.workspaceId,
      serverName: connection.name,
    });

    await prisma.mCPConnection.delete({ where: { id: connectionId } });

    res.json({ message: "MCP connection deleted" });
  } catch (err: unknown) {
    logger.error("[mcp] Error deleting connection", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route 6: POST /:connectionId/toggle — Explicit enable/disable
router.post("/:connectionId/toggle", async (req: Request, res: Response) => {
  try {
    const paramResult = mcpConnectionIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connection ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { connectionId } = paramResult.data;

    const parsed = toggleMcpConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { enabled: newEnabled } = parsed.data;

    const connection = await prisma.mCPConnection.findUnique({ where: { id: connectionId } });
    if (!connection) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    await prisma.mCPConnection.update({
      where: { id: connectionId },
      data: { enabled: newEnabled },
    });

    // Audit log: record enable/disable action (D-10)
    await logEvent("mcp_connection", connectionId, newEnabled ? "mcp.enabled" : "mcp.disabled", req.userId!, {
      catalogEntryId: connection.catalogEntryId,
      workspaceId: connection.workspaceId,
      connectionId,
      serverName: connection.name,
    });

    if (newEnabled) {
      clearConnectionError(connectionId);
      connectMCPServer(connectionId).catch((err: unknown) => {
        logger.error("[mcp] Reconnect failed after toggle", { connectionId, error: (err instanceof Error ? err.message : String(err)) });
      });
    } else {
      await disconnectMCPServer(connectionId);
      unregisterSkillsForConnection(connection.id);
    }

    res.json({ id: connectionId, enabled: newEnabled });
  } catch (err: unknown) {
    logger.error("[mcp] Error toggling connection", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route 7: POST /:connectionId/test — Test connection
router.post("/:connectionId/test", async (req: Request, res: Response) => {
  try {
    const paramResult = mcpConnectionIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connection ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { connectionId } = paramResult.data;

    const connection = await prisma.mCPConnection.findUnique({ where: { id: connectionId } });
    if (!connection) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    // Disconnect any active connection first
    await disconnectMCPServer(connectionId);

    const url = connection.url;
    const headers = connection.headers ? JSON.parse(connection.headers) : undefined;
    const transportType = connection.transportType as "sse" | "streamable-http" | undefined;

    // 10-second timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Connection test timed out after 10 seconds")), 10000)
    );

    let result: { success?: boolean; toolCount?: number; error?: string };
    try {
      // D-17: pass transportType so testMCPServerConnection honors StreamableHTTP + 4xx fallback.
      result = await Promise.race([testMCPServerConnection(url, headers, transportType), timeoutPromise]);
    } catch (err: unknown) {
      res.json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
      return;
    }

    // On test success, if connection is enabled, auto-connect
    if (connection.enabled && result.success) {
      clearConnectionError(connectionId);
      connectMCPServer(connectionId).catch((err: unknown) => {
        logger.error("[mcp] Auto-connect after test failed", { connectionId, error: (err instanceof Error ? err.message : String(err)) });
      });
    }

    res.json(result);
  } catch (err: unknown) {
    logger.error("[mcp] Error testing connection", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;