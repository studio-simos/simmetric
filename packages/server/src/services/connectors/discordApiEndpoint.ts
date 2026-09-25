// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 199 (199-05 Task 1, D-11) — the in-process fake Discord REST API: a
// TEST FIXTURE serving the Discord REST v10 shapes the discord adapter issues
// (199-01), plus a per-call log the E2E spec asserts against. The
// botApiEndpoint.ts template (198-04) mirrored with Discord-shaped routes —
// the planner's add-alongside cohesion call (the shapes are Discord REST
// paths with the Authorization: Bot header, not Bot-API envelopes).
//
// THREAT POSTURE (T-199-15, plan must_haves prohibition):
//  - the listener binds 127.0.0.1 ONLY (loopback; no real network egress is
//    possible from or through the fake);
//  - the Authorization header is recorded as PRESENCE ONLY
//    (authHeaderPresent boolean) — the token itself is NEVER persisted,
//    never logged, never echoed (fixture contract: no credential material
//    survives a run);
//  - callers are the dev-only /api/__tests__ helper routes (index.ts mount
//    gate — production 404). This module is never imported by production
//    runtime paths outside that mount.

import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { logger } from "../../utils/logger";

// ===== Fake Discord REST log (module memory, test fixture only) =====

/**
 * One observed Discord REST call — { method, payload, authHeaderPresent, at }.
 * `method` is "<HTTP verb> <path>" (e.g. "POST /channels/123/messages");
 * `authHeaderPresent` is the ONLY Authorization material recorded (T-199-15).
 */
export interface FakeDiscordApiLogEntry {
  method: string;
  /** The parsed JSON request body ({} for bodyless calls like typing/@me). */
  payload: Record<string, unknown>;
  /** Authorization header PRESENCE ONLY — never the token value. */
  authHeaderPresent: boolean;
  at: string;
}

/** Module-memory state — reset by stopFakeDiscordApi(). */
const state = {
  server: null as http.Server | null,
  port: null as number | null,
  log: [] as FakeDiscordApiLogEntry[],
  /** The invalid-token arm: GET /users/@me answers 401 when armed. */
  invalidTokenMode: false,
  /** Monotonic fake message snowflake for POST /channels/:id/messages. */
  nextMessageSnowflake: 900000000000000100n,
  /** Monotonic fake user id for GET /users/@me. */
  nextUserSnowflake: 900000000000000200n,
};

/** The fake bot identity GET /users/@me returns (D-02 validate mapping). */
const FAKE_BOT_USERNAME = "fake_discord_bot";
const FAKE_BOT_GLOBAL_NAME = "Fake Discord Bot";

/**
 * Serve ONE Discord REST request. Recognized paths:
 *   GET  /users/@me → 200 { id, username, global_name } (401 { message }
 *        when the invalid-token arm is set — the D-11 error row)
 *   POST /channels/:id/typing → 204 EMPTY (the adapter maps 204 → {})
 *   POST /channels/:id/messages → 200 { id: <snowflake>, channel_id, content, ... }
 *        (echoes content; sequential fake snowflake ids)
 * Every other path → 404 { message } (Discord's JSON error envelope).
 */
