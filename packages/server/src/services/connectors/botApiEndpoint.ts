// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-04 Task 2, OQ-1 option (b), A8) — the in-process fake Bot
// API endpoint: a TEST FIXTURE serving the five Bot API method shapes the
// telegram adapter issues, plus a per-call log the E2E spec asserts against.
//
// THREAT POSTURE (T-198-15, plan must_haves prohibition):
//  - the listener binds 127.0.0.1 ONLY (loopback; no real network egress is
//    possible from or through the fake);
//  - tokens are compared ONLY to recognize the /bot<token>/<method> path —
//    the fake NEVER persists or validates real tokens, and log entries MASK
//    the token fragment;
//  - callers are the dev-only /api/__tests__ helper routes (index.ts mount
//    gate — production 404). This module is never imported by production
//    runtime paths outside that mount.

import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { logger } from "../../utils/logger";

// ===== Fake Bot API log + update queue (module memory, test fixture only) =====

/** One observed Bot API call — { method, payload, at }. Token-masked. */
export interface FakeBotApiLogEntry {
  method: string;
  /** The parsed request payload (query params merged for getUpdates-style calls). */
  payload: Record<string, unknown>;
  at: string;
}

/** Module-memory state — reset by stopFakeBotApi(). */
const state = {
  server: null as http.Server | null,
  port: null as number | null,
  log: [] as FakeBotApiLogEntry[],
  /** Updates queued for getUpdates to drain (FIFO), with their update_id. */
  updateQueue: [] as Array<Record<string, unknown>>,
  /** Monotonic message_id for sendMessage results. */
  nextMessageId: 1000,
  /** getUpdates offset tracking: updates drained once, then []. */
};

