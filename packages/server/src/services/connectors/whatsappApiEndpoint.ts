// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 200 (200-05 Task 1, D-15) — the in-process fake WhatsApp Cloud API
// (Graph): a TEST FIXTURE serving the Graph shapes the whatsapp adapter
// issues (200-02), plus a per-call log the E2E spec asserts against.
// Clones the discordApiEndpoint.ts template (199-05) — loopback-only
// http.Server, module-memory call log, start/stop exports. The fake is the
// RECEIVER of adapter calls only: the META-to-us direction (webhook
// deliveries + the GET handshake) is produced by the E2E spec hitting the
// REAL server webhook route (spec-side X-Hub-Signature-256 signing) — the
// signature gate is never bypassed by the fixture.
//
// ROUTE SHAPES served (both probe targets the 200-02 adapter owns):
//   GET /me                     → the token-only validateBotToken probe
//   GET /:phoneId               → the getBotInfo phone-metadata probe
//   POST /:phoneId/messages     → the Cloud API send
//
// THREAT POSTURE (T-200-05, plan must_haves prohibition):
//  - the listener binds 127.0.0.1 ONLY (loopback; no real network egress is
//    possible from or through the fake);
//  - the Authorization header is recorded as PRESENCE ONLY
//    (hasAuthorization boolean) — the token itself is NEVER persisted,
//    never logged, never echoed (fixture contract: no credential material
//    survives a run);
//  - NO template-message shape exists anywhere in this fixture (COVERAGE.md
//    OPT-OUT; spec §7.9-4 — the opt-out must not leak into the fixtures);
//  - callers are the dev-only /api/__tests__ helper routes (index.ts mount
//    gate — production 404). This module is never imported by production
//    runtime paths outside that mount.

import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { logger } from "../../utils/logger";

// ===== Fake WhatsApp Graph API log (module memory, test fixture only) =====

/**
 * One observed Graph API call — { method, path, hasAuthorization, body,
 * at }. `path` includes the phone number id segment when present
 * (e.g. "/109876543210987/messages"); `hasAuthorization` is the ONLY
 * Authorization material recorded (T-200-05); `body` carries only the
 * response-relevant subset (to/text/preview_url for sends), never any
 * credential material.
 */
export interface FakeWhatsappApiLogEntry {
  method: string;
  /** The bare request path incl. phoneId (e.g. "/109876543210987/messages"). */
  path: string;
  /** Authorization header PRESENCE ONLY — never the token value. */
  hasAuthorization: boolean;
  /** The parsed JSON body (the fields the spec asserts on). */
  body: Record<string, unknown>;
  at: string;
}

/** Module-memory state — reset by stopFakeWhatsappApi(). */
const state = {
  server: null as http.Server | null,
  port: null as number | null,
  log: [] as FakeWhatsappApiLogEntry[],
  /** The 131047 arm: POST /:phoneId/messages answers the Graph 400 error. */
  arm131047: false,
  /** The 401 arm: GET /me and GET /:phoneId answer 401. */
  invalidTokenMode: false,
  /** Monotonic fake wamid counter. */
  nextWamid: 1000,
};

/** The fake identity GET /me returns (200-02 token-only probe shape). */
const FAKE_ME_NAME = "Fake WhatsApp Test Bot";

// ===== Arming helpers (the E2E helper routes call these) =====

/**
 * Arm/disarm the 131047 arm: when armed, POST /:phoneId/messages answers
 * HTTP 400 with the Graph error envelope
 * `{ error: { message: "…re-engagement…", code: 131047 } }` — the D-08
 * terminal 24h-window arm is reproducible deterministically (no live Meta
 * messaging-window dependency).
 */
export function setFakeWhatsappApiArm131047(enabled: boolean): void {
  state.arm131047 = enabled;
}

/**
 * Arm/disarm the invalid-token arm: when armed, GET /me and GET /:phoneId
 * answer 401 { error: { message, code: 401 } } — the A3 validate-error row
 * is reproducible deterministically.
 */
export function setFakeWhatsappApiInvalidTokenMode(enabled: boolean): void {
  state.invalidTokenMode = enabled;
}

/**
 * Serve ONE Graph API request. Recognized paths:
 *   GET  /me → 200 { id, name } (401 { error } on the invalid-token arm)
 *   GET  /:phoneId → 200 { id, display_phone_number, verified_name }
 *        (401 on the invalid-token arm)
 *   POST /:phoneId/messages → 200 { messaging_product: "whatsapp",
 *        contacts: [], messages: [{ id: "wamid.FAKE…", message_status:
 *        "accepted" }] } (the 131047 arm answers HTTP 400 with the Graph
 *        error envelope instead)
 * Every other path → 404 { error: { message, code: 404 } } (Graph's envelope).
 */
