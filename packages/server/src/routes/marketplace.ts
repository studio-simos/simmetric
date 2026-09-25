// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireAdmin } from "../middleware/rbac";
import {
  installMcpServerSchema,
  uninstallMcpServerSchema,
  mcpCatalogEntryIdParamSchema,
  mcpHeadersSchema,
  createMcpCatalogEntrySchema,
} from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "../services/eventLogService";
import { connectMCPServer, disconnectMCPServer } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";
// Phase 197 (MCPO-03 D-08): the shared revoke+wipe helper — the uninstall
// route inlines its flow (it does not delegate to uninstallMcpServer), so
// the hook inserts at the route between the skill unregister and the delete.
import { revokeAndWipeCredentials } from "../services/mcpUninstallService";

const router = Router();

// GET / — List all catalog entries (auth only; any authenticated user can browse)
router.get("/", authMiddleware, tenantContextMiddleware, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;

    const entries = await prisma.mcpCatalogEntry.findMany({
      // quick 260918-qts (D-2): soft-deleted entries are invisible to every
      // catalog reader — the filter also blocks boot-seed resurrection from
      // ever being surfaced to admins
      where: { deletedAt: null },
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
router.get("/:entryId", authMiddleware, tenantContextMiddleware, async (req: Request, res: Response) => {
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

    // T-185-10 disposition (Pitfall-2 grep-gate): exempt model —
    // McpCatalogEntry is the GLOBAL marketplace catalog (no org column,
    // not in TENANT_READ_MODELS); the org-owning resource is the
    // MCPConnection the install creates.
    const entry = await prisma.mcpCatalogEntry.findUnique({
      where: { id: entryId },
    });

    if (!entry || entry.deletedAt) {
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
// Phase 185 (D-09): tenant slot between the gates — auth → tenant → admin.
// McpCatalogEntry reads here are org-agnostic catalog rows; the slot keeps
// the ALS store open for the downstream Tier-A MCPConnection installs.
router.use(authMiddleware, tenantContextMiddleware, requireAdmin);

// POST / — Create a catalog entry (admin only, used by E2E tests and admin panel)
router.post("/", async (req: Request, res: Response) => {
  try {
    // T-197-06 (Phase 197 MCPO-03 D-04): the raw req.body destructure is the
    // closed trust-boundary gap — every field now validates through the
    // shared Zod schema (incl. the oauth⇔provider refines) before the DB.
    const parsed = createMcpCatalogEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { name, url, transportType, description, category, version, author, verificationTier, headers, authType, oauthProvider } = parsed.data;

    // D-12 write-side parity: validate admin-supplied catalog headers against
    // mcpHeadersSchema (hop-by-hop blocklist, name regex, size limits) before
    // persisting. Without this, invalid headers could be copied verbatim into
    // MCPConnection.headers on every install that does not pass an override.
    // (Post-schema the field is Record<string,string> | undefined — the old
    // string-form acceptance died with the raw destructure.)
    if (headers !== undefined) {
      const hdr = mcpHeadersSchema.safeParse(headers);
      if (!hdr.success) {
        res.status(400).json({
          error: "Invalid MCP headers",
          details: hdr.error.issues.map((i) => i.message),
        });
        return;
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
        headers: headers ? JSON.stringify(headers) : "{}",
        // Phase 197 (D-04): additive OAuth fields — install-count/health
        // columns stay admin/runtime-owned (never client-writable).
        authType: authType ?? "none",
        oauthProvider: oauthProvider ?? null,
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
    // T-185-10 disposition: exempt global catalog model (rationale above).
    const catalogEntry = await prisma.mcpCatalogEntry.findUnique({
      where: { id: entryId },
    });
    // quick 260918-qts: soft-deleted entries cannot be installed (D-2)
    if (!catalogEntry || catalogEntry.deletedAt) {
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
      // CR-03 (185-05, D-04): explicit org stamp (Tier-A model — same
      // self-visibility class as the mcp.ts create).
      organizationId: req.organizationId!,
      // Phase 197 (MCPO-03 D-05): copy the entry's OAuth identity so the
      // admin completes authorization through the 195 Connect flow. Non-oauth
      // entries keep the column defaults (spread arm empty — byte-identical).
      ...(catalogEntry.authType === "oauth"
        ? { authType: "oauth", oauthProvider: catalogEntry.oauthProvider, oauthStatus: "pending" }
        : {}),
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
    // Phase 197 (MCPO-03 D-05): OAuth entries skip auto-connect — there is no
    // URL to connect until the token exists; the admin completes via the 195
    // Connect flow (oauth/start), then the callback reconnects. Skipping also
    // avoids a pointless connectionErrors entry against the placeholder URL.
    if (catalogEntry.authType !== "oauth") {
      connectMCPServer(connection.id).catch((err: unknown) => {
        logger.error("[marketplace] Auto-connect failed after install", {
          connectionId: connection.id,
          catalogEntryId: entryId,
          error: (err instanceof Error ? err.message : String(err)),
        });
      });
    }

    // 8. Return 201 with connection (same shape as POST /api/mcp-connections)
    // Phase 197 (T-197-06 posture): the secret-bearing oauth columns are
    // stripped from the 201 response — mcp.ts POST returns the row through
    // sanitizeMcpConnection (credentialsEncrypted/oauthError removed), and
    // this route must hold the same leak-pin contract (the E2E leak pin
    // asserts BOTH the connection-list AND the install response). The
    // non-secret oauth badge fields (authType/oauthStatus/oauthProvider)
    // stay — the UI renders from them.
    const { credentialsEncrypted: _ce, oauthError: _oe, ...connectionPublic } = connection;
    res.status(201).json({
      ...connectionPublic,
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

    // Phase 197 (MCPO-03 D-08): best-effort provider-side revocation BEFORE
    // the hard delete (fail-open-to-wipe) — the blob dies with the row.
    await revokeAndWipeCredentials(connection);

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

// DELETE /:entryId — Delete a single catalog entry (quick 260918-qts, D-1)
// Inherits the router.use(authMiddleware, tenantContextMiddleware, requireAdmin)
// chain above — admin-only, exactly like install/uninstall.
router.delete("/:entryId", async (req: Request, res: Response) => {
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

    // 2. Load the entry — 404 when missing OR already soft-deleted
    // T-185-10 disposition: exempt global catalog model (rationale above).
    const entry = await prisma.mcpCatalogEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry || entry.deletedAt) {
      res.status(404).json({ error: "Catalog entry not found" });
      return;
    }

    // 3. In-use guard (T-QTS-02): a catalog entry still referenced by any
    // MCPConnection cannot be deleted — the admin must uninstall it from
    // those workspaces first. No cascade surprise (explicit D-1 disposition).
    const inUseCount = await prisma.mCPConnection.count({
      where: { catalogEntryId: entryId },
    });
    if (inUseCount > 0) {
      res.status(409).json({
        error:
          "This catalog entry is still installed in one or more workspaces. Uninstall it from those workspaces before deleting it from the marketplace.",
      });
      return;
    }

    // 4. Soft delete (repo norm + D-2): update deletedAt instead of a hard
    // delete so the boot-time seed upsert (whose update clause never touches
    // deletedAt) cannot resurrect the entry on restart.
    await prisma.mcpCatalogEntry.update({
      where: { id: entryId },
      data: { deletedAt: new Date() },
    });

    // 5. Audit log (T-QTS-03): mirrors install/uninstall audit discipline
    await logEvent("mcp_catalog_entry", entryId, "mcp.catalog_entry_deleted", req.userId!, {
      name: entry.name,
    });

    res.json({ message: "Catalog entry deleted" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[marketplace] Error deleting catalog entry", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