/** Mask the /bot<token>/ fragment of a request URL before it can reach any log. */
function maskTokenPath(rawUrl: string): string {
  // /bot<token>/<method> → /bot<masked>/<method> (length-preserving stars).
  const m = rawUrl.match(/^\/bot([^/]+)\/?(.*)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return rawUrl;
  const token = m[1];
  return `/bot${"*".repeat(Math.min(token.length, 12))}/${m[2]}`;
}

/** Extract { token, method } from the /bot<token>/<method> URL shape. */
function parseBotPath(rawUrl: string): { token: string; method: string } | null {
  const m = rawUrl.match(/^\/bot([^/]+)\/([^/?]+)(?:\?.*)?$/);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { token: m[1], method: m[2] };
}

/** Parse the query string of a URL into a plain record (string values only). */
function parseQuery(rawUrl: string): Record<string, string> {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return {};
  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

/**
 * Serve ONE Bot API request. Recognized methods:
 *   getMe → { ok, result: { id: 1, is_bot: true, username: "fake_bot", first_name: "Fake Bot" } }
 *   getUpdates → queued updates drained ONCE (offset >= queue-floor semantics:
 *     a repeated call with the SAME offset returns [] — increments advance the
 *     cursor), then { ok, result: [] }
 *   sendMessage → { ok, result: { message_id: <incrementing>, ... } }
 *   sendChatAction → { ok, result: true }
 *   setWebhook / deleteWebhook → { ok, result: true }
 * Unknown method → 404 { ok: false, error_code: 404, description }.
 */
function serveBotMethod(
  method: string,
  payload: Record<string, unknown>,
  res: ServerResponse
): void {
  state.log.push({ method, payload: maskPayload(method, payload), at: new Date().toISOString() });

  switch (method) {
    case "getMe":
      json(res, {
        ok: true,
        result: { id: 1, is_bot: true, username: "fake_bot", first_name: "Fake Bot" },
      });
      return;
    case "getUpdates": {
      // Telegram semantics: updates with update_id >= offset are returned and
      // CONFIRMED by the next call's offset. The fake drains once per cursor:
      // the response returns everything queued, and a follow-up call with the
      // SAME-or-lower offset than what was already served returns [].
      const offsetRaw = typeof payload.offset === "string" ? payload.offset : String(payload.offset ?? "0");
      let offset = 0n;
      try {
        offset = BigInt(offsetRaw);
      } catch {
        offset = 0n;
      }
      const deliverable = state.updateQueue.filter((u) => {
        const uid = BigInt((u as { update_id?: number | string }).update_id ?? 0n);
        return uid >= offset;
      });
      if (deliverable.length > 0) {
        // Drain: the caller's next offset (max update_id + 1) will filter
        // everything below — simulate by REMOVING delivered updates.
        state.updateQueue = state.updateQueue.filter((u) => !deliverable.includes(u));
        json(res, { ok: true, result: deliverable });
        return;
      }
      json(res, { ok: true, result: [] });
      return;
    }
    case "sendMessage":
      state.nextMessageId += 1;
      json(res, {
        ok: true,
        result: {
          message_id: state.nextMessageId,
          date: Math.floor(Date.now() / 1000),
          text: payload.text ?? "",
          chat: { id: payload.chat_id, type: "private" },
        },
      });
      return;
    case "sendChatAction":
      json(res, { ok: true, result: true });
      return;
    case "setWebhook":
      json(res, { ok: true, result: true, description: "Webhook was set" });
      return;
    case "deleteWebhook":
      json(res, { ok: true, result: true, description: "Webhook was deleted" });
      return;
    default:
      res.statusCode = 404;
      json(res, { ok: false, error_code: 404, description: `Not Found: method ${method} not found` });
      return;
  }
}

/**
 * Token masking in the log: payloads never contain the token (the adapter
 * puts it in the URL), but sendMessage texts and chat ids are payload shapes
 * the spec asserts on — keep them verbatim. The URL token is masked at
 * request time (never enters the log).
 */
function maskPayload(method: string, payload: Record<string, unknown>): Record<string, unknown> {
  // No token-shaped fields in any adapter payload — verbatim is safe. The
  // explicit method-keyed hook documents the discipline for future payload
  // shapes that might carry credential material.
  void method;
  return payload;
}

function json(res: ServerResponse, body: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Read the full request body (JSON). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (c.length > 1024 * 1024) {
        reject(new Error("fake bot api: body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The request handler: /bot<token>/<method> only — every other path 404s.
 * The token fragment is masked before ANY logging (T-198-10 discipline
 * mirrored in the fixture).
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  try {
    const parsed = parseBotPath(rawUrl);
    if (!parsed) {
      res.statusCode = 404;
      json(res, { ok: false, error_code: 404, description: "Not Found (fake bot api serves /bot<token>/<method> only)" });
      return;
    }
    // The token is ONLY used to recognize the path shape — never persisted,
    // never validated, never logged (fixture contract).
    void parsed.token;

    let payload: Record<string, unknown> = {};
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw.trim() !== "") {
        try {
          const parsedBody = JSON.parse(raw) as unknown;
          if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
            payload = parsedBody as Record<string, unknown>;
          }
        } catch {
          // Non-JSON POST body → treated as an empty payload (the Bot API
          // methods the adapter uses are always JSON; the fake is lenient).
        }
      }
    }
    // GET-style query params merge into the payload (getUpdates offset).
    const query = parseQuery(rawUrl);
    for (const [k, v] of Object.entries(query)) {
      if (!(k in payload)) payload[k] = v;
    }

    logger.debug(`[fake-bot-api] ${maskTokenPath(rawUrl)}`);
    serveBotMethod(parsed.method, payload, res);
  } catch (err: unknown) {
    logger.warn("[fake-bot-api] request handling failed", {
      path: maskTokenPath(rawUrl),
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.statusCode = 500;
      json(res, { ok: false, error_code: 500, description: "Internal Server Error" });
    }
  }
}

// ===== Public fixture API =====

/**
 * Start the fake Bot API listener on an EPHEMERAL port bound to 127.0.0.1
 * ONLY. Returns the port the E2E helper uses to compose the runtime
 * TELEGRAM_API_URL override (OQ-1 option (b)). Idempotent per call: a
 * second start returns the existing port (the echo-server precedent).
 */
export function startFakeBotApi(): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    if (state.server && state.port !== null) {
      resolve({ port: state.port });
      return;
    }
    const server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    // Loopback ONLY (fixture contract: no real network egress possible).
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      if (!port) {
        reject(new Error("fake bot api: failed to acquire an ephemeral port"));
        return;
      }
      state.server = server;
      state.port = port;
      state.log = [];
      state.updateQueue = [];
      state.nextMessageId = 100;
      logger.info(`[fake-bot-api] listening on 127.0.0.1:${port}`);
      resolve({ port });
    });
    server.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Stop the listener and RESET all module state (log, queue, counters).
 * The stop route also clears the telegram base-URL override (module reset —
 * the override must NOT survive into other tests).
 */
export function stopFakeBotApi(): Promise<void> {
  return new Promise((resolve) => {
    const server = state.server;
    state.server = null;
    state.port = null;
    state.log = [];
    state.updateQueue = [];
    state.nextMessageId = 100;
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/** The observed call log (masked) — the E2E spec's assertion surface. */
export function getFakeBotApiLog(): FakeBotApiLogEntry[] {
  return state.log.map((e) => ({ ...e, payload: { ...e.payload } }));
}

/** Queue an update for the next getUpdates drain (deep-copied). */
export function enqueueUpdate(update: Record<string, unknown>): void {
  state.updateQueue.push(JSON.parse(JSON.stringify(update)) as Record<string, unknown>);
}

/** Test-only: is the fake currently listening (and on which port)? */
export function isFakeBotApiRunning(): { running: boolean; port: number | null } {
  return { running: state.server !== null, port: state.port };
}