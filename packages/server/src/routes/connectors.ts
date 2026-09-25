// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-01b, ECCO-01/ECCO-03) — external chat-connector route surface.
//
// TWO exports on ONE file (widget/widgets.ts split precedent is inverted
// here: the PUBLIC webhook surface must mount BEFORE the JWT catch-all and
// must NOT carry the admin gate, so it is a separate mini-router):
//
//   1. connectorsRoutes (default) — admin CRUD behind
//      authMiddleware → tenantContextMiddleware → requireAdmin (mcp.ts gate
//      shape) + per-route requirePermission("connector:manage"|"connector:view").
//   2. connectorsWebhookRouter — PUBLIC platform webhook surface. NO RBAC:
//      the platform signature (X-Telegram-Bot-Api-Secret-Token, timing-safe
//      compare) is the ONLY auth (D-06). Tenant identity is resolved from
//      the DB row by :connectorId — NEVER from any request-supplied field
//      (T-198-04). Mounted in index.ts BEFORE connectorsRoutes and before
//      the JWT catch-all (widget mount precedent, index.ts:721).
//
// SECRET DISCIPLINE (D-03/D-14, T-198-03): botTokenEncrypted,
// configEncrypted and the decrypted config NEVER appear in any response or
// log — serializeConnector strips the columns and adds hasBotToken /
// hasWebhookSecret booleans.
//
// BigInt (P-1): pollOffset is the repo's FIRST BigInt column — res.json
// throws `TypeError: Do not know how to serialize a BigInt` on it, so
// serializeConnector omits the runtime field entirely (widget-CRUD
// runtime-field-omission principle) and every CRUD response goes through it.

import { Router, json, type Request, type Response } from "express";
import crypto from "crypto";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireAdmin, requirePermission } from "../middleware/rbac";
import {
  createConnectorSchema,
  updateConnectorSchema,
  validateTokenSchema,
  webhookSetupSchema,
  connectorIdParamSchema,
} from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { runInTenant } from "../utils/tenantContext";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";
import { encrypt, decrypt } from "../services/encryptionService";
import { logEvent } from "../services/eventLogService";
import { isPlatformImplemented, getAdapter } from "../services/connectors/registry";
import { handleIncomingMessage } from "../services/connectors/messageRouter";
// Phase 200 (D-03): the Slack signature verification helper — the v0
// basestring recomputation + timing-safe compare + the 5-min anti-replay
// window (boolean-only failure paths, D-14).
import { verifySlackSignature, isFreshTimestamp } from "../services/connectors/slackVerify";
// Phase 199 (199-03, D-05 sync-on-mutation): admin CRUD arms reconcile the
// gateway client so a UI-created/enabled/discord connector gets a live WS
// client WITHOUT a server restart. Best-effort in every arm — a gateway
// sync failure NEVER changes the HTTP status (the reconnect ladder owns
// recovery; the 201/200/200 responses are unaffected).
import { syncDiscordConnector } from "../services/connectors/discordGateway";
import type { EntityType } from "@simmetric-chat/shared";
// Phase 200: the slack async-arm parse call shape (IncomingMessage return).
import type { IncomingMessage } from "../services/connectors/base";

// ===== Types =====

/** The decrypted per-platform config blob (configEncrypted ↔ JSON). */
interface ConnectorConfig {
  webhookSecret?: string;
  [key: string]: unknown;
}

interface TenantConnector {
  id: string;
  platform: string;
  workspaceId: string;
  isEnabled: boolean;
  deletedAt: Date | null;
  configEncrypted: string | null;
  [key: string]: unknown;
}

// declare global { namespace Express } — same shape internalWidget.ts uses
// (:105-113) for req.tenantWidget; the webhook slot stashes the resolved
// connector row here (WR-05: one resolution per request).
declare global {
  namespace Express {
    interface Request {
      /** ChatConnector row resolved ONCE by the webhook tenant slot (198-01b WR-05) — handlers consume the stash, never re-query. */
      tenantConnector?: TenantConnector;
    }
  }
}

// ===== Helpers =====

/**
 * Timing-safe comparison over RAW header bytes (documents.ts:122-127
 * pattern, D-14). String `!==` short-circuits on the first differing byte,
 * leaking the secret length/prefix via timing.
 */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Parse the decrypted configEncrypted blob into a ConnectorConfig, or null
 * when the column is empty / the blob is not a JSON object.
 */