function serveGraphRoute(
  reqMethod: string,
  path: string,
  body: Record<string, unknown>,
  hasAuthorization: boolean,
  res: ServerResponse
): void {
  state.log.push({
    method: `${reqMethod} ${path}`,
    path,
    hasAuthorization,
    body: { ...body },
    at: new Date().toISOString(),
  });

  if (reqMethod === "GET" && path === "/me") {
    if (state.invalidTokenMode) {
      res.statusCode = 401;
      json(res, { error: { message: "Invalid OAuth access token", code: 401 } });
      return;
    }
    json(res, { id: "FAKE_WABA_ME", name: FAKE_ME_NAME });
    return;
  }

  const phoneRoute = path.match(/^\/(\d{5,})(\/messages)?$/);
  if (phoneRoute) {
    const phoneId = phoneRoute[1] ?? "";
    if (reqMethod === "GET") {
      if (state.invalidTokenMode) {
        res.statusCode = 401;
        json(res, { error: { message: "Invalid OAuth access token", code: 401 } });
        return;
      }
      json(res, {
        id: phoneId,
        display_phone_number: "491155000111",
        verified_name: "Fake WhatsApp Test Bot",
      });
      return;
    }
    // POST /:phoneId/messages
    if (state.arm131047) {
      res.statusCode = 400;
      json(res, {
        error: {
          message:
            "(#131047) Re-engagement message is required to continue conversation outside the 24 hour window",
          code: 131047,
        },
      });
      return;
    }
    state.nextWamid += 1;
    json(res, {
      messaging_product: "whatsapp",
      contacts: [],
      messages: [{ id: `wamid.FAKE${state.nextWamid}`, message_status: "accepted" }],
    });
    return;
  }

  res.statusCode = 404;
  json(res, { error: { message: `Not Found: ${reqMethod} ${path} is not served by the fake WhatsApp API`, code: 404 } });
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
        reject(new Error("fake whatsapp api: body too large"));
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
 * The request handler: Graph API shapes only — every other path 404s.
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

    logger.debug(`[fake-whatsapp-api] ${req.method} ${path}`);
    serveGraphRoute(req.method ?? "GET", path, body, typeof req.headers.authorization === "string", res);
  } catch (err: unknown) {
    logger.warn("[fake-whatsapp-api] request handling failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.statusCode = 500;
      json(res, { error: { message: "Internal Server Error", code: 500 } });
    }
  }
}

// ===== Public fixture API =====

/**
 * Start the fake WhatsApp Graph listener on an EPHEMERAL port bound to
 * 127.0.0.1 ONLY. Returns the port the E2E helper uses to compose the
 * runtime WHATSAPP_API_URL override (setWhatsappApiBaseOverride). Idempotent
 * per call: a second start returns the existing port (the botApiEndpoint
 * precedent). Resets the log + arm flags on a fresh start.
 */
export function startFakeWhatsappApi(): Promise<{ port: number }> {
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
        reject(new Error("fake whatsapp api: failed to acquire an ephemeral port"));
        return;
      }
      state.server = server;
      state.port = port;
      state.log = [];
      state.arm131047 = false;
      state.invalidTokenMode = false;
      state.nextWamid = 100;
      logger.info(`[fake-whatsapp-api] listening on 127.0.0.1:${port}`);
      resolve({ port });
    });
    server.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Stop the listener and RESET all module state (log, arm flags). The stop
 * route also clears the Graph URL override (module reset — the override
 * must NOT survive into other tests).
 */
export function stopFakeWhatsappApi(): Promise<void> {
  return new Promise((resolve) => {
    const server = state.server;
    state.server = null;
    state.port = null;
    state.log = [];
    state.arm131047 = false;
    state.invalidTokenMode = false;
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/** The observed call log (Authorization presence-masked) — the E2E spec's assertion surface. */
export function getFakeWhatsappApiLog(): FakeWhatsappApiLogEntry[] {
  return state.log.map((e) => ({ ...e, body: { ...e.body } }));
}

/** Test-only: is the fake currently listening (and on which port)? */
export function isFakeWhatsappApiRunning(): { running: boolean; port: number | null } {
  return { running: state.server !== null, port: state.port };
}