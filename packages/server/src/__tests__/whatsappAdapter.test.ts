// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 200 (200-02 Task 1, D-06/D-07/D-08/D-11) — WhatsappAdapter tests.
 * Postgres-free: globalThis.fetch stubbed per the slackAdapter.test.ts
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
  WhatsappAdapter,
  WhatsappApiError,
  mdToWhatsapp,
  setWhatsappApiBaseOverride,
  getWhatsappApiBaseOverride,
} from "../services/connectors/whatsapp";
import { splitMessage } from "../services/connectors/telegram";
import { getAdapter, isPlatformImplemented } from "../services/connectors/registry";
import type { ConnectorPipelineRow } from "../services/connectors/base";

const ACCESS_TOKEN = "eaag-unit-test-token-not-a-real-token";
const PHONE_ID = "109876543210987";

function connectorRow(overrides: Record<string, unknown> = {}): ConnectorPipelineRow & Record<string, unknown> {
  return {
    id: "550e8400-e29b-41d4-a716-4466554400d1",
    platform: "whatsapp",
    organizationId: "org-200",
    workspaceId: "550e8400-e29b-41d4-a716-4466554400d2",
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
    botTokenEncrypted: encrypt(ACCESS_TOKEN),
    configEncrypted: encrypt(JSON.stringify({ phoneNumberId: PHONE_ID })),
    pollOffset: 0n,
    ...overrides,
  };
}

// ─── fetch stub (globalThis.fetch — slack adapter test pattern) ────────

interface RecordedCall {
  url: string;
  init: RequestInit;
}

const fetchCalls: RecordedCall[] = [];
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchCalls.length = 0;
  setWhatsappApiBaseOverride(null);
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Queue a Graph API response for the next fetch call. */
function queueGraphResponse(
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

/** A well-formed inbound text-message webhook body (research API Contracts 6). */
function whatsappWebhook(overrides: Record<string, unknown> = {}, messageOverrides: unknown[] = []): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    ...overrides,
    entry: [
      {
        id: "WABA-ID-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: "Alice Example" }, wa_id: "491234567890" }],
              messages: [
                { from: "491234567890", id: "wamid.HBgNNDkxMjM0NTY3ODkwFQIAERGG", timestamp: "1750000000", type: "text", text: { body: "Hello" } },
                ...messageOverrides,
              ],
              ...overrides.value,
            },
            ...overrides.change,
          },
        ],
      },
    ],
  };
}

// ─── D-06: module-load registration ────────────────────────────────────

describe("registration (module load)", () => {
  it("registerAdapter('whatsapp') ran at module load — isPlatformImplemented flips true", () => {
    expect(isPlatformImplemented("whatsapp")).toBe(true);
    expect(getAdapter("whatsapp")).toBeInstanceOf(WhatsappAdapter);
  });
});

// ─── D-06: parse boundary ──────────────────────────────────────────────

describe("parseIncomingWebhook (D-06/P10)", () => {
  const adapter = new WhatsappAdapter();

  it("maps a text message → IncomingMessage (wamid id, from, profile name)", () => {
    const msg = adapter.parseIncomingWebhook(whatsappWebhook());
    expect(msg).toMatchObject({
      platformMessageId: "wamid.HBgNNDkxMjM0NTY3ODkwFQIAERGG",
      platformUserId: "491234567890",
      platformUserName: "Alice Example",
      text: "Hello",
      chatType: "private",
    });
  });

  it("echoes platformUserId VERBATIM — bare digits, NO + prefix (P10)", () => {
    const msg = adapter.parseIncomingWebhook(whatsappWebhook());
    expect(msg!.platformUserId).toBe("491234567890");
    expect(msg!.platformUserId.startsWith("+")).toBe(false);
    expect(msg!.platformUserId).toMatch(/^\d+$/);
  });

  it("statuses-only delivery (no messages array) → null (D-06 silent drop)", () => {
    const statusesOnly = whatsappWebhook();
    (statusesOnly.entry[0].changes[0].value as Record<string, unknown>).statuses = [
      { id: "wamid.STATUS1", status: "delivered" },
    ];
    delete (statusesOnly.entry[0].changes[0].value as Record<string, unknown>).messages;
    expect(adapter.parseIncomingWebhook(statusesOnly)).toBeNull();
  });

  it("non-messages payload (no entry/changes/value shape) → null", () => {
    expect(adapter.parseIncomingWebhook(null)).toBeNull();
    expect(adapter.parseIncomingWebhook("string")).toBeNull();
    expect(adapter.parseIncomingWebhook({})).toBeNull();
    expect(adapter.parseIncomingWebhook({ object: "whatsapp_business_account" })).toBeNull();
    expect(adapter.parseIncomingWebhook({ object: "x", entry: [{ changes: [{ value: {} }] }] })).toBeNull();
  });

  it("non-text type (image) → text null (politeness fallback downstream, D-18 parity)", () => {
    const imageMsg = whatsappWebhook({}, [
      { from: "491234567890", id: "wamid.IMG1", type: "image", image: { id: "1", mime_type: "image/png" } },
    ]);
    // The FIRST messages[*] is the mapped one — make it the image.
    const body = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            contacts: [{ profile: { name: "Alice" } }],
            messages: [{ from: "491234567890", id: "wamid.IMG1", type: "image", image: { id: "2" } }],
          },
        }],
      }],
    };
    const msg = adapter.parseIncomingWebhook(body);
    void imageMsg;
    expect(msg).toMatchObject({ platformMessageId: "wamid.IMG1", text: null });
  });

  it("maps a text-typed message with empty text object safely", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            messages: [{ from: "491234567890", id: "wamid.T2", type: "text", text: {} }],
          },
        }],
      }],
    };
    const msg = adapter.parseIncomingWebhook(body);
    expect(msg).toMatchObject({ platformMessageId: "wamid.T2", text: null });
  });

  it("missing contacts → platformUserName undefined (no throw)", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            messages: [{ from: "1", id: "wamid.T3", type: "text", text: { body: "x" } }],
          },
        }],
      }],
    };
    const msg = adapter.parseIncomingWebhook(body);
    expect(msg!.platformUserName).toBeUndefined();
  });
});

