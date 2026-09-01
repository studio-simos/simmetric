// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { apiKeyMiddleware } from "../middleware/auth";
import { requireFeature } from "../middleware/license";
import { widgetSessionCreateSchema, widgetSessionIncrementSchema, widgetSearchRequestSchema, widgetLeadSubmitSchema, widgetChatRequestSchema, WIDGET_LOCALES } from "@simmetric-chat/shared";
import { widgetLeadLimiter } from "../middleware/rateLimit";
import { hybridSearchWithRerank } from "../services/hybridSearchService";
import { linkArchive } from "../services/chatArchiveService";
import { isFeatureEnabled } from "../services/licenseService";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { handleChatStream } from "./chat";

// Widget-side body schema for PATCH /session/:token/chat/archive (D-10).
// The JWT route (80-02) takes chatId from the path; the widget route takes it
// from the body because the session token occupies the path. We compose the
// shared linkArchiveSchema (archiveId: uuid|null) with an extra chatId field
// rather than mutating the shared schema.
const widgetLinkArchiveBody = z.object({
  chatId: z.string().uuid("Invalid chat ID"),
  archiveId: z.string().uuid("Invalid archive ID").nullable(),
});

const router = Router();

// All internal widget endpoints require API key auth (D-12)
router.use(apiKeyMiddleware);

// 151-02 (G-151-1b, Task 7): the widget RUNTIME is an Enterprise feature —
// config, session, chat/stream, search, lead. The admin area is already gated
// (widgets.ts requireFeature), but a Community install kept serving the
// embeddable widget on client sites through this API-key-only surface. Gate
// the WHOLE internal router: 402 { error, feature: "widget_enabled", tier }
// on every route when the flag is off.
router.use(requireFeature("widget_enabled"));

// Body schema for POST /chat/stream (260809-tuw). Composed locally from the
// shared widgetChatRequestSchema (message, chatId, locale) + the two optional
// fields the widget proxy sends after its pre-search (widget/src/routes/chat.ts):
// ragContext (pre-computed RAG context) and disableRagSearch (rag-degraded
// path). REQUIRED: plain widgetChatRequestSchema would STRIP unknown keys
// (Zod default), breaking the rag-degraded path. No shared schema changes
// (mirrors the widgetLinkArchiveBody composition precedent above).
// 131-07 (G-131-19): locale is inherited from widgetChatRequestSchema — the
// composed body MUST declare it or Zod strips it before handleChatStream.
const widgetChatStreamBody = widgetChatRequestSchema.extend({
  ragContext: z.string().max(50000).optional(),
  disableRagSearch: z.boolean().optional(),
});