function serveDiscordRoute(
  req: IncomingMessage,
  path: string,
  payload: Record<string, unknown>,
  res: ServerResponse
): void {
  const method = req.method ?? "GET";
  state.log.push({
    method: `${method} ${path}`,
    payload: { ...payload },
    authHeaderPresent: typeof req.headers.authorization === "string",
    at: new Date().toISOString(),
  });

  if (method === "GET" && path === "/users/@me") {
    if (state.invalidTokenMode) {
      // Discord's real 401 body shape (error.json): { message: "401: Unauthorized" }.
      res.statusCode = 401;
      json(res, { message: "401: Unauthorized" });
      return;
    }
    state.nextUserSnowflake += 1n;
    json(res, {
      id: state.nextUserSnowflake.toString(),
      username: FAKE_BOT_USERNAME,
      global_name: FAKE_BOT_GLOBAL_NAME,
    });
    return;
  }

  const channelRoute = path.match(/^\/channels\/([^/]+)\/(messages|typing)$/);
  if (channelRoute && method === "POST") {
    const channelId = channelRoute[1] ?? "";
    if (channelRoute[2] === "typing") {
      res.statusCode = 204; // empty body — the adapter maps 204 → {}
      res.end();
      return;
    }
    state.nextMessageSnowflake += 1n;
    json(res, {
      id: state.nextMessageSnowflake.toString(),
      channel_id: channelId,
      content: typeof payload.content === "string" ? payload.content : "",
      author: { id: state.nextUserSnowflake.toString(), username: FAKE_BOT_USERNAME, bot: true },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  res.statusCode = 404;
  json(res, { message: `Not Found: ${method} ${path} is not served by the fake Discord API` });
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
        reject(new Error("fake discord api: body too large"));
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
 * The request handler: Discord REST v10 shapes only — every other path 404s.
 * The Authorization header is consumed for the PRESENCE flag only and is
 * never persisted or logged (fixture contract, T-199-15).
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  // Strip the query string — the adapter composes bare paths.
  const path = rawUrl.split("?")[0] ?? "/";
  try {
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
          // Non-JSON POST body → treated as an empty payload (the adapter's
          // calls are always JSON; the fake is lenient like the Bot API fake).
        }
      }
    }

    logger.debug(`[fake-discord-api] ${req.method} ${path}`);
    serveDiscordRoute(req, path, payload, res);
  } catch (err: unknown) {
    logger.warn("[fake-discord-api] request handling failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.statusCode = 500;
      json(res, { message: "Internal Server Error" });
    }
  }
}

// ===== Public fixture API =====

/**
 * Start the fake Discord REST listener on an EPHEMERAL port bound to
 * 127.0.0.1 ONLY. Returns the port the E2E helper uses to compose the
 * runtime DISCORD_API_URL override (setDiscordApiBaseOverride). Idempotent
 * per call: a second start returns the existing port (the botApiEndpoint
 * precedent). Resets the log + arm flags on a fresh start.
 */
export function startFakeDiscordApi(): Promise<{ port: number }> {
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
        reject(new Error("fake discord api: failed to acquire an ephemeral port"));
        return;
      }
      state.server = server;
      state.port = port;
      state.log = [];
      state.invalidTokenMode = false;
      state.nextMessageSnowflake = 900000000000000100n;
      state.nextUserSnowflake = 900000000000000200n;
      logger.info(`[fake-discord-api] listening on 127.0.0.1:${port}`);
      resolve({ port });
    });
    server.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Stop the listener and RESET all module state (log, snowflakes, arm flags).
 * The stop route also clears both the REST and the gateway URL overrides
 * (module reset — the overrides must NOT survive into other tests).
 */
export function stopFakeDiscordApi(): Promise<void> {
  return new Promise((resolve) => {
    const server = state.server;
    state.server = null;
    state.port = null;
    state.log = [];
    state.invalidTokenMode = false;
    state.nextMessageSnowflake = 900000000000000100n;
    state.nextUserSnowflake = 900000000000000200n;
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/** The observed call log (Authorization presence-masked) — the E2E spec's assertion surface. */
export function getFakeDiscordApiLog(): FakeDiscordApiLogEntry[] {
  return state.log.map((e) => ({ ...e, payload: { ...e.payload } }));
}

/**
 * Arm/disarm the invalid-token mode: when armed, GET /users/@me answers
 * 401 { message: "401: Unauthorized" } — the D-11 validate-error row is
 * reproducible deterministically (no flaky token guessing).
 */
export function setFakeDiscordApiInvalidTokenMode(enabled: boolean): void {
  state.invalidTokenMode = enabled;
}

/** Test-only: is the fake currently listening (and on which port)? */
export function isFakeDiscordApiRunning(): { running: boolean; port: number | null } {
  return { running: state.server !== null, port: state.port };
}