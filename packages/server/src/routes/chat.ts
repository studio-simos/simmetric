// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireWorkspaceAccess } from "../middleware/rbac";
import { runAgent, runAgentStreaming } from "../agent/orchestrator";
import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";
import { scanContentAsync, progressiveDLPFlush } from "../services/dlpFilter";
import { getAndClearDlpMatches, getDlpBypassRoles } from "../filters/plugins/dlp";
import { getSetting } from "../services/systemConfigService";
import { runInlet, runOutlet } from "../filters/filterChain";

import { sendPushNotification } from "../routes/push";
import { logger } from "../utils/logger";
import { chatRequestSchema } from "@simmetric-chat/shared";
import type { AgentPlan } from "@simmetric-chat/shared";
import { resolveWikilinks, extractWikilinkSlugs } from "../services/wikiLinkService";
import { recordWidgetEvent } from "../services/widgetAnalyticsService";
import { resolveMcpSourceName } from "../agent/mcpClient";
import { generateAutoTitle, generateTagsAndFollowUps, generateBatchedTitleTagsAndFollowUps } from "../services/postProcessingService";
import { getRedis } from "../services/redisService";
import type Redis from "ioredis";
import "../agent/builtinSkills"; // Ensure skills are registered

// Phase 154 (CSW-02): chat route file map — each sub-file owns one domain.
// chat.ts ← chatCrud.ts — rename/move/edit-message/link-archive mutations on chats.
// chat.ts ← chatList.ts — list chats in a workspace (with pin + message counts).
// chat.ts ← chatAgentConfig.ts — workspace agent config get/upsert + enabled skills.
// chat.ts ← chatExport.ts — export all/single chat as JSON download.
// chat.ts ← chatImport.ts — preview + confirm chat JSON import (multer in-memory).
// chat.ts ← chatRetention.ts — audited system chat-retention-days write (confirmDataLoss).
// chat.ts ← chatTokens.ts — aggregate per-message token usage for a single chat.

// Token usage threshold for push notifications
const TOKEN_THRESHOLD = 100000;

const router = Router();
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// SSE pub/sub fan-out (SCALE-02, D-03)
// ---------------------------------------------------------------------------
// When multiple server instances run behind a load balancer, a user connected
// to instance B must be able to see a chat stream originating on instance A.
// Redis pub/sub bridges the gap: the originating instance publishes each SSE
// event to channel `sse:chat:{chatId}` AFTER writing to its local client
// (fire-and-forget — pub/sub failure never blocks the local stream). Other
// instances subscribed to the same channel relay the events to their own
// connected clients.
//
// Pitfall 1: the subscriber connection uses redis.duplicate() — ioredis
// enters subscriber mode on subscribe() and cannot issue regular commands
// (PUBLISH, SET, GET) on the same connection.
//
// Pitfall 6: the originating instance must NOT relay its own published events
// back to its local client — that would double-write every token. We track
// originating chatIds in a module-level Set and skip relay for those.

/**
 * Module-level set of chatIds that THIS instance is currently originating.
 * The subscriber message handler checks this to skip relay of our own
 * published events (Pitfall 6 — double-write prevention).
 */
const originatingChats = new Set<string>();

/**
 * Publish an SSE event to the Redis pub/sub channel `sse:chat:{chatId}`.
 * Called by sendSSE() AFTER the local res.write() — fire-and-forget so a
 * pub/sub failure never breaks the local stream (D-03).
 *
 * Exposed for unit testing. Production callers use sendSSE() which calls this
 * internally.
 */
/**
 * @public — SSE pub/sub helper extracted for the fan-out test seam
 * (sseFanout.test.ts requires it from a fresh module). Phase 180
 * reviewed-keep.
 */
export function publishSSEEvent(
  res: { write: (chunk: string) => void },
  chatId: string,
  event: string,
  data: unknown,
): void {
  // 1. Local write FIRST (D-03 — local client always gets the event)
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // 2. Fire-and-forget publish to Redis (AFTER local write)
  const redis = getRedis();
  if (redis) {
    redis
      .publish(`sse:chat:${chatId}`, JSON.stringify({ event, data }))
      .catch((err: Error) => {
        logger.warn("[sse] pub/sub publish failed (non-blocking)", {
          error: err.message,
          chatId,
        });
      });
  }
}

/**
 * Set up a Redis pub/sub subscriber for the given chatId on stream start.
 * Returns the subscriber connection (for teardown) or null when Redis is
 * unavailable (graceful degradation — SSE stays single-instance per D-02).
 *
 * @param res       The SSE response to relay events to.
 * @param chatId    The chat ID to subscribe to.
 * @param isOriginating  true if THIS instance is the origin of the stream
 *                       (it publishes events and must NOT relay its own —
 *                       Pitfall 6). false for relay-only subscribers.
 * @returns The subscriber connection, or null when Redis is unavailable.
 */
/**
 * @public — SSE subscriber bridge extracted for the fan-out test seam
 * (sseFanout.test.ts). Phase 180 reviewed-keep.
 */
