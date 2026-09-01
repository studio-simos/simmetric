// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import {
  installMcpServerSchema,
  uninstallMcpServerSchema,
  mcpCatalogEntryIdParamSchema,
  mcpHeadersSchema,
} from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "../services/eventLogService";
import { connectMCPServer, disconnectMCPServer } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";

const router = Router();

// GET / — List all catalog entries (auth only; any authenticated user can browse)
router.get("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;

    const entries = await prisma.mcpCatalogEntry.findMany({
      orderBy: { name: "asc" },
    });

    let installedSet: Set<string> = new Set();

    if (workspaceId) {
      const connections = await prisma.mCPConnection.findMany({
        where: { workspaceId, source: "marketplace" },
        select: { catalogEntryId: true },
      });
      installedSet = new Set(
        connections
          .map((c) => c.catalogEntryId)
          .filter((id): id is string => id !== null)
      );
    }

    const entriesWithInstalled = entries.map((entry) => ({
      ...entry,
      isInstalled: installedSet.has(entry.id),
    }));

    res.json(entriesWithInstalled);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[marketplace] Error listing catalog", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — Get single catalog entry detail (auth only; any authenticated user can browse)
router.get("/:entryId", authMiddleware, async (req: Request, res: Response) => {
  try {
    const paramResult = mcpCatalogEntryIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: paramResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { entryId } = paramResult.data;

    const entry = await prisma.mcpCatalogEntry.findUnique({
      where: { id: entryId },
    });

    if (!entry) {
      res.status(404).json({ error: "Catalog entry not found" });
      return;
    }

    res.json(entry);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[marketplace] Error fetching catalog entry", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// All other marketplace operations require admin access
router.use(authMiddleware, requireAdmin);

// POST / — Create a catalog entry (admin only, used by E2E tests and admin panel)
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, url, transportType, description, category, version, author, verificationTier, headers } = req.body;
    if (!name || !url || !transportType) {
      res.status(400).json({ error: "name, url, and transportType are required" });
      return;
    }

    // D-12 write-side parity: validate admin-supplied catalog headers against
    // mcpHeadersSchema (hop-by-hop blocklist, name regex, size limits) before
    // persisting. Without this, invalid headers could be copied verbatim into
    // MCPConnection.headers on every install that does not pass an override.
    if (headers !== undefined && headers !== null && headers !== "{}") {
      let parsedHeaders: unknown = headers;
      if (typeof headers === "string") {
        try {
          parsedHeaders = JSON.parse(headers);
        } catch {
          res.status(400).json({ error: "Invalid MCP headers", details: ["headers must be valid JSON"] });
          return;
        }
      }
      if (parsedHeaders && typeof parsedHeaders === "object" && Object.keys(parsedHeaders as Record<string, unknown>).length > 0) {
        const hdr = mcpHeadersSchema.safeParse(parsedHeaders);
        if (!hdr.success) {
          res.status(400).json({
            error: "Invalid MCP headers",
            details: hdr.error.issues.map((i) => i.message),
          });
          return;
        }
      }
    }

    const entry = await prisma.mcpCatalogEntry.create({
      data: {
        name,
        url,
        transportType: transportType || "sse",
        description: description || null,
        category: category || null,
        version: version || null,
        author: author || null,
        verificationTier: verificationTier || "unverified",
        headers: headers || "{}",
      },
    });

    res.status(201).json(entry);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[marketplace] Error creating catalog entry", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:entryId/install — Install an MCP server from the catalog (MCP-03, per D-01 through D-04)
router.post("/:entryId/install", async (req: Request, res: Response) => {
  try {
    // 1. Validate entryId param (UUID)
    const paramResult = mcpCatalogEntryIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: paramResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { entryId } = paramResult.data;

    // 2. Validate request body (D-01: workspaceId required)
    const parsed = installMcpServerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { workspaceId, name: overrideName, headers: overrideHeaders } = parsed.data;

    // D-12 write-side parity: validate override headers against mcpHeadersSchema
    // (hop-by-hop blocklist, name regex, size limits) before persisting.
    // Mirrors the write-side guard in mcp.ts POST/PUT routes.
    if (overrideHeaders && Object.keys(overrideHeaders).length > 0) {
      const hdr = mcpHeadersSchema.safeParse(overrideHeaders);
      if (!hdr.success) {
        res.status(400).json({
          error: "Invalid MCP headers",
          details: hdr.error.issues.map((i) => i.message),
        });
        return;
      }
    }

    // 3. Find catalog entry -- 404 if not found
    const catalogEntry = await prisma.mcpCatalogEntry.findUnique({
      where: { id: entryId },
    });
    if (!catalogEntry) {
      res.status(404).json({ error: "Catalog entry not found" });
      return;
    }

    // 4. Check for duplicate install (D-03: reject with 409)
    // WR-05: filter by source: "marketplace" to match the uninstall route's
    // eligibility predicate. Without this, a manual MCPConnection sharing a
    // catalogEntryId would 409 on install but 404 on uninstall.
    const existing = await prisma.mCPConnection.findFirst({
      where: { catalogEntryId: entryId, workspaceId, source: "marketplace" },
    });
    if (existing) {
      res.status(409).json({
        error:
          "This MCP server is already installed in the selected workspace. Enable or disable it from the MCP Connections settings.",
      });
      return;
    }

    // 5. Build connection data (D-02: copy url, transportType from catalog; override name/headers from body)
    // IN-01: type as Prisma.MCPConnectionUncheckedCreateInput so field-name
    // typos surface at compile time rather than as a runtime Prisma error.
    // Uses the Unchecked variant because the install path sets scalar FK
    // fields (workspaceId, projectId, catalogEntryId) directly instead of
    // using the relation-connect syntax required by MCPConnectionCreateInput.
    const connectionData: Prisma.MCPConnectionUncheckedCreateInput = {
      name: overrideName || catalogEntry.name,
      url: catalogEntry.url,
      transportType: catalogEntry.transportType || "sse",
      workspaceId,
      projectId: null,
      enabled: true,
      catalogEntryId: entryId,
      source: "marketplace",
    };

    if (overrideHeaders) {
      connectionData.headers = JSON.stringify(overrideHeaders);
    } else if (catalogEntry.headers && catalogEntry.headers !== "{}") {
      // D-12 write-side parity: validate catalog-supplied headers before copying
      // them into the new MCPConnection row. Bad catalog headers surface as a
      // 400 here rather than a misleading 201 + broken next-status-poll.
      let parsedCatalogHeaders: unknown;
      try {
        parsedCatalogHeaders = JSON.parse(catalogEntry.headers);
      } catch {
        res.status(400).json({
          error: "Catalog entry has invalid headers",
          details: ["stored headers are not valid JSON"],
        });
        return;
      }
      const hdr = mcpHeadersSchema.safeParse(parsedCatalogHeaders);
      if (!hdr.success) {
        res.status(400).json({
          error: "Catalog entry has invalid headers",
          details: hdr.error.issues.map((i) => i.message),
        });
        return;
      }
      connectionData.headers = catalogEntry.headers; // Phase 22 stores as JSON string
    } else {
      connectionData.headers = "{}";
    }

    // 6. Create MCPConnection in DB
    const connection = await prisma.mCPConnection.create({ data: connectionData });

    // Audit log: record install action (D-10)
    await logEvent("mcp_connection", connection.id, "mcp.installed", req.userId!, {
      catalogEntryId: entryId,
      workspaceId,
      serverName: connection.name,
    });

    // 7. Fire-and-forget auto-connect (D-04: connection failure logged, NOT propagated to HTTP)
    connectMCPServer(connection.id).catch((err: unknown) => {
      logger.error("[marketplace] Auto-connect failed after install", {
        connectionId: connection.id,
        catalogEntryId: entryId,
        error: (err instanceof Error ? err.message : String(err)),
      });
    });

    // 8. Return 201 with connection (same shape as POST /api/mcp-connections)
    res.status(201).json({
      ...connection,
      headers: JSON.parse(connection.headers),
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[marketplace] Error installing MCP server", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:entryId/uninstall — Uninstall an MCP server (MCP-05, per D-05 through D-07)
router.post("/:entryId/uninstall", async (req: Request, res: Response) => {
  try {
    // 1. Validate entryId param (UUID)
    const paramResult = mcpCatalogEntryIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: paramResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { entryId } = paramResult.data;

    // 2. Validate request body (D-06: workspaceId required)
    const parsed = uninstallMcpServerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { workspaceId } = parsed.data;

    // 3. Find MCPConnection by catalogEntryId + workspaceId (only marketplace-installed)
    const connection = await prisma.mCPConnection.findFirst({
      where: { catalogEntryId: entryId, workspaceId, source: "marketplace" },
    });
    if (!connection) {
      res.status(404).json({
        error:
          "No installed connection found for this catalog entry in the specified workspace.",
      });
      return;
    }

    // 4. Disconnect runtime + unregister skills (D-05: hard delete cleanup)
    await disconnectMCPServer(connection.id);
    unregisterSkillsForConnection(connection.id);

    // 5. Hard delete DB record (D-05: no soft-delete, no tombstone -- D-07: reinstall = just install again)
    await prisma.mCPConnection.delete({ where: { id: connection.id } });

    // Audit log: record uninstall action (D-10)
    await logEvent("mcp_connection", connection.id, "mcp.uninstalled", req.userId!, {
      catalogEntryId: entryId,
      workspaceId,
      serverName: connection.name,
    });

    // 6. Success (UI-SPEC copy)
    res.json({ message: "MCP server uninstalled" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[marketplace] Error uninstalling MCP server", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
