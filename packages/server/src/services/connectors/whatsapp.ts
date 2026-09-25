// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 200 (200-02, ECCO-06, D-06/D-07/D-08/D-11) — the WhatsApp Cloud API
// platform adapter: fetch-direct Graph API transport (NO SDK — zero-dep
// doctrine D-02), the webhook parse boundary (entry[0].changes[0].value
// envelope, messages[*] only, statuses silently dropped — D-06), the
// md→WhatsApp converter + 4000 fence-safe split (D-11), the 131047 terminal
// error arm (D-08 — outside the 24h window: NO retry, NO template fallback;
// template messages are NEVER in v1, spec §7.9-4), and the no-op
// webhook/typing lifecycle (D-06 — the Meta webhook subscription is
// dashboard-configured and the Cloud API has no typing indicator in scope).
//
// PROBE SHAPES (INFO-2 pin, base.ts:118 single-arg contract):
//   - validateBotToken(token) is a TOKEN-ONLY `GET {base}/me` probe — the
//     base.ts contract pins a single-argument signature, so the probe reads
//     nothing from any row. Graph `/me` returns the token's identity
//     metadata; 200 → valid, 401/403/other non-2xx → invalid (the A3
//     "cheap authenticated GET that 401s on a bad token" contract).
//   - getBotInfo(connector) is the RICHER probe where the row IS available:
//     `GET {base}/{phoneNumberId}` (phoneNumberId from configOf) returns the
//     display phone number + verified name. When the row carries NO
//     phoneNumberId the probe is skipped entirely ({ valid: true }, no
//     identity fields — never a pointless authenticated call).
//
// PERSISTENCE SITE (INFO-2 decision — one arm, stated): the adapter NEVER
// touches prisma. A Graph send failure (including 131047) THROWS a typed
// WhatsappApiError carrying the Graph code; the messageRouter's existing
// send-failure path (sendAndLogReply rethrow → the agent-turn catch →
// failHealth) persists healthStatus + lastError. The 131047 error message
// embeds "131047" so the persisted lastError identifies the window failure.
// The health cron (Plan 03) is INDEPENDENT of this send-failure arm — the
// cron validates tokens, not the 24h window.
//
// PHONE NUMBER DISCIPLINE (P10): Meta `from` values are bare E.164 digits
// WITHOUT the `+` (e.g. `491234567890`); the send `to` expects the same
// shape. The adapter echoes platformUserId VERBATIM — no normalization, no
// `+` prefix (adding one is a known 131026 invalid-recipient source).
//
// SECRET DISCIPLINE (T-200-10, T-198-10 parity): the access token is
// decrypted PER CALL and never logged, never returned by any adapter
// response, and never appears in lastError text — WhatsappApiError carries
// method + HTTP status + Graph description only. Structured errors embed the
// Graph error CODE (a number) and message, never any Authorization material.
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
// D-11: the 4000 split reuses the EXPORTED telegram splitter — it is pure
// (text, limit) → segments[], its fence-safe boundary logic is already
// tested (198 D-17), and importing avoids any copy drift (slack.ts:42
// precedent). NO copy.
import { splitMessage } from "./telegram";

// ===== Runtime base-URL override (the discord/slack seam generalized) =====

/**
 * Module-level Graph API base-URL override: the E2E fake (Plan 04
 * whatsappApiEndpoint-style) sets this via the dev-only /api/__tests__ helper
 * so the adapter's Graph calls hit the in-process fake. graphApi consults
 * this BEFORE getEnv().WHATSAPP_API_URL; null = production semantics.
 * NEVER called by production runtime paths.
 */
let whatsappApiBaseOverride: string | null = null;

/**
 * Set/clear the runtime Graph API base override (dev/test harness only —
 * the e2eHelpers start/stop routes; stop() passes null to reset). An
 * empty/whitespace string clears to null (byte-mirror of
 * setSlackApiBaseOverride).
 */
export function setWhatsappApiBaseOverride(url: string | null): void {
  whatsappApiBaseOverride = url && url.trim() !== "" ? url : null;
}

/** Test-only: the current override value (null = env-driven). */
export function getWhatsappApiBaseOverride(): string | null {
  return whatsappApiBaseOverride;
}

// ===== Structured adapter error =====

/**
 * Structured adapter failure (D-20 mapping upstream): method + HTTP status
 * + Graph description ONLY — NEVER the access token, never any Authorization
 * material, never raw request bodies (T-200-10). `code` carries the Graph
 * error code when the response body declares one (e.g. 131047 — the 24h
 * window error, D-08 terminal arm); the MESSAGE embeds the code so the
 * router-persisted lastError identifies the failure mode.
 */
