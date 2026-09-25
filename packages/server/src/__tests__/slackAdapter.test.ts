// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 200 (200-01 Task 1, D-01/D-04/D-10) — SlackAdapter tests.
 * Postgres-free: globalThis.fetch stubbed per the telegramAdapter.test.ts
 * pattern (NETWORK_EGRESS_BLOCKED discipline); prisma mocked;
 * encryptionService REAL (roundtrip via encrypt).
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

import { encrypt } from "../services/encryptionService";
import {
  SlackAdapter,
  SlackApiError,
  mdToMrkdwn,
  setSlackApiBaseOverride,
  getSlackApiBaseOverride,
} from "../services/connectors/slack";
import { splitMessage } from "../services/connectors/telegram";
import { getAdapter, isPlatformImplemented } from "../services/connectors/registry";
import type { ConnectorPipelineRow } from "../services/connectors/base";

const BOT_TOKEN = "xoxb-unit-test-token-not-a-real-token";

function connectorRow(overrides: Record<string, unknown> = {}): ConnectorPipelineRow & Record<string, unknown> {
  return {
    id: "550e8400-e29b-41d4-a716-4466554400c1",
    platform: "slack",
    organizationId: "org-200",
    workspaceId: "550e8400-e29b-41d4-a716-4466554400c2",
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

// ─── fetch stub (globalThis.fetch — telegram adapter test pattern) ─────

interface RecordedCall {
  url: string;
  init: RequestInit;
}

const fetchCalls: RecordedCall[] = [];
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchCalls.length = 0;
  setSlackApiBaseOverride(null);
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Queue a Web API response for the next fetch call. */
function queueSlackResponse(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {}
): void {
  mockFetch.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  });
}

function lastCall(): RecordedCall {
  return fetchCalls[fetchCalls.length - 1];
}

/** A well-formed inbound DM envelope. */
function dmEnvelope(overrides: Record<string, unknown> = {}, eventOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "event_callback",
    token: "deprecated-ignored",
    team_id: "T123",
    event_id: "Ev0PV52K21",
    event_time: 1355517523,
    ...overrides,
    event: {
      type: "message",
      channel: "D024BE91L",
      user: "U2147483697",
      text: "Hello hello can you hear me?",
      ts: "1355517523.000005",
      channel_type: "im",
      ...eventOverrides,
    },
  };
}

// ─── D-01: module-load registration ────────────────────────────────────

describe("registration (module load)", () => {
  it("registerAdapter('slack') ran at module load — isPlatformImplemented flips true", () => {
    expect(isPlatformImplemented("slack")).toBe(true);
    expect(getAdapter("slack")).toBeInstanceOf(SlackAdapter);
  });
});

// ─── D-01/D-04: parse boundary ─────────────────────────────────────────

describe("parseIncomingWebhook (D-01/D-04/D-18/P4)", () => {
  const adapter = new SlackAdapter();

  it("maps an im message envelope → IncomingMessage (event_id, channel, user)", () => {
    const msg = adapter.parseIncomingWebhook(dmEnvelope());
    expect(msg).toMatchObject({
      platformMessageId: "Ev0PV52K21",
      platformUserId: "D024BE91L",
      platformUserName: "U2147483697",
      text: "Hello hello can you hear me?",
      chatType: "private",
    });
  });

  it("platformMessageId derives from event_id, NEVER event.ts (D-04 — distinct fixture pins the choice)", () => {
    const envelope = dmEnvelope(
      { event_id: "EvDISTINCT-ID" },
      { ts: "1355517523.000005" }
    );
    const msg = adapter.parseIncomingWebhook(envelope);
    expect(msg!.platformMessageId).toBe("EvDISTINCT-ID");
    expect(msg!.platformMessageId).not.toBe("1355517523.000005");
  });

  it("drops url_verification envelopes (route layer answers the challenge — D-01)", () => {
    expect(
      adapter.parseIncomingWebhook({ type: "url_verification", challenge: "abc" })
    ).toBeNull();
  });

  it("drops non-message inner event types (app_rate_limited etc.)", () => {
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { type: "app_rate_limited" }))
    ).toBeNull();
  });

  it("drops non-im channel_type (channel/group/mpim — D-18 silent drop)", () => {
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { channel_type: "channel" }))
    ).toBeNull();
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { channel_type: "group" }))
    ).toBeNull();
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { channel_type: "mpim" }))
    ).toBeNull();
  });

  it("drops bot_id-carrying events (P4 echo guard)", () => {
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { bot_id: "BZYBOTHED" }))
    ).toBeNull();
  });

  it("drops subtype-carrying events (message_changed/message_deleted/bot_message)", () => {
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { subtype: "message_changed" }))
    ).toBeNull();
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { subtype: "bot_message" }))
    ).toBeNull();
  });

  it("drops bot-user echoes when the config blob carries botUserId (P4)", () => {
    const row = connectorRow({
      configEncrypted: encrypt(JSON.stringify({ botUserId: "U0KRQLJ9H" })),
    });
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { user: "U0KRQLJ9H" }), row)
    ).toBeNull();
  });

  it("skips the bot-user guard when the config blob has no botUserId (other guards still active)", () => {
    const row = connectorRow({ configEncrypted: null });
    expect(
      adapter.parseIncomingWebhook(dmEnvelope({}, { user: "U0KRQLJ9H" }), row)
    ).toMatchObject({ platformUserId: "D024BE91L" });
  });

  it("maps a non-text im message to text null (politeness fallback downstream)", () => {
    const msg = adapter.parseIncomingWebhook(dmEnvelope({}, { text: undefined }));
    expect(msg).toMatchObject({ platformMessageId: "Ev0PV52K21", text: null });
  });

  it("rejects a malformed envelope (null / non-object / missing event)", () => {
    expect(adapter.parseIncomingWebhook(null)).toBeNull();
    expect(adapter.parseIncomingWebhook("string")).toBeNull();
    expect(adapter.parseIncomingWebhook({})).toBeNull();
    expect(adapter.parseIncomingWebhook({ type: "event_callback" })).toBeNull();
  });
});