export async function setupSSESubscriber(
  res: { write: (chunk: string) => void; writableEnded: boolean; on: (event: string, cb: () => void) => void },
  chatId: string,
  isOriginating: boolean,
): Promise<Redis | null> {
  const redis = getRedis();
  if (!redis) return null; // D-02: graceful degradation — single-instance mode

  // Pitfall 1: duplicate the connection for subscriber mode — the main
  // connection cannot issue regular commands after subscribe().
  const sub = redis.duplicate();

  await sub.subscribe(`sse:chat:${chatId}`);

  // Register the message handler for relay
  sub.on("message", (channel: string, message: string) => {
    // Only relay messages for our channel
    if (channel !== `sse:chat:${chatId}`) return;
    // Pitfall 6: the originating instance already wrote locally — skip relay
    if (isOriginating && originatingChats.has(chatId)) return;
    // Guard against write-after-end
    if (res.writableEnded) return;

    try {
      const parsed = JSON.parse(message) as { event: string; data: unknown };
      res.write(`event: ${parsed.event}\n`);
      res.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
    } catch {
      // Malformed pub/sub message — skip (T-104-04: not raw passthrough)
    }
  });

  // Track originating chat for double-write prevention (Pitfall 6)
  if (isOriginating) {
    originatingChats.add(chatId);
  }

  // Teardown on res close — unsubscribe + disconnect to avoid leaks (T-104-05)
  res.on("close", () => {
    if (isOriginating) {
      originatingChats.delete(chatId);
    }
    sub
      .unsubscribe(`sse:chat:${chatId}`)
      .then(() => sub.disconnect())
      .catch(() => {
        // Best-effort cleanup — connection may already be closed
      });
  });

  return sub;
}

/**
 * @openapi
 * /workspaces/{workspaceId}/chat:
 *   post:
 *     tags: [Chat]
 *     summary: Send a message and get a synchronous agent response
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - { name: workspaceId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message: { type: string, description: User message }
 *               chatId: { type: string, description: Existing chat ID to continue }
 *               ragContext: { type: string, description: Pre-computed RAG context from widget chat (optional) }
 *     responses:
 *       200:
 *         description: Agent response with metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 chatId: { type: string }
 *                 messageId: { type: string }
 *                 response: { type: string }
 *                 sources: { type: array, items: { type: object } }
 *                 toolCalls: { type: array, items: { type: object } }
 *                 iterations: { type: number }
 *                 tokenUsage: { type: object }
 *       400: { description: message is required }
 *       500: { description: Agent execution failed }
 */
// POST /api/workspaces/:workspaceId/chat — send a message and get agent response
router.post("/:workspaceId/chat", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;

  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { message, chatId, ragContext, providerId, model, attachedDocumentId } = parsed.data;

  try {
    // Get or create chat
    let chat;
    if (chatId) {
      chat = await prisma.chat.findFirst({ where: { id: chatId as string, workspaceId } });
    }

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          workspaceId,
          name: message.substring(0, 50),
          ...(providerId && { providerId }),
          ...(model && { model }),
        },
      });
    }

    // Save user message
    await prisma.chatMessage.create({
      data: {
        chatId: chat.id,
        role: "user",
        content: message,
        ...(attachedDocumentId && { attachedDocumentId: attachedDocumentId as string }),
      },
    });

    // Load chat history
    const messages = await prisma.chatMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: "asc" } as const,
      take: 20,
    });

    const history = messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));

    // Resolve attached document context (IDOR-safe: scoped to workspace + not soft-deleted)
    let effectiveRagContext: string | undefined = ragContext;
    if (attachedDocumentId) {
      const doc = await prisma.document.findFirst({
        where: { id: attachedDocumentId as string, workspaceId, deletedAt: null },
        include: { chunks: true },
      });
      if (doc && doc.chunks.length > 0) {
        const docContext = doc.chunks.map((c: { chunkText: string }) => c.chunkText).join("\n\n");
        effectiveRagContext = ragContext && typeof ragContext === "string" && ragContext.trim()
          ? `${ragContext}\n\n${docContext}`
          : docContext;
      }
    }

    // Phase 100-01: FilterChain inlet — pre-LLM filter plugins (DLP redaction
    // at priority -1). Replaces direct scanContent call; chat continues on
    // plugin crash (D-05 crash isolation). This incidentally closes the
    // pre-existing non-streaming DLP gap (RESEARCH Open Question 2).
    // 260829-n95: role NAMES threaded into the FilterContext so dlpPlugin can
    // evaluate DLP_BYPASS_ROLES (spec §2.2).
    const inletCtx = await runInlet({
      message,
      chatId: chat.id,
      workspaceId,
      userId: req.userId!,
      role: "user",
      metadata: {},
      streaming: false,
      // 260829-ms8: JWT route — always "chat" (widget never enters here).
      source: "chat",
      // 260829-n95: role names for the DLP bypass check — from the same
      // req.user payload authMiddleware already resolved (getUserWithRoles).
      userRoles: req.user?.roles?.map((ur: { role: { name: string } }) => ur.role.name) ?? [],
    });
    const processedMessage = inletCtx.message;

    // Run the agent
    const result = await runAgent({
      workspaceId,
      userId: req.userId!,
      message: processedMessage,
      chatId: chat.id,
      history,
      ragContext: effectiveRagContext,  // Pre-computed RAG context from widget chat + attached document
      providerId: providerId || chat.providerId || undefined,
      model: model || chat.model || undefined,
      archiveId: chat.archiveId ?? undefined,  // D-08: deterministic chat-scoped archiveId
    });

    // Phase 100-01: FilterChain outlet — post-LLM filter plugins (DLP
    // redaction at priority -1) applied to the assistant response before
    // it is persisted and returned to the user.
    // 260829-n95: userRoles threaded for the outlet-side bypass check.
    const outletCtx = await runOutlet({
      message: result.response,
      chatId: chat.id,
      workspaceId,
      userId: req.userId!,
      role: "assistant",
      metadata: {},
      streaming: false,
      // 260829-ms8: JWT route — always "chat" (widget never enters here).
      source: "chat",
      // 260829-n95: same acting user as the inlet — roles resolved once.
      userRoles: req.user?.roles?.map((ur: { role: { name: string } }) => ur.role.name) ?? [],
    });
    const finalResponse = outletCtx.message;

    // Save assistant response
    const assistantMessage = await prisma.chatMessage.create({
      data: {
        chatId: chat.id,
        role: "assistant",
        content: finalResponse,
        metadata: JSON.stringify({
          sources: result.sources,
          toolCalls: result.toolCalls,
          iterations: result.iterations,
          tokenUsage: result.tokenUsage ?? null,
          modelUsed: result.resolvedModel ?? null,
          modelProvider: result.providerType ?? null,
        }),
      },
    });

    await logEvent("chat", chat.id, "message", req.userId!, { iterations: result.iterations });

    // Record widget analytics event if this is a widget-originated request (per D-05)
    const widgetId = req.headers["x-widget-id"] as string | undefined;
    if (widgetId) {
      const widgetSessionId = req.headers["x-widget-session-id"] as string | undefined;
      const hasCitations = (result.sources?.length ?? 0) > 0;
      const qualityScore = hasCitations ? 1 : 0;
      recordWidgetEvent({
        widgetId,
        sessionId: widgetSessionId || null,
        query: message,
        hasCitations,
        qualityScore,
        responseLength: finalResponse?.length,
      }).catch(err => logger.error("[agent] Widget event recording failed", { error: (err instanceof Error ? err.message : String(err)) }));
    }

    // Check token usage threshold for push notification
    if (result.tokenUsage && result.tokenUsage.totalTokens > TOKEN_THRESHOLD) {
      sendPushNotification(
        "Token Usage Alert",
        `Workspace ${workspaceId.substring(0, 8)}... used ${result.tokenUsage.totalTokens.toLocaleString()} tokens`
      ).catch(() => {});
    }

    // Extract and resolve [[wikilink]] references from the agent response
    const wikilinkSlugsNs = extractWikilinkSlugs(finalResponse);
    const resolvedWikilinksNs = await resolveWikilinks(wikilinkSlugsNs);

    res.json({
      chatId: chat.id,
      messageId: assistantMessage.id,
      response: finalResponse,
      sources: result.sources,
      toolCalls: result.toolCalls,
      iterations: result.iterations,
      tokenUsage: result.tokenUsage,
      model: result.resolvedModel,
      providerType: result.providerType,
      resolvedWikilinks: resolvedWikilinksNs,
    });
  } catch (err: unknown) {
    logger.error("[agent] Error:", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Agent execution failed", details: (err instanceof Error ? err.message : String(err)) });
  }
});

