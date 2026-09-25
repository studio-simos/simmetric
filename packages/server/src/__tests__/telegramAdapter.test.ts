// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-03 Task 1, D-13/D-14/D-16/D-18) — TelegramAdapter tests.
 * Postgres-free: globalThis.fetch stubbed per the dlpDocumentMasking
 * pattern (NETWORK_EGRESS_BLOCKED discipline — no test may touch the
 * network); prisma mocked; encryptionService REAL (roundtrip via encrypt —
 * the same real-crypto pattern connectorEncryption.test.ts pins).
 */
// @ts-nocheck
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: (createMockPrisma().prisma as unknown), withSoftDelete: (w: unknown) => w };
});

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import crypto from "crypto";
import { logger } from "../utils/logger";
import { encrypt } from "../services/encryptionService";
import {
  TelegramAdapter,
  TelegramApiError,
  generateWebhookSecret,
  markdownToTelegramHtml,
  splitMessage,
} from "../services/connectors/telegram";
import { getAdapter, isPlatformImplemented } from "../services/connectors/registry";
import type { ConnectorPipelineRow } from "../services/connectors/base";

const BOT_TOKEN = "123456:TEST-TOKEN-not-a-real-token";

function connectorRow(overrides: Record<string, unknown> = {}): ConnectorPipelineRow & Record<string, unknown> {
  return {
    id: "550e8400-e29b-41d4-a716-4466554400b1",
    platform: "telegram",
    organizationId: "org-198",
    workspaceId: "550e8400-e29b-41d4-a716-4466554400b2",
    archiveId: null,
    responseProviderId: null,
    responseModel: null,
    welcomeMessage: null,
    fallbackMessage: null,
    fallbackLocale: "en",
    rateLimitPerMinute: null,
    sessionLimitPerDay: null,
    healthStatus: "unknown",
    lastError: null,
    botTokenEncrypted: encrypt(BOT_TOKEN),
    configEncrypted: null,
    pollOffset: 0n,
    ...overrides,
  };
}

// ─── fetch stub (globalThis.fetch per dlpDocumentMasking pattern) ─────

interface RecordedCall {
  url: string;
  init: RequestInit;
}