// ─── D-10: outbound send ───────────────────────────────────────────────

describe("sendMessage (D-10)", () => {
  it("posts chat.postMessage with Bearer + channel + converted text (override seam → stubbed fetch)", async () => {
    setSlackApiBaseOverride("http://127.0.0.1:45999");
    queueSlackResponse({ ok: true, message: { ts: "1750000000.000100" } });

    const adapter = new SlackAdapter();
    const result = await adapter.sendMessage(connectorRow(), "D024BE91L", "**bold** reply");

    expect(result).toEqual({ platformMessageId: "1750000000.000100" });
    expect(fetchCalls).toHaveLength(1);
    expect(lastCall().url).toBe("http://127.0.0.1:45999/chat.postMessage");
    expect((lastCall().init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${BOT_TOKEN}`);
    const sentBody = JSON.parse(String(lastCall().init.body));
    expect(sentBody.channel).toBe("D024BE91L");
    expect(sentBody.text).toBe("*bold* reply");
    expect(sentBody.parse_mode).toBeUndefined(); // NO parse_mode field exists in the Slack API
  });

  it("ok:false → SlackApiError EVEN at HTTP 200 (P2 inverted trigger)", async () => {
    queueSlackResponse({ ok: false, error: "channel_not_found" }, 200);

    const adapter = new SlackAdapter();
    await expect(adapter.sendMessage(connectorRow(), "D024BE91L", "hi")).rejects.toMatchObject({
      name: "SlackApiError",
      description: "channel_not_found",
    });
  });

  it("non-JSON body → structured failure with NO body echo (T-200-06)", async () => {
    mockFetch.mockImplementationOnce(async () => new Response("<html>gateway error</html>", { status: 502 }));

    const adapter = new SlackAdapter();
    await expect(adapter.sendMessage(connectorRow(), "D024BE91L", "hi")).rejects.toMatchObject({
      name: "SlackApiError",
      status: 502,
    });
  });

  it("ratelimited + Retry-After honored with bounded retries, then SlackApiError (D-10)", async () => {
    // 3 responses: ratelimited ×3 → 2 retries exhausted → throw. A tiny
    // Retry-After keeps the test fast (bounded wait = min(1s, 15s) — the
    // total suite impact is ~2s for this test).
    queueSlackResponse({ ok: false, error: "ratelimited" }, 200, { "Retry-After": "1" });
    queueSlackResponse({ ok: false, error: "ratelimited" }, 200, { "Retry-After": "1" });
    queueSlackResponse({ ok: false, error: "ratelimited" }, 200, { "Retry-After": "1" });

    const adapter = new SlackAdapter();
    await expect(adapter.sendMessage(connectorRow(), "D024BE91L", "hi")).rejects.toMatchObject({
      name: "SlackApiError",
      description: "ratelimited",
    });
    // 1 original + 2 retries = 3 calls (bounded, never a hot loop).
    expect(fetchCalls).toHaveLength(3);
  });

  it("ratelimited arm RECOVERS when a retry succeeds (segment sent, no throw)", async () => {
    queueSlackResponse({ ok: false, error: "ratelimited" }, 200, { "Retry-After": "1" });
    queueSlackResponse({ ok: true, message: { ts: "1750000000.000200" } });

    const adapter = new SlackAdapter();
    const result = await adapter.sendMessage(connectorRow(), "D024BE91L", "hi");
    expect(result).toEqual({ platformMessageId: "1750000000.000200" });
    expect(fetchCalls).toHaveLength(2);
  });

  it("a non-ratelimited error during the retry arm is terminal for the segment (no retry)", async () => {
    queueSlackResponse({ ok: false, error: "ratelimited" }, 200, { "Retry-After": "1" });
    queueSlackResponse({ ok: false, error: "channel_not_found" }, 200);

    const adapter = new SlackAdapter();
    await expect(adapter.sendMessage(connectorRow(), "D024BE91L", "hi")).rejects.toMatchObject({
      description: "channel_not_found",
    });
    expect(fetchCalls).toHaveLength(2);
  });

  it("splits at 39000 on fence-safe boundaries and sends segments serially", async () => {
    setSlackApiBaseOverride("http://127.0.0.1:45999");
    queueSlackResponse({ ok: true, message: { ts: "1750000000.000300" } });
    queueSlackResponse({ ok: true, message: { ts: "1750000000.000301" } });

    const adapter = new SlackAdapter();
    // 2 segments: the first fills to a paragraph boundary past 39000.
    const longText = "a".repeat(20000) + "\n\n" + "b".repeat(20000);
    const segments = splitMessage(longText, 39000);
    expect(segments.length).toBe(2);

    const result = await adapter.sendMessage(connectorRow(), "D024BE91L", longText);
    expect(result.platformMessageId).toBe("1750000000.000301");
    expect(fetchCalls).toHaveLength(2);
    expect(JSON.parse(String(fetchCalls[0].init.body)).text.length).toBeLessThanOrEqual(39000);
    expect(JSON.parse(String(fetchCalls[1].init.body)).text.length).toBeLessThanOrEqual(39000);
  });
});

// ─── D-10: mdToMrkdwn converter ────────────────────────────────────────

describe("mdToMrkdwn (D-10)", () => {
  it("converts **x** → *x*", () => {
    expect(mdToMrkdwn("**hello** world")).toBe("*hello* world");
  });

  it("converts __x__ → _x_", () => {
    expect(mdToMrkdwn("some __emphasis__ here")).toBe("some _emphasis_ here");
  });

  it("single *x* and _x_ pass through unchanged (no double-conversion)", () => {
    expect(mdToMrkdwn("*already* mrkdwn")).toBe("*already* mrkdwn");
    expect(mdToMrkdwn("_already_ mrkdwn")).toBe("_already_ mrkdwn");
  });

  it("bold wins over italic when markers nest (** consumed first)", () => {
    expect(mdToMrkdwn("**bold** and __italic__")).toBe("*bold* and _italic_");
  });

  it("inline code and fenced blocks pass through verbatim", () => {
    expect(mdToMrkdwn("run `npm test` now")).toBe("run `npm test` now");
    const fenced = "before\n```\nconst x = 1;\n```\nafter";
    expect(mdToMrkdwn(fenced)).toBe(fenced);
  });

  it("converts [text](url) → <url|text>", () => {
    expect(mdToMrkdwn("see [docs](https://example.com/x) now")).toBe(
      "see <https://example.com/x|docs> now"
    );
  });

  it("mixed markup converts everything at once", () => {
    expect(mdToMrkdwn("**b** __i__ `c` [l](https://e.com)")).toBe("*b* _i_ `c` <https://e.com|l>");
  });

  it("plain text is returned unchanged", () => {
    expect(mdToMrkdwn("no markup here")).toBe("no markup here");
  });
});

// ─── D-10: 39000 split (imported splitter — no copy) ───────────────────

describe("splitMessage(text, 39000) (D-10)", () => {
  it("every segment ≤ 39000 (paragraph-boundary long text)", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(120)}`).join("\n\n");
    const segments = splitMessage(text, 39000);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      expect(seg.length).toBeLessThanOrEqual(39000);
    }
  });

  it("a mid-fence hard split re-emits the opening fence — no segment starts mid-fence (fence-safe)", () => {
    const fenced = "```\n" + "x".repeat(80000) + "\n```";
    const segments = splitMessage(fenced, 39000);
    // The splitter's pendingReopen contract: any segment after a mid-fence
    // cut starts with the re-emitted fence; the FIRST segment legitimately
    // starts with the original fence. Pinning the shape the adapter relies
    // on (the telegram suite pins the full boundary logic — this is the
    // adapter-side 39000 limit pin).
    for (const seg of segments) {
      expect(seg.length).toBeLessThanOrEqual(39000);
    }
    expect(segments[0].startsWith("```")).toBe(true);
  });
});

