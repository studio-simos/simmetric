// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 199 (199-01 Task 2) — DiscordAdapter unit pins. Postgres-free:
 * globalThis.fetch stubbed per the telegramAdapter.test.ts pattern
 * (NETWORK_EGRESS_BLOCKED discipline — no test may touch the network);
 * prisma mocked; encryptionService REAL (roundtrip via encrypt — the same
 * real-crypto pattern the telegram suite pins).
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
  DiscordAdapter,
  DiscordApiError,
  getDiscordApiBaseOverride,
  setDiscordApiBaseOverride,
} from "../services/connectors/discord";
import { splitMessage } from "../services/connectors/telegram";
import { getAdapter, isPlatformImplemented } from "../services/connectors/registry";
import type { ConnectorPipelineRow } from "../services/connectors/base";

const BOT_TOKEN = "1234567890.abcdef.DISCORD-TEST-TOKEN-not-real";
const DEFAULT_API_URL = "https://discord.com/api/v10";

function connectorRow(overrides: Record<string, unknown> = {}): ConnectorPipelineRow & Record<string, unknown> {
  return {
    id: "550e8400-e29b-41d4-a716-4466554400c1",
    platform: "discord",
    organizationId: "org-199",
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

// ─── fetch stub (globalThis.fetch — zero network egress) ──────────────

interface RecordedCall {
  url: string;
  init: RequestInit;
}

const fetchCalls: RecordedCall[] = [];
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify({ id: "1000000000000000001" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  // mockReset (not clearAllMocks): clears calls AND any queued
  // mockImplementationOnce leftovers from earlier tests — a stale queued
  // response would otherwise answer the next test's fetch (pollution).
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: "1000000000000000001" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  fetchCalls.length = 0;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  // The override seam must not survive into other tests/suites.
  setDiscordApiBaseOverride(null);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Queue a Discord REST response for the next fetch call. */
function queueResponse(body: Record<string, unknown> | string, status = 200, contentType = "application/json"): void {
  mockFetch.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { "Content-Type": contentType },
    });
  });
}

function lastCall(): RecordedCall {
  return fetchCalls[fetchCalls.length - 1];
}

// ─── D-07: outbound send — split/serial/verbatim ──────────────────────