/**
 * @openapi
 * /workspaces/{workspaceId}/chat/stream:
 *   post:
 *     tags: [Chat]
 *     summary: Send a message and receive a streaming SSE response
 *     description: |
 *       Server-Sent Events (SSE) streaming endpoint. The response uses `text/event-stream` content type.
 *       Each event is formatted as `event: <type>\ndata: <json>\n\n`.
 *
 *       **SSE Event Types:**
 *       - `token` — A single LLM output token. Data is a raw string.
 *       - `status` — Tool execution status update. Data: `{ "message": "..." }`.
 *       - `plan` — Structured plan from the planning phase (plan mode only, emitted before `token`). Data: `{ "goal": "...", "steps": [{ "step": 1, "action": "...", "tool": "..." | null }] }`.
 *       - `citations` — RAG source citations. Data: `{ "sources": [...] }`.
 *       - `done` — Stream complete. Data: `{ chatId, messageId, iterations, tokenUsage }`.
 *       - `error` — Agent execution error. Data: `{ "error": "..." }`.
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - { name: workspaceId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message: { type: string, description: User message }
 *               chatId: { type: string, description: Existing chat ID to continue }
 *               ragContext: { type: string, description: Pre-computed RAG context from widget chat (optional) }
 *     responses:
 *       200:
 *         description: SSE stream of agent tokens and metadata
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: object
 *               description: Stream of SSE events (token, status, citations, done, error)
 *       400: { description: message is required }
 *       500: { description: Agent execution failed (sent as SSE error event) }
 */
// POST /api/workspaces/:workspaceId/chat/stream — SSE streaming chat endpoint.
// Thin JWT wrapper over the shared handleChatStream core (260809-tuw): the
// internal widget route (internalWidget.ts POST /chat/stream) reuses the same
// handler with the widget-service account as the acting user.
router.post("/:workspaceId/chat/stream", requireWorkspaceAccess, (req: Request, res: Response) => {
  // 260815-k5s: thread the body's archiveId (selected before the first
  // message) as the 4th arg. `handleChatStream` validates the full body via
  // `chatRequestSchema.safeParse` (line 426) — an invalid archiveId is
  // rejected with 400 before reaching chat.create. `?? null` normalizes
  // undefined to null so the existing `...(archiveId && { archiveId })`
  // spread at line 489 omits the key (byte-identical to today when absent).
  void handleChatStream(req, res, req.params.workspaceId as string, req.body?.archiveId ?? null);
});

