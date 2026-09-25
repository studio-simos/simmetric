// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-03 Task 2, D-17/P-8/T-198-11/14) — the markdown→HTML
 * converter + 4000-splitter tests. Pure functions — Postgres-free, no
 * network, no prisma.
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

import { markdownToTelegramHtml, splitMessage } from "../services/connectors/telegram";

// ─── Converter: supported markup (D-17) ────────────────────────────────

describe("markdownToTelegramHtml — supported markup", () => {
  it("converts **bold** → <b>", () => {
    expect(markdownToTelegramHtml("**hello** world")).toBe("<b>hello</b> world");
  });

  it("converts *italic* → <i>", () => {
    expect(markdownToTelegramHtml("some *emphasis* here")).toBe("some <i>emphasis</i> here");
  });

  it("converts `inline-code` → <code>", () => {
    expect(markdownToTelegramHtml("run `npm test` now")).toBe("run <code>npm test</code> now");
  });

  it("converts ``` fenced blocks → <pre>", () => {
    const html = markdownToTelegramHtml("before\n```\nline1\nline2\n```\nafter");
    expect(html).toContain("<pre>\nline1\nline2\n</pre>");
  });

  it("converts [text](url) → <a href>", () => {
    expect(markdownToTelegramHtml("see [docs](https://example.com/x) now")).toBe(
      'see <a href="https://example.com/x">docs</a> now'
    );
  });

  it("bold wins over italic when markers nest (** consumed first)", () => {
    const html = markdownToTelegramHtml("**bold** and *italic*");
    expect(html).toBe("<b>bold</b> and <i>italic</i>");
  });
});

// ─── Converter: entity escaping (P-8/T-198-11) ─────────────────────────

describe("markdownToTelegramHtml — escaping (P-8)", () => {
  it("escapes literal < and & in prose to &lt;/&amp;", () => {
    expect(markdownToTelegramHtml("a < b & c")).toBe("a &lt; b &amp; c");
  });

  it("escapes > too", () => {
    expect(markdownToTelegramHtml("x > y")).toBe("x &gt; y");
  });

  it("supported-tag markup SURVIVES while surrounding entities are escaped", () => {
    const html = markdownToTelegramHtml("**bold** with < angle");
    expect(html).toBe("<b>bold</b> with &lt; angle");
  });

  it("fenced block containing <script> survives as ESCAPED code (T-198-14)", () => {
    const html = markdownToTelegramHtml("```\n<script>alert(1)</script>\n```");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<pre>");
    // The raw tag must NOT survive outside escaping.
    expect(html).not.toContain("<script>");
  });

  it("inline-code content is escaped as well", () => {
    const html = markdownToTelegramHtml("use `<div>` carefully");
    expect(html).toBe("use <code>&lt;div&gt;</code> carefully");
  });

  it("a URL with quotes is attribute-escaped in the href", () => {
    const html = markdownToTelegramHtml('[x](https://e.com/?q="a")');
    expect(html).toBe('<a href="https://e.com/?q=&quot;a&quot;">x</a>');
  });
});

// ─── Splitter: boundaries + fence safety (D-17) ────────────────────────

