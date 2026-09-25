// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-03 Tasks 1-2, D-13/D-14/D-16/D-17/D-18) — the Telegram
// platform adapter: fetch-direct Bot API transport (NO SDK — telegraf /
// node-telegram-bot-api rejected per D-13), the webhook parse boundary
// (private-only, D-18), typing, getMe token validation, webhook lifecycle,
// the long-poll getUpdates shape, and the outbound markdown→HTML + 4000
// split (D-17).
//
// SECRET DISCIPLINE (T-198-10): the bot token is decrypted PER CALL and is
// never logged, never returned by any adapter response, and never appears in
// lastError text — error fields carry method + HTTP status/description only.
// The base URL is env-overridable (TELEGRAM_API_URL, default
// https://api.telegram.org) — air-gap installs point at a self-hosted Bot API
// mirror; no phone-home beyond the calls the feature requires (D-13).
//
// NOTE (undici pairing, collectorDispatchAgent.ts UPGRADE RULE): this module
// uses the BUILT-IN globalThis.fetch with NO custom dispatcher — a custom
// undici Agent here would be a v8-half-pairing hazard; do NOT introduce one
// in 198 (read-only awareness per plan read_first).

import crypto from "crypto";
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

// ===== D-14: webhook secret generation =====

/**
 * Module-level base-URL override (198-04, OQ-1 option (b)): the E2E fake
 * (botApiEndpoint.ts) sets this via the dev-only /api/__tests__ helper so
 * the adapter's botApi calls hit the in-process fake. botApi consults this
 override BEFORE getEnv().TELEGRAM_API_URL; null = production semantics.
 */
let telegramApiBaseOverride: string | null = null;

/**
 * Set/clear the runtime Bot API base override (dev/test harness only — the
 * e2eHelpers start/stop routes; stop() passes null to reset). NEVER called
 * by production runtime paths.
 */
export function setTelegramApiBaseOverride(url: string | null): void {
  telegramApiBaseOverride = url && url.trim() !== "" ? url : null;
}

/**
 * D-14: generate the Telegram webhook secret — 48 chars of the
 * [A-Za-z0-9_-] charset (Telegram's secret_token constraints; base64url
 * alphabet). crypto.randomBytes(36) → base64url = exactly 48 chars.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(36).toString("base64url");
}

// ===== Bot API payload types ([ASSUMED] shapes, RESEARCH TV-1) =====

interface BotApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  /** Some Bot API error envelopes carry an error_code alongside description. */
  error_code?: number;
}

/** Telegram `message` sub-object — the fields the parse boundary consumes. */
interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  text?: string;
  photo?: unknown;
  voice?: unknown;
  document?: unknown;
  [key: string]: unknown;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: unknown;
  [key: string]: unknown;
}

/** Poll result: the shared PollBatch contract (base.ts — WR-06). */
export type { PollBatch } from "./base";

// ===== Structured adapter error =====

/**
 * Structured adapter failure (D-20 mapping upstream): method + description
 * only — NEVER the token, never the URL fragment that would carry it
 * (T-198-10).
 */
export class TelegramApiError extends Error {
  public readonly method: string;
  public readonly status: number | null;
  public readonly description: string | null;