export class WhatsappApiError extends Error {
  public readonly method: string;
  public readonly status: number | null;
  public readonly description: string | null;
  /** Graph error code from the response body (null when absent). */
  public readonly code: number | null;

  constructor(
    method: string,
    status: number | null,
    description: string | null,
    code: number | null = null
  ) {
    super(
      `WhatsApp ${method} failed${status !== null ? ` (HTTP ${status})` : ""}${
        code !== null ? ` [Graph code ${code}]` : ""
      }${description ? `: ${description}` : ""}`
    );
    this.name = "WhatsappApiError";
    this.method = method;
    this.status = status;
    this.description = description;
    this.code = code;
  }
}

// ===== Graph API payload types (hand-declared, D-02 — no SDK types) =====

/** Graph error envelope: `{ error: { message, type, code, error_data? } }`. */
interface GraphErrorBody {
  error?: {
    message?: string;
    code?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Graph messages-send success envelope:
 * `{ messaging_product, contacts: […], messages: [{ id: "wamid.…" }] }`.
 */
interface GraphSendResponse {
  messages?: { id?: string }[];
  [key: string]: unknown;
}

/**
 * The `/me` identity probe response: Graph returns the token's identity
 * metadata (name/id fields vary by token type — consume display-ish fields
 * only).
 */
interface GraphMeResponse {
  name?: string;
  [key: string]: unknown;
}

/**
 * The phone-number metadata probe (`GET {base}/{phoneNumberId}`): carries
 * display_phone_number + verified_name for getBotInfo.
 */
interface GraphPhoneResponse {
  display_phone_number?: string;
  verified_name?: string;
  [key: string]: unknown;
}

/** Inbound webhook `value` sub-object — the fields the parse boundary consumes. */
interface WhatsappWebhookValue {
  messages?: WhatsappInboundMessage[];
  statuses?: unknown[];
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  [key: string]: unknown;
}

/** The inbound `messages[*]` sub-object — the fields the parse boundary consumes. */
interface WhatsappInboundMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  [key: string]: unknown;
}

/** The webhook envelope shape (research API Contracts 6). */
interface WhatsappWebhookBody {
  object?: string;
  entry?: {
    changes?: { value?: WhatsappWebhookValue }[];
  }[];
  [key: string]: unknown;
}

// ===== md → WhatsApp converter (D-11) =====

/**
 * D-11: minimal markdown→WhatsApp converter. Only the two markers WhatsApp
 * renders differently from markdown are REWRITTEN: `**bold**` → `*bold*`
 * and `__italic__` → `_italic_` (bold FIRST — the double-asterisk marker
 * would otherwise be consumed by a later rewrite). PASS-THROUGH/PROTECTED:
 * `` `inline-code` `` IS native WhatsApp formatting and its CONTENT is
 * extracted verbatim before the rewrite (markup inside a code span renders
 * literally — the slack.ts mdToMrkdwn doctrine), `~~strike~~` passes
 * through UNCHANGED (the D-11 pin — no single-tilde rewrite in v1). Fenced
 * ``` blocks have NO WhatsApp equivalent — they are FLATTENED: each fence
 * CONTENT line becomes a `-wrapped inline-code line, fence delimiter lines
 * are dropped as structural (content NEVER dropped — the D-11 pin).
 *
 * Fail-open (D-11): a CONVERSION failure (regex on pathological input)
 * never loses the answer — the ORIGINAL plain text is returned and a
 * logger.warn records it.
 */
export function mdToWhatsapp(text: string): string {
  try {
    const lines = text.split("\n");
    const out: string[] = [];
    let inFence = false;

    for (const line of lines) {
      // Fenced-block state machine: ``` toggles fence mode. A fence
      // delimiter line itself produces no output (it is structural); the
      // content lines inside become `-wrapped inline-code lines.
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        // FLATTEN: every fenced content line becomes an inline-code line —
        // never drop content (D-11 pin).
        out.push("`" + line + "`");
        continue;
      }
      // Inline code spans are EXTRACTED before the prose conversion (the
      // slack.ts mdToMrkdwn shape): markup inside `…` renders literally.
      const pattern = /`[^`\n]+`/g;
      const parts: string[] = [];
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        parts.push(mdToWhatsappOutside(line.slice(last, match.index)));
        parts.push(match[0]);
        last = match.index + match[0].length;
      }
      parts.push(mdToWhatsappOutside(line.slice(last)));
      out.push(parts.join(""));
    }

    return out.join("\n");
  } catch (err: unknown) {
    // SPEC-LESS EDGE (fail-open, D-11): conversion failure never loses the
    // answer — degrade to the original plain markdown text.
    logger.warn("[connectors] markdown→WhatsApp conversion failed — degraded to plain text", {
      error: err instanceof Error ? err.message : String(err),
    });
    return text;
  }
}

/** Convert the markdown markup OUTSIDE code spans (the segment between code
 * constructs): **bold** → *bold* FIRST, __italic__ → _italic_. Inline
 * `` `code` `` spans and `~~strike~~` are pass-through — code spans are
 * EXTRACTED before the rewrite (the slack.ts:137-152 mdToMrkdwn shape:
 * markup inside a code span must survive literally). */
function mdToWhatsappOutside(text: string): string {
  // 1. Bold FIRST (**…** → *…*) — the double-asterisk marker would
  //    otherwise collide with a later rewrite.
  let out = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => `*${inner}*`);

  // 2. Italic __…__ → _…_.
  out = out.replace(/__([^_\n]+)__/g, (_m, inner: string) => `_${inner}_`);

  // ~~strike~~ passes through UNCHANGED (D-11 pin — no rewrite).
  return out;
}

// ===== The adapter =====

/**
 * WhatsappAdapter (ECCO-06, D-06): fetch-direct Graph API transport over the
 * EXISTING PlatformAdapter contract. The token is decrypted per call from
 * the connector row (never cached in module state beyond the call — threat
 * register boundary). Registered at module load:
 * registry.isPlatformImplemented("whatsapp") flips true, unblocking the 198
 * create/validate/test routes' 400 "Platform not implemented yet".
 */
export class WhatsappAdapter implements PlatformAdapter {
  /**
   * The Graph API call core: an authenticated GET/POST against
   * `{base}/…` with the Bearer token; returns the parsed JSON body. Non-2xx
   * OR a body `error.code` throws WhatsappApiError with the Graph code and
   * description (status + code + message only — never the token,
   * T-200-10). Non-JSON bodies (proxy/error pages) surface as a structured
   * failure with NO body echo.
   */
  private async graphApi(
    token: string,
    path: string,
    init?: { method?: "GET" | "POST"; body?: Record<string, unknown> }
  ): Promise<Record<string, unknown>> {
    const base = whatsappApiBaseOverride ?? getEnv().WHATSAPP_API_URL; // override wins (E2E seam); env is the air-gap lever
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let parsed: Record<string, unknown>;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch (err: unknown) {
      void err;
      // Non-JSON body (proxy/error page): surface as a structured failure
      // without any body echo (could carry request material — T-200-10).
      throw new WhatsappApiError("request", res.status, `non-JSON response (status ${res.status})`);
    }
    // Graph error envelope: { error: { message, code, … } } — fires on ANY
    // non-2xx OR a body carrying error.code (Graph can 200-with-error in
    // odd proxy shapes; the body arm is the safety net).
    const errorBody = (parsed as GraphErrorBody).error;
    if (!res.ok || (errorBody && typeof errorBody === "object" && typeof errorBody.code === "number")) {
      const code = typeof errorBody?.code === "number" ? errorBody.code : null;
      const message = typeof errorBody?.message === "string" ? errorBody.message : null;
      throw new WhatsappApiError(init?.method === "POST" ? "send" : "request", res.status, message, code);
    }
    return parsed;
  }

  /** Decrypt the access token per call (never cached beyond the call). */
  private tokenOf(connector: { botTokenEncrypted?: string | null }): string {
    const enc = connector.botTokenEncrypted;
    if (!enc) {
      throw new WhatsappApiError("token", null, "connector has no access token configured");
    }
    return decrypt(enc);
  }

  /**
   * The decrypted config blob — carries phoneNumberId, appSecret,
   * verifyToken, whatsappBusinessAccountId (stored, unused in v1 send/parse
   * paths — D-06). Parsed per call; fail-open to {} (the telegram.ts:342-354
   * shape); never logged (T-200-10).
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

  // ─── D-06: webhook parse boundary ───────────────────────────────────

  /**
   * Parse an inbound webhook body into an IncomingMessage. Accepts ONLY the
   * `{object, entry:[{changes:[{value:{messages:[…]…]}}]}` envelope with at
   * least one `messages[*]` (research API Contracts 6). DROPS (→ null):
   *   - statuses-only deliveries (`value.statuses[*]` = sent/delivered/
   *     read/failed receipts — D-06 silent drop; no messages array → null);
   *   - non-webhook objects / malformed envelopes (null — the ACK already
   *     went out; the async arm drops silently, D-06);
   *   - non-text message types (image/voice/… — text maps null so the
   *     router's politeness path fires downstream, D-18 parity).
   *
   * MAP: `platformMessageId` = `messages[*].id` (the wamid — GLOBALLY
   * unique per bot, NO CR-02 chat-scoped composition needed); `platformUserId`
   * = `messages[*].from` ECHOED VERBATIM (bare E.164 digits, NO `+` — P10:
   * adding one is a known 131026 invalid-recipient source); `platformUserName`
   * = `value.contacts[0].profile?.name`; `text` = `messages[*].text.body`
   * ONLY when `messages[*].type === "text"`; `chatType` = "private".
   *
   * Only the FIRST messages[*] of entry[0].changes[0] is mapped (one
   * IncomingMessage per webhook request — the envelope shape Cloud API
   * delivers for single-message notifications).
   */
  parseIncomingWebhook(req: unknown): IncomingMessage | null {
    const body = req as WhatsappWebhookBody | null;
    if (!body || typeof body !== "object") return null;
    const entry0 = body.entry?.[0];
    const change0 = entry0?.changes?.[0];
    const value = change0?.value;
    if (!value || typeof value !== "object") return null;

    const messages = value.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null; // statuses-only / non-messages payloads (D-06)
    const message = messages[0];
    if (!message || typeof message !== "object") return null;

    return {
      platformMessageId: typeof message.id === "string" ? message.id : null,
      platformUserId: typeof message.from === "string" ? message.from : "",
      platformUserName:
        typeof value.contacts?.[0]?.profile?.name === "string"
          ? value.contacts[0].profile!.name
          : undefined,
      text:
        message.type === "text" && typeof message.text?.body === "string"
          ? message.text.body
          : null,
      chatType: "private",
    };
  }

  // ─── D-06: webhook-only — empty poll batch ──────────────────────────

  /**
   * D-06: WhatsApp is webhook-only (the connectorPoller filters
   * platform === "telegram", so this is never consulted) — a safe empty
   * PollBatch keeps the adapter contract honest without any platform call.
   */
  async pollUpdates(_connector: ConnectorPipelineRow): Promise<PollBatch> {
    return { messages: [], maxUpdateId: null };
  }

  // ─── D-11: outbound send (4000 split, converter, serial) ────────────

  /**
   * D-11: split the RAW markdown at 4000 chars (the Cloud API text-body
   * cap; the fence-safe splitter never cuts mid-code-block), convert each
   * segment md→WhatsApp, and POST serially to
   * `{base}/{phoneNumberId}/messages` with
   * `{ messaging_product: "whatsapp", recipient_type: "individual",
   * to, type: "text", text: { body, preview_url: false } }` +
   * Authorization: Bearer accessToken. `to` is the platformUserId ECHOED
   * VERBATIM (P10 — bare digits, no `+`).
   *
   * ERROR ARMS (D-08): the 131047 Graph code (outside the 24h window) is a
   * TERMINAL arm — NO retry, NO template fallback (template messages are
   * NEVER in v1, spec §7.9-4). EVERY other error is equally terminal at
   * this layer: the adapter throws WhatsappApiError and does NOT touch
   * prisma — the ROUTER's send-failure path (messageRouter failHealth via
   * the sendAndLogReply rethrow → the agent-turn catch) persists
   * healthStatus + lastError (INFO-2 pin: one persistence site, router-side
   * only). The thrown error's message embeds "131047" so the persisted
   * lastError identifies the window failure.
   *
   * A connector whose blob lacks phoneNumberId throws the structured error
   * BEFORE any network call (fail-closed — the send target is unknowable).
   */
  async sendMessage(
    connector: ConnectorPipelineRow & {
      botTokenEncrypted?: string | null;
      configEncrypted?: string | null;
    },
    platformUserId: string,
    text: string
  ): Promise<{ platformMessageId?: string }> {
    const token = this.tokenOf(connector);
    const config = this.configOf(connector);
    const phoneNumberId = typeof config.phoneNumberId === "string" ? config.phoneNumberId : "";
    if (phoneNumberId === "") {
      throw new WhatsappApiError("send", null, "connector has no phone number ID configured");
    }

    const base = whatsappApiBaseOverride ?? getEnv().WHATSAPP_API_URL;
    const segments = splitMessage(text, 4000);
    let lastMessageId: string | undefined;

    for (const segment of segments) {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: platformUserId,
        type: "text",
        text: {
          body: mdToWhatsapp(segment),
          preview_url: false,
        },
      };

      // 131047 TERMINAL (D-08): the graphApi throw already carries the
      // Graph code — NO retry loop, NO template fallback. Re-thrown
      // unchanged so the router-side failHealth persists it (INFO-2 pin).
      const response = (await this.graphApi(token, `/${phoneNumberId}/messages`, {
        method: "POST",
        body: payload,
      })) as GraphSendResponse;

      const id = response.messages?.[0]?.id;
      if (typeof id === "string") {
        lastMessageId = id;
      }
    }

    return { platformMessageId: lastMessageId };
  }

  // ─── D-06: no typing indicator ──────────────────────────────────────

  /**
   * D-06: the Cloud API has no typing-indicator primitive in v1 scope —
   * no-op resolve (the messageRouter's typing coordinator invokes it
   * harmlessly).
   */
  async sendTypingIndicator(
    _connector: ConnectorPipelineRow,
    _platformUserId: string
  ): Promise<void> {
    // no-op (D-06)
  }

  // ─── INFO-2: token validation + bot identity ────────────────────────

  /**
   * INFO-2 PIN: validate a SUBMITTED token WITHOUT persisting it — a
   * TOKEN-ONLY `GET {base}/me` probe. base.ts:118 pins
   * `validateBotToken(token: string)` as a single-argument contract, so the
   * probe reads NOTHING from any row (phoneNumberId is not consulted here —
   * the richer phone-metadata probe lives in getBotInfo where the row IS
   * available). 200 → `{ valid: true, botUsername: display ?? "whatsapp" }`;
   * 401/403/any non-2xx → `{ valid: false }` without throwing.
   */
  async validateBotToken(
    token: string
  ): Promise<{ valid: boolean; botUsername?: string | null; botDisplayName?: string | null }> {
    try {
      await this.graphApi(token, "/me");
      return { valid: true, botUsername: "whatsapp" };
    } catch (err: unknown) {
      if (err instanceof WhatsappApiError) {
        return { valid: false };
      }
      throw err;
    }
  }

  /**
   * The RICHER probe (where the row IS available): `GET
   * {base}/{phoneNumberId}` returns display_phone_number + verified_name.
   * phoneNumberId comes from configOf; a row WITHOUT one → `{ valid: true }`
   * with no identity fields — the probe is SKIPPED (no pointless
   * authenticated call). A probe failure (invalid/revoked token) throws the
   * structured error (the caller's health mapping owns it).
   */
  async getBotInfo(
    connector: ConnectorPipelineRow & {
      botTokenEncrypted?: string | null;
      configEncrypted?: string | null;
    }
  ): Promise<{ botUsername?: string | null; botDisplayName?: string | null }> {
    const token = this.tokenOf(connector);
    const config = this.configOf(connector);
    const phoneNumberId = typeof config.phoneNumberId === "string" ? config.phoneNumberId : "";
    if (phoneNumberId === "") {
      // No probe target — skip (D-06: never a pointless authenticated call).
      return {};
    }
    const response = (await this.graphApi(token, `/${phoneNumberId}`)) as GraphPhoneResponse;
    return {
      botUsername: response.display_phone_number ?? null,
      botDisplayName: response.verified_name ?? null,
    };
  }

  // ─── D-06: no webhook API surface ───────────────────────────────────

  /**
   * D-06: the Meta webhook subscription is configured in the Meta App
   * dashboard — there is NO setWebhook/removeWebhook API to call. Both
   * lifecycle methods are no-op resolves (the webhook-setup route's
   * best-effort adapter call succeeds without any platform call).
   */
  async setWebhook(
    _connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    _url: string,
    _secret: string
  ): Promise<void> {
    // no-op (D-06 — dashboard-configured Meta webhook subscription)
  }

  /** D-06: no-op resolve (mode-switch + best-effort delete arm). */
  async removeWebhook(
    _connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null }
  ): Promise<void> {
    // no-op (D-06)
  }
}

// ===== Registry registration (module load, D-06) =====

// The 198 create/validate/test routes' 400 "Platform not implemented yet"
// flips to the adapter-driven paths automatically once THIS import runs
// (index.ts side-effect-imports whatsapp.ts beside the slack import).
registerAdapter("whatsapp", new WhatsappAdapter());