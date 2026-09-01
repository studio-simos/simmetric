// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import axios, { type AxiosRequestConfig } from "axios";
import { widgetChatRequestSchema } from "@simmetric-chat/shared";
import { incrementSessionCounters, searchWidgetWorkspaces } from "../services/widgetApi";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

const router: Router = Router();

// D-03 (Phase 94): stripThinkingEvent — pure function that filters
// `event: thinking` blocks from raw SSE bytes. Defense-in-depth for Pitfall 4
// (HIGHEST RISK): even if upstream emits `thinking` (bug or future change),
// the proxy filters it before reaching cached Preact clients that may not
// know how to handle it. The widget also NEVER sets `include_thinking` in
// the upstream request body (the opt-in gate is the primary safety net).
//
// SSE guarantees event boundaries at `\n\n`. The buffer-based approach
// handles blocks split across `data` chunks: incomplete blocks are held in
// `buffer.pending` and completed on the next chunk (mirrors parseSSEStream
// pattern, RESEARCH §Pattern 4).
function stripThinkingEvent(raw: string, buffer: { pending: string }): string {
  const combined = buffer.pending + raw;
  const blocks = combined.split("\n\n");
  buffer.pending = blocks.pop() ?? "";
  const kept = blocks.filter((block) => {
    const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
    return !eventLine || !eventLine.includes("thinking");
  });
  return kept.length > 0 ? kept.join("\n\n") + "\n\n" : "";
}

