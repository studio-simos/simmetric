// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 199 (199-03 Task 1, D-05/D-06/D-04, OQ-1(b)/OQ-3, Pitfalls 1/2/4/9,
// T-199-07..T-199-11) — the Discord Gateway WS inbound path.
//
// Singleton manager: a module-level Map<connectorId, GatewayClient> — at
// boot (initDiscordGateway) it connects ONE raw-ws client per ENABLED
// discord connector; admin create/update/delete mutations re-sync via
// syncDiscordConnector (routes/connectors.ts arms); graceful shutdown closes
// every client BEFORE prisma.$disconnect (index.ts closeDiscordGateway —
// D-05). NO discord.js anywhere (D-02): the client is a ~150-line raw `ws`
// client hand-declaring the docs-verified Gateway payload types (the
// telegram.ts Bot-API-interfaces precedent).
//
// PROTOCOL (docs-verified, 199-RESEARCH Pattern 1):
//   connect `${gatewayUrl}/?v=10&encoding=json` → HELLO(10) schedules
//   heartbeats on the payload's heartbeat_interval with a random first-ACK
//   jitter → IDENTIFY(2) with the minimal intents (DIRECT_MESSAGES |
//   MESSAGE_CONTENT) → track `s` on EVERY payload → on reconnect RESUME(6)
//   with stored session_id + seq against the stored resume_gateway_url.
//
// CLOSE-CODE ROUTING (Pitfall 1, D-06): 4004 → auth-failed path (health
// flip + token-free lastError, connector stays ENABLED, NO reconnect — the
// infinite 4004 loop never happens); 4010/4011/4012/4013/4014 → config-fatal
// stop; 1000 or the closing flag → operator close, suppressed (OQ-3);
// anything else → exponential backoff reconnect 1s → cap 60s.
//
// ZOMBIE DETECTION (Pitfall 2): if no HEARTBEAT ACK (op 11) has arrived
// since the last heartbeat send → terminate() + reconnect-with-resume.
//
// DM-ONLY + BOT-ECHO GUARDS at the parse boundary (D-03/D-04, Pitfall 4,
// A2): guild messages (guild_id present) AND group-DM (channel_type not 1)
// are dropped SILENTLY before ANY DB write; author.bot echoes are dropped
// before the pipeline (the bot's own REST sends fire MESSAGE_CREATE back —
// dedup alone cannot prevent the self-loop). MESSAGE_CREATE dispatches are
// normalized into the base.ts IncomingMessage (platformMessageId = bare
// snowflake, platformUserId = the DM channel id, platformUserName =
// global_name ?? username, chatType "private") and handed to
// messageRouter.handleIncomingMessage — the SAME pipeline Telegram feeds
// (D-01); no platform payload leaks downstream.
//
// SECRET DISCIPLINE (T-199-11, T-198-10 parity): the token rides ONLY the
// identify/resume payload on the wire; it is decrypted per client start,
// NEVER logged, and never appears in lastError.
//
// AIR-GAP (D-02): the gateway host resolves via setDiscordGatewayUrlOverride
// (dev/test harness seam) ?? getEnv().DISCORD_GATEWAY_URL — no hardcoded
// gateway host anywhere outside env.ts defaults.

import WebSocket from "ws";
import prisma from "../../utils/prisma";
import { logger } from "../../utils/logger";
import { getEnv } from "../../config/env";
import { decrypt } from "../encryptionService";
import { handleIncomingMessage } from "./messageRouter";
import type { IncomingMessage } from "./base";

// ===== Gateway payload types (hand-declared, D-02 — no SDK types) =====

/** Discord Gateway opcodes (docs-verified subset). */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Minimal intents (D-04): DIRECT_MESSAGES | MESSAGE_CONTENT = 36864. */
const INTENTS = (1 << 12) | (1 << 15);

/** Reconnect backoff constants (D-05): 1s → cap 60s. */
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