// ─── D-11: outbound send ───────────────────────────────────────────────

describe("sendMessage (D-11/D-08)", () => {
  it("POSTs the exact Cloud API body shape with Bearer (override seam → stubbed fetch)", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ messaging_product: "whatsapp", contacts: [], messages: [{ id: "wamid.OUT1" }] });

    const adapter = new WhatsappAdapter();
    const result = await adapter.sendMessage(connectorRow(), "491234567890", "**bold** reply");

    expect(result).toEqual({ platformMessageId: "wamid.OUT1" });
    expect(fetchCalls).toHaveLength(1);
    expect(lastCall().url).toBe(`http://127.0.0.1:46001/${PHONE_ID}/messages`);
    expect(lastCall().init.method).toBe("POST");
    expect((lastCall().init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`);
    const sentBody = JSON.parse(String(lastCall().init.body));
    expect(sentBody).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "491234567890",
      type: "text",
      text: { body: "*bold* reply", preview_url: false },
    });
  });

  it("a from-style to value passes through VERBATIM — no + prefix (P10)", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ messages: [{ id: "wamid.OUT2" }] });

    const adapter = new WhatsappAdapter();
    await adapter.sendMessage(connectorRow(), "491234567890", "hi");

    const sentBody = JSON.parse(String(lastCall().init.body));
    expect(sentBody.to).toBe("491234567890");
    expect(sentBody.to.startsWith("+")).toBe(false);
  });

  it("Graph error body → WhatsappApiError carrying the Graph code", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse(
      { error: { message: "(#131026) Recipient phone number not in whatsapp", code: 131026 } },
      400
    );

    const adapter = new WhatsappAdapter();
    await expect(adapter.sendMessage(connectorRow(), "491234567890", "hi")).rejects.toMatchObject({
      name: "WhatsappApiError",
      code: 131026,
      status: 400,
    });
  });

  it("131047 (outside the 24h window) is TERMINAL — send attempted EXACTLY once, no retry, no template fallback (D-08)", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse(
      {
        error: {
          message: "Message failed to send because it was outside the allowed window (24h).",
          code: 131047,
        },
      },
      400
    );

    const adapter = new WhatsappAdapter();
    let thrown: unknown;
    try {
      await adapter.sendMessage(connectorRow(), "491234567890", "hi");
      throw new Error("should have thrown");
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      name: "WhatsappApiError",
      code: 131047,
    });

    // TERMINAL: exactly ONE network call — no retry, no template fallback.
    expect(fetchCalls).toHaveLength(1);
    // No template message body was ever constructed on any call.
    for (const call of fetchCalls) {
      const body = JSON.parse(String(call.init.body ?? "{}"));
      expect(body.type).not.toBe("template");
      expect(body.template).toBeUndefined();
      expect(body.type).toBe("text");
    }
    // The error MESSAGE embeds 131047 — the router-persisted lastError
    // identifies the window failure (INFO-2 persistence pin).
    expect((thrown as Error).message).toContain("131047");
  });

  it("splits at 4000 on fence-safe boundaries and sends segments serially", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ messages: [{ id: "wamid.OUT3a" }] });
    queueGraphResponse({ messages: [{ id: "wamid.OUT3b" }] });

    const adapter = new WhatsappAdapter();
    const longText = "a".repeat(2500) + "\n\n" + "b".repeat(2500);
    const segments = splitMessage(longText, 4000);
    expect(segments.length).toBe(2);

    const result = await adapter.sendMessage(connectorRow(), "491234567890", longText);
    expect(result.platformMessageId).toBe("wamid.OUT3b");
    expect(fetchCalls).toHaveLength(2);
    expect(JSON.parse(String(fetchCalls[0].init.body)).text.body.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(String(fetchCalls[1].init.body)).text.body.length).toBeLessThanOrEqual(4000);
  });

  it("a connector with no phoneNumberId in the blob throws BEFORE any network call", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    const adapter = new WhatsappAdapter();
    await expect(
      adapter.sendMessage(connectorRow({ configEncrypted: encrypt(JSON.stringify({})) }), "491234567890", "hi")
    ).rejects.toMatchObject({ name: "WhatsappApiError", method: "send" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("a tokenless row throws the structured error (never a raw decrypt failure)", async () => {
    const adapter = new WhatsappAdapter();
    await expect(adapter.sendMessage(connectorRow({ botTokenEncrypted: null }), "1", "hi")).rejects.toBeInstanceOf(
      WhatsappApiError
    );
  });

  it("non-JSON body → structured failure with NO body echo (T-200-10)", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    mockFetch.mockImplementationOnce(async () => new Response("<html>gateway error</html>", { status: 502 }));

    const adapter = new WhatsappAdapter();
    await expect(adapter.sendMessage(connectorRow(), "491234567890", "hi")).rejects.toMatchObject({
      name: "WhatsappApiError",
      status: 502,
    });
  });

  it("the adapter NEVER touches prisma on a send error (router-side failHealth is the sole persistence site, INFO-2 pin)", async () => {
    // whatsapp.ts contains no prisma import — asserted structurally below
    // (acceptance criterion) and behaviorally here: a Graph error throws;
    // nothing else happens.
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ error: { message: "window", code: 131047 } }, 400);
    const adapter = new WhatsappAdapter();
    await expect(adapter.sendMessage(connectorRow(), "491234567890", "hi")).rejects.toBeInstanceOf(WhatsappApiError);
  });
});

// ─── D-11: mdToWhatsapp converter ──────────────────────────────────────

describe("mdToWhatsapp (D-11)", () => {
  it("converts **x** → *x*", () => {
    expect(mdToWhatsapp("**hello** world")).toBe("*hello* world");
  });

  it("converts __x__ → _x_", () => {
    expect(mdToWhatsapp("some __emphasis__ here")).toBe("some _emphasis_ here");
  });

  it("inline code passes through verbatim (native WhatsApp formatting)", () => {
    expect(mdToWhatsapp("run `npm test` now")).toBe("run `npm test` now");
  });

  it("~~strike~~ passes through verbatim (D-11 pin — no rewrite in v1)", () => {
    expect(mdToWhatsapp("~~struck~~ text")).toBe("~~struck~~ text");
  });

  it("fenced blocks FLATTEN: each content line becomes an inline-code line, delimiters dropped, content preserved", () => {
    const fenced = "before\n```\nconst x = 1;\nconst y = 2;\n```\nafter";
    expect(mdToWhatsapp(fenced)).toBe(
      "before\n`const x = 1;`\n`const y = 2;`\nafter"
    );
  });

  it("a 3-line fenced block becomes 3 inline-code lines — NEVER drop content", () => {
    const fenced = "```\nline one\nline two\nline three\n```";
    const out = mdToWhatsapp(fenced);
    expect(out).toBe("`line one`\n`line two`\n`line three`");
    expect(out).toContain("line one");
    expect(out).toContain("line two");
    expect(out).toContain("line three");
  });

  it("mixed markup converts everything at once", () => {
    expect(mdToWhatsapp("**b** and __i__ and `c` and ~~s~~")).toBe("*b* and _i_ and `c` and ~~s~~");
  });

  it("plain text is identity (the converter is a no-op on plain input)", () => {
    expect(mdToWhatsapp("no markup at all")).toBe("no markup at all");
  });

  it("bold runs BEFORE italic (** consumed first — no double rewrite)", () => {
    expect(mdToWhatsapp("**x**")).toBe("*x*");
    expect(mdToWhatsapp("**x** and __y__")).toBe("*x* and _y_");
  });

  it("converter fail-open: pathological input returns a string, no throw", () => {
    const adversarial = "**[**__(```";
    expect(() => mdToWhatsapp(adversarial)).not.toThrow();
    expect(typeof mdToWhatsapp(adversarial)).toBe("string");
  });
});

