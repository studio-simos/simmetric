// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 200 (200-05 Task 1, D-15) — the in-process fake Slack Web API: a
// TEST FIXTURE serving the two Web API method shapes the slack adapter
// issues (200-01), plus a per-call log the E2E spec asserts against.
// Clones the discordApiEndpoint.ts template (199-05) — loopback-only
// http.Server, module-memory call log, start/stop exports. The fake is the
// RECEIVER of adapter calls only: the SLACK-to-us direction (event
// deliveries) is produced by the E2E spec hitting the REAL server webhook
// route with locally-computed HMAC signatures (spec-side signing — the
// signature gate is never bypassed by the fixture).
//
// THREAT POSTURE (T-200-05, plan must_haves prohibition):
//  - the listener binds 127.0.0.1 ONLY (loopback; no real network egress is
//    possible from or through the fake);
//  - the Authorization header is recorded as PRESENCE ONLY
//    (hasAuthorization boolean) — the token itself is NEVER persisted,
//    never logged, never echoed (fixture contract: no credential material
//    survives a run);
//  - callers are the dev-only /api/__tests__ helper routes (index.ts mount
//    gate — production 404). This module is never imported by production
//    runtime paths outside that mount.

import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { logger } from "../../utils/logger";

// ===== Fake Slack Web API log (module memory, test fixture only) =====

/**
 * One observed Slack Web API call — { method, path, hasAuthorization,
 * body, at }. `method` is the called Web API method (e.g. "chat.postMessage");
 * `hasAuthorization` is the ONLY Authorization material recorded (T-200-05
 * — token-masked logs); `body` carries only the response-relevant subset
 * (channel/text/ok-fields), never any credential material.
 */
export interface FakeSlackApiLogEntry {
  method: string;
  /** The bare request path (e.g. "/chat.postMessage" — no query). */
  path: string;
  /** Authorization header PRESENCE ONLY — never the token value. */
  hasAuthorization: boolean;
  /** The parsed JSON body (the fields the spec asserts on). */
  body: Record<string, unknown>;
  at: string;
}

/** Module-memory state — reset by stopFakeSlackApi(). */
const state = {
  server: null as http.Server | null,
  port: null as number | null,
  log: [] as FakeSlackApiLogEntry[],
  /** The ratelimited arm: POST /chat.postMessage answers {ok:false} + Retry-After. */
  ratelimitedMode: false,
  /** The invalid-token arm: POST /auth.test answers {ok:false, invalid_auth}. */
  invalidTokenMode: false,
  /** Fixed fake message ts for chat.postMessage results (D-15 log assertion). */
  fixedTs: "1735689600.000100",
};

// ===== Arming helpers (the E2E helper routes call these) =====

/**
 * Arm/disarm the ratelimited arm: when armed, POST /chat.postMessage
 * answers HTTP 200 `{ok: false, error: "ratelimited"}` with a
 * Retry-After header — the D-10 bounded-retry row is reproducible
 * deterministically (no rate-budget flakiness).
 */
export function setFakeSlackApiRatelimitedMode(enabled: boolean): void {
  state.ratelimitedMode = enabled;
}

/**
 * Arm/disarm the invalid-token arm: when armed, POST /auth.test answers
 * `{ok: false, error: "invalid_auth"}` (the inverted HTTP-200 trigger —
 * Slack logical errors ride ok:false even at HTTP 200).
 */
export function setFakeSlackApiInvalidTokenMode(enabled: boolean): void {
  state.invalidTokenMode = enabled;
}

/**
 * Serve ONE Slack Web API request. Recognized paths:
 *   POST /chat.postMessage → {ok: true, channel, ts, message: {ts}}
 *        (the ratelimited arm answers {ok: false, error: "ratelimited"} +
 *        Retry-After: 1 instead)
 *   POST /auth.test → {ok: true, user, bot_id, user_id}
 *        (the invalid-token arm answers {ok: false, error: "invalid_auth"})
 * Every other path → 404 {ok: false, error: "not_found"} (Slack's envelope).
 */