  constructor(method: string, status: number | null, description: string | null) {
    super(`Telegram ${method} failed${status !== null ? ` (HTTP ${status})` : ""}${description ? `: ${description}` : ""}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

// ===== markdown → Telegram HTML converter (D-17, P-8) =====

/**
 * Escape the three HTML-sensitive chars OUTSIDE supported tags (P-8: the
 * escaping is part of the converter — the fail-open retry is only the
 * safety net, not the happy path).
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * D-17: minimal markdown→Telegram-HTML converter. Supports **bold** → <b>,
 * *italic* → <i>, `inline-code` → <code>, ``` fenced blocks → <pre>,
 * [text](url) → <a href>. ALL other <, >, & in the text are entity-escaped
 * FIRST (P-8), so the only surviving entities are the ones the converter
 * itself re-opens from markdown syntax — injected HTML inside a code fence
 * survives as ESCAPED code (it cannot execute entities).
 *
 * Fail-open (D-17): a CONVERSION failure (regex on pathological input) never
 * loses the answer — the caller retries with plain text (the "can't parse
 * entities" path in sendMessage); this catch is the encoding safety net.
 */
export function markdownToTelegramHtml(text: string): string {
  try {
    // 1. Escape EVERYTHING first — the converter then re-opens only the
    //    supported tags from markdown syntax it produced itself. Code-fence
    //    content is escaped too (same pass): <script> inside a fence becomes
    //    escaped code text, never an executable entity.
    let out = escapeHtml(text);

    // 2. Fenced code blocks → <pre>. Content is ALREADY escaped (step 1) —
    //    no re-escape here (a second pass would corrupt &lt; into &amp;lt;).
    out = out.replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre>${code}</pre>`);

    // 3. Inline code → <code> (content already escaped).
    out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code}</code>`);

    // 4. Links [text](url) → <a href="url">text</a>. URL is attribute-escaped
    //    (quotes inside hrefs break the attribute, not just entities).
    out = out.replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, label: string, url: string) =>
        `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`
    );

    // 5. Bold **…** → <b>, then italic *…* → <i> (bold first — the
    //    double-asterisk marker would otherwise be consumed as two italics).
    out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => `<b>${inner}</b>`);
    out = out.replace(/\*([^*\n]+)\*/g, (_m, inner: string) => `<i>${inner}</i>`);

    return out;
  } catch (err: unknown) {
    // SPEC-LESS EDGE (D-17 encoding): conversion failure never loses the
    // answer — degrade to the escaped plain text (entities only).
    logger.warn("[connectors] markdown→HTML conversion failed — degraded to escaped text", {
      error: err instanceof Error ? err.message : String(err),
    });
    return escapeHtml(text);
  }
}

// ===== 4000-char splitter (D-17) =====

/**
 * D-17: split `text` into segments of at most `limit` chars. Boundary
 * preference: paragraph (\n\n) → newline (\n) → hard-split (last resort).
 * NEVER cuts INSIDE a fenced code block when a safe boundary exists: fence
 * state is tracked across the whole text, candidate cuts strictly inside a
 * fence are skipped, and a hard split that lands mid-fence re-emits the
 * opening fence at the top of the next segment — no segment ever STARTS
 * mid-fence (SPEC-LESS EDGE: an unterminated fence stays parseable).
 *
 * Returns segments IN ORDER; the joined content preserves every character
 * except re-emitted fence prefixes.
 */
export function splitMessage(text: string, limit = 4000): string[] {
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];

  // Fence occurrence indices — paired ``` delimiters track fenced-block
  // state; an ODD count of occurrences before a position means that
  // position is INSIDE a fence.
  const fenceStarts: number[] = [];
  let idx = text.indexOf("```");
  while (idx !== -1) {
    fenceStarts.push(idx);
    idx = text.indexOf("```", idx + 3);
  }
  const fenceCountBefore = (p: number): number => {
    let lo = 0;
    let hi = fenceStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((fenceStarts[mid] ?? 0) < p) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };
  const insideFenceAt = (p: number): boolean => fenceCountBefore(p) % 2 === 1;

  const segments: string[] = [];
  let start = 0;
  let pendingReopen = false; // the previous cut landed mid-fence — re-emit the opening fence

  while (start < text.length) {
    let prefix = "";
    let budget = limit;
    if (pendingReopen) {
      prefix = "```\n";
      budget = limit - prefix.length;
      pendingReopen = false;
    }

    if (text.length - start <= budget) {
      segments.push(prefix + text.slice(start));
      break;
    }

    const windowEnd = start + budget; // exclusive candidate ceiling

    // Candidate boundary cuts, best first: paragraph (\n\n, boundary kept in
    // the segment), then newline (\n). A candidate strictly inside a fence
    // is skipped (fence-safe boundary discipline).
    let cut = -1;
    for (const sep of ["\n\n", "\n"]) {
      for (let i = windowEnd - sep.length; i > start; i--) {
        if (text.startsWith(sep, i)) {
          const candidate = i + sep.length;
          if (!insideFenceAt(candidate)) {
            cut = candidate;
            break;
          }
        }
      }
      if (cut !== -1) break;
    }

    if (cut === -1) {
      // Last resort: hard-split at the budget ceiling. When that lands
      // mid-fence, the NEXT segment re-opens the fence (pendingReopen) so
      // no segment starts mid-fence.
      cut = windowEnd;
      if (insideFenceAt(cut)) {
        pendingReopen = true;
      }
    }

    segments.push(prefix + text.slice(start, cut));
    start = cut;
  }

  return segments;
}