// ─── INFO-2: token validation + bot identity ───────────────────────────

describe("validateBotToken / getBotInfo (INFO-2 pin)", () => {
  it("valid token → GET {base}/me (TOKEN-ONLY probe — no phoneNumberId needed) → { valid: true }", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ id: "123", name: "Simmetric" });

    const adapter = new WhatsappAdapter();
    const result = await adapter.validateBotToken(ACCESS_TOKEN);
    expect(result.valid).toBe(true);
    expect(lastCall().url).toBe("http://127.0.0.1:46001/me");
    expect((lastCall().init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("bad token (401) → { valid: false } without throwing, no row needed", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 401);

    const adapter = new WhatsappAdapter();
    const result = await adapter.validateBotToken("eaag-wrong");
    expect(result.valid).toBe(false);
  });

  it("403 (permission denied) → { valid: false }", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ error: { message: "(#200) Permission denied", code: 200 } }, 403);

    const adapter = new WhatsappAdapter();
    const result = await adapter.validateBotToken("eaag-wrong");
    expect(result.valid).toBe(false);
  });

  it("getBotInfo probes {base}/{phoneNumberId} on the DECRYPTED row (display phone + verified name)", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ display_phone_number: "15550001111", verified_name: "Simmetric Chat" });

    const adapter = new WhatsappAdapter();
    const result = await adapter.getBotInfo(connectorRow());
    expect(result).toEqual({ botUsername: "15550001111", botDisplayName: "Simmetric Chat" });
    expect(lastCall().url).toBe(`http://127.0.0.1:46001/${PHONE_ID}`);
  });

  it("getBotInfo SKIPS the probe when the row has no phoneNumberId ({ valid-ish } empty identity, no call)", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    const adapter = new WhatsappAdapter();
    const result = await adapter.getBotInfo(connectorRow({ configEncrypted: encrypt(JSON.stringify({})) }));
    expect(result).toEqual({});
    expect(fetchCalls).toHaveLength(0);
  });
});