describe("sendMessage (D-07: 1900 split, serial, verbatim)", () => {
  it("a >1900-char reply produces ≥2 serial POSTs to /channels/:id/messages, each ≤2000 chars, NO parse_mode key anywhere", async () => {
    const adapter = new DiscordAdapter();
    const text = "x".repeat(4500);
    const expectedSegments = splitMessage(text, 1900); // the adapter delegates to this splitter
    for (let i = 0; i < expectedSegments.length; i++) queueResponse({ id: `msg-${i}` });

    const sent = await adapter.sendMessage(connectorRow(), "dm-channel-77", text);

    // N serial posts, each ≤2000 chars (Discord hard limit) — 1900 budget
    // keeps the margin.
    expect(fetchCalls.length).toBe(expectedSegments.length);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of fetchCalls) {
      expect(call.url).toBe(`${DEFAULT_API_URL}/channels/dm-channel-77/messages`);
      expect(call.init.method).toBe("POST");
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bot ${BOT_TOKEN}`);
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(call.init.body as string);
      expect(Object.keys(body)).toEqual(["content"]); // no parse_mode key — D-07 verbatim
      expect(body.content.length).toBeLessThanOrEqual(2000);
    }
    // Serial order preserved — the segments reconstruct the input.
    const allContent = fetchCalls.map((c) => JSON.parse(c.init.body as string).content);
    expect(allContent).toEqual(expectedSegments);
    expect(allContent.join("")).toBe(text);
    // Last response's id is the platformMessageId.
    expect(sent.platformMessageId).toBe(`msg-${expectedSegments.length - 1}`);
  });

  it("sends markdown VERBATIM (no conversion layer) — **bold** survives as literal markdown", async () => {
    queueResponse({ id: "msg-md" });

    const adapter = new DiscordAdapter();
    await adapter.sendMessage(connectorRow(), "dm-channel-77", "**bold** and `code` and <angle>");

    const body = JSON.parse(lastCall().init.body as string);
    expect(body.content).toBe("**bold** and `code` and <angle>"); // byte-identical, no escape, no parse_mode
    expect(body.parse_mode).toBeUndefined();
  });

  it("a long fenced block splits only at fence-safe boundaries and re-emits the opening fence on the continuation segment", async () => {
    const adapter = new DiscordAdapter();
    // A single fenced block with NO internal newline boundaries — the hard
    // split lands mid-fence and the next segment MUST re-open the fence
    // (the telegram splitter's pendingReopen discipline, imported).
    const text = "```js\n" + "z".repeat(4000) + "\nend```";
    const segments = splitMessage(text, 1900);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < segments.length; i++) queueResponse({ id: `fence-${i}` });
    const sent = await adapter.sendMessage(connectorRow(), "dm-channel-77", text);

    // Every segment re-emitted content is byte-identical to the splitter's
    // output (the adapter delegates, never re-splits).
    expect(fetchCalls.length).toBe(segments.length);
    fetchCalls.forEach((call, i) => {
      const body = JSON.parse(call.init.body as string);
      expect(body.content).toBe(segments[i]);
    });
    // The continuation segments start with the reopened fence (no segment
    // starts mid-fence).
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];
      const fenceCount = (segment.match(/```/g) ?? []).length;
      // A mid-fence continuation re-opens with "```\n" — the fence parity
      // stays even per segment, so Discord never renders broken markup.
      if (!segment.startsWith("```") && fenceCount % 2 === 1) {
        throw new Error(`segment ${i} starts mid-fence without a reopened fence`);
      }
    }
    expect(sent.platformMessageId).toBe(`fence-${segments.length - 1}`);
  });
});

// ─── D-19 parity: typing ──────────────────────────────────────────────

describe("sendTypingIndicator (D-19 parity)", () => {
  it("POSTs to /channels/:id/typing with the Bot header and tolerates a 204 empty body", async () => {
    // Node undici: a 204 Response must carry NO body (null) — the adapter
    // must resolve (not throw) on the empty typing response.
    mockFetch.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    });

    const adapter = new DiscordAdapter();
    await expect(adapter.sendTypingIndicator(connectorRow(), "dm-channel-77")).resolves.toBeUndefined();

    expect(fetchCalls).toHaveLength(1);
    expect(lastCall().url).toBe(`${DEFAULT_API_URL}/channels/dm-channel-77/typing`);
    expect(lastCall().init.method).toBe("POST");
    expect((lastCall().init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(lastCall().init.body).toBeUndefined(); // bodyless typing post
  });
});

// ─── D-02/D-03: validate + bot identity ───────────────────────────────

