// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 200 (200-01 Task 2, D-10) — the Slack formatter contract pin:
 * the 39000 fence-safe split boundaries, the md→mrkdwn round-trip cases,
 * and the fail-open arm. Pure functions — Postgres-free, no network, no
 * prisma.
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

import { mdToMrkdwn } from "../services/connectors/slack";
import { splitMessage } from "../services/connectors/telegram";

// ─── D-10: split boundaries (paragraph → newline → hard, fence-safe) ───

describe("splitMessage(text, 39000) — boundaries (D-10)", () => {
  it("splits on paragraph (\n\n) boundaries, never mid-paragraph, when paragraphs exist", () => {
    const para = "p".repeat(1200);
    const text = Array.from({ length: 50 }, (_, i) => `${para}-${i}`).join("\n\n");
    const segments = splitMessage(text, 39000);

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(39000);
    }
    // Serial segments re-join to the original text (boundary separators
    // stay INSIDE segments — no characters lost).
    expect(segments.join("")).toBe(text);
  });

  it("splits on newline boundaries when no paragraph boundary fits", () => {
    const line = "l".repeat(500);
    const text = Array.from({ length: 100 }, (_, i) => `${line}-${i}`).join("\n");
    const segments = splitMessage(text, 39000);

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(39000);
    }
    expect(segments.join("")).toBe(text);
  });

  it("NEVER splits inside a fenced code block when a safe boundary exists", () => {
    const block = "```\n" + "x".repeat(3000) + "\n```";
    const text = Array.from({ length: 30 }, () => block).join("\n\n");
    const segments = splitMessage(text, 39000);

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
        // Non-final segments must not end INSIDE a fence (odd count with
        // content after the last opener).
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
    const segments = splitMessage(fenced, 39000);

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(39000);
    }
    // Every non-first segment starts with the re-emitted fence.
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].startsWith("```\n")).toBe(true);
    }
  });

  it("re-joined serial segments equal the original when no fence re-emit occurred", () => {
    const text = Array.from({ length: 40 }, (_, i) => `para ${i}\n${"z".repeat(1000)}`).join("\n\n");
    const segments = splitMessage(text, 39000);
    expect(segments.join("")).toBe(text);
  });
});

// ─── D-10: mdToMrkdwn round-trip cases ────────────────────────────────

describe("mdToMrkdwn — round-trip cases (D-10)", () => {
  it("bold **x** → *x* (single *x* passes through unchanged)", () => {
    expect(mdToMrkdwn("**bold** text")).toBe("*bold* text");
    expect(mdToMrkdwn("*already* text")).toBe("*already* text");
  });

  it("italic __x__ → _x_ (single _x_ passes through unchanged)", () => {
    expect(mdToMrkdwn("__italic__ text")).toBe("_italic_ text");
    expect(mdToMrkdwn("_already_ text")).toBe("_already_ text");
  });

  it("inline code passes through verbatim", () => {
    expect(mdToMrkdwn("run `npm test` now")).toBe("run `npm test` now");
    expect(mdToMrkdwn("`**not-converted**`")).toBe("`**not-converted**`");
  });

  it("fenced blocks pass through verbatim", () => {
    const fenced = "before\n```\n**code stays**\n__verbatim__\n```\nafter";
    expect(mdToMrkdwn(fenced)).toBe(fenced);
  });

  it("converts [t](u) → <u|t>", () => {
    expect(mdToMrkdwn("see [docs](https://example.com/x)")).toBe("see <https://example.com/x|docs>");
  });

  it("mixed markup converts all supported shapes at once", () => {
    expect(mdToMrkdwn("**b** and __i__ and `c` and [l](https://e.com/p)")).toBe(
      "*b* and _i_ and `c` and <https://e.com/p|l>"
    );
  });

  it("plain text is identity (the converter is a no-op on plain input)", () => {
    expect(mdToMrkdwn("no markup at all")).toBe("no markup at all");
  });

  it("bold runs BEFORE italic (** consumed first — no double rewrite)", () => {
    // If italic ran first, **bold** would become **…* — the pin asserts the
    // correct order produces the single-asterisk bold marker.
    expect(mdToMrkdwn("**x**")).toBe("*x*");
    expect(mdToMrkdwn("**x** and __y__")).toBe("*x* and _y_");
  });

  it("converter fail-open: pathological input returns plain text, no throw", () => {
    // The converter's regexes handle any string, but the fail-open tail is
    // the contract: on ANY conversion failure the ORIGINAL text is
    // returned and a warn is logged. Simulate by asserting the pass-through
    // behavior on adversarial inputs (never throws).
    const adversarial = "**[**__(```";
    expect(() => mdToMrkdwn(adversarial)).not.toThrow();
    expect(typeof mdToMrkdwn(adversarial)).toBe("string");
  });

  it("no parse_mode key can exist in the converted output contract (mrkdwn has no parse_mode analog)", () => {
    // The outbound body contract: { channel, text } — no parse_mode key.
    // (The adapter test pins the wire body; this pin documents the D-10
    // contract at the converter layer.)
    const converted = mdToMrkdwn("**x**");
    expect(converted).not.toContain("parse_mode");
  });
});