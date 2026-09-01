// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP Filter Multibyte & Surrogate-Pair Boundary Tests (COV-02)
 *
 * Test-first coverage for two documented gaps in dlpFilter.ts:
 *   - Family A: ASCII-only regexes (email \b[A-Za-z0-9...], credit_card \b\d...)
 *     leak non-Latin PII (Cyrillic email, Arabic-Indic digit strings).
 *   - Family B: progressiveDLPFlush uses a UTF-16 code-unit slice that can split
 *     a 4-byte surrogate pair at the safeEnd boundary, emitting a lone high
 *     surrogate in the safe prefix.
 *
 * Pure utility test — dlpFilter.ts has no getEnv() path, so no jest.mock and
 * no ./helpers/setupEnv import. Mirrors the dlpFilter.test.ts harness style.
 */
import { scanContent, progressiveDLPFlush, DLP_PATTERNS } from "../services/dlpFilter";

describe("DLP Filter — multibyte & surrogate-pair boundary (COV-02)", () => {
  describe("Family A — non-Latin PII detection", () => {
    it("redacts Cyrillic email (пользователь@почта.рф)", () => {
      const result = scanContent("contact: пользователь@почта.рф end");
      expect(result.hasMatch).toBe(true);
      expect(result.redactedText).toContain("[REDACTED]");
      expect(result.redactedText).not.toContain("пользователь@почта.рф");
    });

    it("redacts Arabic-Indic digit credit-card-equivalent", () => {
      const cc = "٠١٢٣٤٥٦٧٨٩٠١٢٣"; // U+0660..U+0669 sequence (13 digits)
      const result = scanContent(`card: ${cc} end`);
      expect(result.hasMatch).toBe(true);
      expect(result.redactedText).toContain("[REDACTED]");
    });

    it("DLP_PATTERNS exports the 6 original pattern types (10 total since quick 260829-xb1)", () => {
      const types = DLP_PATTERNS.map(p => p.type);
      expect(types).toContain("email");
      expect(types).toContain("credit_card");
      expect(DLP_PATTERNS.length).toBe(10); // 6 originals + 4 EU/IT built-ins
    });
  });

  describe("Family B — surrogate-pair boundary in progressiveDLPFlush", () => {
    it("does not emit a lone surrogate when safeEnd splits a 4-byte emoji", () => {
      // length 127: "x"×62 (indices 0..61) + 😀 surrogate pair (indices 62..63) + "x"×63 (indices 64..126).
      // safeEnd = 127 - 64 = 63; buffer.charCodeAt(62) = 0xD83D (high surrogate).
      // slice(0, 63) on the UNFIXED code = "x"×62 + lone \uD83D -> trailing high surrogate.
      const buffer = "x".repeat(62) + "😀" + "x".repeat(63);
      const result = progressiveDLPFlush(buffer, 64);
      // No lone high surrogate at the end of the safe prefix.
      expect(result.safePrefix).not.toMatch(/[\uD800-\uDBFF]$/);
      // Reconstitution invariant: safePrefix + remaining === buffer.
      expect(result.safePrefix + result.remaining).toBe(buffer);
    });

    it("held-back remaining tail survives a final scanContent pass (no lone-surrogate crash)", () => {
      const buffer = "x".repeat(62) + "😀" + "x".repeat(63);
      const result = progressiveDLPFlush(buffer, 64);
      const finalScan = scanContent(result.remaining);
      expect(typeof finalScan.redactedText).toBe("string");
    });
  });

  describe("regression — ASCII path unchanged", () => {
    it("progressiveDLPFlush ASCII safePrefix length is unchanged", () => {
      expect(progressiveDLPFlush("a".repeat(100), 64).safePrefix).toBe("a".repeat(36));
    });
  });

  // CR-01 (code review): the email boundary class must treat a trailing sentence
  // period as a boundary (like \b does), NOT as an extender. Otherwise an email
  // ending a sentence ("...john@example.com.") fails the negative lookahead and
  // the entire email leaks unredacted. This pins the faithful \b replacement
  // ([\p{L}\p{N}_] boundary = Unicode word chars only).
  describe("regression — sentence-period & alphanumeric-prefix boundaries (CR-01/WR-01)", () => {
    it("redacts an email ending a sentence with a period", () => {
      const result = scanContent("Contact me at john@example.com.");
      expect(result.hasMatch).toBe(true);
      expect(result.redactedText).not.toContain("john@example.com");
      expect(result.redactedText).toContain("[REDACTED]");
    });

    it("redacts both emails in a comma-separated list ending with a period", () => {
      const result = scanContent("john@example.com, bob@y.com.");
      expect(result.hasMatch).toBe(true);
      expect(result.redactedText).not.toContain("john@example.com");
      expect(result.redactedText).not.toContain("bob@y.com");
    });

    it("does NOT false-positive redact a digit run prefixed by letters", () => {
      // Faithful to \b: a word char immediately before the digit run blocks the match.
      const result = scanContent("ORDER1234567890123 done");
      expect(result.redactedText).toBe("ORDER1234567890123 done");
    });

    it("does NOT false-positive redact a digit run prefixed by underscore", () => {
      const result = scanContent("id_1234567890123 done");
      expect(result.redactedText).toBe("id_1234567890123 done");
    });

    it("still redacts a legitimate space-flanked 16-digit card", () => {
      const result = scanContent("card 4111111111111111 end");
      expect(result.hasMatch).toBe(true);
      expect(result.redactedText).toContain("[REDACTED]");
    });
  });
});