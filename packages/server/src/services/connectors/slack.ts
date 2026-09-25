// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 200 (200-01, ECCO-06, D-01/D-02/D-04/D-10) — the Slack platform
// adapter: fetch-direct Web API transport (NO SDK — zero-dep doctrine D-02),
// the Events API webhook parse boundary (event_callback + message.im only,
// D-01/D-18; bot-echo drop per research P4), the md→mrkdwn converter +
// 39000 fence-safe split (D-10), auth.test token validation, and the
// no-op webhook/typing lifecycle (D-01 — Slack event URLs are
// dashboard-configured and Slack bots have no typing indicator).
//
// The INVERTED ERROR TRIGGER (research P2): unlike Telegram (HTTP-status
// errors), the Slack Web API returns HTTP 200 with `{ ok: false, error }`
// on logical failures — SlackApiError FIRES ON BODY ok === false.
//
// SECRET DISCIPLINE (T-200-06, T-198-10 parity): the bot token and signing
// secret are decrypted PER CALL and never logged, never returned by any
// adapter response, and never appear in lastError text — SlackApiError
// carries method + status/description only.
//
// NOTE (undici pairing, collectorDispatchAgent.ts UPGRADE RULE): this module
// uses the BUILT-IN globalThis.fetch with NO custom dispatcher — a custom
// undici Agent here would be a v8-half-pairing hazard (telegram.ts:20-23
// doctrine mirrored).

import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { decrypt } from "../encryptionService";
import type {
  ConnectorPipelineRow,
  IncomingMessage,
  PlatformAdapter,
  PollBatch,
} from "./base";
import { registerAdapter } from "./registry";
// D-10: the 39000 split reuses the EXPORTED telegram splitter — it is pure
// (text, limit) → segments[], its fence-safe boundary logic is already
// tested (198 D-17), and importing avoids any copy drift (discord.ts:45
// precedent). NO copy.
import { splitMessage } from "./telegram";

// ===== Runtime base-URL override (the discord.ts seam generalized) =====

/**
 * Module-level Web API base-URL override: the E2E fake (Plan 04
 * slackApiEndpoint-style) sets this via the dev-only /api/__tests__ helper
 * so the adapter's slackApi calls hit the in-process fake. slackApi
 * consults this BEFORE getEnv().SLACK_API_URL; null = production
 * semantics. NEVER called by production runtime paths.
 */
let slackApiBaseOverride: string | null = null;

/**
 * Set/clear the runtime Web API base override (dev/test harness only — the
 * e2eHelpers start/stop routes; stop() passes null to reset). An
 * empty/whitespace string clears to null (byte-mirror of
 * setDiscordApiBaseOverride).
 */
export function setSlackApiBaseOverride(url: string | null): void {
  slackApiBaseOverride = url && url.trim() !== "" ? url : null;
}

/** Test-only: the current override value (null = env-driven). */
export function getSlackApiBaseOverride(): string | null {
  return slackApiBaseOverride;
}

// ===== Structured adapter error =====

/**
 * Structured adapter failure (D-20 mapping upstream): method + HTTP status
 * + platform description ONLY — NEVER the token, never any Authorization
 * material, never raw request bodies (T-200-06). NOTE the inverted trigger
 * vs Telegram (research P2): this error FIRES ON BODY `ok === false` even
 * at HTTP 200 (channel_not_found / invalid_auth / ratelimited envelopes).
 */
export class SlackApiError extends Error {
  public readonly method: string;
  public readonly status: number | null;
  public readonly description: string | null;