/**
 * Shared SSE stream-handler core (260809-tuw). Handles body parsing, SSE
 * headers, disconnect handling, chat get-or-create, Redis pub/sub fan-out,
 * DLP progressive flush, runAgentStreaming with all callbacks, wikilinks/MCP
 * sources, persistence, citations/done events, widget analytics, and the
 * error catch. Reads ONLY req.userId (populated by the JWT authMiddleware or
 * the internal apiKeyMiddleware), the X-Widget-Id / X-Widget-Session-Id
 * headers, and req.body. The workspace is passed in by the caller:
 * - JWT route: req.params.workspaceId (behind requireWorkspaceAccess)
 * - internal widget route: whitelist[0] resolved from the widget's DB
 *   WidgetWorkspace rows (IDOR-safe — never client-supplied)
 */
export async function handleChatStream(req: Request, res: Response, workspaceId: string, archiveId?: string | null, locale?: string, widgetModel?: { providerId?: string | null; model?: string | null }): Promise<void> {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { message, chatId, ragContext, disableRagSearch, providerId, model, attachedDocumentId, isRegeneration, include_thinking } = parsed.data;

  // 131-07 (G-131-19): the visitor locale is a WIDGET-only field — the JWT
  // route never sends it (chatRequestSchema.locale is additive-optional, so
  // the JWT route is byte-identical). The internal widget route passes it as
  // the 5th arg (threaded from the composed body's parsed.data.locale).
  const effectiveLocale = locale ?? parsed.data.locale;

  // 260831-hgy: per-widget response model pin. Priority chain:
  // body > widget config > chat record. The internal widget route passes the
  // DB-resolved widget row's responseProviderId/responseModel as the 6th arg
  // (server-side, NEVER client-supplied — the composed body schema strips
  // unknown keys and the widget proxy never sends model fields, so in
  // practice the widget config wins whenever set). The JWT route passes no
  // 6th arg → effective* === body values (byte-identical legacy behavior).
  const effectiveProviderId = providerId || widgetModel?.providerId || undefined;
  const effectiveModel = model || widgetModel?.model || undefined;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders();

  // Handle client disconnect
  let clientDisconnected = false;
  const abortController = new AbortController();
  req.on("close", () => {
    clientDisconnected = true;
    abortController.abort();
  });

  // D-03: chatId for Redis pub/sub — set after chat is created/found inside
  // the try block. Declared here so sendSSE (also defined before try) can
  // reference it via closure.
  let streamChatId = "";

  // SSE helper — defined before try block so it's accessible in catch.
  // D-03: publishes to Redis pub/sub AFTER the local res.write (fire-and-
  // forget). The publish is handled by publishSSEEvent which writes locally
  // first, then fire-and-forget publishes to sse:chat:{chatId}.
  const sendSSE = (event: string, data: unknown) => {
    if (clientDisconnected) return;
    try {
      publishSSEEvent(res, streamChatId, event, data);
    } catch {
      // Client already disconnected
    }
  };

  try {
    // Get or create chat
    let chat;
    if (chatId) {
      chat = await prisma.chat.findFirst({ where: { id: chatId as string, workspaceId } });
    }

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          workspaceId,
          name: message.substring(0, 50),
          // 260831-hgy: effective* carries the widget pin when set — widget
          // chats now record the model that actually serves them (falls back
          // to the body values on the JWT path, byte-identical).
          ...(effectiveProviderId && { providerId: effectiveProviderId }),
          ...(effectiveModel && { model: effectiveModel }),
          // 260809-uxk T3 (D-08): widget-bound knowledge archive — truthy
          // string only; null/undefined omit the key (JWT route passes no
          // 4th arg → behavior byte-identical).
          ...(archiveId && { archiveId }),
        },
      });
    }

    // D-03: subscribe to Redis pub/sub channel for this chat so events
    // published by OTHER instances are relayed to this client. This instance
    // is the origin (isOriginating=true) — it publishes events via sendSSE
    // and must NOT relay its own (Pitfall 6 double-write prevention).
    streamChatId = chat.id;
    await setupSSESubscriber(
      res as unknown as { write: (chunk: string) => void; writableEnded: boolean; on: (event: string, cb: () => void) => void },
      chat.id,
      true,
    );

    // Save user message (skip for regeneration flows where the message already exists)
    if (!isRegeneration) {
      await prisma.chatMessage.create({
        data: {
          chatId: chat.id,
          role: "user",
          content: message,
          ...(attachedDocumentId && { attachedDocumentId: attachedDocumentId as string }),
        },
      });
    }

    // Load chat history
    const messages = await prisma.chatMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: "asc" } as const,
      take: 20,
    });

    const history = messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));

    // Check DLP setting (used for ragContext logging + final output log below)
    const dlpEnabled = (await getSetting("DLP_ENABLED")).value === "true";

    // DLP source tag (quick 260829-ms8, DLP_FEATURES_SPEC §2.1): this shared
    // core serves BOTH the JWT chat route and the internal widget route, so
    // the origin surface is derived from the X-Widget-Id header — the widget
    // proxy ALWAYS sends it (widget/src/routes/chat.ts) and the JWT route
    // never carries it (IDOR design: the JWT route resolves workspaceId from
    // the path, not a widget header). Tags dlp.rag_context_match and the
    // end-of-run dlp.output_match metadata + inlet FilterContext so the
    // DlpAuditPanel can distinguish chat vs widget events.
    const isWidgetSource = Boolean(req.headers["x-widget-id"]);
    const dlpSource: "chat" | "widget" = isWidgetSource ? "widget" : "chat";

    // Phase 100-01: FilterChain inlet — pre-LLM filter plugins (DLP redaction
    // at priority -1). Replaces the direct scanContent inlet call; chat
    // continues on plugin crash (D-05). The streaming outlet progressive
    // flush stays inline below per Pitfall 4.
    // 260829-n95: role NAMES (from req.user — the widget route's
    // apiKeyMiddleware injects the widget SERVICE ACCOUNT user, so bypass
    // evaluates service-account roles too) threaded into the FilterContext;
    // dlpPlugin.inlet both skips its scan AND fires the dlp.bypassed audit
    // (fire-and-forget, spec §2.2 + §4.6) when DLP_BYPASS_ROLES intersects.
    const userRoleNames = req.user?.roles?.map((ur: { role: { name: string } }) => ur.role.name) ?? [];
    const inletCtx = await runInlet({
      message,
      chatId: chat.id,
      workspaceId,
      userId: req.userId!,
      role: "user",
      metadata: {},
      streaming: true,
      // 260829-ms8: DLP audit source tag — inlet (dlp.input_match) reads it.
      source: dlpSource,
      // 260829-n95: role names for the DLP bypass check (spec §2.2).
      userRoles: userRoleNames,
    });
    const processedMessage = inletCtx.message;

    // 260829-n95 (DLP_FEATURES_SPEC §2.2): role-bypass evaluation for the
    // INLINE streaming DLP block below, which is separate from the plugin
    // path (Phase 100 Pitfall 4 — progressive flush cannot run inside
    // runOutlet). The inlet already logged dlp.bypassed for this run when
    // the bypass fired (single event per request); here we only READ the
    // decision to gate every inline scan site (rag_context scan, thinking
    // flush, progressive token flush, final tail scan) so the bypass covers
    // EVERY streaming DLP surface (spec consistency requirement).
    const dlpScanEnabled = dlpEnabled && (await getDlpBypassRoles(userRoleNames)).length === 0;

    // Resolve attached document context (IDOR-safe: scoped to workspace + not soft-deleted)
    let effectiveRagContext: string | undefined = ragContext;
    if (attachedDocumentId) {
      const doc = await prisma.document.findFirst({
        where: { id: attachedDocumentId as string, workspaceId, deletedAt: null },
        include: { chunks: true },
      });
      if (doc && doc.chunks.length > 0) {
        const docContext = doc.chunks.map((c: { chunkText: string }) => c.chunkText).join("\n\n");
        effectiveRagContext = ragContext && typeof ragContext === "string" && ragContext.trim()
          ? `${ragContext}\n\n${docContext}`
          : docContext;
      }
    }

    // DLP: scan ragContext document chunks for PII (logging only, no redaction per revised D-13)
    // 260829-n95: gated on dlpScanEnabled (DLP_ENABLED AND no role bypass).
    // 260829-ony: DB-backed patterns via scanContentAsync (built-in fallback
    // on DB failure — spec §2.4).
    if (dlpScanEnabled && effectiveRagContext && typeof effectiveRagContext === "string" && effectiveRagContext.trim()) {
      const ragScan = await scanContentAsync(effectiveRagContext);
      if (ragScan.hasMatch) {
        const matchTypes = [...new Set(ragScan.matches.map(m => m.type))];
        await logEvent("dlp", chat.id, "dlp.rag_context_match", req.userId!, { matchTypes, source: dlpSource });
      }
    }

    // DLP streaming path stays inline per Phase 100 Pitfall 4 — FilterChain
    // streaming API deferred to v0.16. The token-by-token dlpBuffer +
    // progressiveDLPFlush + final flush below is the battle-tested
    // progressive flush (D-01); wrapping it naively in runOutlet per-token
    // would lose the holdback buffer management.
    //
    // DLP output: progressive flush with tail-holdback (D-01).
    // holdback (64 char) >= longest DLP pattern (35 char sk-[a-zA-Z0-9]{32,})
    // so PII can never be split across flush boundaries. Each replayed token
    // (from 62-03 buffered-replay) is appended to dlpBuffer; progressiveDLPFlush
    // extracts a DLP-scanned safe prefix and retains a 64-char tail.
    const DLP_HOLDBACK = 64;
    let dlpBuffer = "";
    let dlpHadMatch = false;
    // quick 260829-m6p: accumulate the matches found in EVERY progressive
    // flush (content + thinking) plus the final tail scan, so the end-of-run
    // dlp.output_match event carries the full match list of the run. The
    // previous behavior derived matchTypes from finalScan (the LAST chunk
    // scan) only — when the last chunk was clean but earlier chunks matched,
    // the event stored matchTypes: [] and the DLP audit panel showed
    // "no details" despite the row having a match-type badge.
    const dlpOutputMatches: Array<{ type: string; text: string }> = [];
    // Full redacted assistant content for downstream (wikilinks, mcpSources, chatMessage.create)
    let fullResponse = "";

    // Forward wiki_edit events from skills to the SSE stream
    const onEvent = (event: string, data: unknown) => {
      if (event === "wiki_edit") {
        sendSSE("wiki_edit", data);
      }
    };

    // Forward the structured plan from the planning phase (plan mode only).
    // Emitted before any `token`/`status` so the frontend can render the
    // PlanBanner above the in-flight response.
    const onPlan = (plan: AgentPlan) => {
      sendSSE("plan", plan);
    };

    // D-03 (Phase 94): onThinking callback — mirror of onToken DLP progressive
    // flush. The callback ALWAYS fires when the provider yields reasoning
    // (Ollama `message.thinking`); the opt-in gate is load-bearing here:
    // `event: thinking` is emitted ONLY when `include_thinking === true`.
    // When false/absent, reasoning is parsed and silently discarded (Pitfall 4
    // HIGHEST RISK — widget cached clients must never receive thinking).
    // DLP progressive flush applies to thinking too (T-94-01): PII in
    // reasoning is redacted before SSE emission, same as content tokens.
    let dlpThinkingBuffer = "";
    // 260829-n95: role bypass — thinking flush gated on dlpScanEnabled too
    // (PII in reasoning passes through unredacted for bypassed roles).
    const onThinking = (thinking: string) => {
      if (!dlpScanEnabled) {
        if (include_thinking === true && !clientDisconnected) {
          sendSSE("thinking", { content: thinking });
        }
        return;
      }
      dlpThinkingBuffer += thinking;
      const { safePrefix, remaining, hadMatch, matches } = progressiveDLPFlush(dlpThinkingBuffer, DLP_HOLDBACK);
      if (hadMatch) dlpHadMatch = true;
      dlpOutputMatches.push(...matches.map(m => ({ type: m.type, text: m.matchedText })));
      if (safePrefix && include_thinking === true && !clientDisconnected) {
        sendSSE("thinking", { content: safePrefix });
      }
      dlpThinkingBuffer = remaining;
    };

    // Run the streaming agent
    const result = await runAgentStreaming(
      {
        workspaceId,
        userId: req.userId!,
        message: processedMessage,
        chatId: chat.id,
        history,
        ragContext: effectiveRagContext,  // Pre-computed RAG context from widget chat + attached document (NOT redacted per D-13)
        disableRagSearch,  // WID-02 D-04: forwarded to orchestrator to filter rag_search fallback
        // 131-07 (G-131-19): the visitor locale reaches the orchestrator so
        // the no-results sentence follows the chat language (additive — the
        // JWT route never sends it).
        ...(effectiveLocale ? { locale: effectiveLocale } : {}),
        // 260831-hgy: priority chain for the serving model —
        // effective* (body > widget pin) BEFORE chat.providerId/chat.model.
        // The widget pin MUST sit BEFORE chat.model because Chat.model has a
        // schema default ("qwen2.5:3b") which would otherwise mask the widget
        // selection on chat continuation (chat.model is always truthy once
        // the chat row exists). The orchestrator honors params.model by
        // skipping the workspace agentConfig.model override
        // (orchestrator.ts resolveProviderConfig) → widget config > workspace
        // default > global default.
        providerId: effectiveProviderId || chat.providerId || undefined,
        model: effectiveModel || chat.model || undefined,
        archiveId: chat.archiveId ?? undefined,  // D-08: deterministic chat-scoped archiveId
      },
      // onToken — D-01 progressive DLP flush: append to dlpBuffer, extract
      // safe prefix, emit via sendSSE, retain 64-char tail.
      // 260829-n95: dlpScanEnabled=false (role bypass) → skip the progress
      // scan entirely, emit the raw token (every-other-path gated below).
      (token: string) => {
        if (!dlpScanEnabled) {
          fullResponse += token;
          if (!clientDisconnected) sendSSE("token", token);
          return;
        }
        dlpBuffer += token;
        const { safePrefix, remaining, hadMatch, matches } = progressiveDLPFlush(dlpBuffer, DLP_HOLDBACK);
        if (hadMatch) dlpHadMatch = true;
        dlpOutputMatches.push(...matches.map(m => ({ type: m.type, text: m.matchedText })));
        if (safePrefix && !clientDisconnected) {
          sendSSE("token", safePrefix);
        }
        fullResponse += safePrefix;
        dlpBuffer = remaining;
      },
      // onStatus — notify client of tool execution status
      (statusMessage: string) => {
        sendSSE("status", { message: statusMessage });
      },
      abortController.signal,
      onEvent,
      onPlan,
      onThinking,
    );

    // D-03 (Phase 94): final flush of the thinking DLP tail. Same pattern as
    // the content final flush below — scan on the remaining buffer
    // redacts any PII that completed inside the tail. Emitted ONLY when
    // `include_thinking === true` (opt-in gate, Pitfall 4).
    // 260829-n95: bypassed runs pass the thinking tail through unredacted.
    // 260829-ony: DB-backed patterns via scanContentAsync (spec Fase 3 — the
    // FINAL flush moves to async patterns; the per-token flush above stays
    // sync on the built-ins, v1 limitation per spec §4.1). The await is safe
    // here: we are already in the async SSE handler after runAgentStreaming
    // resolved, no per-token hot loop.
    const thinkingFinalScan = dlpScanEnabled ? await scanContentAsync(dlpThinkingBuffer) : { hasMatch: false, matches: [], redactedText: dlpThinkingBuffer };
    const thinkingFinal = thinkingFinalScan.hasMatch ? thinkingFinalScan.redactedText : dlpThinkingBuffer;
    if (thinkingFinalScan.hasMatch) dlpHadMatch = true;
    if (thinkingFinal && include_thinking === true && !clientDisconnected) {
      sendSSE("thinking", { content: thinkingFinal });
    }

    // DLP output: final flush of the held-back tail (D-01). Scan on
    // the remaining buffer redacts any PII that completed inside the tail.
    // 260829-n95: bypassed runs pass the tail through unredacted (and never
    // emit thinking either — the onThinking callback already gated above).
    // 260829-ony: scanContentAsync — end-of-stream final flush runs the
    // DB-backed pattern set (built-in fallback on DB failure, spec §2.4).
    const finalScan = dlpScanEnabled ? await scanContentAsync(dlpBuffer) : { hasMatch: false, matches: [], redactedText: dlpBuffer };
    const finalResponse = finalScan.hasMatch ? finalScan.redactedText : dlpBuffer;
    if (finalScan.hasMatch) dlpHadMatch = true;
    dlpOutputMatches.push(...finalScan.matches.map(m => ({ type: m.type, text: m.matchedText })));
    fullResponse += finalResponse;
    if (finalResponse && !clientDisconnected) {
      sendSSE("token", finalResponse);
    }

    // Phase 115: retrieve accumulated DLP matches for SSE done event and metadata persistence
    const finalDlpMatches = getAndClearDlpMatches(chat.id);

    // DLP log event — fire once if any scan across the run had a match.
    // quick 260829-m6p: matchTypes + matches derive from the accumulated
    // flush matches of the WHOLE run (content + thinking + tail), not from
    // finalScan alone. Matches are stored per the dlp filter-plugin precedent
    // (dlp.input_match / non-streaming dlp.output_match both carry matches);
    // this panel is admin-only + audit_log_immutable-gated and the same
    // data already reaches the client via the done event / message metadata.
    // 260829-n95: dlpScanEnabled (not dlpEnabled) — a bypassed run never
    // scans, so dlpHadMatch stays false anyway; the gate documents intent.
    if (dlpScanEnabled && dlpHadMatch) {
      const matchTypes = [...new Set(dlpOutputMatches.map(m => m.type))];
      await logEvent("dlp", chat.id, "dlp.output_match", req.userId!, {
        matchTypes,
        matches: dlpOutputMatches.length > 0 ? dlpOutputMatches : undefined,
        // 260829-ms8: origin surface — "widget" when the shared core was
        // entered via internalWidget.ts (X-Widget-Id header), "chat" for JWT.
        source: dlpSource,
      });
    }

    // Extract and resolve [[wikilink]] references from the FULL response (NOT
    // finalResponse, which is only the DLP tail-holdback ~64 char — extracting
    // from there would miss wikilinks in the body of the answer).
    const wikilinkSlugs = extractWikilinkSlugs(fullResponse);
    const resolvedWikilinks = await resolveWikilinks(wikilinkSlugs);

    // Extract MCP sources from tool calls (per D-16, D-17, D-18).
    // D-13: resolve UUID-prefixed tool names back to human-readable connection.name
    // via the resolveMcpSourceName helper (Pitfall 2: lastIndexOf split broke under UUID).
    const mcpToolCalls = (result.toolCalls || []).filter(tc => tc.tool.startsWith("mcp_"));
    const resolvedNames = await Promise.all(
      mcpToolCalls.map(tc => resolveMcpSourceName(tc.tool))
    );
    const mcpSources = [...new Set(resolvedNames.filter((n): n is string => n !== null))];

    // Save assistant response to DB (redacted content if DLP match, includes mcpSources in metadata)
    // D-08: persistence MUST NOT depend on client connection — wrap in try/catch
    // so EPIPE/write-after-end on the SSE side never blocks message persistence.
    // D-04 (plan 62-05): on unknown_tool_breaker trip, SKIP the assistant save
    // (no hallucinated tool-call content persisted to chat history) and emit an
    // SSE event:error to the user. Token usage still persists via the
    // orchestrator's finally block (BOT-01, plan 62-03) — no free runs.
    let assistantMessage: { id: string } | null = null;
    if (result.abortReason !== "unknown_tool_breaker") {
      try {
        assistantMessage = await prisma.chatMessage.create({
          data: {
            chatId: chat.id,
            role: "assistant",
            // BUG FIX: persist the FULL redacted response (fullResponse), NOT
            // finalResponse. finalResponse is only the final DLP tail-holdback
            // flush (~64 char); saving it truncated every assistant message to
            // its last ~64 characters on chat reload. fullResponse holds the
            // complete DLP-redacted answer (accumulated token-by-token + final
            // flush at line 429).
            content: fullResponse,
            metadata: JSON.stringify({
              sources: result.sources,
              toolCalls: result.toolCalls,
              iterations: result.iterations,
              mcpSources,
              tokenUsage: result.tokenUsage ?? null,
              modelUsed: result.resolvedModel ?? null,
              modelProvider: result.providerType ?? null,
              dlpMatches: finalDlpMatches.length > 0 ? finalDlpMatches : undefined,
            }),
          },
        });
      } catch (err: unknown) {
        logger.warn("[agent/stream] Failed to save assistant message: " + (err instanceof Error ? err.message : String(err)));
      }
    } else {
      // D-04 breaker trip: surface the failure to the user as an SSE error event.
      // No assistant chatMessage.create — hallucinated tool-call content is not persisted.
      if (!clientDisconnected) {
        sendSSE("error", { error: "Il modello ha tentato tool inesistenti ripetutamente" });
      }
    }

    // D-02 (Phase 98): fire-and-forget auto title generation — post-commit
    // (assistantMessage already saved above), non-blocking (does NOT await),
    // before sendSSE("done"). Pattern identical to recordWidgetEvent/sendPushNotification.
    // Gates inside the service: auto_title_enabled + license + titleSource + count === 1.
    if (assistantMessage) {
      // Phase 157 (CSW-12 D-10): when auto_batch_title_tags=true AND both
      // auto_title_enabled + auto_tags_enabled are on, issue ONE batched LLM
      // call (title + tags + follow-ups) instead of the two-call default path.
      // The gate reads are cheap (cached SystemConfig lookups) and run after
      // the assistant message is saved, so they don't block the SSE response.
      const batchEnabled = (await getSetting("auto_batch_title_tags")).value === "true";
      const titleOn = (await getSetting("auto_title_enabled")).value === "true";
      const tagsOn = (await getSetting("auto_tags_enabled")).value === "true";
      if (batchEnabled && titleOn && tagsOn) {
        void generateBatchedTitleTagsAndFollowUps(chat.id, assistantMessage.id, message, fullResponse).catch(
          (err: unknown) =>
            logger.warn("[post-proc] Batched generation failed", {
              chatId: chat.id,
              error: err instanceof Error ? err.message : String(err),
            }),
        );
      } else {
        void generateAutoTitle(chat.id, message, fullResponse).catch((err: unknown) =>
          logger.warn("[post-proc] Auto title generation failed", {
            chatId: chat.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        // D-06: Tag + follow-up gen — fire-and-forget, parallel with title gen.
        void generateTagsAndFollowUps(chat.id, assistantMessage.id, message, fullResponse).catch(
          (err: unknown) =>
            logger.warn("[post-proc] Tag/follow-up generation failed", {
              chatId: chat.id,
              error: err instanceof Error ? err.message : String(err),
            }),
        );
      }
    }

    // Log event
    await logEvent("chat", chat.id, "message", req.userId!, { iterations: result.iterations, streaming: true });

    // Check token usage threshold
    if (result.tokenUsage && result.tokenUsage.totalTokens > TOKEN_THRESHOLD) {
      sendPushNotification(
        "Token Usage Alert",
        `Workspace ${workspaceId.substring(0, 8)}... used ${result.tokenUsage.totalTokens.toLocaleString()} tokens`
      ).catch(() => {});
    }

    // Send citations
    sendSSE("citations", { sources: result.sources || [] });

    // Send done event with metadata (includes mcpSources per D-17).
    // D-08: sendSSE helper already guards against clientDisconnected (line 274)
    // so the done event is suppressed silently when the client has disconnected.
    sendSSE("done", {
      chatId: chat.id,
      messageId: assistantMessage?.id ?? null,
      iterations: result.iterations,
      tokenUsage: result.tokenUsage,
      model: result.resolvedModel,
      providerType: result.providerType,
      mcpSources,
      resolvedWikilinks,
      // Phase 115: dlp_matches — only present when DLP is enabled and matches found
      // 260829-n95: dlpScanEnabled — bypassed runs carry no matches.
      dlp_matches: dlpScanEnabled && finalDlpMatches.length > 0 ? finalDlpMatches : undefined,
      // D-04 (Phase 94): additive optional — per-provider normalized
      // termination reason. Omitted (undefined) when not mappable; old
      // clients ignore the field (JS graceful on unknown object fields).
      doneReason: result.doneReason,
      // Pipeline info — describes what tools were called and whether sources
      // were found. Used by the frontend to show the user how the answer was
      // produced.
      pipeline: result.pipeline,
    });

    // Record widget analytics event if this is a widget-originated request (per D-03)
    const widgetId = req.headers["x-widget-id"] as string | undefined;
    if (widgetId) {
      const widgetSessionId = req.headers["x-widget-session-id"] as string | undefined;
      const hasCitations = (result.sources?.length ?? 0) > 0;
      const qualityScore = hasCitations ? 1 : 0;
      recordWidgetEvent({
        widgetId,
        sessionId: widgetSessionId || null,
        query: message,
        hasCitations,
        qualityScore,
        responseLength: result.response?.length,
      }).catch(err => logger.error("[agent] Widget event recording failed", { error: (err instanceof Error ? err.message : String(err)) }));
    }

    // D-08: EPIPE guard — only end the response if the client is still connected.
    if (!clientDisconnected) {
      try {
        res.end();
      } catch {
        // EPIPE/write-after-end — client already gone
      }
    }
  } catch (err: unknown) {
    logger.error("[agent/stream] Error:", { error: (err instanceof Error ? err.message : String(err)), stack: (err instanceof Error ? err.stack : undefined) });

    // Try to send error event if client is still connected
    if (!clientDisconnected) {
      try {
        sendSSE("error", { error: (err instanceof Error ? err.message : String(err)) || "Agent execution failed" });
        res.end();
      } catch {
        // Client already disconnected
      }
    }
  }
}

export default router;