function serveSlackRoute(
  path: string,
  body: Record<string, unknown>,
  hasAuthorization: boolean,
  res: ServerResponse
): void {
  state.log.push({
    method: path.replace(/^\//, ""),
    path,
    hasAuthorization,
    body: { ...body },
    at: new Date().toISOString(),
  });

  if (path === "/chat.postMessage") {
    if (state.ratelimitedMode) {
      res.setHeader("Retry-After", "1");
      json(res, { ok: false, error: "ratelimited" });
      return;
    }
    json(res, {
      ok: true,
      channel: typeof body.channel === "string" ? body.channel : "",
      ts: state.fixedTs,
      message: { ts: state.fixedTs },
    });
    return;
  }

  if (path === "/auth.test") {
    if (state.invalidTokenMode) {
      json(res, { ok: false, error: "invalid_auth" });
      return;
    }
    json(res, { ok: true, user: "testbot", bot_id: "BTEST", user_id: "UTEST" });
    return;
  }

  res.statusCode = 404;
  json(res, { ok: false, error: `not_found: ${path} is not served by the fake Slack API` });
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
        reject(new Error("fake slack api: body too large"));
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
 * The request handler: POST-only Web API shapes — every other verb 404s.
 * The Authorization header is consumed for the PRESENCE flag only and is
 * never persisted or logged (fixture contract, T-200-05).
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  // Strip the query string — the adapter composes bare paths.
  const path = rawUrl.split("?")[0] ?? "/";
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw.trim() !== "") {
        try {
          const parsedBody = JSON.parse(raw) as unknown;
          if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
            body = parsedBody as Record<string, unknown>;
          }
        } catch {
          // Non-JSON POST body → treated as an empty body (the adapter's
          // calls are always JSON; the fake is lenient like the discord fake).
        }
      }
    }

    logger.debug(`[fake-slack-api] ${req.method} ${path}`);
    serveSlackRoute(path, body, typeof req.headers.authorization === "string", res);
  } catch (err: unknown) {
    logger.warn("[fake-slack-api] request handling failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.statusCode = 500;
      json(res, { ok: false, error: "internal_error" });
    }
  }
}

// ===== Public fixture API =====

/**
 * Start the fake Slack Web API listener on an EPHEMERAL port bound to
 * 127.0.0.1 ONLY. Returns the port the E2E helper uses to compose the
 * runtime SLACK_API_URL override (setSlackApiBaseOverride). Idempotent
 * per call: a second start returns the existing port (the botApiEndpoint
 * precedent). Resets the log + arm flags on a fresh start.
 */
export function startFakeSlackApi(): Promise<{ port: number }> {
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
        reject(new Error("fake slack api: failed to acquire an ephemeral port"));
        return;
      }
      state.server = server;
      state.port = port;
      state.log = [];
      state.ratelimitedMode = false;
      state.invalidTokenMode = false;
      logger.info(`[fake-slack-api] listening on 127.0.0.1:${port}`);
      resolve({ port });
    });
    server.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Stop the listener and RESET all module state (log, arm flags). The stop
 * route also clears the Web API URL override (module reset — the override
 * must NOT survive into other tests).
 */
export function stopFakeSlackApi(): Promise<void> {
  return new Promise((resolve) => {
    const server = state.server;
    state.server = null;
    state.port = null;
    state.log = [];
    state.ratelimitedMode = false;
    state.invalidTokenMode = false;
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/** The observed call log (Authorization presence-masked) — the E2E spec's assertion surface. */
export function getFakeSlackApiLog(): FakeSlackApiLogEntry[] {
  return state.log.map((e) => ({ ...e, body: { ...e.body } }));
}

/** Test-only: is the fake currently listening (and on which port)? */
export function isFakeSlackApiRunning(): { running: boolean; port: number | null } {
  return { running: state.server !== null, port: state.port };
}