// POST /api/internal/widget/chat/stream — SSE chat stream for the widget
// proxy (260809-tuw). Behind the router-level apiKeyMiddleware above, so the
// widget service (X-Api-Key holder) is the caller and the widget-service
// account (req.userId set by the middleware) is the acting user — chat
// persistence, event logs, DLP logs and widget analytics keep working for
// anonymous visitor sessions.
//
// IDOR prevention (mirror of POST /search): the target workspace is ALWAYS
// resolved from the widget's DB WidgetWorkspace whitelist (whitelist[0], the
// primary workspace), never from client-supplied input — the body schema
// strips any workspaceId field the client might send. This is why the widget
// proxy cannot be pointed at the JWT /api/workspaces/:workspaceId/chat/stream
// route (path param would be client-influenceable) and why apiKeyMiddleware
// is NOT mounted as an additional auth option there.
router.post("/chat/stream", async (req: Request, res: Response) => {
  try {
    const parsed = widgetChatStreamBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    // 260831-hgy (T-hgy-01 tamper pin): strip any client-supplied model fields
    // BEFORE delegating — the shared core re-parses req.body with
    // chatRequestSchema, which ACCEPTS providerId/model for the JWT path, so
    // this delete is the seam that keeps the widget path's model assignment
    // DB-only (server-resolved via X-Widget-Id). The widget proxy never sends
    // these fields (it builds a fresh body from schema fields only), so this
    // is defense-in-depth against a compromised proxy or leaked API key —
    // pinned by widgetChatStream.test.ts (c).
    const body = req.body as Record<string, unknown>;
    delete body.providerId;
    delete body.model;

    const widgetId = req.headers["x-widget-id"] as string | undefined;
    if (!widgetId) {
      res.status(400).json({ error: "X-Widget-Id header is required" });
      return;
    }

    // Resolve the widget and its linked workspaces from DB (IDOR-safe: the
    // whitelist is the ONLY source of truth for the target workspace).
    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null, isActive: true },
      include: { workspaces: { select: { workspaceId: true } } },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found or inactive" });
      return;
    }

    const workspaceIds = widget.workspaces.map(w => w.workspaceId);

    if (workspaceIds.length === 0) {
      res.status(404).json({ error: "Widget has no linked workspaces" });
      return;
    }

    // Primary workspace — matches the config route's primaryWorkspaceId
    // semantics and what the proxy's config.workspaceId holds. The
    // length === 0 check above guarantees this element exists.
    const targetWorkspaceId = workspaceIds[0]!;

    // Delegate to the shared stream-handler core. It reads req.userId (set
    // by apiKeyMiddleware to the widget-service account), req.body (already
    // parsed above) and the X-Widget-Id / X-Widget-Session-Id headers for
    // widget analytics. The handler catches stream errors itself (emits SSE
    // error events); this catch is defensive only. The archiveId comes from
    // the DB row resolved via X-Widget-Id, NEVER from the request body
    // (IDOR-safe; the composed body schema strips unknown keys).
    // 131-07 (G-131-19): the visitor locale is threaded as the 5th arg so
    // the orchestrator can localize the no-results sentence.
    // 260831-hgy: the per-widget response model pin is threaded as the 6th
    // arg — server-side DB-resolved from the same widget row, NEVER
    // client-supplied (same IDOR pattern as archiveId; the composed body
    // schema strips any body providerId/model the proxy might forward).
    // Unset columns are null → the core falls through to the existing
    // workspace/global resolution chain.
    await handleChatStream(req, res, targetWorkspaceId, widget.archiveId ?? null, parsed.data.locale, { providerId: widget.responseProviderId ?? null, model: widget.responseModel ?? null });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[internalWidget] Error in chat stream", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/widget/search -- multi-workspace hybrid search (RAG-02, RAG-03)
// IDOR prevention: server resolves workspaceIds from the widget's DB whitelist (WidgetWorkspace),
// NOT from the client-provided list. Per RESEARCH.md T-03-04: "Server resolves workspaceIds
// from DB (widget's whitelist), NOT from client-provided list."
router.post("/search", async (req: Request, res: Response) => {
  try {
    const parsed = widgetSearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { query, widgetId, limit } = parsed.data;

    // Resolve the widget and its linked workspaces from DB
    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null, isActive: true },
      include: { workspaces: { select: { workspaceId: true } } },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found or inactive" });
      return;
    }

    // Server resolves workspaceIds from the widget's whitelist -- client cannot override
    const workspaceIds = widget.workspaces.map(w => w.workspaceId);

    // 131-07 (G-131-19): the bound archive participates in the pre-search. The
    // archive pseudo-workspace ("archive:<id>") joins the workspace whitelist —
    // server-side resolution from the DB row keeps the archive out of client
    // control (T-131-17, same IDOR pattern as the whitelist). The append
    // happens BEFORE the empty-workspaces early-return so an archive-only
    // widget (zero linked workspaces) still searches the archive.
    const searchScope = widget.archiveId
      ? [...workspaceIds, `archive:${widget.archiveId}`]
      : workspaceIds;

    if (searchScope.length === 0) {
      res.json({ results: [] });
      return;
    }

    // Phase 93-02: live RAG path now goes through hybridSearchWithRerank,
    // which handles single-WS vs multi-WS branching internally and applies
    // the CrossEncoder rerank post-RRF when rag_reranker_enabled=true (SC1
    // default OFF → byte-identical RRF order; D-03 over-fetch + rerank + trim
    // when enabled; D-07 graceful fallback on collector failure).
    const results = await hybridSearchWithRerank(query, searchScope, limit);

    res.json({ results });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[internalWidget] Search failed", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/widget/lead -- submit lead from widget visitor (ADM-04 per D-10/D-13)
// Rate-limited at 3 per IP per hour via widgetLeadLimiter
router.post("/lead", widgetLeadLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = widgetLeadSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { email, name, transcript } = parsed.data;

    // widgetId from request body -- must match an active widget
    const widgetId = req.body.widgetId;
    if (!widgetId || typeof widgetId !== "string") {
      res.status(400).json({ error: "Widget ID is required" });
      return;
    }

    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null, isActive: true },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found or inactive" });
      return;
    }

    // Check lead capture is enabled for this widget (ADM-04)
    if (!widget.leadCaptureEnabled) {
      res.status(403).json({ error: "Lead capture is not enabled for this widget" });
      return;
    }

    // sessionId must be a valid UUID referencing WidgetSession.id (FK constraint)
    // The widget service route resolves the session and passes the DB id, not the token
    const sessionId = req.body.sessionId || null;

    const lead = await prisma.widgetLead.create({
      data: {
        widgetId,
        sessionId,
        email,
        name: name || null,
        transcript,
      },
    });

    res.status(201).json({ id: lead.id, email: lead.email, createdAt: lead.createdAt });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[internalWidget] Error creating lead", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/internal/widget/:id/config
// Returns widget config for the widget service to use (D-13)
router.get("/:id/config", async (req: Request, res: Response) => {
  try {
    const widget = await prisma.widget.findFirst({
      where: { id: req.params.id as string, deletedAt: null },
      include: { workspaces: true },
    });

    if (!widget || !widget.isActive) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }

    const workspaceIds = widget.workspaces.map(w => w.workspaceId);
    const primaryWorkspaceId = workspaceIds.length > 0 ? workspaceIds[0] : null;

    if (workspaceIds.length === 0) {
      res.status(404).json({ error: "Widget has no linked workspaces" });
      return;
    }

    res.json({
      id: widget.id,
      name: widget.name,
      welcomeMessage: widget.welcomeMessage,
      fallbackMessage: widget.fallbackMessage,
      position: widget.position,
      isActive: widget.isActive,
      workspaceId: primaryWorkspaceId,  // backward compat (first linked workspace)
      workspaceIds,                      // all linked workspace IDs
      // Branding (CUST-01/CUST-02): always provide defaults for Community tier
      primaryColor: widget.primaryColor || "#4c6ef5",
      botName: widget.botName || "AI Assistant",
      logoUrl: widget.logoUrl || null,
      avatarUrl: widget.avatarUrl || null,
      // Display trigger fields (CUST-03)
      autoOpenDelay: widget.autoOpenDelay,
      autoOpenUrlPatterns: widget.autoOpenUrlPatterns,
      exitIntentEnabled: widget.exitIntentEnabled,
      exitIntentCooldownMs: widget.exitIntentCooldownMs,
      // Lead capture fields (ADM-04)
      leadCaptureEnabled: widget.leadCaptureEnabled,
      leadCapturePrompt: widget.leadCapturePrompt,
      // Per-widget rate-limit override (SCALE-04, D-05). null = global default.
      rateLimitPerMinute: widget.rateLimitPerMinute,
      // Per-widget daily MESSAGE limit (151-02, G-151-1b). null = global
      // default. Raw pass-through — the widget service's
      // widgetDailyMessageLimiter reads it from the Redis config cache.
      sessionLimitPerDay: widget.sessionLimitPerDay,
      // Localization blobs + fallbackLocale (D-01, Phase 126) — raw pass-through,
      // visitor-agnostic, NOT locale-resolved (no cache fragmentation).
      localizedTexts: widget.localizedTexts,
      suggestedQuestions: widget.suggestedQuestions,
      credits: widget.credits,
      fallbackLocale: widget.fallbackLocale || "en",
      // 130-01 (D-03): server-derived, license-owned — never client-supplied.
      // Inline isFeatureEnabled on the read path (requireFeature middleware is
      // for admin write endpoints only). The route stays behind apiKeyMiddleware.
      whiteLabel: isFeatureEnabled("white_label"),
      // 260809-uxk T3: bound knowledge archive (null when unbound) — raw
      // pass-through, server-derived from the DB row (never client-supplied).
      archiveId: widget.archiveId ?? null,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[internalWidget] Error fetching config", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/internal/widget/session/:token
// Validates session token and returns session data (D-08, D-09)
router.get("/session/:token", async (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    const session = await prisma.widgetSession.findUnique({
      where: { sessionToken: token },
    });

    if (!session || session.expiresAt < new Date()) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    const hourlyRemaining = Math.max(0, 20 - session.messageCount);
    const dailyRemaining = Math.max(0, 5 - session.conversationCount);

    res.json({
      id: session.id,
      widgetId: session.widgetId,
      sessionToken: session.sessionToken,
      ipAddress: session.ipAddress,
      messageCount: session.messageCount,
      conversationCount: session.conversationCount,
      lastResetAt: session.lastResetAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      hourlyLimit: 20,
      dailyLimit: 5,
      hourlyRemaining,
      dailyRemaining,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[internalWidget] Error validating session", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/internal/widget/session
// Creates a new anonymous session with 256-bit hex token (D-08)
router.post("/session", async (req: Request, res: Response) => {
  try {
    const parsed = widgetSessionCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { widgetId } = parsed.data;

    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null, isActive: true },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }

    const sessionToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h default per D-08

    const session = await prisma.widgetSession.create({
      data: {
        widgetId,
        sessionToken,
        ipAddress: (req.body as Record<string, unknown>).ipAddress as string || null,
        expiresAt,
      },
    });

    res.status(201).json({
      id: session.id,
      widgetId: session.widgetId,
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt.toISOString(),
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[internalWidget] Error creating session", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/internal/widget/session/:token/increment
// Increments message_count or conversation_count (D-10)
router.patch("/session/:token/increment", async (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    const parsed = widgetSessionIncrementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { field } = parsed.data;

    const session = await prisma.widgetSession.findUnique({
      where: { sessionToken: token },
    });

    if (!session || session.expiresAt < new Date()) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    // Check rate limits before incrementing (D-10, SEC-02)
    if (field === "messageCount" && session.messageCount >= 20) {
      res.status(429).json({ error: "Hourly message limit exceeded", retryAfter: "3600" });
      return;
    }
    if (field === "conversationCount" && session.conversationCount >= 5) {
      res.status(429).json({ error: "Daily conversation limit exceeded", retryAfter: "86400" });
      return;
    }

    const updated = await prisma.widgetSession.update({
      where: { sessionToken: token },
      data: {
        [field]: { increment: 1 },
        lastMessageAt: new Date(),
      },
    });

    const hourlyRemaining = Math.max(0, 20 - updated.messageCount);
    const dailyRemaining = Math.max(0, 5 - updated.conversationCount);

    res.json({
      id: updated.id,
      messageCount: updated.messageCount,
      conversationCount: updated.conversationCount,
      hourlyRemaining,
      dailyRemaining,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[internalWidget] Error incrementing counter", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/internal/widget/session/:token/chat/archive (D-10 — widget API-key path)
// Links/unlinks a Chat to an Archive via the SHARED linkArchive service (same write
// path as the JWT route in 80-02). Body carries chatId because the session token
// occupies the path param.
//
// IDOR layers (ARCH-LINK-02):
//   1. Widget-side session-IDOR: chat must belong to a workspace whitelisted on
//      the widget (resolved from DB, NOT client-supplied) → 404 hide existence.
//   2. Cross-workspace archive IDOR: delegated to linkArchive service (80-02),
//      which scoping archive.findFirst to chat.workspaceId → 404 hide existence.
//
// Audit (D-12 widget): linkArchive emits logEvent with userId=null (anonymous
// widget session). The route passes null; the service owns the audit row.
router.patch("/session/:token/chat/archive", async (req: Request, res: Response) => {
  try {
    const parsed = widgetLinkArchiveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { chatId, archiveId } = parsed.data;

    // Resolve session token (mirrors GET /session/:token + PATCH .../increment)
    const token = req.params.token as string;
    const session = await prisma.widgetSession.findUnique({
      where: { sessionToken: token },
    });
    if (!session || session.expiresAt < new Date()) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    // Resolve widget → whitelisted workspaceIds (mirrors POST /search IDOR pattern)
    const widget = await prisma.widget.findFirst({
      where: { id: session.widgetId, deletedAt: null, isActive: true },
      include: { workspaces: { select: { workspaceId: true } } },
    });
    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }
    const workspaceIds = widget.workspaces.map(w => w.workspaceId);

    // Widget-side session-IDOR: chat must belong to a whitelisted workspace.
    // Hide existence with 404 — do NOT leak that the chat lives elsewhere.
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, workspaceId: { in: workspaceIds } },
      select: { id: true, workspaceId: true },
    });
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    // Delegate to the shared linkArchive service (D-10 — single write path).
    // userId=null: anonymous widget session; the service emits the audit row.
    const result = await linkArchive({
      chatId,
      archiveId,
      workspaceId: chat.workspaceId,
      userId: null,
    });

    if ("error" in result) {
      // Map the service discriminated union to HTTP. Both not-found cases hide
      // existence with 404 (ARCH-LINK-02). chat_not_found is defensive — the route
      // already verified the chat, but a race is possible.
      if (result.error === "chat_not_found") {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      // archive_not_found: cross-workspace archive IDOR caught by the service
      res.status(404).json({ error: "Archive not found" });
      return;
    }

    // D-11: full Chat entity, identical shape to the JWT route
    res.json(result.chat);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[internalWidget] Error linking archive", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;