// POST /:widgetId/stream — SSE proxy to main server chat endpoint
router.post("/:widgetId/stream", async (req: Request<{ widgetId: string }>, res: Response) => {
  const widgetId = req.params.widgetId;

  // Validate request body with Zod schema
  const parsed = widgetChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { message, chatId, locale } = parsed.data;

  // Session middleware attaches widgetSession and widgetConfig
  const session = req.widgetSession;
  const config = req.widgetConfig;

  if (!session || !config) {
    res.status(401).json({ error: "Missing session token" });
    return;
  }

  // Check DB-tracked rate limits from session
  if (session.hourlyRemaining !== undefined && session.hourlyRemaining <= 0) {
    res.status(429).json({ error: "Rate limit exceeded", retryAfter: "3600" });
    return;
  }

  // Increment message counter before proxying (D-10)
  try {
    await incrementSessionCounters(session.sessionToken, "messageCount");
  } catch (err: any) {
    logger.error("[widget/chat] Failed to increment session counters", { error: err.message });
  }

  // Pre-search widget's linked workspaces for RAG context (RAG-02, RAG-03)
  // Send widgetId (not workspaceIds) -- server resolves workspaceIds from DB whitelist (IDOR prevention)
  // WID-02 D-01/D-02: hard failure (throw/5xx/timeout) OR results.length === 0
  // triggers rag-degraded path (status event to client + disableRagSearch body upstream)
  let ragContext: string | undefined;
  let disableRagSearch = false;
  let searchFailed = false;
  try {
    const searchResponse = await searchWidgetWorkspaces(
      message,
      config.id   // widgetId -- server resolves workspaceIds from DB
    );
    const results = searchResponse.results || [];
    if (results.length === 0) {
      searchFailed = true; // D-02: 0 risultati = degrado (multi-workspace include già il primary)
    } else {
      ragContext = results.map((r: any) =>
        `[Source: ${r.documentName || "Unknown"} (workspace: ${r.metadata?.sourceWorkspaceId || config.workspaceId})]\n${r.chunkText}`
      ).join("\n\n---\n\n");
    }
  } catch (err: any) {
    searchFailed = true;
    logger.warn("[widget/chat] RAG search failed, degrading", { error: err.message });
  }

  // Set SSE headers (matching main server agent.ts pattern)
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // WID-02 D-01/D-03: emit status event rag-degraded to client BEFORE proxying upstream
  // so the visitor sees the degradation via ErrorBar (auto-hide 5s, dismissible).
  // Byte-relay below stays a transparent pass-through — no SSE parsing in the proxy.
  // 131-07 (G-131-19): the event carries a machine-readable flag ONLY — the
  // hardcoded English literal is gone. The client translates via
  // t("chatErrors.ragDegraded") (it knows the resolved visitor locale; this
  // proxy does not). A cached old client receiving the key-less event shows
  // its t() fallback, never leaked text (T-131-16).
  if (searchFailed) {
    try {
      res.write(`event: status\ndata: ${JSON.stringify({
        status: "rag-degraded",
        level: "warn",
      })}\n\n`);
    } catch {
      // Client already disconnected — abort gracefully
    }
    disableRagSearch = true;
  }

  // Track client disconnect
  let clientDisconnected = false;
  const abortController = new AbortController();

  req.on("close", () => {
    clientDisconnected = true;
    abortController.abort();
  });

  // Proxy to main server SSE endpoint (260809-tuw): the internal widget
  // endpoint accepts the proxy's API-key-only auth (X-Api-Key), unlike the
  // JWT-only /api/workspaces/:workspaceId/chat/stream route (which 401s —
  // the "Upstream request failed" bug). The server resolves the target
  // workspace from the widget's DB whitelist (IDOR-safe). The proxy stays a
  // dumb byte-relay: headers/body/relay are unchanged.
  const env = getEnv();
  const upstreamUrl = `${env.SERVER_URL}/api/internal/widget/chat/stream`;

  try {
    const upstream = await axios.post(upstreamUrl, {
      message,
      ...(chatId ? { chatId } : {}),
      // 131-07 (G-131-19): forward the visitor locale so the server
      // orchestrator can localize the no-results sentence (additive — omitted
      // when the client does not send it).
      ...(locale ? { locale } : {}),
      ...(ragContext ? { ragContext } : {}),
      // WID-02 D-04: when pre-search failed/empty, ask server to filter rag_search
      // skill from active skills (mirror of ragContext branch, orchestrator.ts:154)
      ...(disableRagSearch ? { disableRagSearch } : {}),
    }, {
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": env.WIDGET_API_KEY,
        "X-Widget-Id": widgetId,
        ...(session.id ? { "X-Widget-Session-Id": session.id } : {}),
        // WID-01 D-08: disable intermediary (nginx) buffering along the whole path
        // and advertise SSE intent on the upstream REQUEST (not just the response)
        "X-Accel-Buffering": "no",
        "Accept": "text/event-stream",
      },
      responseType: "stream",
      signal: abortController.signal,
    } as AxiosRequestConfig);

    // D-03 (Phase 94): stripBuffer holds incomplete SSE blocks split across
    // `data` chunks. The stripThinkingEvent filter removes `event: thinking`
    // blocks defense-in-depth (Pitfall 4) before relaying to the cached
    // Preact client. The widget NEVER sets include_thinking upstream, so
    // upstream should not emit thinking — the strip is the safety net.
    const stripBuffer = { pending: "" };

    // Relay SSE bytes from upstream to client, filtering `event: thinking`
    // blocks defense-in-depth (Pitfall 4 HIGHEST RISK).
    upstream.data.on("data", (chunk: Buffer) => {
      if (clientDisconnected) return;
      const raw = chunk.toString();
      const filtered = stripThinkingEvent(raw, stripBuffer);
      if (filtered) {
        try {
          res.write(filtered);
        } catch {
          // EPIPE or similar — client already disconnected
          clientDisconnected = true;
          abortController.abort();
        }
      }
    });

    upstream.data.on("end", () => {
      if (!clientDisconnected) {
        try {
          res.end();
        } catch {
          // Client already disconnected
        }
      }
    });

    upstream.data.on("error", (err: Error) => {
      logger.error("[widget/chat] Upstream stream error", { error: err.message });
      if (!clientDisconnected) {
        try {
          if (res.headersSent) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: "Upstream stream error" })}\n\n`);
            res.end();
          } else {
            res.status(502).json({ error: "Upstream stream error" });
          }
        } catch {
          // Client already disconnected
        }
      }
    });
  } catch (err: any) {
    logger.error("[widget/chat] Upstream request failed", { error: err.message });
    if (!clientDisconnected) {
      try {
        if (res.headersSent) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: "Upstream request failed" })}\n\n`);
          res.end();
        } else {
          res.status(502).json({ error: "Upstream request failed" });
        }
      } catch {
        // Client already disconnected
      }
    }
  }
});

export default router;