const fetchCalls: RecordedCall[] = [];
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify({ ok: true, result: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchCalls.length = 0;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Queue a Bot API response for the next fetch call. */
function queueBotResponse(body: Record<string, unknown>, status = 200): void {
  mockFetch.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function lastCall(): RecordedCall {
  return fetchCalls[fetchCalls.length - 1];
}

function privateMessageUpdate(overrides: Record<string, unknown> = {}, messageOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 42,
    ...overrides,
    message: {
      message_id: 101,
      from: { id: 555000111, first_name: "Alice", username: "alice_w" },
      chat: { id: 555000111, type: "private" },
      text: "Hello bot",
      ...messageOverrides,
    },
  };
}

// ─── D-13: transport shape ─────────────────────────────────────────────

describe("botApi transport (D-13)", () => {
  it("posts to ${TELEGRAM_API_URL}/bot<token>/<method> via global fetch with a JSON body", async () => {
    const adapter = new TelegramAdapter();
    await adapter.sendMessage(connectorRow(), "555000111", "plain reply");

    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const call of fetchCalls) {
      expect(call.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
      expect(call.init.method).toBe("POST");
      expect((call.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    }
  });

  it("reads the base URL from getEnv().TELEGRAM_API_URL — no SDK import, fetch-direct only", async () => {
    const adapter = new TelegramAdapter();
    await adapter.sendTypingIndicator(connectorRow(), "555000111");

    expect(lastCall().url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`);
    const body = JSON.parse(lastCall().init.body as string);
    expect(body.action).toBe("typing");
    expect(body.chat_id).toBe("555000111");
  });

  it("NEVER logs the token — logger calls carry method/ok/description only (T-198-10)", async () => {
    const adapter = new TelegramAdapter();
    await adapter.sendMessage(connectorRow(), "555000111", "reply");

    const allLogArgs = JSON.stringify(
      (logger.warn as jest.Mock).mock.calls.concat((logger.error as jest.Mock).mock.calls)
    );
    expect(allLogArgs).not.toContain(BOT_TOKEN);
  });

  it("throws a structured TelegramApiError on ok:false — token never in the error text", async () => {
    queueBotResponse({ ok: false, error_code: 401, description: "Unauthorized: invalid token" });

    const adapter = new TelegramAdapter();
    await expect(adapter.sendTypingIndicator(connectorRow(), "555000111")).rejects.toMatchObject({
      method: "sendChatAction",
      status: 401,
    });

    try {
      await adapter.sendTypingIndicator(connectorRow(), "555000111");
    } catch (err) {
      expect((err as TelegramApiError).message).not.toContain(BOT_TOKEN);
      expect(String(err)).not.toContain(BOT_TOKEN);
    }
  });

  it("decrypts the token per call via encryptionService (encrypted roundtrip)", async () => {
    const row = connectorRow({ botTokenEncrypted: encrypt(BOT_TOKEN) });
    const adapter = new TelegramAdapter();
    await adapter.getBotInfo(row);

    expect(lastCall().url).toContain(`/bot${BOT_TOKEN}/getMe`);
    // The encrypted column itself never appears in the URL.
    expect(lastCall().url).not.toContain(row.botTokenEncrypted);
  });
});

// ─── D-18: webhook parse boundary ──────────────────────────────────────

describe("parseIncomingWebhook (D-18)", () => {
  const adapter = new TelegramAdapter();

  it("accepts a private text message and maps all fields", () => {
    const msg = adapter.parseIncomingWebhook(privateMessageUpdate());
    expect(msg).toMatchObject({
      // CR-02: chat-scoped composite id (`${chatId}:${message_id}`) — the
      // dedup arbiter is per connector, so the bare per-chat id would
      // collide across different platform users.
      platformMessageId: "555000111:101",
      platformUserId: "555000111",
      platformUserName: "alice_w",
      text: "Hello bot",
      chatType: "private",
    });
  });

  it("maps a /start command to isCommand 'start'", () => {
    const msg = adapter.parseIncomingWebhook(privateMessageUpdate({}, { text: "/start" }));
    expect(msg?.isCommand).toBe("start");
  });

  it("maps a plain non-command text with NO isCommand field", () => {
    const msg = adapter.parseIncomingWebhook(privateMessageUpdate({}, { text: "just text" }));
    expect(msg?.isCommand).toBeUndefined();
  });

  it("returns null for edited_message (D-18: update without `message`)", () => {
    expect(
      adapter.parseIncomingWebhook({
        update_id: 2,
        edited_message: privateMessageUpdate().message,
      })
    ).toBeNull();
  });

  it("returns null for channel_post and callback_query updates", () => {
    expect(adapter.parseIncomingWebhook({ update_id: 3, channel_post: { message_id: 1 } })).toBeNull();
    expect(adapter.parseIncomingWebhook({ update_id: 4, callback_query: { id: "cb" } })).toBeNull();
  });

  it.each(["group", "supergroup", "channel"] as const)(
    "returns null for chat.type %s (D-18 boundary)",
    (chatType) => {
      const msg = adapter.parseIncomingWebhook(
        privateMessageUpdate({}, { chat: { id: -100123, type: chatType } })
      );
      expect(msg).toBeNull();
    }
  );

  it("photo-only (no text) → text null + mediaPresent flag (router politeness path)", () => {
    const msg = adapter.parseIncomingWebhook(
      privateMessageUpdate({}, { photo: [{ file_id: "f1" }], text: undefined })
    );
    expect(msg).not.toBeNull();
    expect(msg?.text).toBeNull();
    expect((msg as unknown as Record<string, unknown>).mediaPresent).toBe(true);
  });
});

// ─── D-15: long-poll getUpdates ────────────────────────────────────────

describe("pollUpdates (D-15)", () => {
  it("calls getUpdates with offset = pollOffset (BigInt), timeout 25, allowed_updates message-only", async () => {
    queueBotResponse({ ok: true, result: [] });

    const adapter = new TelegramAdapter();
    await adapter.pollUpdates(connectorRow({ pollOffset: 5000000000n }));

    expect(lastCall().url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    const body = JSON.parse(lastCall().init.body as string);
    expect(body.offset).toBe("5000000000"); // BigInt beyond int32 horizon — no truncation
    expect(body.timeout).toBe(25);
    expect(body.allowed_updates).toEqual(["message"]);
  });

  it("maps private-chat updates to IncomingMessages with their raw update_id attached", async () => {
    queueBotResponse({
      ok: true,
      result: [
        privateMessageUpdate({ update_id: 42 }),
        privateMessageUpdate({
          update_id: 43,
          message: { message_id: 102, from: { id: 999, first_name: "Bob" }, chat: { id: 999, type: "private" }, text: "second" },
        }),
      ],
    });

    const adapter = new TelegramAdapter();
    const batch = await adapter.pollUpdates(connectorRow({ pollOffset: 0n }));

    expect(batch.messages).toHaveLength(2);
    expect(batch.messages[0]).toMatchObject({ text: "Hello bot", platformMessageId: "555000111:101" });
    expect(batch.messages[0].updateId).toBe(42n);
    expect(batch.messages[1].updateId).toBe(43n);
    expect(batch.maxUpdateId).toBe(43n);
  });

  it("composes the platformMessageId per chat — two users with the SAME per-chat id do not collide (CR-02)", async () => {
    queueBotResponse({
      ok: true,
      result: [
        privateMessageUpdate({ update_id: 50 }),
        privateMessageUpdate(
          { update_id: 51 },
          { from: { id: 999, first_name: "Bob" }, chat: { id: 999, type: "private" }, text: "bob first" }
        ),
      ],
    });

    const adapter = new TelegramAdapter();
    const batch = await adapter.pollUpdates(connectorRow({ pollOffset: 0n }));

    // Alice and Bob both have per-chat id 101 — the composite ids differ.
    expect(batch.messages[0].platformMessageId).toBe("555000111:101");
    expect(batch.messages[1].platformMessageId).toBe("999:101");
  });

  it("GROUP-ONLY batch still reports the batch-wide maxUpdateId (WR-06 stall pin)", async () => {
    queueBotResponse({
      ok: true,
      result: [
        { update_id: 60, message: { message_id: 110, chat: { id: -100, type: "group" }, text: "chatter 1" } },
        { update_id: 61, message: { message_id: 111, chat: { id: -100, type: "supergroup" }, text: "chatter 2" } },
        { update_id: 62, edited_message: { message_id: 112, chat: { id: 555000111, type: "private" }, text: "edit" } },
      ],
    });

    const adapter = new TelegramAdapter();
    const batch = await adapter.pollUpdates(connectorRow({ pollOffset: 0n }));

    // No private message survived the filter — but the cursor max covers
    // ALL update_ids, so the poller can advance past the group traffic.
    expect(batch.messages).toHaveLength(0);
    expect(batch.maxUpdateId).toBe(62n);
  });

  it("drops non-private updates from the batch (group messages never reach the caller, D-18)", async () => {
    queueBotResponse({
      ok: true,
      result: [
        privateMessageUpdate(),
        { update_id: 44, message: { message_id: 103, chat: { id: -100, type: "group" }, text: "group msg" } },
        { update_id: 45, edited_message: { message_id: 104, chat: { id: 555000111, type: "private" }, text: "edit" } },
      ],
    });

    const adapter = new TelegramAdapter();
    const batch = await adapter.pollUpdates(connectorRow({ pollOffset: 0n }));

    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0].platformMessageId).toBe("555000111:101");
  });
});

// ─── D-17: outbound send (split + fail-open) ───────────────────────────

describe("sendMessage (D-17)", () => {
  it("sends a short message as ONE sendMessage call", async () => {
    queueBotResponse({ ok: true, result: { message_id: 900 } });

    const adapter = new TelegramAdapter();
    const sent = await adapter.sendMessage(connectorRow(), "555000111", "hello");

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(lastCall().init.body as string);
    expect(body.chat_id).toBe("555000111");
    expect(body.text).toBe("hello");
    // CR-02: the outbound id is chat-scoped too (shares the chat sequence
    // with inbound ids — the bare id would collide on the dedup key).
    expect(sent.platformMessageId).toBe("555000111:900");
  });

  it("converts markdown to HTML and attaches parse_mode only when markup is present", async () => {
    queueBotResponse({ ok: true, result: { message_id: 901 } });

    const adapter = new TelegramAdapter();
    await adapter.sendMessage(connectorRow(), "555000111", "**bold** and plain");

    const body = JSON.parse(lastCall().init.body as string);
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toBe("<b>bold</b> and plain");
  });

  it("sends plain text WITHOUT parse_mode when the segment has no markup", async () => {
    queueBotResponse({ ok: true, result: { message_id: 902 } });

    const adapter = new TelegramAdapter();
    await adapter.sendMessage(connectorRow(), "555000111", "no markup here");

    const body = JSON.parse(lastCall().init.body as string);
    expect(body.parse_mode).toBeUndefined();
  });

  it("a 4500-char reply splits into 2 serial sendMessage calls", async () => {
    queueBotResponse({ ok: true, result: { message_id: 903 } });
    queueBotResponse({ ok: true, result: { message_id: 904 } });

    const adapter = new TelegramAdapter();
    const text = "x".repeat(4500);
    const sent = await adapter.sendMessage(connectorRow(), "555000111", text);

    expect(fetchCalls).toHaveLength(2);
    expect(sent.platformMessageId).toBe("555000111:904"); // LAST message_id (D-11), chat-scoped (CR-02)
  });

  it("a 9000-char reply splits into 3 serial sendMessage calls", async () => {
    for (let i = 0; i < 3; i++) queueBotResponse({ ok: true, result: { message_id: 910 + i } });

    const adapter = new TelegramAdapter();
    await adapter.sendMessage(connectorRow(), "555000111", "y".repeat(9000));

    expect(fetchCalls).toHaveLength(3);
  });

  it("a 'can't parse entities' 400 triggers EXACTLY ONE plain-text retry (fail-open, D-17)", async () => {
    // First attempt (HTML) → 400 parse error; retry (plain) → ok.
    queueBotResponse({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
    queueBotResponse({ ok: true, result: { message_id: 920 } });

    const adapter = new TelegramAdapter();
    const sent = await adapter.sendMessage(connectorRow(), "555000111", "**weird** <markup>");

    expect(fetchCalls).toHaveLength(2);
    const first = JSON.parse(fetchCalls[0].init.body as string);
    const retry = JSON.parse(fetchCalls[1].init.body as string);
    expect(first.parse_mode).toBe("HTML");
    expect(retry.parse_mode).toBeUndefined(); // parse_mode DROPPED on retry
    expect(retry.text).toBe("**weird** <markup>"); // raw segment, plain
    expect(sent.platformMessageId).toBe("555000111:920");
  });

  it("a non-parse 400 does NOT retry — the structured error propagates (health mapping upstream)", async () => {
    queueBotResponse({ ok: false, error_code: 400, description: "Bad Request: chat not found" });

    const adapter = new TelegramAdapter();
    await expect(adapter.sendMessage(connectorRow(), "555000111", "hello")).rejects.toMatchObject({
      method: "sendMessage",
      description: "Bad Request: chat not found",
    });
    expect(fetchCalls).toHaveLength(1);
  });

  it("the error text never carries the token (T-198-10 backstop)", async () => {
    queueBotResponse({ ok: false, error_code: 404, description: "Not Found" });

    const adapter = new TelegramAdapter();
    try {
      await adapter.sendMessage(connectorRow(), "555000111", "hello");
    } catch (err) {
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }
  });
});

// ─── D-13: token validation + webhook lifecycle ────────────────────────

describe("validateBotToken / getBotInfo (D-13/D-05)", () => {
  it("getMe maps the username WITHOUT the @ and the display name", async () => {
    queueBotResponse({ ok: true, result: { id: 1, username: "@my_bot", first_name: "My Bot" } });

    const adapter = new TelegramAdapter();
    const result = await adapter.validateBotToken(BOT_TOKEN);

    expect(result).toEqual({ valid: true, botUsername: "my_bot", botDisplayName: "My Bot" });
    expect(lastCall().url).toContain("/getMe");
  });

  it("an invalid token (ok:false) → { valid: false } without throwing", async () => {
    queueBotResponse({ ok: false, error_code: 401, description: "Unauthorized" });

    const adapter = new TelegramAdapter();
    const result = await adapter.validateBotToken("bad-token");

    expect(result).toEqual({ valid: false });
  });

  it("getBotInfo uses the STORED (decrypted) token", async () => {
    queueBotResponse({ ok: true, result: { id: 1, username: "stored_bot", first_name: "Stored" } });

    const adapter = new TelegramAdapter();
    const info = await adapter.getBotInfo(connectorRow());

    expect(lastCall().url).toContain(`/bot${BOT_TOKEN}/getMe`);
    expect(info.botUsername).toBe("stored_bot");
  });
});

describe("setWebhook / removeWebhook (D-14/D-15)", () => {
  it("setWebhook payload carries url + secret_token + allowed_updates message-only", async () => {
    queueBotResponse({ ok: true, result: true });

    const adapter = new TelegramAdapter();
    await adapter.setWebhook(connectorRow(), "https://example.com/api/connectors/telegram/x/webhook", "s3cret");

    const body = JSON.parse(lastCall().init.body as string);
    expect(body).toEqual({
      url: "https://example.com/api/connectors/telegram/x/webhook",
      secret_token: "s3cret",
      allowed_updates: ["message"],
    });
    expect(lastCall().url).toContain("/setWebhook");
  });

  it("removeWebhook calls deleteWebhook with an empty payload", async () => {
    queueBotResponse({ ok: true, result: true });

    const adapter = new TelegramAdapter();
    await adapter.removeWebhook(connectorRow());

    expect(lastCall().url).toContain("/deleteWebhook");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({});
  });
});

// ─── D-14: secret generation ───────────────────────────────────────────

describe("generateWebhookSecret (D-14)", () => {
  it("generates a 48-char [A-Za-z0-9_-] secret", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{48}$/);
  });

  it("generates unique secrets across calls", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });
});

// ─── Registry registration (module load) ───────────────────────────────

describe("registry registration", () => {
  it("telegram is registered at module load — isPlatformImplemented flips true", () => {
    expect(isPlatformImplemented("telegram")).toBe(true);
    expect(getAdapter("telegram")).toBeInstanceOf(TelegramAdapter);
  });
});

// ─── Formatter unit pins (shared surface with telegramFormatter.test.ts) ─

describe("markdownToTelegramHtml / splitMessage (spot pins — full coverage in telegramFormatter.test.ts)", () => {
  it("escapes literal < and & outside supported tags (P-8)", () => {
    const html = markdownToTelegramHtml("a < b & c");
    expect(html).toBe("a &lt; b &amp; c");
  });

  it("splitMessage returns 3 segments for a 9000-char boundary-less text", () => {
    const segments = splitMessage("z".repeat(9000));
    expect(segments).toHaveLength(3);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(4000);
    expect(segments.join("").length).toBeGreaterThanOrEqual(9000);
  });
});