// ===== The adapter =====

/**
 * TelegramAdapter (D-13, spec §2.3.1): fetch-direct Bot API transport. The
 * token is decrypted per call from the connector row (never cached in module
 * state beyond the call — threat register boundary #3). Registered at module
 * load: `registry.isPlatformImplemented("telegram")` flips true, unblocking
 * the 198-01b create/validate/test 400s.
 */
export class TelegramAdapter implements PlatformAdapter {
  /**
   * The Bot API call core (RESEARCH "Telegram adapter fetch core"): POST to
   * `${TELEGRAM_API_URL}/bot<token>/<method>` with a JSON body; returns the
   * parsed { ok, result, description } envelope. NEVER logs the token
   * (method + ok/description only — T-198-10).
   */
  private async botApi(
    token: string,
    method: string,
    payload?: Record<string, unknown>
  ): Promise<BotApiResponse> {
    const base = telegramApiBaseOverride ?? getEnv().TELEGRAM_API_URL; // override wins (OQ-1 (b)); env is the air-gap lever
    const res = await fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    let parsed: BotApiResponse;
    try {
      parsed = (await res.json()) as BotApiResponse;
    } catch (err: unknown) {
      // Non-JSON body (proxy/error page): surface as a structured failure
      // without any body echo (could carry request material — T-198-10).
      throw new TelegramApiError(method, res.status, `non-JSON response (status ${res.status})`);
    }
    if (!parsed.ok) {
      // Bot API errors carry ok:false + description — the description text
      // is platform-generated (method-level), token-free by construction.
      throw new TelegramApiError(method, parsed.error_code ?? null, parsed.description ?? null);
    }
    return parsed;
  }

  /** Decrypt the bot token per call (never cached beyond the call). */
  private tokenOf(connector: { botTokenEncrypted?: string | null }): string {
    const enc = connector.botTokenEncrypted;
    if (!enc) {
      throw new TelegramApiError("token", null, "connector has no bot token configured");
    }
    return decrypt(enc);
  }

  /**
   * D-14: the decrypted config blob — carries the webhook secret (and
   * per-platform secrets in later phases). Parsed per call; never logged.
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

  // ─── D-18: webhook parse boundary ───────────────────────────────────

  /**
   * Parse an inbound webhook update into an IncomingMessage. Accepts ONLY
   * updates with a `message` field whose chat.type is "private" (D-18):
   * edited_message / channel_post / callback_query (any update without
   * `message`) → null. Group/supergroup/channel messages → null (silent
   * drop, D-18 — no row, no counter churn; the router's guard is a
   * belt-and-braces second layer). Non-text-only messages map text=null so
   * the router's politeness path fires (D-18).
   *
   * The secret header comparison is done UPSTREAM in the 198-01b route —
   * this method is payload-only.
   */
  parseIncomingWebhook(req: unknown): IncomingMessage | null {
    const update = req as TelegramUpdate | null;
    if (!update || typeof update !== "object") return null;
    const message = update.message;
    if (!message || typeof message !== "object") return null; // edited_message/channel_post/callback_query/etc.
    if (message.chat?.type !== "private") return null; // D-18 boundary

    const rawText = typeof message.text === "string" ? message.text : null;
    const isCommand =
      rawText !== null && rawText.startsWith("/")
        ? rawText.slice(1).split(/[\s@]/)[0] || undefined
        : undefined;

    // Media-present flag: the base IncomingMessage has no media field — a
    // null text on a message that carries media is what the router's D-18
    // politeness path keys on. Attachments are NOT processed in v1 (D-18).
    const hasMedia = message.photo !== undefined || message.voice !== undefined || message.document !== undefined;

    // CR-02: Telegram's message_id is unique PER CHAT, not per bot — two
    // different private-chat users each run their own low-starting id
    // sequence. The dedup arbiter is @@unique([connectorId, platformMessageId])
    // (D-11, schema-locked), so the chat identity is composed INTO the id
    // HERE at the adapter boundary: `${chatId}:${message_id}` is globally
    // unique per connector, cross-chat collisions vanish, and dedup within a
    // chat still works. Applies transitively to pollUpdates (it routes
    // through parseIncomingWebhook).
    return {
      platformMessageId: `${message.chat.id}:${message.message_id}`,
      platformUserId: String(message.from?.id ?? message.chat.id),
      platformUserName: message.from?.username ?? message.from?.first_name ?? undefined,
      text: rawText,
      chatType: "private",
      ...(isCommand !== undefined ? { isCommand } : {}),
      // mediaPresent is an adapter-level extension the router ignores —
      // informational (the dedup/limits ride platformMessageId).
      mediaPresent: hasMedia || undefined,
    } as IncomingMessage & { mediaPresent?: boolean };
  }