describe("validateBotToken / getBotInfo (D-02/D-03)", () => {
  it("maps a 200 { id, username, global_name: null } → botDisplayName = username (the ?? formula), botUsername without any @ prefix", async () => {
    queueResponse({ id: "900010001", username: "simmetric_bot", global_name: null });

    const adapter = new DiscordAdapter();
    const result = await adapter.validateBotToken(BOT_TOKEN);

    expect(result).toEqual({ valid: true, botUsername: "simmetric_bot", botDisplayName: "simmetric_bot" });
    expect(lastCall().url).toBe(`${DEFAULT_API_URL}/users/@me`);
    expect(lastCall().init.method).toBe("GET");
    expect((lastCall().init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);
  });

  it("maps a 200 with global_name set → botDisplayName = global_name (the ?? formula)", async () => {
    queueResponse({ id: "900010001", username: "simmetric_bot", global_name: "Simmetric" });

    const adapter = new DiscordAdapter();
    const result = await adapter.validateBotToken(BOT_TOKEN);

    expect(result.botDisplayName).toBe("Simmetric");
  });

  it("a 401 { message } body → { valid: false } without throwing", async () => {
    queueResponse({ message: "401: Unauthorized" }, 401);

    const adapter = new DiscordAdapter();
    const result = await adapter.validateBotToken("bad-token");

    expect(result).toEqual({ valid: false });
  });

  it("getBotInfo decrypts the STORED token — the Authorization header carries the decrypted roundtrip token", async () => {
    queueResponse({ id: "900010001", username: "stored_bot", global_name: null });

    const adapter = new DiscordAdapter();
    const row = connectorRow();
    const info = await adapter.getBotInfo(row);

    expect(lastCall().url).toBe(`${DEFAULT_API_URL}/users/@me`);
    expect((lastCall().init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);
    // The encrypted column itself never appears anywhere on the wire.
    expect(lastCall().url).not.toContain(row.botTokenEncrypted);
    expect(info.botUsername).toBe("stored_bot");
  });

  it("getBotInfo never logs the token (T-199-01)", async () => {
    queueResponse({ id: "900010001", username: "stored_bot", global_name: null });

    const adapter = new DiscordAdapter();
    await adapter.getBotInfo(connectorRow());

    const allLogArgs = JSON.stringify(
      (logger.warn as jest.Mock).mock.calls.concat((logger.error as jest.Mock).mock.calls)
    );
    expect(allLogArgs).not.toContain(BOT_TOKEN);
  });
});

// ─── A1: 429 retry-once ───────────────────────────────────────────────

describe("429 retry-once (A1)", () => {
  it("a 429 with retry_after 0.5 retries EXACTLY once after ~500ms (fake timers), then succeeds", async () => {
    jest.useFakeTimers();

    // 1st call → 429 with retry_after 0.5s; 2nd call (the retry) → success.
    mockFetch.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 0.5, global: false }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    });
    queueResponse({ id: "after-429" });

    const adapter = new DiscordAdapter();
    const promise = adapter.sendMessage(connectorRow(), "dm-channel-77", "hello");

    // Let the first (429) fetch resolve and the setTimeout(500) arm.
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toHaveLength(1); // only the 429 so far

    // Advance past the ~500ms backoff — the single retry fires and resolves.
    await jest.advanceTimersByTimeAsync(500);
    const sent = await promise;

    expect(fetchCalls).toHaveLength(2); // EXACTLY ONE retry (no loop)
    expect(sent.platformMessageId).toBe("after-429");

    jest.useRealTimers();
  });

  it("a second consecutive 429 surfaces as a structured error (no unbounded retry loop)", async () => {
    queueResponse({ message: "rate limited", retry_after: 0.01 }, 429);
    queueResponse({ message: "rate limited", retry_after: 0.01 }, 429);

    const adapter = new DiscordAdapter();
    await expect(adapter.sendMessage(connectorRow(), "dm-channel-77", "hello")).rejects.toMatchObject({
      method: "POST",
      status: 429,
    });
    expect(fetchCalls).toHaveLength(2); // initial + the one retry — never a third
  });
});

// ─── T-199-01: error shape ────────────────────────────────────────────

describe("error shape (T-199-01)", () => {
  it("a non-JSON error body → DiscordApiError with the non-JSON description and status; message contains NO token substring", async () => {
    queueResponse("<html>502 Service Unavailable</html>", 502, "text/html");

    const adapter = new DiscordAdapter();
    try {
      await adapter.sendMessage(connectorRow(), "dm-channel-77", "hello");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordApiError);
      expect((err as DiscordApiError).status).toBe(502);
      expect((err as DiscordApiError).description).toBe("non-JSON response (status 502)");
      expect((err as DiscordApiError).message).toBe("Discord POST failed (HTTP 502): non-JSON response (status 502)");
      expect((err as Error).message).not.toContain(BOT_TOKEN);
      expect(String(err)).not.toContain(BOT_TOKEN);
    }
  });

  it("a JSON { message } error body maps the platform description; token never in the error text", async () => {
    // 403 (not 50007): undici rejects non-[200,599] status codes in the
    // Response constructor — the adapter's non-OK arm is what's under pin.
    queueResponse({ message: "Cannot send messages to this user" }, 403);

    const adapter = new DiscordAdapter();
    try {
      await adapter.sendTypingIndicator(connectorRow(), "dm-channel-77");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as DiscordApiError).message).not.toContain(BOT_TOKEN);
      expect((err as DiscordApiError).description).toBe("Cannot send messages to this user");
    }
  });
});

