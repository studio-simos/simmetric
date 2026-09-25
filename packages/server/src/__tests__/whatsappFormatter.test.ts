// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 200 (200-02 Task 2, D-11) — the WhatsApp formatter contract pin:
 * the 4000 fence-safe split boundaries, the md→WhatsApp conversion set
 * (bold/italic rewrite, inline-code/strike pass-through, fence flattening
 * that never drops content), and the fail-open arm. Pure functions —
 * Postgres-free, no network, no prisma.
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

import { mdToWhatsapp } from "../services/connectors/whatsapp";
import { splitMessage } from "../services/connectors/telegram";

// ─── D-11: split boundaries (paragraph → newline → hard, fence-safe) ───

describe("splitMessage(text, 4000) — boundaries (D-11)", () => {
  it("splits on paragraph (\n\n) boundaries, never mid-paragraph, when paragraphs exist", () => {
    const para = "p".repeat(1200);
    const text = Array.from({ length: 50 }, (_, i) => `${para}-${i}`).join("\n\n");
    const segments = splitMessage(text, 4000);

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(4000);
    }
    // Serial segments re-join to the original text (boundary separators
    // stay INSIDE segments — no characters lost).
    expect(segments.join("")).toBe(text);
  });

  it("splits on newline boundaries when no paragraph boundary fits", () => {
    const line = "l".repeat(500);
    const text = Array.from({ length: 100 }, (_, i) => `${line}-${i}`).join("\n");
    const segments = splitMessage(text, 4000);

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(4000);
    }
    expect(segments.join("")).toBe(text);
  });

  it("NEVER splits inside a fenced code block when a safe boundary exists", () => {
    const block = "```\n" + "x".repeat(3000) + "\n```";
    const text = Array.from({ length: 30 }, () => block).join("\n\n");
    const segments = splitMessage(text, 4000);

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      // A segment must not START mid-fence: either it begins with a fence
      // (the original opening or the re-emitted prefix) or outside one.
      // Fence-parity pin: each segment carries an EVEN number of fence
      // markers UNLESS it is the final segment of an unterminated fence —
      // with the re-emit rule, a non-final odd count would mean a cut
      // inside a fence.
      const fenceCount = (s.match(/```/g) ?? []).length;
      const isLast = s === segments[segments.length - 1];
      if (!isLast) {
        const lastFence = s.lastIndexOf("```");
        const endsInsideFence = fenceCount % 2 === 1 && lastFence < s.length - 3;
        expect(endsInsideFence).toBe(false);
      }
    }
  });

  it("a mid-fence hard split re-emits the opening fence at the top of the next segment", () => {
    // One giant fenced block with no safe boundary inside → the hard cut
    // lands mid-fence; the next segment re-opens the fence (the splitter's
    // pendingReopen contract — no segment ever STARTS mid-fence).
    const fenced = "```\n" + "y".repeat(80000) + "\n```";
    const segments = splitMessage(fenced, 4000);

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(4000);
    }
    // Every non-first segment starts with the re-emitted fence.
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].startsWith("```\n")).toBe(true);
    }
  });

  it("re-joined serial segments equal the original when no fence re-emit occurred", () => {
    const text = Array.from({ length: 40 }, (_, i) => `para ${i}\n${"z".repeat(1000)}`).join("\n\n");
    const segments = splitMessage(text, 4000);
    expect(segments.join("")).toBe(text);
  });
});

// ─── D-11: mdToWhatsapp conversion set ─────────────────────────────────