  // ─── D-15: long-poll getUpdates ─────────────────────────────────────

  /**
   * D-15: long-poll getUpdates with offset = connector.pollOffset (BigInt
   * passed through — no int32 truncation at the update-id horizon) and
   * timeout 25 (Telegram-side hold, seconds). Returns the parsed
   * private-chat messages with their raw update_id attached — the CALLER
   * (connectorPoller) advances pollOffset to maxUpdateId+1 and stamps
   * lastPollAt (D-01/D-15).
   *
   * WR-06: maxUpdateId is computed over ALL returned update_ids BEFORE the
   * private-filter — `allowed_updates: ["message"]` still delivers group/
   * supergroup/channel `message` updates, which parse to null and are
   * dropped from the batch; a group-only batch must still advance the
   * cursor or its updates are re-delivered every tick forever.
   *
   * The 409 "webhook is active" conflict (P-7) surfaces as a thrown
   * TelegramApiError — the poller's error-threshold health flip handles it
   * (no frantic retry loop).
   */
  async pollUpdates(
    connector: ConnectorPipelineRow & {
      pollOffset?: bigint;
      botTokenEncrypted?: string | null;
    }
  ): Promise<PollBatch> {
    const token = this.tokenOf(connector);
    const offset =
      typeof connector.pollOffset === "bigint"
        ? connector.pollOffset
        : typeof connector.pollOffset === "string"
          ? BigInt(connector.pollOffset)
          : 0n;
    const response = await this.botApi(token, "getUpdates", {
      offset: offset.toString(),
      timeout: 25,
      allowed_updates: ["message"],
    });
    const updates = (response.result ?? []) as TelegramUpdate[];
    const messages: PollBatch["messages"] = [];
    let maxUpdateId: PollBatch["maxUpdateId"] = null;
    for (const update of updates) {
      const updateId = BigInt(update.update_id);
      // Batch-wide max FIRST (WR-06) — the private-filter below must not
      // starve the cursor.
      if (maxUpdateId === null || updateId > maxUpdateId) {
        maxUpdateId = updateId;
      }
      const parsed = this.parseIncomingWebhook(update);
      if (parsed) {
        messages.push({ ...parsed, updateId });
      }
    }
    return { messages, maxUpdateId };
  }

  // ─── D-17: outbound send ────────────────────────────────────────────