/** ws maxPayload cap (T-199-07): bounds pathological gateway frames (~1MB). */
const WS_MAX_PAYLOAD = 1024 * 1024;

/** Never-reconnect close codes: config-fatal (Pitfall 1, D-06). */
const CONFIG_FATAL_CLOSE_CODES = new Set([4010, 4011, 4012, 4013, 4014]);

/** AUTH_FAILED_CLOSE_CODE: invalid token on identify (Pitfall 1). */
const AUTH_FAILED_CLOSE_CODE = 4004;

/** Operator/graceful close code (OQ-3). */
const OPERATOR_CLOSE_CODE = 1000;

/** A raw Gateway payload frame (JSON encoding). */
interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/** HELLO(10) payload. */
interface HelloData {
  heartbeat_interval: number;
}

/** READY dispatch payload — the fields the client stores. */
interface ReadyData {
  session_id?: string;
  resume_gateway_url?: string;
  user?: { username?: string };
}

/** MESSAGE_CREATE dispatch payload — the fields the normalizer consumes. */
interface MessageCreateData {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  channel_type?: number | string;
  content?: string | null;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
}

/** The DM channel-type discriminator (channel.mdx: 1 = DM, 3 = group DM). */
const DM_CHANNEL_TYPE = 1;

/**
 * Module-level gateway-URL override: the E2E harness (Plan 199-05) sets this
 * so the manager's connect/resume calls hit an in-process fake ws server
 * instead of the real gateway. Consulted BEFORE getEnv().DISCORD_GATEWAY_URL
 * at every connect/resume; null = production semantics. NEVER set by
 * production runtime paths (dev/test module setter only — T-199-03 posture).
 */
let discordGatewayUrlOverride: string | null = null;

/** Set/clear the gateway-URL override (dev/test harness only; null clears). */
export function setDiscordGatewayUrlOverride(url: string | null): void {
  discordGatewayUrlOverride = url && url.trim() !== "" ? url : null;
}

function resolveGatewayUrl(): string {
  return discordGatewayUrlOverride ?? getEnv().DISCORD_GATEWAY_URL;
}

// ===== ws factory seam (A6: unit tests inject a fake — zero real sockets) =====

/**
 * The minimal ws surface the client touches — structurally compatible with
 * the `ws` WebSocket, injectable for tests (fakeGatewayServer.ts) so the
 * gateway suite never opens a real socket (WS EGRESS BLOCKED discipline).
 */
