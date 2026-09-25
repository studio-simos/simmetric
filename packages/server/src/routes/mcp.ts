// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
// Phase 185 (T-185-10): the CRUD router's findUnique sites below are
// post-fetch-org-asserted (Pitfall-2 grep-gate option b — the row is
// PK-keyed by connectionId and immediately updated, so a scoped findFirst
// would need a second query; the 404-hide assertion is equivalent).
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireAdmin, requirePermission } from "../middleware/rbac";
import { createMcpConnectionSchema, updateMcpConnectionSchema, toggleMcpConnectionSchema, mcpConnectionIdParamSchema, mcpHeadersSchema } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { connectMCPServer, disconnectMCPServer, getConnectionStatuses, testMCPServerConnection, clearConnectionError, resolveConnectionHeaders } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";
import { logEvent } from "../services/eventLogService";
// Phase 195 (MCPO-01): OAuth flow seams — registry (D-04/D-06), state (D-07/D-08),
// token lifecycle (exchange/decrypt/revoke through the AES-256-GCM blob).
import { resolveProvider, hasClientConfigured, buildAuthorizeUrl, resolveScopes, resolveRedirectUri } from "../services/oauthProviderRegistry";
import { signOAuthState } from "../services/oauthStateService";
import { revokeProviderToken, decryptTokenBlob } from "../services/oauthTokenLifecycle";
// Phase 197 (MCPO-03 D-08): the shared revoke+wipe helper consumed by both
// hard-delete paths (generic DELETE here + marketplace uninstall).
import { revokeAndWipeCredentials } from "../services/mcpUninstallService";
import { getEnv } from "../config/env";

const router = Router();

// All MCP connection management requires admin access
router.use(authMiddleware, tenantContextMiddleware, requireAdmin);

/**
 * Phase 196 (MCPO-02 D-03a): derive the sanitized provider-error summary —
 * the first ≤200 chars of the stored provider-prose oauthError, or null.
 * The raw text is safe to summarize: Phase 195 guarantees every write site
 * stores provider error_description prose (token-free — oauthTokenLifecycle
 * failure paths carry only descriptions). BOTH the sanitize helper and the
 * /statuses enrichment derive through this ONE helper to prevent drift.
 * Raw provider error JSON bodies are never included (message text only).
 */
function deriveOauthErrorSummary(oauthError: unknown): string | null {
  return typeof oauthError === "string" && oauthError.length > 0
    ? oauthError.slice(0, 200)
    : null;
}

/**
 * Phase 195 (MCPO-01, Pitfall 1 / T-195-09): strip the secret-bearing oauth
 * columns before ANY row spread reaches a response body.
 *
 * - credentialsEncrypted (AES-256-GCM blob) and oauthError (provider error
 *   text) are SECRET-BEARING / noise — never exposed.
 * - oauthStatus, tokenExpiresAt, authType, oauthProvider are NON-secret and
 *   Phase 196's UI badges need them — kept.
 * - Phase 196 (D-03a): oauthErrorSummary rides along — the sanitized
 *   ≤200-char provider-error prose the ✗ badge tooltip renders (the raw
 *   oauthError stays stripped).
 *
 * Applied at every former `...row` spread site (GET list, POST create, PUT
 * update, and the reconnect-warning arm of PUT). The headers deserialization
 * rides the same helper so all sites stay in one shape.
 *
 * WR-05 (defensive parse): headers are normally written via JSON.stringify,
 * but a legacy row, manual DB edit, or partial write can carry invalid JSON —
 * an unguarded JSON.parse here would turn ONE bad row into a 500 for the
 * entire admin list (GET /, POST /, PUT / all funnel responses through this
 * helper). A corrupt row degrades to `{}` instead (per-row, not wholesale).
 */
function sanitizeMcpConnection(row: Record<string, unknown>): Record<string, unknown> {
  const { credentialsEncrypted: _ce, oauthError: _oe, headers, ...rest } = row;
  let parsedHeaders: Record<string, unknown> = {};
  if (typeof headers === "string" && headers.length > 0) {
    try {
      const parsed: unknown = JSON.parse(headers);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedHeaders = parsed as Record<string, unknown>;
      }
    } catch {
      parsedHeaders = {}; // corrupt JSON degrades per-row (WR-05)
    }
  } else if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    // Deserialized shape (should not occur on read paths, but never throw).
    parsedHeaders = headers as Record<string, unknown>;
  }
  return {
    ...rest,
    oauthErrorSummary: deriveOauthErrorSummary(_oe),
    headers: parsedHeaders,
  };
}