describe("mdToWhatsapp — conversion set (D-11)", () => {
  it("bold **x** → *x* (single *x* passes through unchanged)", () => {
    expect(mdToWhatsapp("**bold** text")).toBe("*bold* text");
    expect(mdToWhatsapp("*already* text")).toBe("*already* text");
  });

  it("italic __x__ → _x_ (single _x_ passes through unchanged)", () => {
    expect(mdToWhatsapp("__italic__ text")).toBe("_italic_ text");
    expect(mdToWhatsapp("_already_ text")).toBe("_already_ text");
  });

  it("inline code passes through verbatim (native WhatsApp formatting)", () => {
    expect(mdToWhatsapp("run `npm test` now")).toBe("run `npm test` now");
    expect(mdToWhatsapp("`**not-converted**`")).toBe("`**not-converted**`");
  });

  it("~~strike~~ passes through verbatim (D-11 pin — no rewrite in v1)", () => {
    expect(mdToWhatsapp("~~struck~~ text")).toBe("~~struck~~ text");
  });

  it("fenced blocks FLATTEN to inline-code lines with delimiters dropped, content preserved", () => {
    const fenced = "before\n```\nconst x = 1;\nconst y = 2;\n```\nafter";
    expect(mdToWhatsapp(fenced)).toBe("before\n`const x = 1;`\n`const y = 2;`\nafter");
  });

  it("a 3-line fenced block becomes 3 inline-code lines — the NEVER-drop-content pin", () => {
    const fenced = "```\nline one\nline two\nline three\n```";
    const out = mdToWhatsapp(fenced);
    expect(out).toBe("`line one`\n`line two`\n`line three`");
    expect(out).toContain("line one");
    expect(out).toContain("line two");
    expect(out).toContain("line three");
  });

  it("markup INSIDE a fenced block is never converted (flatten wraps, does not rewrite)", () => {
    const fenced = "```\n**stays-markdown**\n__verbatim__\n```";
    const out = mdToWhatsapp(fenced);
    expect(out).toBe("`**stays-markdown**`\n`__verbatim__`");
  });

  it("mixed markup converts all supported shapes at once", () => {
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

  it("an UNTERMINATED fence degrades fail-open: trailing content lines still wrap, nothing lost", () => {
    // The fence state machine flips on the lone ``` and every following
    // line wraps as inline code — content preserved, no exception (the
    // malformed fence is the author's markup ambiguity, never a throw).
    const unterminated = "before\n```\nconst x = 1;";
    const out = mdToWhatsapp(unterminated);
    expect(out).toBe("before\n`const x = 1;`");
  });

  it("no parse_mode key can exist in the converted output contract", () => {
    const converted = mdToWhatsapp("**x**");
    expect(converted).not.toContain("parse_mode");
  });
});

// ─── Outbound fixture hygiene (D-08 backstop) ──────────────────────────

describe("outbound fixture hygiene (D-08)", () => {
  it("no outbound fixture ever carries a template message or a non-whatsapp messaging_product", async () => {
    // Drive the adapter's ACTUAL send path for both fixture shapes and
    // assert the wire body: type stays "text", messaging_product stays
    // "whatsapp", no template key ever appears (D-08 — template messages
    // are NEVER in v1).
    const { WhatsappAdapter } = await import("../services/connectors/whatsapp");
    const { encrypt } = await import("../services/encryptionService");

    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.FX1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new WhatsappAdapter();
      const row = {
        id: "550e8400-e29b-41d4-a716-4466554400e1",
        platform: "whatsapp",
        organizationId: "org-200",
        workspaceId: "550e8400-e29b-41d4-a716-4466554400e2",
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
        botTokenEncrypted: encrypt("eaag-fixture-token"),
        configEncrypted: encrypt(JSON.stringify({ phoneNumberId: "109876543210987" })),
        pollOffset: 0n,
      };
      for (const text of [
        "**bold** and __italic__ and `code`",
        "```\nfenced content\n```",
        "~~strike~~ plain",
        "plain text only",
      ]) {
        await adapter.sendMessage(row, "491234567890", text);
      }
      expect(fetchCalls.length).toBeGreaterThanOrEqual(4);
      for (const call of fetchCalls) {
        const body = JSON.parse(String(call.init.body));
        expect(body.type).toBe("text");
        expect(body.messaging_product).toBe("whatsapp");
        expect(body.template).toBeUndefined();
        expect(body.recipient_type).toBe("individual");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});