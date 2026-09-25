// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 199 (199-05 Task 1b, D-06/D-11) — the loopback-only fake Discord
// Gateway: a TEST FIXTURE ws endpoint the REAL GatewayClient (discordGateway.ts,
// Plan 199-03) connects to when the E2E harness overrides
// setDiscordGatewayUrlOverride. The ONLY ws surface an E2E connector's real
// client touches — zero external egress (plan must_haves prohibition).
//
// BEHAVIOR:
//   startFakeDiscordGateway() opens a 127.0.0.1-only ephemeral ws-upgrade
//   listener (node:http + the `ws` package's server-mode upgrade handling —
//   the same ws 8.21.3 direct dependency the client uses, so the protocol
//   path under test is the REAL one both sides).
//
//   ARMED (default — the invalid-token arm): the fake completes the ws
//   upgrade, waits for the client's IDENTIFY(2) frame, records it, then
//   closes the socket with code 4004 — so the REAL GatewayClient's close
//   handler executes the D-06 health flip (healthStatus='error' + token-free
//   lastError + no reconnect). The E2E health-flip row rides the REAL
//   protocol path (identify → 4004), not a mock of the manager.
//
//   DISARMED (accept-and-idle — a query flag on the start route): the fake
//   completes the upgrade, records the identify, answers HELLO(10) with a
//   heartbeat interval, and idles (no dispatches) — the shape a healthy
//   connector needs for rows (d)/(d2)/(e)/(f)/(h), where message traffic is
//   injected via injectDiscordConnectorMessage and replies go out over the
//   REST fake.
//
// THREAT POSTURE (T-199-15 fixture contract, T-199-11 parity):
//   - loopback ONLY (no socket leaves 127.0.0.1);
//   - the identify payload's token is recorded as PRESENCE ONLY
//     (tokenPresent boolean) — never persisted, never logged;
//   - callers are the dev-only /api/__tests__ helper routes.

import http from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "../../utils/logger";

/** One observed gateway event — the E2E/spec assertion surface. */
interface FakeDiscordGatewayLogEntry {
  /** "identify" | "close" */
  kind: string;
  /** Presence ONLY for identify — never the token value (T-199-11). */
  tokenPresent?: boolean;
  /** The close code the fake sent (4004 armed / undefined idle). */
  code?: number;
  at: string;
}

/** Module-memory state — reset by stopFakeDiscordGateway(). */
const state = {
  httpServer: null as http.Server | null,
  wss: null as WebSocketServer | null,
  port: null as number | null,
  /** Armed = close 4004 right after identify; disarmed = accept-and-idle. */
  armed: true,
  log: [] as FakeDiscordGatewayLogEntry[],
};

/**
 * One client connection lifecycle (docs-correct handshake): on connection →
 * send HELLO(10) (the real client only IDENTIFYs after HELLO) → wait for
 * IDENTIFY(2) (record token presence) → armed ? close(4004) : READY + idle.
 * Heartbeats (op 1) are ACKed (op 11) so the client's zombie detection never
 * misfires against the fake.
 */
function handleClient(socket: WebSocket): void {
  let identified = false;
  // HELLO first — the GatewayClient schedules heartbeats + identifies on it.
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  socket.on("message", (data: unknown, isBinary: boolean) => {
    if (isBinary) return; // JSON encoding — text frames only
    let payload: { op?: number; d?: { token?: unknown } };
    try {
      payload = JSON.parse(String(data)) as { op?: number; d?: { token?: unknown } };
    } catch {
      return; // malformed frame — ignore (fixture)
    }
    if (payload.op === 1) {
      // Heartbeat → ACK (keeps the client's zombie detection quiet).
      socket.send(JSON.stringify({ op: 11 }));
      return;
    }
    if (payload.op !== 2) return; // only IDENTIFY is recorded
    if (identified) return;
    identified = true;
    state.log.push({
      kind: "identify",
      tokenPresent: typeof payload.d?.token === "string" && payload.d.token !== "",
      at: new Date().toISOString(),
    });
    if (state.armed) {
      // The invalid-token arm: the REAL client's close handler sees 4004 and
      // executes the D-06 flip (healthStatus error + no reconnect).
      socket.close(4004, "Authentication failed.");
      state.log.push({ kind: "close", code: 4004, at: new Date().toISOString() });
      return;
    }
    // Disarmed (accept-and-idle): READY dispatch so the real client stores a
    // session pair — the docs-correct healthy shape. resume_gateway_url
    // points at the SAME loopback fake (a reconnect would resume here).
    socket.send(
      JSON.stringify({
        op: 0,
        s: 1,
        t: "READY",
        d: {
          session_id: "fake-session-199-05",
          resume_gateway_url: `ws://127.0.0.1:${state.port ?? 0}`,
          user: { username: "fake_discord_bot" },
        },
      })
    );
  });
  socket.on("error", () => {
    // Client disconnects mid-handshake — the fixture ignores socket errors.
  });
}

// ===== Public fixture API =====

/**
 * Start the fake gateway on an EPHEMERAL port bound to 127.0.0.1 ONLY.
 * Accepts ws upgrade requests (the URL path is irrelevant — the real client
 * appends /?v=10&encoding=json). Returns the port the helper composes the
 * DISCORD_GATEWAY_URL override from. Idempotent: a second start returns the
 * existing port. A fresh start resets the log and RE-ARMS (default armed —
 * the invalid-token arm is the plan's default gateway posture).
 */
export function startFakeDiscordGateway(): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    if (state.httpServer && state.wss && state.port !== null) {
      resolve({ port: state.port });
      return;
    }
    const server = http.createServer((_req, res) => {
      // Plain HTTP on the fake gateway is meaningless — 426 Upgrade Required.
      res.statusCode = 426;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: "Upgrade Required (ws gateway only)" }));
    });
    const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
    wss.on("connection", (socket) => handleClient(socket));
    wss.on("error", (err: Error) => {
      logger.warn("[fake-discord-gateway] server error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Loopback ONLY (fixture contract: no real network egress possible).
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      if (!port) {
        reject(new Error("fake discord gateway: failed to acquire an ephemeral port"));
        return;
      }
      state.httpServer = server;
      state.wss = wss;
      state.port = port;
      state.log = [];
      state.armed = true; // re-arm on every fresh start (the default posture)
      logger.info(`[fake-discord-gateway] listening on 127.0.0.1:${port} (armed=${state.armed})`);
      resolve({ port });
    });
    server.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Arm/disarm the 4004 close arm (the start route's query/body flag):
 * armed → close(4004) right after identify (the invalid-token row);
 * disarmed → accept-and-idle (the healthy connector shape).
 */
export function setFakeDiscordGatewayArmed(armed: boolean): void {
  state.armed = armed;
}

/**
 * Stop the listener and RESET all module state (log, armed posture).
 * The stop route also clears the gateway URL override (module reset — the
 * override must NOT survive into other tests).
 */
export function stopFakeDiscordGateway(): Promise<void> {
  return new Promise((resolve) => {
    const wss = state.wss;
    const server = state.httpServer;
    state.wss = null;
    state.httpServer = null;
    state.port = null;
    state.log = [];
    state.armed = true;
    if (!wss || !server) {
      resolve();
      return;
    }
    wss.close(() => {
      server.close(() => resolve());
    });
  });
}

/** Test-only: is the fake gateway listening (and on which port)? */
export function isFakeDiscordGatewayRunning(): { running: boolean; port: number | null } {
  return { running: state.wss !== null && state.httpServer !== null, port: state.port };
}