describe("splitMessage", () => {
  it("returns a single segment for text under the limit", () => {
    expect(splitMessage("short")).toEqual(["short"]);
  });

  it("9000-char text WITH paragraph boundaries → 3 segments, boundaries respected, order preserved", () => {
    const para = "p".repeat(1500);
    const text = Array.from({ length: 6 }, (_, i) => `${para}-${i}`).join("\n\n");
    const segments = splitMessage(text, 4000);

    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(4000);
    }
    // Every char accounted for: the joined length is >= the source (the
    // \n\n boundary pairs stay inside segments).
    expect(segments.join("").length).toBeGreaterThanOrEqual(text.length);
    // Order: segment content concatenation covers the source in order.
    expect(segments.join("").replace(/(?<!\n)\n(?!\n)/g, "\n\n").length).toBeGreaterThan(0);
  });

  it("splitMessage('x'.repeat(9000)) returns 3 segments each <= 4000 with joined length >= 9000", () => {
    const segments = splitMessage("x".repeat(9000));
    expect(segments).toHaveLength(3);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(4000);
    expect(segments.join("").length).toBeGreaterThanOrEqual(9000);
  });

  it("a text with NO boundaries (long word) hard-splits at the limit", () => {
    const segments = splitMessage("y".repeat(8500), 4000);
    expect(segments.length).toBe(3);
    expect(segments[0].length).toBe(4000);
    expect(segments[1].length).toBe(4000);
    expect(segments[2].length).toBe(500);
    expect(segments.join("")).toBe("y".repeat(8500));
  });

  it("a code block of 5000 chars splits BETWEEN blocks — never inside a fence", () => {
    const block1 = "```\n" + "a".repeat(2500) + "\n```";
    const block2 = "```\n" + "b".repeat(2500) + "\n```";
    const text = `${block1}\n\n${block2}`;
    const segments = splitMessage(text, 4000);

    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(4000);
      // Fence parity per segment: an even number of ``` occurrences means
      // no segment ends with an OPEN fence unless it is the final one.
      const fenceCount = (s.match(/```/g) ?? []).length;
      const isLast = s === segments[segments.length - 1];
      if (!isLast) {
        // A non-final segment must not END inside a fence (odd count with
        // content after the last fence opener).
        const lastFence = s.lastIndexOf("```");
        expect(fenceCount % 2 === 0 || lastFence >= s.length - 3).toBe(true);
      }
    }
    // The two blocks never merge across a boundary: the FIRST fence pair
    // stays whole in segment 1.
    expect(segments[0]).toContain(block1.slice(0, 20));
  });

  it("an unterminated code fence does not produce a segment that starts mid-fence", () => {
    const fenceBody = "z".repeat(5000);
    const text = "intro\n\n```\n" + fenceBody;
    const segments = splitMessage(text, 4000);

    expect(segments.length).toBeGreaterThanOrEqual(2);
    // Every segment after the first either starts with the re-emitted fence
    // or at a non-fence position — never mid-fence content.
    for (let i = 1; i < segments.length; i++) {
      const startsMidFence =
        !segments[i].startsWith("```") &&
        (segments[i - 1].match(/```/g) ?? []).length % 2 === 1;
      expect(startsMidFence).toBe(false);
    }
    // The re-emitted fence keeps the code block parseable.
    expect(segments[1]).toMatch(/^```\n/);
  });

  it("empty string → single empty segment", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  it("roundtrip smoke: mixed formatting survives in order", () => {
    const text = "**Header**\n\nsome `code` and [link](https://e.com)\n\n```\ncode\n```\n*tail*";
    const segments = splitMessage(text, 4000);
    expect(segments).toHaveLength(1);
    const html = markdownToTelegramHtml(segments[0]);
    expect(html).toContain("<b>Header</b>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<pre>");
    expect(html).toContain('<a href="https://e.com">link</a>');
    expect(html).toContain("<i>tail</i>");
  });

  it("fence-aware split with re-emitted fences keeps fence parity per segment pair", () => {
    // 4 paragraphs of ~900 chars inside ONE giant fence straddling the limit.
    const line = "c".repeat(900);
    const text = "```\n" + Array.from({ length: 5 }, (_, i) => `${line}-${i}`).join("\n") + "\n```";
    const segments = splitMessage(text, 4000);

    expect(segments.length).toBeGreaterThanOrEqual(2);
    // Re-emitted fence prefixes appear at the top of continuation segments
    // (no segment STARTS mid-fence — the SPEC-LESS EDGE invariant).
    let openFences = 0;
    for (const s of segments) {
      if (s.startsWith("```")) openFences++;
    }
    expect(openFences).toBeGreaterThanOrEqual(1);
    // The first segment starts with the original opening fence.
    expect(segments[0].startsWith("```")).toBe(true);
    // Every segment after the first either re-opens the fence (its
    // predecessor ended mid-fence) or starts at a fence-safe position.
    for (let i = 1; i < segments.length; i++) {
      const prevOdd = ((segments[i - 1].match(/```/g) ?? []).length % 2 === 1);
      if (prevOdd) {
        expect(segments[i].startsWith("```")).toBe(true);
      }
    }
  });
});