function parseConfig(raw: string | null): ConnectorConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decrypt(raw)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ConnectorConfig;
    }
    return null;
  } catch (err: unknown) {
    // A corrupt/unencryptable config must not 500 a webhook — fail closed
    // (treated as no-config). Logged without any blob material (D-14).
    logger.warn("[connectors] configEncrypted parse failed — treating as no config", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * P-1 (repo's FIRST BigInt): serialize a ChatConnector row for a CRUD
 * response. Omits the runtime pollOffset field entirely (BigInt is not
 * JSON-serializable — res.json throws), the encrypted secret columns
 * (botTokenEncrypted/configEncrypted — T-198-03) and any decrypted config;
 * adds hasBotToken/hasWebhookSecret booleans (D-03/D-14).
 */
function serializeConnector(row: Record<string, unknown>): Record<string, unknown> {
  const { botTokenEncrypted: _token, configEncrypted: _config, pollOffset: _offset, ...rest } = row;
  void _token;
  void _config;
  void _offset;
  const config = parseConfig(typeof _config === "string" ? _config : null);
  return {
    ...rest,
    hasBotToken: Boolean(_token),
    hasWebhookSecret: Boolean(config?.webhookSecret),
    // Phase 200 (D-03/D-15 leak-strip): presence booleans computed from the
    // DECRYPTED blob — never the secret values themselves.
    hasSigningSecret: Boolean(config?.signingSecret),
    hasVerifyToken: Boolean(config?.verifyToken),
  };
}

// ===== Admin router =====

const router = Router();

// All connector management requires admin access (mcp.ts gate shape, D-05).
router.use(authMiddleware, tenantContextMiddleware, requireAdmin);

// POST /api/connectors — Create (connector:manage)
router.post("/", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  try {
    const parsed = createConnectorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    // D-03 fail-closed platform check: unimplemented platform → 400 (the
    // registry stub returns false for all four until 198-02/199/200 fill it).
    if (!isPlatformImplemented(parsed.data.platform)) {
      res.status(400).json({ error: "Platform not implemented yet" });
      return;
    }

    // T-198-04/WR-05: the workspace FK proves EXISTENCE, not org ownership —
    // assert the bound workspace belongs to the request principal's org
    // (widget-create whitelist pattern). Without this an admin can bind a
    // connector to another org's workspace, and the two org-stamp paths
    // diverge (connector org ≠ workspace org → the webhook-arm tenant window
    // filters the chat history to empty).
    const workspace = await prisma.workspace.findUnique({
      where: { id: parsed.data.workspaceId },
      select: { id: true, organizationId: true, deletedAt: true },
    });
    if (!workspace || workspace.deletedAt !== null || workspace.organizationId !== req.organizationId) {
      res.status(400).json({ error: "Workspace not found in your organization" });
      return;
    }
    if (parsed.data.archiveId) {
      const archive = await prisma.archive.findUnique({
        where: { id: parsed.data.archiveId },
        select: { id: true, organizationId: true, deletedAt: true },
      });
      if (!archive || archive.deletedAt !== null || archive.organizationId !== req.organizationId) {
        res.status(400).json({ error: "Archive not found in your organization" });
        return;
      }
    }

    // The org identity is stamped from the REQUEST PRINCIPAL (CR-03 pattern)
    // — never from body-supplied fields.
    // Phase 200 (D-16 blob-carried / BLOCKER-1 wiring): the per-platform
    // config fields submitted at create (slack signingSecret; whatsapp
    // phoneNumberId/appSecret/verifyToken/whatsappBusinessAccountId) are
    // persisted INSIDE configEncrypted — a fresh encrypt (no prior blob on
    // create; the webhookSecret merge shape at :541-546 is the update-path
    // mirror). Stripped of undefined so a partial submission persists only
    // what was sent. NEVER echoed back (hasSigningSecret/hasVerifyToken
    // booleans only, D-03/D-15).
    const platformConfig: Record<string, string> = {};
    if (typeof parsed.data.signingSecret === "string") platformConfig.signingSecret = parsed.data.signingSecret;
    if (typeof parsed.data.phoneNumberId === "string") platformConfig.phoneNumberId = parsed.data.phoneNumberId;
    if (typeof parsed.data.appSecret === "string") platformConfig.appSecret = parsed.data.appSecret;
    if (typeof parsed.data.verifyToken === "string") platformConfig.verifyToken = parsed.data.verifyToken;
    if (typeof parsed.data.whatsappBusinessAccountId === "string") platformConfig.whatsappBusinessAccountId = parsed.data.whatsappBusinessAccountId;
    const hasPlatformConfig = Object.keys(platformConfig).length > 0;

    const connector = await prisma.chatConnector.create({
      data: {
        platform: parsed.data.platform,
        name: parsed.data.name,
        workspaceId: parsed.data.workspaceId,
        archiveId: parsed.data.archiveId ?? null,
        botTokenEncrypted: encrypt(parsed.data.botToken),
        ...(hasPlatformConfig ? { configEncrypted: encrypt(JSON.stringify(platformConfig)) } : {}),
        welcomeMessage: parsed.data.welcomeMessage ?? null,
        fallbackMessage: parsed.data.fallbackMessage,
        fallbackLocale: parsed.data.fallbackLocale,
        rateLimitPerMinute: parsed.data.rateLimitPerMinute,
        sessionLimitPerDay: parsed.data.sessionLimitPerDay,
        responseProviderId: parsed.data.responseProviderId,
        responseModel: parsed.data.responseModel,
        organizationId: req.organizationId!,
        createdBy: req.userId!,
      },
    });

    res.status(201).json(serializeConnector(connector as unknown as Record<string, unknown>));

    // Phase 199 (D-05 sync-on-mutation): the created discord connector gets
    // its live gateway client immediately. BEST-EFFORT — a connect failure
    // (bad gateway URL, decrypt error) logs and resolves; the 201 already
    // returned (fire-and-forget with a logged catch — the reconnect ladder
    // owns recovery).
    if ((connector as { platform?: string }).platform === "discord") {
      try {
        syncDiscordConnector(connector as unknown as Parameters<typeof syncDiscordConnector>[0]);
      } catch (syncErr: unknown) {
        logger.warn("[connectors] discord gateway sync failed (best-effort, created)", {
          connectorId: connector.id,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
      }
    }
  } catch (err: unknown) {
    logger.error("[connectors] Error creating connector", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/connectors/oauth/providers — OAuth-provider visibility signal
// (Phase 200, UI-SPEC contract 4): the create dialog's "Connect with Slack"
// outline button renders ONLY when the configured-flag reports true. Boolean
// surface ONLY — no client IDs, no redirect URIs, no secret material
// (T-200-13: the browser receives `configured: true|false` and nothing more).
// Registered BEFORE GET /:id so ":id" never swallows the "oauth" segment.
router.get("/oauth/providers", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  res.json({
    providers: [{ id: "slack", configured: hasClientConfigured("slack") }],
  });
});

// GET /api/connectors — List (connector:view). WR-03: scoped to the admin's
// org + tombstoned rows excluded — the tenant extension's admin-bypass arm
// gives platform admins GLOBAL read visibility, so without an explicit where
// this surfaced every org's connectors INCLUDING soft-deleted ones while
// GET /:id 404-hides both (the two read surfaces disagreed). One semantics:
// org-scoped, soft-delete-aware — mirroring the detail route's 404-hide
// semantics.
router.get("/", requirePermission("connector:view"), async (req: Request, res: Response) => {
  try {
    const connectors = await prisma.chatConnector.findMany({
      where: { organizationId: req.organizationId, deletedAt: null },
      orderBy: { createdAt: "desc" } as const,
    });
    res.json(connectors.map((c) => serializeConnector(c as unknown as Record<string, unknown>)));
  } catch (err: unknown) {
    logger.error("[connectors] Error listing connectors", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/connectors/:id — Detail (connector:view, 404-hide on org mismatch)
router.get("/:id", requirePermission("connector:view"), async (req: Request, res: Response) => {
  try {
    const paramResult = connectorIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connector ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { id } = paramResult.data;

    const connector = await prisma.chatConnector.findFirst({ where: { id } });
    // 404-hide (mcp.ts:158-163 pattern): cross-org rows are indistinguishable
    // from nonexistent ones.
    if (!connector || connector.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    res.json(serializeConnector(connector as unknown as Record<string, unknown>));
  } catch (err: unknown) {
    logger.error("[connectors] Error fetching connector", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/connectors/:id — Update (connector:manage; NEVER accepts botToken/config — D-03)
router.put("/:id", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  try {
    const paramResult = connectorIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connector ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { id } = paramResult.data;

    const parsed = updateConnectorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const existing = await prisma.chatConnector.findFirst({ where: { id } });
    // 404-hide: cross-org update is indistinguishable from nonexistent.
    if (!existing || existing.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    // D-15/D-16 (P-7 desync protection): a pollMode SWITCH syncs the
    // platform-side webhook BEFORE persisting the new mode —
    //   webhook→polling: deleteWebhook FIRST (Telegram forbids getUpdates
    //     while a webhook is active — the 409 conflict);
    //   polling→webhook: setWebhook (stored/regenerated secret) FIRST.
    // A platform-side failure returns 502 { error } and does NOT flip
    // pollMode — the DB and Telegram never desync (P-7).
    if (
      parsed.data.pollMode &&
      parsed.data.pollMode !== existing.pollMode &&
      isPlatformImplemented(existing.platform)
    ) {
      const adapter = getAdapter(existing.platform) as {
        setWebhook?: (c: unknown, url: string, secret: string) => Promise<unknown>;
        removeWebhook?: (c: unknown) => Promise<unknown>;
      } | undefined;
      try {
        if (parsed.data.pollMode === "polling" && existing.pollMode === "webhook") {
          if (adapter?.removeWebhook) {
            await adapter.removeWebhook(existing);
          }
        } else if (parsed.data.pollMode === "webhook" && existing.pollMode === "polling") {
          // The stored secret is required for setWebhook; a connector that
          // never ran webhook-setup has none — 502 (admin must run
          // webhook-setup first, D-14 lifecycle).
          const config = parseConfig(existing.configEncrypted);
          const secret = config?.webhookSecret;
          if (!adapter?.setWebhook || typeof secret !== "string" || !secret) {
            res.status(502).json({ error: "Webhook secret not configured — run webhook-setup first" });
            return;
          }
          // The public base URL for the platform-side setWebhook call rides
          // SERVER_URL (env) + the canonical webhook path.
          const webhookUrl = `${getEnv().SERVER_URL}/api/connectors/telegram/${existing.id}/webhook`;
          await adapter.setWebhook(existing, webhookUrl, secret);
        }
      } catch (err: unknown) {
        // Platform call failed → do NOT flip pollMode (desync protection).
        logger.error("[connectors] pollMode switch platform call failed", {
          connectorId: id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(502).json({ error: "Platform webhook sync failed — pollMode unchanged" });
        return;
      }
    }

    // updateConnectorSchema strips botToken/configEncrypted at Zod level
    // (D-03 write-only discipline) — the spread below cannot re-introduce
    // them.
    const updated = await prisma.chatConnector.update({
      where: { id },
      data: { ...parsed.data },
    });

    res.json(serializeConnector(updated as unknown as Record<string, unknown>));

    // Phase 199 (D-05 sync-on-mutation): a mutated discord row (isEnabled /
    // welcome edit / anything) re-syncs its gateway client — close stale +
    // reconnect fresh on enable, close on disable. BEST-EFFORT (the 200
    // already returned; never fails the admin mutation).
    if ((updated as { platform?: string }).platform === "discord") {
      try {
        syncDiscordConnector(updated as unknown as Parameters<typeof syncDiscordConnector>[0]);
      } catch (syncErr: unknown) {
        logger.warn("[connectors] discord gateway sync failed (best-effort, updated)", {
          connectorId: id,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
      }
    }
  } catch (err: unknown) {
    logger.error("[connectors] Error updating connector", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/connectors/:id — Soft delete (connector:manage)
router.delete("/:id", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  try {
    const paramResult = connectorIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connector ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { id } = paramResult.data;

    const connector = await prisma.chatConnector.findFirst({ where: { id } });
    // 404-hide.
    if (!connector || connector.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    // Soft delete is the norm (server AGENTS.md) — hard delete would cascade
    // sessions/messages; the soft path keeps the audit trail.
    const deleted = await prisma.chatConnector.update({
      where: { id },
      data: { deletedAt: new Date(), isEnabled: false },
    });

    // D-21/OQ-2: audit log entity "chat_connector" (EntityType landed in 198-01).
    await logEvent("chat_connector" as EntityType, id, "chat_connector.deleted", req.userId!, {
      workspaceId: connector.workspaceId,
      platform: connector.platform,
      name: connector.name,
    });

    // Best-effort platform-side webhook removal — the adapter may be absent
    // pre-198-02 (registry stub returns undefined for every platform), so
    // wrap in an existence check and NEVER fail the delete on it.
    if (deleted.pollMode === "webhook" && isPlatformImplemented(deleted.platform)) {
      const adapter = getAdapter(deleted.platform) as { removeWebhook?: (c: unknown) => Promise<unknown> } | undefined;
      if (adapter?.removeWebhook) {
        adapter.removeWebhook(deleted).catch((err: unknown) => {
          logger.warn("[connectors] removeWebhook failed (best-effort)", {
            connectorId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // Phase 199 (D-05 sync-on-mutation): the tombstoned row's gateway client
    // closes (isEnabled=false was set above — the sync's disabled arm owns
    // it). BEST-EFFORT alongside the existing removeWebhook call — the 200
    // already returned.
    if ((deleted as { platform?: string }).platform === "discord") {
      try {
        syncDiscordConnector(deleted as unknown as Parameters<typeof syncDiscordConnector>[0]);
      } catch (syncErr: unknown) {
        logger.warn("[connectors] discord gateway sync failed (best-effort, deleted)", {
          connectorId: id,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
      }
    }

    res.json({ message: "Connector deleted" });
  } catch (err: unknown) {
    logger.error("[connectors] Error deleting connector", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/connectors/:platform/validate — Validate bot token (connector:manage)
// D-05: calls the platform with the SUBMITTED token and NEVER persists it —
// persistence happens only via create (encrypt(botToken)).
router.post("/:platform/validate", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  try {
    const parsed = validateTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    if (!isPlatformImplemented(parsed.data.platform)) {
      res.status(400).json({ error: "Platform not implemented yet" });
      return;
    }

    const adapter = getAdapter(parsed.data.platform) as { validateBotToken?: (token: string) => Promise<{ valid: boolean; botUsername?: string | null; botDisplayName?: string | null }> } | undefined;
    if (!adapter?.validateBotToken) {
      res.status(400).json({ error: "Platform not implemented yet" });
      return;
    }

    // Phase 200: the platform config fields ride the validate INPUT only —
    // the probe may consume them (e.g. the WhatsApp phone probe reads
    // phoneNumberId from the submitted body) and NOTHING is persisted here
    // (D-05: validate never persists).
    void parsed.data.signingSecret;
    void parsed.data.phoneNumberId;
    void parsed.data.appSecret;
    void parsed.data.verifyToken;
    void parsed.data.whatsappBusinessAccountId;

    const result = await adapter.validateBotToken(parsed.data.botToken);
    res.json({
      valid: result.valid,
      botUsername: result.botUsername ?? null,
      botDisplayName: result.botDisplayName ?? null,
    });
  } catch (err: unknown) {
    logger.error("[connectors] Error validating token", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/connectors/:id/webhook-setup — Generate + persist webhook secret (connector:manage)
// D-14: secret is 48 chars in [A-Za-z0-9_-] (crypto.randomBytes(36).base64url),
// persisted INSIDE configEncrypted and NEVER returned (hasWebhookSecret only).
// WR-04: the platform setWebhook is AWAITED and ordered BEFORE the persist —
// mirroring the PUT pollMode-switch semantics (platform call first, 502 + no
// persistence on failure). A fire-and-forget call left a silently dead
// connector on a platform-side failure (pollMode=webhook persisted, no
// platform registration, no updates ever arrive, admin got 200).
router.post("/:id/webhook-setup", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  try {
    const paramResult = connectorIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connector ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { id } = paramResult.data;

    const parsed = webhookSetupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const connector = await prisma.chatConnector.findFirst({ where: { id } });
    // 404-hide.
    if (!connector || connector.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    // Generate the platform webhook secret (D-14).
    const webhookSecret = crypto.randomBytes(36).toString("base64url");

    // WR-04: platform-side setWebhook FIRST — a Telegram-side failure (401
    // token, invalid URL) returns 502 and persists NOTHING (no secret, no
    // pollMode flip): the DB and Telegram never desync (P-7, PUT-switch
    // parity). An ABSENT adapter (pre-198-02 / unimplemented platform) is
    // not an error — the secret persists without the platform call.
    if (isPlatformImplemented(connector.platform)) {
      const adapter = getAdapter(connector.platform) as { setWebhook?: (c: unknown, url: string, secret: string) => Promise<unknown> } | undefined;
      if (adapter?.setWebhook) {
        try {
          await adapter.setWebhook(connector, parsed.data.url, webhookSecret);
        } catch (err: unknown) {
          logger.error("[connectors] setWebhook failed — nothing persisted", {
            connectorId: id,
            error: err instanceof Error ? err.message : String(err),
          });
          res.status(502).json({ error: "Platform webhook registration failed — nothing persisted" });
          return;
        }
      }
    }

    // Platform call succeeded (or had nothing to do) — NOW persist the
    // merged config blob + pollMode flip (preserving any existing keys).
    const existingConfig = parseConfig(connector.configEncrypted) ?? {};
    const newConfig: ConnectorConfig = { ...existingConfig, webhookSecret };

    const updated = await prisma.chatConnector.update({
      where: { id },
      data: { configEncrypted: encrypt(JSON.stringify(newConfig)), pollMode: "webhook" },
    });

    // NEVER return the secret (D-14) — hasWebhookSecret boolean only.
    res.json(serializeConnector(updated as unknown as Record<string, unknown>));
  } catch (err: unknown) {
    logger.error("[connectors] Error setting up webhook", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/connectors/:id/webhook-remove — Strip webhook secret (connector:manage)
router.post("/:id/webhook-remove", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  try {
    const paramResult = connectorIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connector ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { id } = paramResult.data;

    const connector = await prisma.chatConnector.findFirst({ where: { id } });
    // 404-hide.
    if (!connector || connector.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    // Best-effort platform-side removeWebhook (adapter may be absent
    // pre-198-02 — wrap in an existence check).
    if (isPlatformImplemented(connector.platform)) {
      const adapter = getAdapter(connector.platform) as { removeWebhook?: (c: unknown) => Promise<unknown> } | undefined;
      if (adapter?.removeWebhook) {
        adapter.removeWebhook(connector).catch((err: unknown) => {
          logger.warn("[connectors] removeWebhook failed (best-effort)", {
            connectorId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // Strip webhookSecret from the config blob (keep other keys).
    const existingConfig = parseConfig(connector.configEncrypted) ?? {};
    const { webhookSecret: _removed, ...restConfig } = existingConfig;
    void _removed;
    const updated = await prisma.chatConnector.update({
      where: { id },
      data: {
        configEncrypted: encrypt(JSON.stringify(restConfig)),
        pollMode: "polling",
      },
    });

    res.json(serializeConnector(updated as unknown as Record<string, unknown>));
  } catch (err: unknown) {
    logger.error("[connectors] Error removing webhook", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/connectors/:id/test — Send a test message (connector:manage)
// 198-01b stub: unimplemented platform → 400 (198-02 Task 3 completes the
// adapter-driven send).
router.post("/:id/test", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  try {
    const paramResult = connectorIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connector ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { id } = paramResult.data;

    const connector = await prisma.chatConnector.findFirst({ where: { id } });
    // 404-hide.
    if (!connector || connector.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    if (!isPlatformImplemented(connector.platform)) {
      res.status(400).json({ error: "Platform not implemented yet" });
      return;
    }

    // 198-02 completes the adapter-driven send.
    const adapter = getAdapter(connector.platform) as { sendMessage?: (c: unknown, userId: string, text: string) => Promise<unknown> } | undefined;
    const platformUserId = typeof (req.body as Record<string, unknown> | undefined)?.platformUserId === "string"
      ? (req.body as Record<string, unknown>).platformUserId as string
      : "";
    if (!adapter?.sendMessage || !platformUserId) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    await adapter.sendMessage(connector, platformUserId, "Test message from Simmetric Chat");
    res.json({ sent: true });
  } catch (err: unknown) {
    logger.error("[connectors] Error sending test message", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/connectors/:id/oauth/start — the "Add to Slack" install start
// (Phase 200 ECCO-06, D-05 — mcp.ts Route-8 shape :526-580 riding the SAME
// Phase 195 registry). Mints a CONNECTOR-audience signed state + PKCE pair
// and returns { authorizeUrl } built from the registry's slack def.
//
// NOTE the missing pending-status write: ChatConnector has NO oauthStatus
// column — the callback's row-presence check + single-use PKCE verifier
// consumption (deleted on read) ARE the replay guard (mcpOAuthCallback's
// pending-CAS has no connector analog).
//
// The redirect_uri is resolveConnectorRedirectUri() — the SAME
// connector-specific constant the callback's token exchange sends (Slack
// validates redirect_uri consistency between the authorize and token calls;
// the admin registers `${SERVER_URL}/api/connectors/oauth/callback` as the
// Slack App's Redirect URL per CONNECTORS.md).
router.post("/:id/oauth/start", requirePermission("connector:manage"), async (req: Request, res: Response) => {
  try {
    const paramResult = connectorIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({ error: "Invalid connector ID", details: paramResult.error.flatten().fieldErrors });
      return;
    }
    const { id } = paramResult.data;

    const connector = await prisma.chatConnector.findFirst({ where: { id } });
    // 404-hide (T-185-10 org assertion: cross-org connector hides as 404).
    if (!connector || connector.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    // The connector OAuth flow authorizes ONLY slack (v1): another platform
    // has no def-shaped install surface here.
    if (connector.platform !== "slack") {
      res.status(400).json({ error: "Connector platform does not support OAuth" });
      return;
    }

    const def = resolveProvider("slack");
    if (!def) {
      res.status(400).json({ error: "Unknown OAuth provider" });
      return;
    }

    // D-06 posture: no client configured → clear 400 (never a 500). False
    // (the default) keeps the Connect button hidden — the static-token
    // create path stays the only install surface.
    if (!hasClientConfigured("slack")) {
      res.status(400).json({ error: "OAuth provider client not configured" });
      return;
    }

    // Mint the signed state WITH THE CONNECTOR AUDIENCE (WR-03 purpose
    // separation — the MCP callback rejects this state and vice versa) + the
    // PKCE verifier. The verifier lives in the process-memory Map ONLY (D-08)
    // and never leaves the process.
    const { state, verifier } = signOAuthState(id, CONNECTOR_OAUTH_STATE_AUDIENCE);

    // Scope-REDUCE-ONLY resolution (T-195-02): no per-connector scope storage
    // exists, so the full default list is the requested-undefined arm — the
    // registry's defaults are the maximum grantable set.
    const scopes = resolveScopes(def);

    const authorizeUrl = buildAuthorizeUrl(def, {
      clientId: getEnv().SLACK_CLIENT_ID ?? "",
      redirectUri: resolveConnectorRedirectUri(),
      scopes,
      state,
      codeVerifier: verifier,
    });

    // Audit trail (T-195-10 shape): action + platform only. The state rides
    // inside authorizeUrl by the OAuth spec's design (the IdP echoes it
    // back) — that is the IdP contract, NOT a response leak.
    await logEvent("chat_connector", id, "chat_connector.oauth_started", req.userId!, {
      platform: connector.platform,
    });

    // Exactly { authorizeUrl } — no state/code/token field beyond it
    // (T-195-09 response-shape contract).
    res.json({ authorizeUrl });
  } catch (err: unknown) {
    logger.error("[connectors] Error starting connector OAuth flow", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Phase 200 (ECCO-06, D-05): the Slack "Add to Slack" OAuth start — the
// connector arm of the Phase 195 registry flow (mcp.ts Route-8 shape).
import {
  resolveProvider,
  hasClientConfigured,
  buildAuthorizeUrl,
  resolveScopes,
  resolveConnectorRedirectUri,
} from "../services/oauthProviderRegistry";
import { signOAuthState, CONNECTOR_OAUTH_STATE_AUDIENCE } from "../services/oauthStateService";

// ===== Public webhook mini-router =====

// PUBLIC platform webhook surface (D-06): NO RBAC, NO JWT — the platform
// signature is the ONLY auth. Mounted in index.ts BEFORE connectorsRoutes
// and BEFORE the JWT catch-all. Tenant identity comes from the DB row
// resolved by :connectorId — never from any request-supplied field
// (T-198-04). Route order per D-06: platform-agnostic 400 → DB resolution →
// row-existence 404 → timing-safe secret 403 → row-state 404s → stash +
// runInTenant → 200-ACK.
const connectorsWebhookRouter = Router();

// WR-07: route-scoped body parser — the Telegram webhook is the repo's only
// UNAUTHENTICATED, secret-gated-AFTER-parse POST surface, so the global 100mb
// express.json limit made it a cheap memory/CPU amplifier (a loop of garbage
// bodies fully buffered + JSON.parsed before ANY gate ran). Telegram updates
// are KBs at most — the webhook router parses at 256kb; larger bodies 413 at
// the parser, before the UUID pre-check / DB lookup / timing-safe compare
// pay for them.
const webhookJson = json({ limit: "256kb" });

// Route order: /telegram/:connectorId/webhook, /slack/:connectorId/webhook
// and the /whatsapp/:connectorId/webhook GET+POST pair are SPECIFIC paths —
// they must register before any wider pattern. The admin router is a
// SEPARATE app mount, so no cross-router shadowing occurs; within this
// mini-router each platform owns one subpath (whatsapp landed in 200-02
// with its own GET+POST subpath — unimplemented platforms have no inbound
// surface, so they 404 by NOT being registered here).
connectorsWebhookRouter.post("/telegram/:connectorId/webhook", webhookJson, async (req: Request, res: Response) => {
  let tenantOrgId: string | null = null;
  try {
    // (a) param validation — malformed connectorId → 400 (pre-DB, cheap).
    const connectorId = typeof req.params.connectorId === "string" ? req.params.connectorId : "";
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!connectorId || !uuidRe.test(connectorId)) {
      res.status(400).json({ error: "Invalid connector ID" });
      return;
    }

    // (b) Resolve the row from the DB by :connectorId — tenant identity from
    // the DB, NEVER from any request-supplied field (T-198-04). Plain findUnique
    // (PK-keyed, extension-skipped) + explicit soft-delete filter.
    const connector = (await prisma.chatConnector.findUnique({
      where: { id: connectorId },
    })) as TenantConnector | null;

    // (c) Row-state gate 1: unknown OR soft-deleted → indistinguishable 404.
    // A caller without the row CANNOT possess a valid secret — it can never
    // reach the 403 arm, so the 404 must not be differentiated (P-3).
    if (!connector || connector.deletedAt !== null) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // (d) Secret check — ordered BEFORE the row-state 404s (D-06). Decrypt
    // the config and timing-safe compare the header against the stored
    // webhookSecret. 403 ONLY here (known connector + wrong/missing secret).
    const config = parseConfig(connector.configEncrypted);
    const headerSecret = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    if (!config?.webhookSecret || !secretEquals(headerSecret, config.webhookSecret)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // (e) Row-state gate 2 (AFTER the secret): disabled connector → 404.
    // Indistinguishable from unknown to secret-less callers, because (d)
    // already ran — an unauthenticated caller without the correct secret
    // gets 403 (known) or 404 (unknown), never a differentiated 404.
    if (!connector.isEnabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // (h) Polling mode with NO secret configured (webhook-setup never run) →
    // 404 (no inbound surface in polling mode, D-14). Unreachable when
    // webhookSecret is absent because (d) 403s — kept as the explicit
    // fail-closed statement of the polling-mode contract.
    if (connector.pollMode !== "webhook") {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // (f) Tenant slot (WR-05 mirror): stash the row + org from the workspace
    // chain (DB-resolved) and open the ALS tenant window for the downstream
    // async processing.
    const workspace = (await prisma.workspace.findUnique({
      where: { id: connector.workspaceId },
      select: { organizationId: true, deletedAt: true },
    })) as { organizationId: string; deletedAt: Date | null } | null;
    if (!workspace || workspace.deletedAt !== null) {
      // Tombstoned workspace — fail closed (widget slot precedent).
      res.status(404).json({ error: "Not found" });
      return;
    }
    tenantOrgId = workspace.organizationId;
    req.tenantConnector = connector;
    req.organizationId = tenantOrgId;

    // Parse boundary guard (D-18): non-"message" updates are ACKed and
    // skipped — the full pipeline routes in Plan 02.
    const update = req.body as Record<string, unknown> | undefined;
    const updateType = update && typeof update === "object" ? Object.keys(update).find((k) => k !== "update_id") : undefined;
    if (updateType !== "message") {
      res.status(200).json({ ok: true });
      return;
    }

    // (g) ACK 200 immediately — process async (fire-and-forget with a
    // .catch that logs — D-16; Telegram retries non-2xx deliveries, so a
    // slow pipeline must not fail the webhook).
    res.status(200).json({ ok: true });

    // lastWebhookAt stamp (D-01/D-14: the last platform interaction marker
    // on the connector row) — ACK-time write, swallowed on failure (the
    // analytics stamp must not fail the delivery).
    void prisma.chatConnector
      .update({
        where: { id: connector.id },
        data: { lastWebhookAt: new Date() },
      })
      .catch((err: unknown) => {
        logger.debug("[connectors] lastWebhookAt stamp failed", {
          connectorId: connector.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    // D-16 (198-03): the async arm routes the parsed update through the
    // SAME handleIncomingMessage pipeline as the polling arm. Parse runs
    // via the registered adapter (fail-closed lookup, D-03); a non-
    // processable payload (edited_message/group/etc.) is dropped at the
    // adapter boundary — the tenant window stays open for the pipeline.
    const orgId = tenantOrgId;
    setImmediate(() => {
      runInTenant({ organizationId: orgId, bypass: false }, () => {
        try {
          const adapter = getAdapter(connector.platform);
          if (!adapter) {
            logger.debug("[connectors] no adapter for platform — update dropped", {
              platform: connector.platform,
            });
            return;
          }
          const msg = adapter.parseIncomingWebhook(update);
          if (!msg) {
            // edited_message / callback_query / non-private — dropped at
            // the parse boundary (D-18 silent drop).
            return;
          }
          void handleIncomingMessage(
            connector as unknown as Parameters<typeof handleIncomingMessage>[0],
            msg
          ).catch((err: unknown) => {
            // handleIncomingMessage owns its own error paths (D-12) — this
            // catch is the setImmediate-safety net (no unhandled rejection).
            logger.error("[connectors] webhook async pipeline failed", {
              connectorId: connector.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } catch (err: unknown) {
          logger.error("[connectors] webhook async arm failed", {
            connectorId: connector.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });
  } catch (err: unknown) {
    // Fail-closed catch (widget slot precedent): a DB outage must not present
    // as a silent flood of different statuses; log WITHOUT any header
    // secret/config material (D-14).
    logger.warn("[connectors] webhook resolution failed — failing closed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(404).json({ error: "Not found" });
  }
});

// POST /api/connectors/slack/:connectorId/webhook — the Slack Events API
// surface (Phase 200, D-03). Gate chain mirrors the Telegram WR-05 slot
// byte-order with these substitutions: the (d) secret gate is the
// X-Slack-Signature HMAC (v0:ts:rawBody, timing-safe) + the rawBody
// fail-closed guard (missing capture = tamper/fail-closed, never fail-open),
// the (e) anti-replay window (|now-ts|>300s → 403), a SYNCHRONOUS
// url_verification challenge echo AFTER the signature + row-state gates and
// BEFORE the ACK-and-defer shape (P3: a challenge echo IS the handler
// response — Slack requires it within 3s), and NO (h) pollMode gate
// (Slack is webhook-only — the telegram-specific gate is omitted).
connectorsWebhookRouter.post("/slack/:connectorId/webhook", webhookJson, async (req: Request, res: Response) => {
  let tenantOrgId: string | null = null;
  try {
    // (a) param validation — malformed connectorId → 400 (pre-DB, cheap).
    const connectorId = typeof req.params.connectorId === "string" ? req.params.connectorId : "";
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!connectorId || !uuidRe.test(connectorId)) {
      res.status(400).json({ error: "Invalid connector ID" });
      return;
    }

    // (b) Resolve the row from the DB by :connectorId — tenant identity from
    // the DB, NEVER from any request-supplied field (T-198-04). Plain
    // findUnique (PK-keyed, extension-skipped) + explicit soft-delete filter.
    const connector = (await prisma.chatConnector.findUnique({
      where: { id: connectorId },
    })) as TenantConnector | null;

    // (c) Row-state gate 1: unknown OR soft-deleted → indistinguishable 404
    // (P-3 — a caller without the row cannot possess the signing secret).
    if (!connector || connector.deletedAt !== null) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // (d) Signature gate — ordered BEFORE the row-state 404s (D-03(d), the
    // telegram (d) shape): recompute HMAC-SHA256 over the RAW captured body
    // and timing-safe compare against X-Slack-Signature. Missing rawBody
    // (the wrapper never ran / non-JSON body) fails CLOSED — never
    // fail-open (T-200-01b).
    const config = parseConfig(connector.configEncrypted);
    const signature = String(req.headers["x-slack-signature"] ?? "");
    const timestamp = String(req.headers["x-slack-request-timestamp"] ?? "");
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (
      !config?.signingSecret ||
      typeof config.signingSecret !== "string" ||
      rawBody === undefined ||
      !verifySlackSignature(config.signingSecret, timestamp, rawBody, signature)
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // (e) Anti-replay (D-03(e), AFTER the signature): Slack's 5-minute
    // window — |now - ts| > 300s → 403.
    if (!isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // (e2) Row-state gate 2 (AFTER the secret, telegram (e) shape): disabled
    // connector → 404 (indistinguishable from unknown to secret-less callers).
    if (!connector.isEnabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // (f) url_verification arm — SYNCHRONOUS, inside the request, AFTER the
    // signature + row-state gates and BEFORE the ACK-and-defer shape
    // (research P3: the challenge echo IS the handler response — Slack
    // requires it within 3s; an ACK-and-defer would answer too late).
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body === "object" && body.type === "url_verification") {
      res.status(200).json({ challenge: body.challenge });
      return;
    }

    // (f2) Tenant slot (WR-05 mirror): stash the row + org from the
    // workspace chain (DB-resolved) and open the ALS tenant window for the
    // downstream async processing.
    const workspace = (await prisma.workspace.findUnique({
      where: { id: connector.workspaceId },
      select: { organizationId: true, deletedAt: true },
    })) as { organizationId: string; deletedAt: Date | null } | null;
    if (!workspace || workspace.deletedAt !== null) {
      // Tombstoned workspace — fail closed (widget slot precedent).
      res.status(404).json({ error: "Not found" });
      return;
    }
    tenantOrgId = workspace.organizationId;
    req.tenantConnector = connector;
    req.organizationId = tenantOrgId;

    // (g) ACK 200 immediately — process async (D-03: Slack retries non-2xx
    // deliveries and requires the 2xx within 3s; the pipeline must not be
    // in the request path).
    res.status(200).json({ ok: true });

    // lastWebhookAt stamp (D-01/D-14: the last platform interaction marker
    // on the connector row) — ACK-time write, swallowed on failure (the
    // analytics stamp must not fail the delivery).
    void prisma.chatConnector
      .update({
        where: { id: connector.id },
        data: { lastWebhookAt: new Date() },
      })
      .catch((err: unknown) => {
        logger.debug("[connectors] lastWebhookAt stamp failed", {
          connectorId: connector.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    // D-16 (198-03): the async arm routes the parsed envelope through the
    // SAME handleIncomingMessage pipeline. Parse runs via the registered
    // adapter (fail-closed lookup, D-03); a non-processable envelope
    // (url_validation slips the type guard / non-im / bot echo) is dropped
    // at the adapter boundary — the tenant window stays open.
    const orgId = tenantOrgId;
    setImmediate(() => {
      runInTenant({ organizationId: orgId, bypass: false }, () => {
        try {
          const adapter = getAdapter(connector.platform);
          if (!adapter) {
            logger.debug("[connectors] no adapter for platform — update dropped", {
              platform: connector.platform,
            });
            return;
          }
          // Phase 200: the slack adapter's parse boundary takes the
          // connector row as the optional second argument (the bot-user
          // echo guard reads the blob's botUserId). The PlatformAdapter
          // contract stays single-arg — the extended shape is a
          // slack-route-local cast (other adapters ignore the extra arg in
          // JS semantics, and the row here is signature-gated to slack
          // configs anyway).
          const msg = (
            adapter as unknown as {
              parseIncomingWebhook: (
                req: unknown,
                connector?: { configEncrypted?: string | null } | null
              ) => IncomingMessage | null;
            }
          ).parseIncomingWebhook(body, connector);
          if (!msg) {
            // Non-event_callback / non-im / bot-echo — dropped at the parse
            // boundary (D-18 silent drop).
            return;
          }
          void handleIncomingMessage(
            connector as unknown as Parameters<typeof handleIncomingMessage>[0],
            msg
          ).catch((err: unknown) => {
            // handleIncomingMessage owns its own error paths (D-12) — this
            // catch is the setImmediate-safety net (no unhandled rejection).
            logger.error("[connectors] webhook async pipeline failed", {
              connectorId: connector.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } catch (err: unknown) {
          logger.error("[connectors] webhook async arm failed", {
            connectorId: connector.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });
  } catch (err: unknown) {
    // Fail-closed catch (widget slot precedent): a DB outage must not present
    // as a silent flood of different statuses; log WITHOUT any header
    // secret/config material (D-14).
    logger.warn("[connectors] webhook resolution failed — failing closed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(404).json({ error: "Not found" });
  }
});

// GET + POST /api/connectors/whatsapp/:connectorId/webhook — the WhatsApp
// Cloud API surface (Phase 200-02, D-07). P5: BOTH verbs are registered
// ADJACENT on the same path — a POST-only registration would 404 Meta's GET
// handshake. Both arms share the tenant-slot gate chain (the telegram
// WR-05 clone per D-07): (a) UUID 400 → (b) row resolve → (c) unknown/
// soft-deleted 404 → then the platform-specific secret gate → row-state 404
// AFTER the secret → tenant slot → ACK + async pipeline. NO pollMode gate
// (WhatsApp is webhook-only — the telegram-specific gate is omitted).
//
// GET arm (Meta handshake): hub.mode=subscribe AND hub.verify_token
// timing-equal to configOf().verifyToken → respond hub.challenge verbatim
// (parseInt echo per D-07 — Meta's verifier accepts the plaintext number);
// mismatch or hub.mode≠subscribe → 404 indistinguishable (D-07). The GET is
// unauthenticated BY DESIGN (the verify token IS the auth) — the row-state
// gates still run FIRST (D-07: row state before token compare).
//
// POST arm (X-Hub-Signature-256): HMAC-SHA256 over req.rawBody (the P1
// path-filtered wrapper from Plan 01 captured it — never re-wrapped here)
// with configOf().appSecret, timing-safe compared against the
// `sha256=<hex>` header. Missing rawBody / missing appSecret / mismatch →
// 403 fail-CLOSED (never fail-open, T-200-02).
function whatsappSignatureValid(
  appSecret: string,
  rawBody: Buffer,
  header: string
): boolean {
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return secretEquals(header, expected);
}

connectorsWebhookRouter.get("/whatsapp/:connectorId/webhook", async (req: Request, res: Response) => {
  try {
    // (a) param validation — malformed connectorId → 400 (pre-DB, cheap).
    const connectorId = typeof req.params.connectorId === "string" ? req.params.connectorId : "";
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!connectorId || !uuidRe.test(connectorId)) {
      res.status(400).json({ error: "Invalid connector ID" });
      return;
    }

    // (b) Resolve the row from the DB by :connectorId (T-198-04 — tenant
    // identity from the DB, never request-supplied).
    const connector = (await prisma.chatConnector.findUnique({
      where: { id: connectorId },
    })) as TenantConnector | null;

    // (c) Row-state gate 1: unknown OR soft-deleted → indistinguishable 404
    // BEFORE the verify-token compare (D-07 — a caller without the row
    // cannot possess the token).
    if (!connector || connector.deletedAt !== null) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // GET secret gate: hub.mode=subscribe AND hub.verify_token timing-equal
    // to the stored verifyToken. Mismatch / missing config / wrong mode →
    // 404 indistinguishable (D-07 — never 403 on the GET handshake).
    const config = parseConfig(connector.configEncrypted);
    const hubMode = String(req.query["hub.mode"] ?? "");
    const hubToken = String(req.query["hub.verify_token"] ?? "");
    if (
      hubMode !== "subscribe" ||
      !config?.verifyToken ||
      typeof config.verifyToken !== "string" ||
      !secretEquals(hubToken, config.verifyToken)
    ) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Row-state gate 2 (AFTER the token): disabled connector → 404.
    if (!connector.isEnabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // D-07: challenge echo — the bare parseInt'd challenge as the response
    // BODY (Meta's verifier accepts the plaintext number; P5). The
    // handshake IS the response — no ACK-and-defer, no pipeline arm.
    const challenge = parseInt(String(req.query["hub.challenge"] ?? "0"), 10);
    res.send(String(challenge));
  } catch (err: unknown) {
    // Fail-closed catch: log WITHOUT any token/config material (D-14).
    logger.warn("[connectors] whatsapp GET handshake resolution failed — failing closed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(404).json({ error: "Not found" });
  }
});

connectorsWebhookRouter.post("/whatsapp/:connectorId/webhook", async (req: Request, res: Response) => {
  let tenantOrgId: string | null = null;
  try {
    // (a) param validation — malformed connectorId → 400 (pre-DB, cheap).
    const connectorId = typeof req.params.connectorId === "string" ? req.params.connectorId : "";
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!connectorId || !uuidRe.test(connectorId)) {
      res.status(400).json({ error: "Invalid connector ID" });
      return;
    }

    // (b) Resolve the row from the DB by :connectorId (T-198-04).
    const connector = (await prisma.chatConnector.findUnique({
      where: { id: connectorId },
    })) as TenantConnector | null;

    // (c) Row-state gate 1: unknown OR soft-deleted → indistinguishable 404
    // BEFORE the signature compare (P-3 — a caller without the row cannot
    // possess the app secret).
    if (!connector || connector.deletedAt !== null) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // (d) Signature gate (T-200-02) — ordered BEFORE the row-state 404s:
    // recompute HMAC-SHA256 over the RAW captured body with the app secret
    // and timing-safe compare against `X-Hub-Signature-256: sha256=<hex>`.
    // Missing rawBody (the wrapper never ran / non-JSON body), a missing
    // appSecret, or a mismatch fails CLOSED → 403 (never fail-open,
    // T-200-01b parity with the slack (d) gate).
    const config = parseConfig(connector.configEncrypted);
    const signature = String(req.headers["x-hub-signature-256"] ?? "");
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (
      !config?.appSecret ||
      typeof config.appSecret !== "string" ||
      rawBody === undefined ||
      !whatsappSignatureValid(config.appSecret, rawBody, signature)
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // (e) Row-state gate 2 (AFTER the secret, telegram (e) shape): disabled
    // connector → 404 (indistinguishable from unknown to secret-less callers).
    if (!connector.isEnabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // (f) Tenant slot (WR-05 mirror): stash the row + org from the
    // workspace chain (DB-resolved) and open the ALS tenant window for the
    // downstream async processing.
    const workspace = (await prisma.workspace.findUnique({
      where: { id: connector.workspaceId },
      select: { organizationId: true, deletedAt: true },
    })) as { organizationId: string; deletedAt: Date | null } | null;
    if (!workspace || workspace.deletedAt !== null) {
      // Tombstoned workspace — fail closed (widget slot precedent).
      res.status(404).json({ error: "Not found" });
      return;
    }
    tenantOrgId = workspace.organizationId;
    req.tenantConnector = connector;
    req.organizationId = tenantOrgId;

    // (g) ACK 200 immediately — process async (the Cloud API needs no body;
    // Meta retries non-2xx deliveries, so a slow pipeline must not fail the
    // webhook). NO pollMode gate — webhook-only platform (D-07 note).
    res.status(200).json({ ok: true });

    // lastWebhookAt stamp (D-01/D-14 parity) — ACK-time write, swallowed on
    // failure (the analytics stamp must not fail the delivery).
    void prisma.chatConnector
      .update({
        where: { id: connector.id },
        data: { lastWebhookAt: new Date() },
      })
      .catch((err: unknown) => {
        logger.debug("[connectors] lastWebhookAt stamp failed", {
          connectorId: connector.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    // D-16 (198-03): the async arm routes the parsed envelope through the
    // SAME handleIncomingMessage pipeline. Parse runs via the registered
    // adapter (fail-closed lookup, D-03); a non-processable envelope
    // (statuses-only, malformed) is dropped at the adapter boundary — the
    // tenant window stays open.
    const orgId = tenantOrgId;
    setImmediate(() => {
      runInTenant({ organizationId: orgId, bypass: false }, () => {
        try {
          const adapter = getAdapter(connector.platform);
          if (!adapter) {
            logger.debug("[connectors] no adapter for platform — update dropped", {
              platform: connector.platform,
            });
            return;
          }
          const msg = adapter.parseIncomingWebhook(req.body);
          if (!msg) {
            // statuses-only / non-messages payload — dropped at the parse
            // boundary (D-06 silent drop).
            return;
          }
          void handleIncomingMessage(
            connector as unknown as Parameters<typeof handleIncomingMessage>[0],
            msg
          ).catch((err: unknown) => {
            // handleIncomingMessage owns its own error paths (D-12) — this
            // catch is the setImmediate-safety net (no unhandled rejection).
            logger.error("[connectors] webhook async pipeline failed", {
              connectorId: connector.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } catch (err: unknown) {
          logger.error("[connectors] webhook async arm failed", {
            connectorId: connector.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });
  } catch (err: unknown) {
    // Fail-closed catch (widget slot precedent): a DB outage must not present
    // as a silent flood of different statuses; log WITHOUT any header
    // secret/config material (D-14).
    logger.warn("[connectors] webhook resolution failed — failing closed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(404).json({ error: "Not found" });
  }
});

// Admin CRUD router (mcp.ts precedent) — named export; the PUBLIC webhook
// mini-router rides as a named export too, so index.ts can mount it FIRST,
// gate-less, before the JWT catch-all.
export { router as connectorsRoutes, connectorsWebhookRouter };