// Route 1: GET / — List all MCP connections
router.get("/", async (_req: Request, res: Response) => {
  try {
    const connections = await prisma.mCPConnection.findMany({
      orderBy: { createdAt: "desc" } as const,
    });
    res.json(connections.map(c => sanitizeMcpConnection(c)));
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
        // Phase 196 (MCPO-02 D-03a): the sanitized badge-matrix field set the
        // frontend OAuth badges render from — secrets stay stripped (the
        // statuses route hand-picks fields, so the summary derives through
        // the same shared helper as sanitizeMcpConnection).
        authType: c.authType,
        oauthProvider: c.oauthProvider,
        oauthStatus: c.oauthStatus,
        tokenExpiresAt: c.tokenExpiresAt,
        oauthScopes: c.oauthScopes,
        oauthErrorSummary: deriveOauthErrorSummary(c.oauthError),
        // CR-02: re-include the deserialized static headers. Phase 196
        // repointed the settings list to /statuses, which omitted headers —
        // the edit dialog seeded from `connection.headers` (always undefined
        // → empty rows) and every Save PUT an `headers: {}` over the row,
        // silently destroying the stored static auth headers. Route 1
        // already returns headers to this same admin-gated audience; the
        // parse rides the same defensive posture as sanitizeMcpConnection
        // (WR-05: a corrupt JSON row degrades to {} here too, keeping the
        // whole list page alive). Secret-bearing columns stay stripped.
        headers: (() => {
          if (typeof c.headers === "string" && c.headers.length > 0) {
            try {
              const parsed: unknown = JSON.parse(c.headers);
              return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : {};
            } catch {
              return {}; // corrupt JSON degrades per-row (WR-05)
            }
          }
          return {};
        })(),
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

    const { name, url, transportType, projectId, workspaceId, headers, enabled, authType, oauthProvider, oauthScopes, oauthClientId } = parsed.data;

    const connection = await prisma.mCPConnection.create({
      data: {
        name,
        url,
        transportType,
        projectId: projectId ?? null,
        workspaceId: workspaceId ?? null,
        headers: headers ? JSON.stringify(headers) : "{}",
        enabled: enabled ?? true,
        // Phase 195 (D-03/D-01): persist the validated OAuth fields. The
        // schema's refine already enforces provider-required-for-oauth and
        // rejects spurious oauth-* fields on non-oauth authTypes.
        authType: authType ?? "none",
        oauthProvider: oauthProvider ?? null,
        oauthScopes: oauthScopes ?? null,
        oauthClientId: oauthClientId ?? null,
        // CR-03 (185-05, D-04): explicit org stamp (MCPConnection is Tier-A —
        // cross-org reads hide as 404 via the post-fetch assertion; the row
        // itself must carry the creator's org to be self-visible).
        organizationId: req.organizationId!,
      },
    });

    // Auto-connect if enabled
    if (connection.enabled) {
      connectMCPServer(connection.id).catch((err: unknown) => {
        logger.error("[mcp] Auto-connect failed", { connectionId: connection.id, error: (err instanceof Error ? err.message : String(err)) });
      });
    }

    res.status(201).json(sanitizeMcpConnection(connection));
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
    // T-185-10 org assertion: cross-org connection hides as 404 (fail-closed).
    if (!existing || existing.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    const updateData: Record<string, unknown> = { ...parsed.data };

    // WR-04: an auth-semantics transition (authType flip, or provider change
    // on an oauth row) invalidates the stored credential material — the old
    // blob belongs to the previous auth identity (a Google token under a
    // Microsoft-configured row, or a decryptable blob on a non-oauth row
    // that could be silently reused after flipping back). Clears in the SAME
    // update so the row never rests in a mixed state.
    const authTypeChanged =
      parsed.data.authType !== undefined && parsed.data.authType !== existing.authType;
    const providerChanged =
      parsed.data.oauthProvider !== undefined && parsed.data.oauthProvider !== existing.oauthProvider;
    if (authTypeChanged || providerChanged) {
      updateData.credentialsEncrypted = null;
      updateData.tokenExpiresAt = null;
      updateData.oauthStatus = "none";
      updateData.oauthError = null;
    }

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
          ...sanitizeMcpConnection(updated),
          _warning: `Reconnect failed: ${(err instanceof Error ? err.message : String(err))}`,
        });
        return;
      }
    }

    res.json(sanitizeMcpConnection(updated));
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
    // T-185-10 org assertion: cross-org connection hides as 404 (fail-closed).
    if (!connection || connection.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    await disconnectMCPServer(connectionId);
    unregisterSkillsForConnection(connection.id);

    // Phase 197 (MCPO-03 D-08): best-effort provider-side revocation BEFORE
    // the hard delete — the generic DELETE can remove a marketplace-installed
    // oauth connection too; the blob dies with the row (no orphan
    // credentialsEncrypted after either path).
    await revokeAndWipeCredentials(connection);

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
    // T-185-10 org assertion: cross-org connection hides as 404 (fail-closed).
    if (!connection || connection.organizationId !== req.organizationId) {
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
    // T-185-10 org assertion: cross-org connection hides as 404 (fail-closed).
    if (!connection || connection.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    // Disconnect any active connection first
    await disconnectMCPServer(connectionId);

    const url = connection.url;
    // Phase 195 (MCPO-01 D-15a): resolve headers through the SAME
    // resolveConnectionHeaders helper connectMCPServer uses — the admin
    // validates the config the same way the live path runs (oauth rows get
    // the server-built Bearer; none/static keep the mcpHeadersSchema path).
    // No duplicated OAuth/header logic in the route.
    const resolved = resolveConnectionHeaders(connection);
    if (!resolved.ok) {
      res.json({ success: false, error: resolved.error });
      return;
    }
    const headers = resolved.headers;
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

// ─── Phase 195 (MCPO-01): OAuth authorize flow (D-06/D-07/D-14/D-15) ────
// Both routes ride the router-level admin gate AND layer a per-route
// requirePermission("mcp:oauth:manage") (D-15 — the archiveConfig.ts:23
// pattern), deliberately separate from requireAdmin so "configure but not
// authorize" delegations become possible.

/**
 * Resolve the env-carried client credentials for a provider (D-06 — env-only
 * in v1; the per-org oauthClientId column stays dormant). Values flow ONLY
 * into the authorize URL / token calls — never logged, never echoed.
 */
function clientCredentials(providerId: string): { clientId: string; clientSecret: string } {
  const env = getEnv();
  if (providerId === "google") {
    return { clientId: env.GOOGLE_CLIENT_ID ?? "", clientSecret: env.GOOGLE_CLIENT_SECRET ?? "" };
  }
  if (providerId === "microsoft") {
    return { clientId: env.MICROSOFT_CLIENT_ID ?? "", clientSecret: env.MICROSOFT_CLIENT_SECRET ?? "" };
  }
  return { clientId: "", clientSecret: "" };
}

// Route 8: POST /:connectionId/oauth/start — mint the signed state + PKCE
// pair, flip the row to pending, return { authorizeUrl } (D-07).
router.post("/:connectionId/oauth/start", requirePermission("mcp:oauth:manage"), async (req: Request, res: Response) => {
  try {
    const paramResult = mcpConnectionIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connection ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { connectionId } = paramResult.data;

    const connection = await prisma.mCPConnection.findUnique({ where: { id: connectionId } });
    // T-185-10 org assertion: cross-org connection hides as 404 (fail-closed).
    if (!connection || connection.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    // The row must be an oauth-type connection with a known provider.
    if (connection.authType !== "oauth" || !connection.oauthProvider) {
      res.status(400).json({ error: "Connection is not configured for OAuth" });
      return;
    }
    const def = resolveProvider(connection.oauthProvider);
    if (!def) {
      res.status(400).json({ error: "Unknown OAuth provider" });
      return;
    }

    // D-06: no client configured → clear 400 (never a 500).
    if (!hasClientConfigured(connection.oauthProvider)) {
      res.status(400).json({ error: "OAuth provider client not configured" });
      return;
    }

    // Mint the signed state (JWT_SECRET HS256, 10-min exp) + PKCE verifier.
    // The verifier lives in the process-memory Map ONLY (D-08) — it is used
    // to build the authorize URL below and never leaves the process.
    const { state, verifier } = signOAuthState(connectionId);

    // Scope-REDUCE-ONLY resolution (T-195-02): the row's stored oauthScopes
    // string is intersected with the provider defaults — never amplified.
    const scopes = resolveScopes(def, connection.oauthScopes ?? undefined);

    const authorizeUrl = buildAuthorizeUrl(def, {
      clientId: clientCredentials(connection.oauthProvider).clientId,
      redirectUri: resolveRedirectUri(),
      scopes,
      state,
      codeVerifier: verifier,
    });

    await prisma.mCPConnection.update({
      where: { id: connectionId },
      data: { oauthStatus: "pending", oauthError: null },
    });

    // Audit trail (T-195-10): action + provider only. The state rides inside
    // authorizeUrl by the OAuth spec's design (the IdP echoes it back) — that
    // is the IdP contract, NOT a response leak; it is never echoed in a
    // second field here.
    await logEvent("mcp_connection", connectionId, "mcp.oauth_started", req.userId!, { provider: connection.oauthProvider });

    // oauthStartResponseSchema shape: exactly { authorizeUrl } — no
    // state/code/token field beyond it.
    res.json({ authorizeUrl });
  } catch (err: unknown) {
    logger.error("[mcp] Error starting OAuth flow", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route 9: DELETE /:connectionId/oauth — provider-revoke (Google; MS skipped,
// RESEARCH A1) + wipe ALL credential columns + reconnect as static path (D-14).
router.delete("/:connectionId/oauth", requirePermission("mcp:oauth:manage"), async (req: Request, res: Response) => {
  try {
    const paramResult = mcpConnectionIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connection ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { connectionId } = paramResult.data;

    const connection = await prisma.mCPConnection.findUnique({ where: { id: connectionId } });
    // T-185-10 org assertion: cross-org connection hides as 404 (fail-closed).
    if (!connection || connection.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    // Best-effort provider-side revocation (T-195-13): local blob wipe is
    // ALWAYS the primary revocation; Google's revoke endpoint is best-effort
    // (revoking the access token also revokes its refresh token); Microsoft
    // has no RFC-7009 endpoint and returns { ok: true, skipped: true }.
    if (connection.credentialsEncrypted && connection.oauthProvider) {
      const def = resolveProvider(connection.oauthProvider);
      if (def) {
        const decoded = decryptTokenBlob(connection.credentialsEncrypted);
        if (decoded.ok) {
          await revokeProviderToken(def, decoded.blob.accessToken);
        }
      }
    }

    await prisma.mCPConnection.update({
      where: { id: connectionId },
      data: {
        credentialsEncrypted: null,
        tokenExpiresAt: null,
        oauthStatus: "none",
        oauthError: null,
        // KEEP authType "oauth" + oauthProvider so re-authorizing needs no
        // reconfiguration (D-14: revoke ≠ unconfigure — the admin only drops
        // the grant, the connection keeps its OAuth identity).
      },
    });

    // Reconnect as the static path (D-14): drop the live connection first,
    // then re-connect if the row is enabled. connectMCPServer now resolves
    // headers through resolveConnectionHeaders (Task 2) — an authType=oauth
    // row with a wiped blob refuses to start with a clear error, which is
    // the correct post-revoke posture.
    await disconnectMCPServer(connectionId);
    if (connection.enabled) {
      clearConnectionError(connectionId);
      connectMCPServer(connectionId).catch((err: unknown) => {
        logger.error("[mcp] Reconnect after OAuth revoke failed", { connectionId, error: (err instanceof Error ? err.message : String(err)) });
      });
    }

    await logEvent("mcp_connection", connectionId, "mcp.oauth_revoked", req.userId!, { provider: connection.oauthProvider ?? "" });

    res.json({ revoked: true });
  } catch (err: unknown) {
    logger.error("[mcp] Error revoking OAuth", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;