  constructor(method: string, status: number | null, description: string | null) {
    super(`Slack ${method} failed${status !== null ? ` (HTTP ${status})` : ""}${description ? `: ${description}` : ""}`);
    this.name = "SlackApiError";
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

// ===== Web API payload types (hand-declared, D-02 — no SDK types) =====

/**
 * Slack Web API envelope: logical errors arrive on HTTP 200 with
 * ok:false + error (research P2). The chat.postMessage success envelope
 * additionally carries the posted `message` object (its `ts` is the
 * platform message id the send path consumes).
 */
interface SlackApiResponse {
  ok: boolean;
  error?: string;
  message?: { ts?: string };
  user?: string;
  [key: string]: unknown;
}

/** Slack Events API inner `message` event — the fields the parse boundary consumes. */
interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  [key: string]: unknown;
}

/** Slack Events API envelope — the fields the parse boundary consumes. */
interface SlackEnvelope {
  type?: string;
  event_id?: string;
  event?: SlackEvent;
  [key: string]: unknown;
}

// ===== md → mrkdwn converter (D-10) =====

/**
 * Convert the markdown markup OUTSIDE code spans (the segment between code
 * constructs): **bold** → *bold* FIRST, __italic__ → _italic_,
 * [text](url) → <url|text>.
 */
function mdToMrkdwnOutside(text: string): string {
  // 1. Bold FIRST (**…** → *…*) — the double-asterisk marker would
  //    otherwise be consumed as two italic rewrites.
  let out = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => `*${inner}*`);

  // 2. Italic __…__ → _…_.
  out = out.replace(/__([^_\n]+)__/g, (_m, inner: string) => `_${inner}_`);

  // 3. Links [text](url) → <url|text> (mrkdwn link shape).
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => `<${url}|${label}>`
  );

  return out;
}

/**
 * D-10: minimal markdown→Slack-mrkdwn converter. Regex-rewrite ONLY —
 * mrkdwn has NO entities (no escape-first step, unlike the Telegram HTML
 * converter). `` `inline-code` `` and ``` fenced blocks pass through
 * VERBATIM (mrkdwn code spans render their content literally — the markup
 * inside them is protected from the conversion); outside code spans:
 * **bold** → *bold* (bold FIRST, before single-asterisk handling),
 * __italic__ → _italic_, [text](url) → <url|text> mrkdwn link.
 *
 * Fail-open tail (telegram.ts:151-188 shape minus escaping): a CONVERSION
 * failure (regex on pathological input) never loses the answer — the
 * ORIGINAL plain text is returned and a logger.warn records it.
 */
