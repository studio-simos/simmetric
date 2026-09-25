// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 199 (199-01, ECCO-04, D-01/D-02/D-03/D-05/D-07) — the Discord
// platform adapter: the OUTBOUND REST half of the Discord connector.
// fetch-direct REST v10 transport (NO SDK — discord.js rejected per D-02:
// ESM-only heavy dep + moduleNameMapper cost on all 3 server jest configs),
// the runtime base-URL override seam (the setTelegramApiBaseOverride pattern
// generalized), 1900-split serial verbatim sends (D-07 — Discord renders
// markdown natively, so there is NO conversion layer and NO parse_mode), the
// single-shot typing post (204), and the /users/@me token validation.
//
// The WS Gateway inbound path is a SEPARATE module (discordGateway.ts, Plan
// 199-03) that feeds messageRouter.handleIncomingMessage directly — this
// adapter's parseIncomingWebhook returns null ALWAYS (D-01: Discord has no
// HTTP webhook inbound in v1) and pollUpdates is a never-consulted stub (the
// connectorPoller filters platform === "telegram").
//
// SECRET DISCIPLINE (T-199-01, T-198-10 parity): the bot token is decrypted
// PER CALL and is never logged, never returned by any adapter response, and
// never appears in lastError text — DiscordApiError carries method + HTTP
// status + platform description only.
//
// NOTE (undici pairing, collectorDispatchAgent.ts UPGRADE RULE): this module
// uses the BUILT-IN globalThis.fetch with NO custom dispatcher — a custom
// undici Agent here would be a v8-half-pairing hazard (telegram.ts
// telegram.ts:20-23 doctrine mirrored).

import { getEnv } from "../../config/env";
import { decrypt } from "../encryptionService";
import type {
  ConnectorPipelineRow,
  IncomingMessage,
  PlatformAdapter,
  PollBatch,
} from "./base";
import { registerAdapter } from "./registry";
// D-07: the 1900 split reuses the EXPORTED telegram splitter — it is pure
// (text, limit) → segments[], its fence-safe boundary logic is already
// tested (198 D-17), and importing avoids any copy drift. Markdown handling
// stays platform-local: Discord has NO conversion layer (D-07 verbatim rule)
// — segments are sent VERBATIM with no parse_mode key.
import { splitMessage } from "./telegram";

// ===== Runtime base-URL override (the telegram.ts seam generalized) =====

/**
 * Module-level REST base-URL override: the E2E fake (Plan 199-05
 * discordApiEndpoint-style) sets this via the dev-only /api/__tests__ helper
 * so the adapter's discordApi calls hit the in-process fake. discordApi
 * consults this BEFORE getEnv().DISCORD_API_URL; null = production
 * semantics. NEVER called by production runtime paths (T-199-03: the
 * override is a module setter invoked only by the dev/test harness —
 * production paths resolve getEnv().DISCORD_API_URL with the pinned zod
 * default).
 */
let discordApiBaseOverride: string | null = null;

/**
 * Set/clear the runtime REST base override (dev/test harness only — the
 * e2eHelpers start/stop routes; stop() passes null to reset). An
 * empty/whitespace string clears to null (byte-mirror of
 * setTelegramApiBaseOverride).
 */
export function setDiscordApiBaseOverride(url: string | null): void {
  discordApiBaseOverride = url && url.trim() !== "" ? url : null;
}

/** Test-only: the current override value (null = env-driven). */
export function getDiscordApiBaseOverride(): string | null {
  return discordApiBaseOverride;
}

// ===== Structured adapter error =====

/**
 * Structured adapter failure (D-20 mapping upstream): method + HTTP status
 * + platform description ONLY — NEVER the token, never any Authorization
 * material (T-199-01, telegram.ts TelegramApiError shape mirrored).
 */
export class DiscordApiError extends Error {
  public readonly method: string;
  public readonly status: number | null;
  public readonly description: string | null;