// ─── D-02: token validation ────────────────────────────────────────────

describe("validateBotToken / getBotInfo (D-02)", () => {
  it("valid token → { valid: true, botUsername: user, botDisplayName: user }", async () => {
    queueSlackResponse({ ok: true, user: "simmetric_bot", team: "T1" });

    const adapter = new SlackAdapter();
    const result = await adapter.validateBotToken(BOT_TOKEN);
    expect(result).toEqual({ valid: true, botUsername: "simmetric_bot", botDisplayName: "simmetric_bot" });
    expect(lastCall().url).toContain("/auth.test");
    expect((lastCall().init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${BOT_TOKEN}`);
  });

  it("ok:false (invalid_auth) → { valid: false } without throwing (P2 envelope discipline)", async () => {
    queueSlackResponse({ ok: false, error: "invalid_auth" }, 200);

    const adapter = new SlackAdapter();
    const result = await adapter.validateBotToken("xoxb-wrong");
    expect(result.valid).toBe(false);
  });

  it("getBotInfo probes the STORED (decrypted) token", async () => {
    queueSlackResponse({ ok: true, user: "simmetric_bot" });

    const adapter = new SlackAdapter();
    const result = await adapter.getBotInfo(connectorRow());
    expect(result).toEqual({ botUsername: "simmetric_bot", botDisplayName: "simmetric_bot" });
  });

  it("a tokenless row throws the structured error (never a raw decrypt failure)", async () => {
    const adapter = new SlackAdapter();
    await expect(adapter.getBotInfo(connectorRow({ botTokenEncrypted: null }))).rejects.toBeInstanceOf(
      SlackApiError
    );
  });
});

// ─── D-01: no-op lifecycle ─────────────────────────────────────────────

describe("no-op lifecycle (D-01)", () => {
  it("sendTypingIndicator resolves without any platform call", async () => {
    const adapter = new SlackAdapter();
    await expect(adapter.sendTypingIndicator(connectorRow(), "D1")).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it("pollUpdates returns an empty PollBatch (webhook-only)", async () => {
    const adapter = new SlackAdapter();
    const batch = await adapter.pollUpdates(connectorRow());
    expect(batch).toEqual({ messages: [], maxUpdateId: null });
    expect(fetchCalls).toHaveLength(0);
  });

  it("setWebhook/removeWebhook are no-op successes without any platform call", async () => {
    const adapter = new SlackAdapter();
    await expect(adapter.setWebhook(connectorRow(), "https://x", "s")).resolves.toBeUndefined();
    await expect(adapter.removeWebhook(connectorRow())).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ─── Override seam ─────────────────────────────────────────────────────

describe("setSlackApiBaseOverride (E2E seam)", () => {
  it("override wins over env; null/empty clears back to env-driven", async () => {
    setSlackApiBaseOverride("http://127.0.0.1:46001");
    expect(getSlackApiBaseOverride()).toBe("http://127.0.0.1:46001");

    queueSlackResponse({ ok: true, message: { ts: "1" } });
    const adapter = new SlackAdapter();
    await adapter.sendMessage(connectorRow(), "D1", "x");
    expect(lastCall().url).toBe("http://127.0.0.1:46001/chat.postMessage");

    setSlackApiBaseOverride(null);
    expect(getSlackApiBaseOverride()).toBeNull();
    setSlackApiBaseOverride("   ");
    expect(getSlackApiBaseOverride()).toBeNull();
  });
});

// ─── T-200-06: secret discipline ───────────────────────────────────────

describe("secret discipline (T-200-06)", () => {
  it("error messages never carry the token", async () => {
    queueSlackResponse({ ok: false, error: "invalid_auth" }, 200);
    const adapter = new SlackAdapter();
    try {
      await adapter.sendMessage(connectorRow(), "D1", "hi");
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(BOT_TOKEN);
      expect(err).toBeInstanceOf(SlackApiError);
    }
  });
});