// ─── D-01: no inbound surface ─────────────────────────────────────────

describe("D-01 surface stubs", () => {
  it("parseIncomingWebhook(anything) → null for every probe", () => {
    const adapter = new DiscordAdapter();
    expect(adapter.parseIncomingWebhook({ message: "whatever" })).toBeNull();
    expect(adapter.parseIncomingWebhook(null)).toBeNull();
    expect(adapter.parseIncomingWebhook(undefined)).toBeNull();
    expect(adapter.parseIncomingWebhook("string")).toBeNull();
    expect(adapter.parseIncomingWebhook(42)).toBeNull();
    expect(adapter.parseIncomingWebhook({ d: { content: "hello" } })).toBeNull();
  });

  it("pollUpdates → { messages: [], maxUpdateId: null } with NO fetch call", async () => {
    const adapter = new DiscordAdapter();
    const batch = await adapter.pollUpdates(connectorRow());
    expect(batch).toEqual({ messages: [], maxUpdateId: null });
    expect(fetchCalls).toHaveLength(0);
  });

  it("setWebhook/removeWebhook resolve without any fetch (D-01 no-op)", async () => {
    const adapter = new DiscordAdapter();
    await expect(adapter.setWebhook(connectorRow(), "https://example.com/hook", "s3cret")).resolves.toBeUndefined();
    await expect(adapter.removeWebhook(connectorRow())).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ─── Pitfall 5: registry flip at module load ──────────────────────────

describe("registry registration (Pitfall 5)", () => {
  it("discord is registered at module load — isPlatformImplemented flips true and getAdapter returns the instance", () => {
    expect(isPlatformImplemented("discord")).toBe(true);
    expect(getAdapter("discord")).toBeInstanceOf(DiscordAdapter);
  });
});

// ─── T-199-03: the override seam ──────────────────────────────────────

describe("setDiscordApiBaseOverride (T-199-03)", () => {
  it("the override wins over getEnv().DISCORD_API_URL — the fetched URL uses the fake base", async () => {
    queueResponse({ id: "overridden-1" });

    setDiscordApiBaseOverride("http://127.0.0.1:45919/api/v10");
    const adapter = new DiscordAdapter();
    await adapter.sendMessage(connectorRow(), "dm-channel-77", "hello");

    expect(getDiscordApiBaseOverride()).toBe("http://127.0.0.1:45919/api/v10");
    expect(lastCall().url).toBe("http://127.0.0.1:45919/api/v10/channels/dm-channel-77/messages");
  });

  it("an empty/whitespace string clears the override to null (byte-mirror of setTelegramApiBaseOverride)", () => {
    setDiscordApiBaseOverride("http://127.0.0.1:45919");
    expect(getDiscordApiBaseOverride()).toBe("http://127.0.0.1:45919");
    setDiscordApiBaseOverride("   ");
    expect(getDiscordApiBaseOverride()).toBeNull();
    setDiscordApiBaseOverride("");
    expect(getDiscordApiBaseOverride()).toBeNull();
  });

  it("null clears the override — production semantics resume (env-driven base)", async () => {
    queueResponse({ id: "prod-1" });

    setDiscordApiBaseOverride("http://127.0.0.1:45919");
    setDiscordApiBaseOverride(null);
    const adapter = new DiscordAdapter();
    await adapter.sendMessage(connectorRow(), "dm-channel-77", "hello");

    expect(getDiscordApiBaseOverride()).toBeNull();
    expect(lastCall().url).toBe(`${DEFAULT_API_URL}/channels/dm-channel-77/messages`);
  });
});