  constructor(method: string, status: number | null, description: string | null) {
    super(`Discord ${method} failed${status !== null ? ` (HTTP ${status})` : ""}${description ? `: ${description}` : ""}`);
    this.name = "DiscordApiError";
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

// ===== REST payload types (hand-declared, D-02 — no SDK types) =====

/** Discord REST error body: a JSON { message } envelope (or non-JSON). */
interface DiscordErrorBody {
  message?: string;
}

/** Discord `GET /users/@me` user object — the fields the validate path maps. */
interface DiscordBotUser {
  id?: string;
  username?: string;
  global_name?: string | null;
}

/** Discord `POST /channels/:id/messages` response — the fields the send path consumes. */
interface DiscordMessageResponse {
  id?: string;
  [key: string]: unknown;
}

// ===== The adapter =====

/**
 * DiscordAdapter (ECCO-04, D-01): fetch-direct REST v10 transport over the
 * EXISTING PlatformAdapter contract. The token is decrypted per call from
 * the connector row (never cached in module state beyond the call — threat
 * register boundary #3). Registered at module load:
 * registry.isPlatformImplemented("discord") flips true, unblocking the 198
 * create/validate/test routes' 400 "Platform not implemented yet".
 */
export class DiscordAdapter implements PlatformAdapter {
  /**
   * The REST call core (199-RESEARCH Pattern 2): fetch against
   * `${DISCORD_API_URL}${path}` with the Authorization: Bot header; a JSON
   * body rides along only when `body` is present (the typing POST is
   * bodyless). 429 retries ONCE after min(retry_after*1000, 15000) ms
   * (A1 belt-and-braces — recursion depth 1, no unbounded retry loop).
   * 204 returns an empty object (the typing endpoint has no body). Non-OK
   * throws the structured DiscordApiError — a non-JSON body degrades to a
   * "non-JSON response (status N)" description with NO body echo (the body
   * could carry request material — T-199-01). NEVER logs the token.
   */
  private async discordApi(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    _depth = 0
  ): Promise<unknown> {
    const base = discordApiBaseOverride ?? getEnv().DISCORD_API_URL; // override wins (E2E seam); env is the air-gap lever
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Authorization": `Bot ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 429) {
      // Discord rate-limit body: { message, retry_after (seconds), global }.
      // Retry ONCE (depth 1 cap) after min(retry_after*1000, 15s) — the
      // pipeline's own D-10 limit (20/h default) is far below the platform
      // per-route budget, so this is belt-and-braces, never a hot loop.
      let retryAfter = 1; // docs-sane fallback when the body is not parseable JSON
      try {
        const parsed = (await res.clone().json()) as DiscordErrorBody & { retry_after?: number } | null;
        if (parsed && typeof parsed.retry_after === "number") {
          retryAfter = parsed.retry_after;
        }
      } catch {
        // non-JSON 429 body — keep the fallback
      }
      if (_depth < 1) {
        await new Promise((r) => setTimeout(r, Math.min(retryAfter * 1000, 15_000)));
        return this.discordApi(token, method, path, body, _depth + 1);
      }
      // Second 429: surface as a structured failure (no infinite loop).
      throw new DiscordApiError(method, 429, "rate limited (retry exhausted)");
    }

    if (res.status === 204) {
      return {}; // typing endpoint — 204 empty
    }

    if (!res.ok) {
      let description: string | null = null;
      try {
        const parsed = (await res.json()) as DiscordErrorBody | null;
        description = parsed?.message ?? null;
      } catch {
        // Non-JSON body (proxy/error page): NO body echo — it could carry
        // request material (T-199-01).
        description = `non-JSON response (status ${res.status})`;
      }
      throw new DiscordApiError(method, res.status, description);
    }

    return res.json();
  }

  /** Decrypt the bot token per call (never cached beyond the call). */
  private tokenOf(connector: { botTokenEncrypted?: string | null }): string {
    const enc = connector.botTokenEncrypted;
    if (!enc) {
      throw new DiscordApiError("token", null, "connector has no bot token configured");
    }
    return decrypt(enc);
  }

  // ─── D-01: no HTTP webhook inbound in v1 ───────────────────────────

  /**
   * D-01: Discord DMs arrive over the Gateway WS (discordGateway.ts, Plan
   * 199-03) — there is NO HTTP webhook inbound surface in v1. This method
   * returns null ALWAYS (the gateway path bypasses it entirely); the
   * contract keeps it for interface fit.
   */
  parseIncomingWebhook(_req: unknown): IncomingMessage | null {
    return null;
  }

  // ─── D-01: never-consulted polling stub ────────────────────────────

  /**
   * D-01: the connectorPoller filters platform === "telegram" (198-03
   * :121-124), so this is NEVER consulted — a safe empty PollBatch stub
   * keeps the adapter contract honest without any platform call.
   */
  async pollUpdates(_connector: ConnectorPipelineRow): Promise<PollBatch> {
    return { messages: [], maxUpdateId: null };
  }

  // ─── D-07: outbound send (1900 split, serial, verbatim) ────────────

  /**
   * D-07: split the RAW markdown at 1900 chars (margin under Discord's
   * 2000-char limit; the splitter is fence-safe — never mid-code-block, a
   * mid-fence hard split re-emits the opening fence) and send each segment
   * VERBATIM serially to POST /channels/:id/messages with { content }.
   * NO markdown conversion, NO parse_mode key on the payload (Discord parses
   * markdown natively in `content`). platformMessageId is the bare message
   * snowflake of the LAST segment (globally unique per bot in DMs — D-03:
   * no CR-02 chat-scoped composition in v1; if guild support ever lands,
   * the composition becomes mandatory at this boundary). Structured error
   * (method + status/description, no token) on failures — health mapping is
   * upstream (D-20).
   */
  async sendMessage(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    platformUserId: string,
    text: string
  ): Promise<{ platformMessageId?: string }> {
    const token = this.tokenOf(connector);
    const segments = splitMessage(text, 1900);
    let lastMessageId: string | undefined;

    for (const segment of segments) {
      const response = (await this.discordApi(
        token,
        "POST",
        `/channels/${platformUserId}/messages`,
        { content: segment } // verbatim — no conversion layer, no parse_mode (D-07)
      )) as DiscordMessageResponse | null;
      if (response && typeof response.id === "string") {
        lastMessageId = response.id;
      }
    }

    return { platformMessageId: lastMessageId };
  }

  // ─── D-19 parity: single-shot typing ───────────────────────────────

  /**
   * D-19 parity: REST POST /channels/:id/typing — a single-shot pre-run
   * send (the 204 response is empty; the router owns resend cadence). The
   * typing TTL is 10s Discord-side (vs Telegram's 5s) — one call suffices.
   */
  async sendTypingIndicator(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    platformUserId: string
  ): Promise<void> {
    const token = this.tokenOf(connector);
    await this.discordApi(token, "POST", `/channels/${platformUserId}/typing`);
  }

  // ─── D-02/D-03: token validation + bot identity ────────────────────

  /**
   * D-02: validate a SUBMITTED token without persisting it — GET /users/@me
   * against the platform. Maps botUsername = username (no @ prefix on
   * Discord) and botDisplayName = global_name ?? username (D-03's display
   * formula). Invalid (DiscordApiError — e.g. 401) → { valid: false }
   * without throwing.
   */
  async validateBotToken(
    token: string
  ): Promise<{ valid: boolean; botUsername?: string | null; botDisplayName?: string | null }> {
    try {
      const response = (await this.discordApi(token, "GET", "/users/@me")) as DiscordBotUser | null;
      if (!response || typeof response.username !== "string" || response.username === "") {
        return { valid: false };
      }
      return {
        valid: true,
        botUsername: response.username,
        botDisplayName: response.global_name ?? response.username,
      };
    } catch (err: unknown) {
      if (err instanceof DiscordApiError) {
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
    const response = (await this.discordApi(token, "GET", "/users/@me")) as DiscordBotUser | null;
    return {
      botUsername: typeof response?.username === "string" ? response.username : null,
      botDisplayName:
        typeof response?.username === "string"
          ? (response?.global_name ?? response.username)
          : null,
    };
  }

  // ─── D-01: no webhook surface ──────────────────────────────────────

  /**
   * D-01: Discord has NO HTTP webhook surface in v1 — both lifecycle
   * methods are no-op resolves (no fetch, no platform call). The PUT
   * pollMode arm's adapter-capability guard routes non-telegram platforms
   * away from webhook mode, so these never fire in production either.
   */
  async setWebhook(
    _connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    _url: string,
    _secret: string
  ): Promise<void> {
    // no-op (D-01)
  }

  /** D-01: no-op resolve (mode-switch + best-effort delete arm). */
  async removeWebhook(
    _connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null }
  ): Promise<void> {
    // no-op (D-01)
  }
}

// ===== Registry registration (module load, D-01/Pitfall 5) =====

// The 198 create/validate/test routes' 400 "Platform not implemented yet"
// flips to the adapter-driven paths automatically once THIS import runs
// (index.ts side-effect-imports discord.ts beside the telegram import).
registerAdapter("discord", new DiscordAdapter());