export function mdToMrkdwn(text: string): string {
  try {
    // Code spans (fenced ``` blocks first, then inline `…`) are EXTRACTED
    // verbatim — the conversion applies only to the surrounding prose.
    // An unterminated fence stays outside the match set (its content is
    // converted — the fail-open posture; a malformed fence is the author's
    // markup ambiguity, never an exception).
    const pattern = /```[\s\S]*?```|`[^`\n]+`/g;
    const parts: string[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      parts.push(mdToMrkdwnOutside(text.slice(last, match.index)));
      parts.push(match[0]);
      last = match.index + match[0].length;
    }
    parts.push(mdToMrkdwnOutside(text.slice(last)));
    return parts.join("");
  } catch (err: unknown) {
    // SPEC-LESS EDGE (fail-open, D-10): conversion failure never loses the
    // answer — degrade to the original plain markdown text.
    logger.warn("[connectors] markdown→mrkdwn conversion failed — degraded to plain text", {
      error: err instanceof Error ? err.message : String(err),
    });
    return text;
  }
}

// ===== The adapter =====

/**
 * SlackAdapter (ECCO-06, D-01): fetch-direct Web API transport over the
 * EXISTING PlatformAdapter contract. The token is decrypted per call from
 * the connector row (never cached in module state beyond the call — threat
 * register boundary). Registered at module load:
 * registry.isPlatformImplemented("slack") flips true, unblocking the 198
 * create/validate/test routes' 400 "Platform not implemented yet".
 */
export class SlackAdapter implements PlatformAdapter {
  /**
   * The Web API call core (research P2 discipline): POST to
   * `${SLACK_API_URL}/${method}` with a JSON body + the
   * Authorization: Bearer header; returns the parsed envelope. The
   * inverted trigger: `{ ok: false }` throws SlackApiError EVEN AT HTTP
   * 200 (channel_not_found / invalid_auth / ratelimited). Non-JSON bodies
   * (proxy/error pages) surface as a structured failure with NO body echo
   * (the body could carry request material — T-200-06).
   *
   * The Retry-After header of the triggering response (when Slack sends
   * one on the ratelimited error) is stashed on the INSTANCE for the
   * sendMessage retry arm to consult (per-call lifetime — never module
   * state).
   */
  private async slackApi(
    token: string,
    method: string,
    payload?: Record<string, unknown>
  ): Promise<SlackApiResponse> {
    const base = slackApiBaseOverride ?? getEnv().SLACK_API_URL; // override wins (E2E seam); env is the air-gap lever
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload ?? {}),
    });
    const retryAfterHeader = res.headers.get("retry-after");
    this.lastRetryAfterSeconds =
      retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader.trim())
        ? Number(retryAfterHeader)
        : null;
    let parsed: SlackApiResponse;
    try {
      parsed = (await res.json()) as SlackApiResponse;
    } catch (err: unknown) {
      void err;
      // Non-JSON body (proxy/error page): surface as a structured failure
      // without any body echo (could carry request material — T-200-06).
      throw new SlackApiError(method, res.status, `non-JSON response (status ${res.status})`);
    }
    if (parsed.ok === false) {
      // Slack logical error envelope (HTTP 200 OK included, research P2).
      // `error` is platform-generated (method-level), token-free by
      // construction.
      throw new SlackApiError(method, null, parsed.error ?? "unknown error");
    }
    return parsed;
  }

  /** Per-call Retry-After stash (seconds) — instance lifetime only. */
  private lastRetryAfterSeconds: number | null = null;

  /** Decrypt the bot token per call (never cached beyond the call). */
  private tokenOf(connector: { botTokenEncrypted?: string | null }): string {
    const enc = connector.botTokenEncrypted;
    if (!enc) {
      throw new SlackApiError("token", null, "connector has no bot token configured");
    }
    return decrypt(enc);
  }

  /**
   * The decrypted config blob — carries the signing secret (and the
   * OAuth-seeded botUserId when the install path wrote it). Parsed per
   * call; fail-open to {} (the same telegram.ts:342-354 shape); never
   * logged (T-200-06).
   */
  private configOf(connector: { configEncrypted?: string | null }): Record<string, unknown> {
    const enc = connector.configEncrypted;
    if (!enc) return {};
    try {
      const parsed = JSON.parse(decrypt(enc)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  // ─── D-01: Events API webhook parse boundary ────────────────────────

  /**
   * Parse an inbound Events API envelope into an IncomingMessage. Accepts
   * ONLY `type === "event_callback"` envelopes whose inner event is a
   * `message` in an `im` channel (D-01/D-18). DROPS (→ null):
   *   - url_verification envelopes (the ROUTE answers the challenge — the
   *     handshake is not a message, D-01);
   *   - non-`message` inner event types (app_rate_limited, app_uninstalled,
   *     … — silent ignore);
   *   - non-im channel_types (channel/group/mpim — silent drop, D-18);
   *   - BOT ECHOES (research P4 — Slack echoes the bot's own replies,
   *     unlike Telegram): any event carrying `bot_id`, any event carrying a
   *     `subtype` (message_changed/message_deleted/bot_message), or an
   *     event whose `user` equals the connector's stored `botUserId`
   *     (seeded by the OAuth install; absent from the blob → that one
   *     guard is skipped).
   *
   * MAP (D-04): `platformMessageId` = the ENVELOPE's `event_id` (globally
   * unique and stable across Slack's retry redeliveries — NOT the inner
   * `event.ts`); `platformUserId` = `event.channel` (the D… DM id — also
   * the chat.postMessage reply target); `platformUserName` = `event.user`;
   * `text` = `event.text ?? null` (non-text events → politeness fallback
   * downstream); `chatType` = "private".
   *
   * NOTE the adapter signature: the ROUTE passes the already-parsed body
   * (the envelope) — the `req: unknown` parameter carries the parsed
   * envelope per the telegram parse-call shape (connectors.ts:798). The
   * bot-user echo guard consults the connector row via the optional
   * second argument; callers that omit it (tests) exercise the
   * bot_id/subtype guards only.
   */
  parseIncomingWebhook(req: unknown, connector?: { configEncrypted?: string | null } | null): IncomingMessage | null {
    const envelope = req as SlackEnvelope | null;
    if (!envelope || typeof envelope !== "object") return null;
    if (envelope.type !== "event_callback") return null; // url_verification + others → route layer
    const event = envelope.event;
    if (!event || typeof event !== "object") return null;
    if (event.type !== "message") return null; // app_rate_limited / app_uninstalled / …
    if (event.channel_type !== "im") return null; // D-18 boundary: channel/group/mpim → null

    // Bot-echo drop guards (research P4 — Slack echoes the bot's own
    // replies; the telegram parser never needed these).
    if (typeof event.bot_id === "string" && event.bot_id !== "") return null;
    if (event.subtype !== undefined && event.subtype !== null && event.subtype !== "") return null;

    // Bot-user echo guard: the OAuth install seeds botUserId into the
    // config blob; when absent, skip this one guard (the bot_id/subtype
    // guards above already cover the real echo surface).
    if (connector) {
      const config = this.configOf(connector);
      const botUserId = typeof config.botUserId === "string" ? config.botUserId : "";
      if (botUserId !== "" && event.user === botUserId) return null;
    }

    return {
      platformMessageId: typeof envelope.event_id === "string" ? envelope.event_id : null,
      platformUserId: typeof event.channel === "string" ? event.channel : "",
      platformUserName: typeof event.user === "string" ? event.user : undefined,
      text: typeof event.text === "string" ? event.text : null,
      chatType: "private",
    };
  }

  // ─── D-01: webhook-only — empty poll batch ──────────────────────────

  /**
   * D-01: Slack is webhook-only (the connectorPoller filters
   * platform === "telegram", so this is never consulted) — a safe empty
   * PollBatch keeps the adapter contract honest without any platform call.
   */
  async pollUpdates(_connector: ConnectorPipelineRow): Promise<PollBatch> {
    return { messages: [], maxUpdateId: null };
  }

  // ─── D-10: outbound send (39000 split, mrkdwn, serial) ──────────────

  /**
   * D-10: split the RAW markdown at 39000 chars (margin under Slack's
   * 40000 limit; the fence-safe splitter never cuts mid-code-block) and
   * send each segment converted md→mrkdwn, serially, to
   * POST {SLACK_API_URL}/chat.postMessage with
   * `{ channel, text }` + Authorization: Bearer. NO parse_mode key exists
   * in the Slack API — omitted. platformMessageId is the LAST segment's
   * response `message.ts` (Slack's message id is globally unique per
   * channel/bot — no CR-02 chat-scoped composition needed). Rate-limit
   * arm: a `{ok:false,error:"ratelimited"}` body retries at most 2 times
   * per segment after min(retryAfter*1000, 15000) ms, then throws
   * SlackApiError (D-10 — bounded, never a hot loop). A non-ratelimited
   * retry failure is terminal for the segment (no silent drop).
   */
  async sendMessage(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    platformUserId: string,
    text: string
  ): Promise<{ platformMessageId?: string }> {
    const token = this.tokenOf(connector);
    const segments = splitMessage(text, 39000);
    let lastMessageId: string | undefined;

    for (const segment of segments) {
      const payload = {
        channel: platformUserId,
        text: mdToMrkdwn(segment),
      };

      try {
        const response = await this.slackApi(token, "chat.postMessage", payload);
        const ts = response.message?.ts;
        if (typeof ts === "string") {
          lastMessageId = ts;
        }
      } catch (err: unknown) {
        // D-10 ratelimited arm: honor Retry-After (bounded — max 2 retries
        // per segment), then surface the failure (lastError persistence is
        // upstream, D-20).
        if (err instanceof SlackApiError && err.description === "ratelimited") {
          let sent = false;
          let lastErr: unknown = err;
          for (let attempt = 0; attempt < 2 && !sent; attempt += 1) {
            const waitSeconds = this.lastRetryAfterSeconds ?? 1;
            await new Promise((r) => setTimeout(r, Math.min(waitSeconds * 1000, 15_000)));
            try {
              const response = await this.slackApi(token, "chat.postMessage", payload);
              const ts = response.message?.ts;
              if (typeof ts === "string") {
                lastMessageId = ts;
              }
              sent = true;
            } catch (retryErr: unknown) {
              lastErr = retryErr;
              if (!(retryErr instanceof SlackApiError && retryErr.description === "ratelimited")) {
                // A non-ratelimited retry failure is terminal for this segment.
                break;
              }
            }
          }
          if (!sent) {
            throw lastErr;
          }
        } else {
          throw err;
        }
      }
    }

    return { platformMessageId: lastMessageId };
  }

  // ─── D-01: no typing indicator ──────────────────────────────────────

  /**
   * D-01: Slack bots have NO typing indicator — no-op resolve (the
   * messageRouter's typing coordinator invokes it harmlessly).
   */
  async sendTypingIndicator(
    _connector: ConnectorPipelineRow,
    _platformUserId: string
  ): Promise<void> {
    // no-op (D-01)
  }

  // ─── D-02: token validation + bot identity ──────────────────────────

  /**
   * D-02: validate a SUBMITTED token without persisting it — POST auth.test
   * with the Bearer token. Success `{ok:true, user}` maps botUsername AND
   * botDisplayName to `user` (Slack usernames carry no @; research
   * API Contracts 4). ANY `{ok:false}` envelope (invalid_auth etc.) →
   * `{ valid: false }` without throwing (P2 envelope discipline).
   */
  async validateBotToken(
    token: string
  ): Promise<{ valid: boolean; botUsername?: string | null; botDisplayName?: string | null }> {
    try {
      const response = await this.slackApi(token, "auth.test", {});
      const user = typeof response.user === "string" ? response.user : null;
      if (!user) return { valid: false };
      return { valid: true, botUsername: user, botDisplayName: user };
    } catch (err: unknown) {
      if (err instanceof SlackApiError) {
        return { valid: false };
      }
      throw err;
    }
  }

  /** D-02: bot identity for the STORED token (persisted at validate time). */
  async getBotInfo(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null }
  ): Promise<{ botUsername?: string | null; botDisplayName?: string | null }> {
    const token = this.tokenOf(connector);
    const response = await this.slackApi(token, "auth.test", {});
    const user = typeof response.user === "string" ? response.user : null;
    return { botUsername: user, botDisplayName: user };
  }

  // ─── D-01: no webhook API surface ───────────────────────────────────

  /**
   * D-01: Slack event-subscription URLs are configured in the Slack App
   * dashboard — there is NO setWebhook/removeWebhook API to call. Both
   * lifecycle methods are no-op resolves (the webhook-setup route's
   * best-effort adapter call succeeds without any platform call).
   */
  async setWebhook(
    _connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    _url: string,
    _secret: string
  ): Promise<void> {
    // no-op (D-01 — dashboard-configured event URLs)
  }

  /** D-01: no-op resolve (mode-switch + best-effort delete arm). */
  async removeWebhook(
    _connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null }
  ): Promise<void> {
    // no-op (D-01)
  }
}

// ===== Registry registration (module load, D-01) =====

// The 198 create/validate/test routes' 400 "Platform not implemented yet"
// flips to the adapter-driven paths automatically once THIS import runs
// (index.ts side-effect-imports slack.ts beside the telegram/discord imports).
registerAdapter("slack", new SlackAdapter());