  /**
   * D-17: convert markdown→HTML, split at 4000, send segments serially with
   * parse_mode "HTML". On a Telegram 400 "can't parse entities" retry ONCE
   * with parse_mode dropped (plain text — the fail-open; D-17). The LAST
   * message_id is the returned platformMessageId, composed with the chat id
   * (CR-02 — bot message ids share the chat sequence, so the bare id would
   * collide with the user's inbound ids on the dedup arbiter's
   * (connectorId, platformMessageId) key; D-11 out-rows must not collide).
   * Structured
   * error (method + status/description, no token) on other failures —
   * health mapping is upstream (D-20).
   */
  async sendMessage(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    platformUserId: string,
    text: string
  ): Promise<{ platformMessageId?: string }> {
    const token = this.tokenOf(connector);
    const html = markdownToTelegramHtml(text);
    const segments = splitMessage(text, 4000);
    let lastMessageId: string | undefined;

    for (const segment of segments) {
      // NOTE: each segment is converted INDEPENDENTLY (converter runs on the
      // full text only to validate; the per-segment HTML re-derives from the
      // raw segment so a split at a markdown boundary cannot produce
      // half-converted markup).
      const payload: Record<string, unknown> = {
        chat_id: platformUserId,
        text: markdownToTelegramHtml(segment),
      };
      // Only attach parse_mode when the segment carries markup the
      // converter actually produced; a plain segment sends as plain text
      // (fewer parse-error surfaces, D-17).
      const htmlSegment = payload.text as string;
      if (htmlSegment !== segment) {
        payload.parse_mode = "HTML";
      }

      try {
        const response = await this.botApi(token, "sendMessage", payload);
        const result = response.result as { message_id?: number } | undefined;
        if (result && typeof result.message_id === "number") {
          lastMessageId = `${platformUserId}:${result.message_id}`;
        }
      } catch (err: unknown) {
        // D-17 fail-open: a 400 "can't parse entities" retries ONCE with
        // parse_mode dropped (plain text) — an LLM formatting oddity never
        // loses the answer.
        if (err instanceof TelegramApiError && err.status === 400 && err.description?.includes("can't parse entities")) {
          const plain = await this.botApi(token, "sendMessage", {
            chat_id: platformUserId,
            text: segment,
          });
          const result = plain.result as { message_id?: number } | undefined;
          if (result && typeof result.message_id === "number") {
            lastMessageId = `${platformUserId}:${result.message_id}`;
          }
        } else {
          throw err;
        }
      }
    }

    return { platformMessageId: lastMessageId };
  }

  // ─── D-19: typing indicator ─────────────────────────────────────────

  /**
   * D-19: the sendChatAction "typing" primitive (5s Telegram-side TTL). The
   * single-shot pre-run send + at-most-one mid-run re-send are orchestrated
   * by the messageRouter's D-19 typing coordinator (198-02 Task 2 — owning
   * task); this method is the primitive that coordinator invokes.
   */
  async sendTypingIndicator(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    platformUserId: string
  ): Promise<void> {
    const token = this.tokenOf(connector);
    await this.botApi(token, "sendChatAction", { chat_id: platformUserId, action: "typing" });
  }

  // ─── D-13: token validation + bot identity ──────────────────────────

  /**
   * D-05: validate a SUBMITTED token without persisting it — getMe against
   * the platform. Maps username WITHOUT the @ and the display name.
   */
  async validateBotToken(
    token: string
  ): Promise<{ valid: boolean; botUsername?: string | null; botDisplayName?: string | null }> {
    try {
      const response = await this.botApi(token, "getMe", {});
      const result = response.result as { username?: string; first_name?: string } | undefined;
      if (!result) return { valid: false };
      return {
        valid: true,
        botUsername: (result.username ?? "").replace(/^@/, "") || null,
        botDisplayName: result.first_name ?? null,
      };
    } catch (err: unknown) {
      if (err instanceof TelegramApiError) {
        return { valid: false };
      }
      throw err;
    }
  }

  /** D-13: bot identity for the STORED token (persisted at validate time). */
  async getBotInfo(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null }
  ): Promise<{ botUsername?: string | null; botDisplayName?: string | null }> {
    const token = this.tokenOf(connector);
    const response = await this.botApi(token, "getMe", {});
    const result = response.result as { username?: string; first_name?: string } | undefined;
    return {
      botUsername: (result?.username ?? "").replace(/^@/, "") || null,
      botDisplayName: result?.first_name ?? null,
    };
  }

  // ─── D-14/D-15: webhook lifecycle ───────────────────────────────────

  /** D-14: setWebhook with the secret_token param + allowed_updates message-only. */
  async setWebhook(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null },
    url: string,
    secret: string
  ): Promise<void> {
    const token = this.tokenOf(connector);
    await this.botApi(token, "setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message"],
    });
  }

  /** D-15: deleteWebhook — mode switch (webhook→polling) + best-effort delete arm. */
  async removeWebhook(
    connector: ConnectorPipelineRow & { botTokenEncrypted?: string | null }
  ): Promise<void> {
    const token = this.tokenOf(connector);
    await this.botApi(token, "deleteWebhook", {});
  }
}

// ===== Registry registration (module load, D-13) =====

// The 198-01b create/validate/test routes' 400 "Platform not implemented yet"
// flips to the adapter-driven paths automatically once THIS import runs.
registerAdapter("telegram", new TelegramAdapter());