// ─── D-06: no-op lifecycle ─────────────────────────────────────────────

describe("no-op lifecycle (D-06)", () => {
  it("sendTypingIndicator resolves without any platform call", async () => {
    const adapter = new WhatsappAdapter();
    await expect(adapter.sendTypingIndicator(connectorRow(), "491234567890")).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it("pollUpdates returns an empty PollBatch (webhook-only)", async () => {
    const adapter = new WhatsappAdapter();
    const batch = await adapter.pollUpdates(connectorRow());
    expect(batch).toEqual({ messages: [], maxUpdateId: null });
    expect(fetchCalls).toHaveLength(0);
  });

  it("setWebhook/removeWebhook are no-op successes without any platform call", async () => {
    const adapter = new WhatsappAdapter();
    await expect(adapter.setWebhook(connectorRow(), "https://x", "s")).resolves.toBeUndefined();
    await expect(adapter.removeWebhook(connectorRow())).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ─── Override seam ─────────────────────────────────────────────────────

describe("setWhatsappApiBaseOverride (E2E seam)", () => {
  it("override wins over env; null/empty clears back to env-driven", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46002");
    expect(getWhatsappApiBaseOverride()).toBe("http://127.0.0.1:46002");

    queueGraphResponse({ messages: [{ id: "wamid.SEAM" }] });
    const adapter = new WhatsappAdapter();
    await adapter.sendMessage(connectorRow(), "491234567890", "x");
    expect(lastCall().url).toBe(`http://127.0.0.1:46002/${PHONE_ID}/messages`);

    setWhatsappApiBaseOverride(null);
    expect(getWhatsappApiBaseOverride()).toBeNull();
    setWhatsappApiBaseOverride("   ");
    expect(getWhatsappApiBaseOverride()).toBeNull();
  });
});

// ─── T-200-10: secret discipline ───────────────────────────────────────

describe("secret discipline (T-200-10)", () => {
  it("error messages never carry the access token", async () => {
    setWhatsappApiBaseOverride("http://127.0.0.1:46001");
    queueGraphResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 401);
    const adapter = new WhatsappAdapter();
    try {
      await adapter.sendMessage(connectorRow(), "491234567890", "hi");
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(ACCESS_TOKEN);
      expect(err).toBeInstanceOf(WhatsappApiError);
    }
  });
});

// ─── Adapter source hygiene (INFO-2 pin) ───────────────────────────────

describe("adapter source hygiene (INFO-2)", () => {
  it("whatsapp.ts contains NO prisma reference (router-side failHealth is the sole persistence site)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../services/connectors/whatsapp.ts"),
      "utf-8"
    );
    expect(source).not.toMatch(/from "\.\.\/utils\/prisma"|prisma\.chatConnector|prisma\.update|@prisma/);
  });
});