export interface GatewaySocketLike {
  send(data: string): void;
  close(code?: number, reason?: Buffer): void;
  terminate(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export type WebSocketFactory = (url: string, options?: { maxPayload?: number }) => GatewaySocketLike;

const defaultWsFactory: WebSocketFactory = (url, options) => new WebSocket(url, options) as unknown as GatewaySocketLike;

let wsFactory: WebSocketFactory = defaultWsFactory;

/** Test-only: replace the ws constructor (fakeGatewayServer seam, A6). */
export function setGatewaySocketFactory(factory: WebSocketFactory | null): void {
  wsFactory = factory ?? defaultWsFactory;
}

// ===== Auth-failed callback (D-06 health flip) =====

/**
 * The close-4004 callback type. The manager wires the prisma-backed
 * flipGatewayHealth into every GatewayClient it constructs; tests construct
 * GatewayClient directly with a spy (constructor injection — no module
 * setter needed).
 */
export type AuthFailedCallback = (connectorId: string) => void;

async function flipGatewayHealth(connectorId: string): Promise<void> {
  try {
    await prisma.chatConnector.update({
      where: { id: connectorId },
      data: {
        healthStatus: "error",
        lastError: "Discord Gateway authentication failed (close code 4004)",
      },
    });
  } catch (err: unknown) {
    logger.error("[connectors] discord gateway health flip failed", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * WR-01 (code review 199): the D-06 "next successful interaction flips
 * 'healthy'" arm. The READY/RESUMED dispatches are the gateway's success
 * markers — a connector that errored (4004 or worse) and then re-authenticates
 * cleanly flips back to healthy + lastError cleared. Idempotent and
 * best-effort: a failed write never disturbs the gateway lifecycle.
 */
async function markGatewayHealthy(connectorId: string): Promise<void> {
  try {
    await prisma.chatConnector.update({
      where: { id: connectorId },
      data: { healthStatus: "healthy", lastError: null },
    });
  } catch (err: unknown) {
    logger.error("[connectors] discord gateway healthy flip failed", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * UAT live-smoke finding: config-fatal closes (4010-4014) need a DISTINCT,
 * actionable lastError — 4014 (disallowed intents) is fixed by a developer-portal
 * toggle, not a token rotation. Token-free (T-199-11), best-effort like the
 * other health writes.
 */
async function flipGatewayConfigFatal(connectorId: string, closeCode: number): Promise<void> {
  const remediation =
    closeCode === 4014
      ? "Discord rejected the gateway connection (close 4014 — disallowed intents): enable MESSAGE CONTENT INTENT for this bot in the Discord Developer Portal, then re-enable the connector."
      : closeCode === 4010
        ? "Discord rejected the provided intents (close 4010): the configured intents exceed the bot's allowed set."
        : `Discord closed the gateway connection with config-fatal code ${closeCode} — the bot setup (sharding/intents) needs correction before it can connect.`;
  try {
    await prisma.chatConnector.update({
      where: { id: connectorId },
      data: { healthStatus: "error", lastError: remediation },
    });
  } catch (err: unknown) {
    logger.error("[connectors] discord gateway config-fatal flip failed", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ===== The GatewayClient (internal) =====

/**
 * One per enabled discord connector (D-05): the raw-ws protocol client.
 * Owns hello → heartbeat+jitter → identify → dispatch → resume → close-code
 * routing. The manager is the ONLY instantiator (plus tests via the seam).
 */
export class GatewayClient {
  private readonly connectorId: string;
  private readonly token: string;
  private readonly onDispatch: (msg: IncomingMessage) => void;
  private readonly onAuthFailed: AuthFailedCallback;

  private ws: GatewaySocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalMs = 0;
  private awaitingAck = false;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private backoffMs = BACKOFF_START_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(opts: {
    connectorId: string;
    token: string;
    onDispatch: (msg: IncomingMessage) => void;
    onAuthFailed: AuthFailedCallback;
  }) {
    this.connectorId = opts.connectorId;
    this.token = opts.token;
    this.onDispatch = opts.onDispatch;
    this.onAuthFailed = opts.onAuthFailed;
  }

  /** Open the gateway connection (fresh identify or resume). */
  connect(): void {
    this.closing = false;
    const url = this.sessionId && this.resumeUrl ? this.resumeUrl : resolveGatewayUrl();
    logger.info("[connectors] discord gateway connecting", {
      connectorId: this.connectorId,
    });
    const socket = wsFactory(`${url}/?v=10&encoding=json`, { maxPayload: WS_MAX_PAYLOAD });
    this.ws = socket;

    socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    socket.on("close", (code) => this.handleClose(code));
    socket.on("error", (err) => {
      // T-199-11: log the error text only — never any frame/URL material
      // beyond the host, and NEVER the token.
      logger.warn("[connectors] discord gateway socket error", {
        connectorId: this.connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    socket.on("open", () => {
      logger.debug("[connectors] discord gateway socket open", {
        connectorId: this.connectorId,
      });
    });
  }

  /** Operator/graceful close (OQ-3): close(1000) — NEVER reconnects. */
  close(): void {
    this.closing = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(OPERATOR_CLOSE_CODE);
      } catch {
        // already dead — nothing to close
      }
      this.ws = null;
    }
  }

  /** Whether the gateway session has a stored (session, resume) pair. */
  hasSession(): boolean {
    return this.sessionId !== null && this.resumeUrl !== null;
  }

  /** Test-only: force a session pair (simulates a prior READY). */
  setSession(sessionId: string, resumeUrl: string, seq: number | null): void {
    this.sessionId = sessionId;
    this.resumeUrl = resumeUrl;
    if (seq !== null) this.seq = seq;
  }

  /** Test-only: the pending reconnect backoff (the ladder pins read it). */
  getBackoffMs(): number {
    return this.backoffMs;
  }

  /** Test-only: whether a reconnect timer is armed (4004 pins assert NONE). */
  hasReconnectTimer(): boolean {
    return this.reconnectTimer !== null;
  }

  /** Test-only: inject a raw dispatch payload (Plan 199-05 seam driver). */
  handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
    this.processFrame(data, isBinary);
  }

  // ─── frame handling ───────────────────────────────────────────────

  /**
   * JSON-encoding frame parse (T-199-07): text frames only (binary ignored —
   * plain-JSON encoding), size already bounded by ws maxPayload, parse inside
   * try/catch — a malformed frame is dropped WITHOUT crashing the client and
   * WITHOUT logging payload material.
   */
  private processFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) return; // JSON encoding — text frames only
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(String(data)) as GatewayPayload;
    } catch {
      // Malformed frame — drop silently (T-199-07: no payload echo in logs).
      logger.debug("[connectors] discord gateway malformed frame dropped", {
        connectorId: this.connectorId,
      });
      return;
    }
    this.handlePayload(payload);
  }

  private handlePayload(payload: GatewayPayload): void {
    // Track `s` on EVERY payload (docs rule — resume depends on it).
    if (payload.s !== undefined && payload.s !== null) {
      this.seq = payload.s;
    }

    switch (payload.op) {
      case OP_HELLO: {
        const hello = (payload.d ?? {}) as HelloData;
        this.heartbeatIntervalMs =
          typeof hello.heartbeat_interval === "number" ? hello.heartbeat_interval : 0;
        this.scheduleFirstHeartbeat();
        // Pitfall 9: resume ONLY with a stored session pair; fresh sessions
        // identify. The resume goes to the STORED resume_gateway_url (D-05).
        if (this.sessionId && this.resumeUrl) {
          this.sendPayload({
            op: OP_RESUME,
            d: { token: this.token, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.sendPayload({
            op: OP_IDENTIFY,
            d: {
              token: this.token,
              intents: INTENTS,
              properties: { os: "linux", browser: "simmetric-chat", device: "simmetric-chat" },
            },
          });
        }
        break;
      }
      case OP_DISPATCH: {
        if (payload.t === "READY") {
          const ready = (payload.d ?? {}) as ReadyData;
          this.sessionId = typeof ready.session_id === "string" ? ready.session_id : null;
          this.resumeUrl =
            typeof ready.resume_gateway_url === "string" ? ready.resume_gateway_url : null;
          this.backoffMs = BACKOFF_START_MS; // successful connect — reset the ladder
          void markGatewayHealthy(this.connectorId); // WR-01: D-06 healthy-flip arm
        } else if (payload.t === "RESUMED") {
          this.backoffMs = BACKOFF_START_MS; // replay complete
          void markGatewayHealthy(this.connectorId); // WR-01: successful resume counts
        } else if (payload.t === "MESSAGE_CREATE") {
          this.dispatchMessageCreate((payload.d ?? {}) as MessageCreateData);
        }
        // Other dispatch types are irrelevant to DM-only v1 — ignored.
        break;
      }
      case OP_HEARTBEAT: {
        // Server-requested immediate heartbeat — reply with the last seq.
        this.sendPayload({ op: OP_HEARTBEAT, d: this.seq });
        break;
      }
      case OP_HEARTBEAT_ACK: {
        this.awaitingAck = false; // the link is alive (Pitfall 2 marker)
        break;
      }
      case OP_RECONNECT: {
        // Server asks to reconnect → close + reconnect-with-resume (docs).
        try {
          this.ws?.close(4000);
        } catch {
          // already dead
        }
        break;
      }
      case OP_INVALID_SESSION: {
        // d:true → resumable (close 4000; HELLO on the reconnect resumes);
        // d:false → the session is gone → clear it so the reconnect IDENTIFYs
        // fresh (Pitfall 9 — no resume attempt without a session).
        const resumable = (payload.d ?? false) === true;
        if (!resumable) {
          this.sessionId = null;
          this.resumeUrl = null;
        }
        try {
          this.ws?.close(4000);
        } catch {
          // already dead
        }
        break;
      }
      default:
        break;
    }
  }

  // ─── dispatch → pipeline (D-01/D-03/D-04) ─────────────────────────

  /**
   * The DM-only + bot-echo guards at the parse boundary (Pitfall 4, A2):
   * guild messages (guild_id present) AND group-DM (channel_type !== 1 —
   * LOAD-BEARING: group DMs also lack guild_id) are dropped SILENTLY before
   * ANY DB write; the bot's own outbound echo (author.bot) is dropped before
   * the pipeline (T-199-08: dedup alone cannot prevent the self-loop).
   * Everything else normalizes into the base.ts IncomingMessage and feeds
   * handleIncomingMessage — no platform payload leaks downstream (D-01).
   */
  private dispatchMessageCreate(d: MessageCreateData): void {
    // UAT live-smoke probe (temporary, info-level): prove MESSAGE_CREATE delivery.
    logger.info("[connectors] discord gateway MESSAGE_CREATE received", {
      connectorId: this.connectorId,
      guildId: d.guild_id ?? null,
      channelType: d.channel_type ?? "(absent)",
      hasAuthor: Boolean(d.author),
      isBot: d.author?.bot === true,
      hasContent: typeof d.content === "string" && d.content.length > 0,
    });
    if (d.guild_id !== undefined && d.guild_id !== null) return; // guild — silent (D-03)
    // WR-02 (code review 199): `channel_type` is OPTIONAL on MESSAGE_CREATE —
    // an absent discriminator must NOT black-hole the DM. Discriminate only
    // when the field is present; guild_id absent + field absent = processable DM.
    if (
      d.channel_type !== undefined &&
      d.channel_type !== null &&
      d.channel_type !== DM_CHANNEL_TYPE
    )
      return; // group-DM etc. — silent (A2: load-bearing when the field IS present)
    if (d.author?.bot === true) return; // bot self-echo — silent (Pitfall 4)
    if (typeof d.channel_id !== "string" || d.channel_id === "") return;
    if (typeof d.id !== "string" || d.id === "") return;
    if (!d.author) return;

    const msg: IncomingMessage = {
      platformMessageId: d.id, // bare snowflake — globally unique per bot in DMs (D-03)
      platformUserId: d.channel_id, // the DM channel id IS the per-user key (D-03)
      platformUserName: d.author.global_name ?? d.author.username,
      text: typeof d.content === "string" && d.content.trim() !== "" ? d.content : null,
      chatType: "private",
      // no updateId — gateway inbound is webhook-analogous (base.ts comment)
    };
    this.onDispatch(msg);
  }

  // ─── heartbeat + zombie detection (Pitfall 2) ─────────────────────

  /** First heartbeat after interval × random() jitter (docs anti-herd rule). */
  private scheduleFirstHeartbeat(): void {
    this.clearHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    const first = this.heartbeatIntervalMs * Math.random();
    this.heartbeatTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs) as unknown as ReturnType<typeof setTimeout>;
    }, first);
  }

  /**
   * Send one heartbeat { op:1, d: <last seq or null> } and mark the ACK as
   * pending — the zombie check flips on the NEXT interval send with no ACK
   * in between (Pitfall 2 recipe: terminate + reconnect-with-resume).
   */
  private sendHeartbeat(): void {
    if (this.closing || !this.ws) return;
    if (this.awaitingAck) {
      // No ACK since the last heartbeat send → zombie. terminate() (not
      // close()) — the socket is dead; the close handler reconnects with
      // resume.
      logger.warn("[connectors] discord gateway zombie — terminating", {
        connectorId: this.connectorId,
      });
      this.awaitingAck = false;
      try {
        this.ws.terminate();
      } catch {
        // already dead
      }
      return;
    }
    this.awaitingAck = true;
    this.sendPayload({ op: OP_HEARTBEAT, d: this.seq });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      clearInterval(this.heartbeatTimer as unknown as ReturnType<typeof setInterval>);
      this.heartbeatTimer = null;
    }
    this.awaitingAck = false;
  }

  private sendPayload(payload: GatewayPayload): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err: unknown) {
      logger.debug("[connectors] discord gateway send failed", {
        connectorId: this.connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── close-code routing (Pitfall 1, D-06, OQ-3) ───────────────────

  /**
   * Close-code routing (the Pitfall-1 ladder):
   *   closing flag or 1000 → operator close — suppressed (OQ-3);
   *   4004 → auth-failed callback ONLY (health flip, NO reconnect armed —
   *     the connector stays ENABLED; D-06);
   *   4010-4014 → config-fatal — log + stop (no retry ladder);
   *   otherwise → reconnect after backoffMs, then double it (cap 60s).
   * The heartbeat timer is ALWAYS cleared first — it never fires post-close.
   */
  private handleClose(code: number): void {
    this.clearHeartbeat();
    this.ws = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.closing || code === OPERATOR_CLOSE_CODE) {
      logger.info("[connectors] discord gateway closed (operator)", {
        connectorId: this.connectorId,
      });
      return; // OQ-3: operator close NEVER reconnects
    }

    if (code === AUTH_FAILED_CLOSE_CODE) {
      logger.error("[connectors] discord gateway auth failed (4004) — health flipped, no reconnect", {
        connectorId: this.connectorId,
      });
      // Pitfall 1: the auth-failed callback ONLY — NO reconnect timer armed.
      // The connector stays ENABLED (D-06: never auto-disable); the token is
      // never part of any error text (T-199-11).
      try {
        this.onAuthFailed(this.connectorId);
      } catch (cbErr: unknown) {
        logger.error("[connectors] discord gateway auth-failed handler failed", {
          connectorId: this.connectorId,
          error: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
      return;
    }

    if (CONFIG_FATAL_CLOSE_CODES.has(code)) {
      logger.error("[connectors] discord gateway config-fatal close — no retry", {
        connectorId: this.connectorId,
        closeCode: code,
      });
      // UAT live-smoke finding: a config-fatal close (4014 = disallowed
      // intents, 4011 = Sh required, …) is exactly as user-visible as a bad
      // token — the admin card must say WHY, not stay "unknown" forever.
      // Health error + a token-free ACTIONABLE lastError; the connector
      // stays ENABLED, NO reconnect. 4014's remedy is a portal toggle
      // (enable MESSAGE CONTENT INTENT), not a token rotation.
      try {
        void flipGatewayConfigFatal(this.connectorId, code);
      } catch (cbErr: unknown) {
        logger.error("[connectors] discord gateway config-fatal health flip failed", {
          connectorId: this.connectorId,
          error: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
      return; // config-fatal — a portal-toggle problem, never retried
    }

    // Transient close — schedule the reconnect and double the ladder.
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    logger.info("[connectors] discord gateway closed — reconnect scheduled", {
      connectorId: this.connectorId,
      closeCode: code,
      reconnectInMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing) {
        this.connect();
      }
    }, delay);
  }
}

// ===== The normalizer (199-RESEARCH Pattern 3 — exported for tests) =====

/**
 * Normalize a raw MESSAGE_CREATE payload `d` into the base.ts IncomingMessage
 * (or null when the payload is not a processable DM). Exported for unit pins
 * + the Plan 199-05 injection seam; the GatewayClient calls it via
 * dispatchMessageCreate.
 */
export function toIncomingMessage(d: Record<string, unknown>): IncomingMessage | null {
  if (d.guild_id !== undefined && d.guild_id !== null) return null; // D-03
  // WR-02 (code review 199): discriminate only when channel_type is present —
  // the field is optional on MESSAGE_CREATE; absence = processable DM (guild
  // frames are already excluded by the guild_id guard above; group DMs that
  // carry the field remain excluded).
  if (
    d.channel_type !== undefined &&
    d.channel_type !== null &&
    d.channel_type !== DM_CHANNEL_TYPE
  )
    return null; // A2: load-bearing when the field IS present
  const author = d.author as MessageCreateData["author"];
  if (!author || author.bot === true) return null; // Pitfall 4
  if (typeof d.id !== "string" || d.id === "") return null;
  if (typeof d.channel_id !== "string" || d.channel_id === "") return null;
  return {
    platformMessageId: d.id,
    platformUserId: d.channel_id,
    platformUserName: author.global_name ?? author.username,
    text: typeof d.content === "string" && d.content.trim() !== "" ? d.content : null,
    chatType: "private",
  };
}

// ===== The manager (D-05 singleton Map) =====

interface GatewayClientEntry {
  client: GatewayClient;
  token: string;
}

/**
 * D-05 singleton: connectorId → client entry. ONE long-lived ws client per
 * enabled discord connector (spec §4.2 — per-message connections would burn
 * the 1000-identifies/24h budget). mcpClient/connectorPoller Map precedent.
 */
const gatewayClients = new Map<string, GatewayClientEntry>();

/** Reset module state (tests only — mirrors resetConnectorPollState). */
export function resetGatewayState(): void {
  for (const [, entry] of gatewayClients) {
    entry.client.close();
  }
  gatewayClients.clear();
  setDiscordGatewayUrlOverride(null);
  setGatewaySocketFactory(null);
}

/** Test-only: the live client count (the one-client-per-connector pins). */
export function gatewayClientCount(): number {
  return gatewayClients.size;
}

/** Test-only: whether a client exists for a connector id. */
export function hasGatewayClient(connectorId: string): boolean {
  return gatewayClients.has(connectorId);
}

/** The full row shape the manager consumes (decrypts botTokenEncrypted). */
type GatewayConnectorRow = {
  id: string;
  platform: string;
  isEnabled: boolean;
  deletedAt: Date | null;
  botTokenEncrypted: string | null;
  welcomeMessage: string | null;
  fallbackMessage: string | null;
  fallbackLocale: string;
  rateLimitPerMinute: number | null;
  sessionLimitPerDay: number | null;
  healthStatus: string;
  lastError: string | null;
  workspaceId: string;
  organizationId: string;
  archiveId: string | null;
  responseProviderId: string | null;
  responseModel: string | null;
};

/** Token decrypt per client start (the adapter's tokenOf posture). */
function tokenOf(row: GatewayConnectorRow): string {
  if (!row.botTokenEncrypted) {
    throw new Error("discord connector has no bot token configured");
  }
  return decrypt(row.botTokenEncrypted);
}

/**
 * Connect ONE enabled discord connector row: decrypt the token, build the
 * GatewayClient with the pipeline dispatch + prisma-backed auth-failed
 * callback, store it in the Map. Existing entry → closed and replaced (a
 * sync on a mutated row always reconnects fresh).
 */
function connectConnector(row: GatewayConnectorRow): void {
  const existing = gatewayClients.get(row.id);
  if (existing) {
    existing.client.close();
    gatewayClients.delete(row.id);
  }
  const token = tokenOf(row);
  const client = new GatewayClient({
    connectorId: row.id,
    token,
    onDispatch: (msg) => {
      // D-01: hand the normalized DM message to the SAME pipeline Telegram
      // feeds. A per-message failure is owned INSIDE handleIncomingMessage
      // (D-12 single error owner) — the gateway must never crash on it.
      void handleIncomingMessage(
        row as unknown as Parameters<typeof handleIncomingMessage>[0],
        msg
      ).catch((err: unknown) => {
        logger.error("[connectors] discord gateway dispatch pipeline failed", {
          connectorId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onAuthFailed: (connectorId) => {
      // D-06: flip health ONCE and stop — the close handler never arms a
      // reconnect for 4004.
      void flipGatewayHealth(connectorId);
    },
  });
  gatewayClients.set(row.id, { client, token });
  client.connect();
}

/**
 * D-05: connect every ENABLED discord connector at boot (the
 * connectorPoller init shape). Idempotent (a second init is a logged no-op —
 * index.ts calls it once; tests/boot-reloads must not stack clients).
 */
export async function initDiscordGateway(): Promise<void> {
  if (gatewayClients.size > 0) {
    logger.debug("[connectors] discord gateway already initialized — skipping");
    return;
  }
  const rows = (await prisma.chatConnector.findMany({
    where: {
      platform: "discord",
      isEnabled: true,
      deletedAt: null,
    },
  })) as unknown as GatewayConnectorRow[];

  for (const row of rows) {
    try {
      connectConnector(row);
    } catch (err: unknown) {
      // A single failing row (missing token) must not abort the batch.
      logger.error("[connectors] discord gateway connect failed", {
        connectorId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info("[connectors] discord gateway initialized", {
    clients: gatewayClients.size,
  });
}

/**
 * D-05 sync-on-mutation: reconcile ONE connector row's client with its
 * current state — enabled discord row → connect (fresh, replacing any
 * stale client); disabled/tombstoned/non-discord row → close + evict.
 * Throws nothing (the route arms wrap it best-effort).
 */
export function syncDiscordConnector(row: GatewayConnectorRow): void {
  const enabled = row.platform === "discord" && row.isEnabled && row.deletedAt === null;
  if (!enabled) {
    const existing = gatewayClients.get(row.id);
    if (existing) {
      existing.client.close();
      gatewayClients.delete(row.id);
      logger.info("[connectors] discord gateway client closed (disabled/deleted)", {
        connectorId: row.id,
      });
    }
    return; // non-discord or disabled rows are no-ops for non-clients
  }
  // The decrypted token is re-derived per sync (a re-validated/updated token
  // must reconnect with the fresh value).
  connectConnector(row);
  logger.info("[connectors] discord gateway client synced", { connectorId: row.id });
}

/**
 * D-05: close every client (graceful shutdown — index.ts calls this FIRST in
 * the shutdown sequence, BEFORE prisma.$disconnect).
 */
export function closeDiscordGateway(): void {
  for (const [id, entry] of gatewayClients) {
    entry.client.close();
    gatewayClients.delete(id);
  }
  logger.info("[connectors] discord gateway closed all clients");
}

/**
 * Plan 199-05 injection seam: drive the normalizer + pipeline for a
 * connector's client WITHOUT a real gateway connection (the E2E fake feeds
 * MESSAGE_CREATE payloads here). Best-effort: an unknown connector or a
 * pipeline failure logs and resolves — never throws.
 */
export async function injectDiscordConnectorMessage(
  connectorId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const entry = gatewayClients.get(connectorId);
  if (!entry) {
    logger.warn("[connectors] injectDiscordConnectorMessage: no client for connector", {
      connectorId,
    });
    return;
  }
  const msg = toIncomingMessage(payload);
  if (!msg) {
    logger.debug("[connectors] injectDiscordConnectorMessage: payload filtered (non-DM/bot)", {
      connectorId,
    });
    return;
  }
  // Route through the SAME pipeline the dispatch path uses (D-01 parity).
  const rows = (await prisma.chatConnector.findMany({
    where: { id: connectorId },
  })) as unknown as GatewayConnectorRow[];
  const row = rows[0];
  if (!row) {
    logger.warn("[connectors] injectDiscordConnectorMessage: connector row missing", {
      connectorId,
    });
    return;
  }
  void entry; // (the client's existence is the seam's gate — pipeline parity below)
  await handleIncomingMessage(row as unknown as Parameters<typeof handleIncomingMessage>[0], msg);
}