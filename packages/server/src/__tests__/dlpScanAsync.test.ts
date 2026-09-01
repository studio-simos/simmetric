// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * scanContentAsync tests (quick 260829-ony — spec §2.3/§2.4).
 *
 * Covers: DB-backed patterns used when the service succeeds, BUILT-IN
 * fallback when the DB is unreachable (spec §2.4 graceful degradation), and
 * the empty-enabled-set = no-scan contract (DB is the source of truth).
 * scanContent (SYNC) regression: untouched behavior with the built-in const.
 */
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetActiveCompiledPatterns = jest.fn();
const mockLogDbFallback = jest.fn();

jest.mock("../services/dlpPatternService", () => ({
  __esModule: true,
  getActiveCompiledPatterns: (...args: unknown[]) => mockGetActiveCompiledPatterns(...args),
  logDbFallback: (...args: unknown[]) => mockLogDbFallback(...args),
}));

import { scanContentAsync, scanContent, scanWithPatterns, DLP_PATTERNS } from "../services/dlpFilter";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("scanContentAsync", () => {
  it("scans with DB patterns when the service resolves", async () => {
    mockGetActiveCompiledPatterns.mockResolvedValue([
      { type: "custom_code", regex: /PROJECT_[A-Z]+/g, replacement: "[REDACTED]" },
    ]);
    const res = await scanContentAsync("see PROJECT_X now");
    expect(res.hasMatch).toBe(true);
    expect(res.redactedText).toBe("see [REDACTED] now");
    expect(res.matches[0]!.type).toBe("custom_code");
  });

  it("falls back to built-in patterns when the DB is unreachable (spec §2.4)", async () => {
    mockGetActiveCompiledPatterns.mockRejectedValue(new Error("Connection refused"));
    const res = await scanContentAsync("mail me at bob@example.com");
    expect(res.hasMatch).toBe(true);
    expect(res.redactedText).toContain("[REDACTED]");
    expect(res.matches[0]!.type).toBe("email");
    expect(mockLogDbFallback).toHaveBeenCalledTimes(1);
  });

  it("empty enabled set → no scan (admin disabled everything = intended)", async () => {
    mockGetActiveCompiledPatterns.mockResolvedValue([]);
    const res = await scanContentAsync("bob@example.com 4111111111111111");
    expect(res.hasMatch).toBe(false);
    expect(res.redactedText).toBe("bob@example.com 4111111111111111");
  });

  it("built-in email pattern still matches via fallback with match metadata", async () => {
    mockGetActiveCompiledPatterns.mockRejectedValue(new Error("down"));
    const res = await scanContentAsync("contact alice@test.org ok");
    expect(res.matches[0]).toMatchObject({ type: "email", matchedText: "alice@test.org" });
  });

  // --- EU/IT built-ins (quick 260829-xb1) — DB-down fallback parity ------------
  describe("DB-down fallback covers the EU/IT built-ins (mirror of migration rows)", () => {
    it("fallback detects it_vat_iva (label-anchored)", async () => {
      mockGetActiveCompiledPatterns.mockRejectedValue(new Error("Connection refused"));
      const res = await scanContentAsync("P. IVA: 01234567890");
      expect(res.hasMatch).toBe(true);
      expect(res.matches.some(m => m.type === "it_vat_iva")).toBe(true);
      expect(res.redactedText).toBe("[REDACTED]");
      expect(mockLogDbFallback).toHaveBeenCalledTimes(1);
    });

    it("fallback does NOT match it_vat_iva on a bare 11-digit number (label-anchoring holds)", async () => {
      mockGetActiveCompiledPatterns.mockRejectedValue(new Error("Connection refused"));
      // NOTE: the bare 11-digit run is NOT covered by eu_phone in the
      // fallback (260829-xxx: the entry carries enabled:false mirroring its
      // DB seed) — the assertion pins it_vat_iva's label anchoring only.
      const res = await scanContentAsync("invoice 01234567890");
      expect(res.matches.some(m => m.type === "it_vat_iva")).toBe(false);
    });

    it("fallback detects it_codice_fiscale", async () => {
      mockGetActiveCompiledPatterns.mockRejectedValue(new Error("Connection refused"));
      const res = await scanContentAsync("CF RSSMRA85T01A562S ok");
      expect(res.matches.some(m => m.type === "it_codice_fiscale")).toBe(true);
      expect(res.redactedText).not.toContain("RSSMRA85T01A562S");
    });

    it("fallback does NOT match the lowercase word 'foschi' (uppercase-only CF)", async () => {
      mockGetActiveCompiledPatterns.mockRejectedValue(new Error("Connection refused"));
      const res = await scanContentAsync("il foschi di oggi");
      expect(res.hasMatch).toBe(false);
    });

    it("fallback detects iban (compact IT)", async () => {
      mockGetActiveCompiledPatterns.mockRejectedValue(new Error("Connection refused"));
      const res = await scanContentAsync("wire IT60X0542811101000000123456 ok");
      expect(res.matches.some(m => m.type === "iban")).toBe(true);
      expect(res.redactedText).not.toContain("IT60X0542811101000000123456");
    });

    it("fallback does NOT match a random uppercase hex run", async () => {
      mockGetActiveCompiledPatterns.mockRejectedValue(new Error("Connection refused"));
      const res = await scanContentAsync("DEADBEEFCAFEBABE01234567890FFFF");
      expect(res.hasMatch).toBe(false);
    });

    it("fallback does NOT serve eu_phone (260829-xxx: enabled:false mirrors the DB seed)", async () => {
      mockGetActiveCompiledPatterns.mockRejectedValue(new Error("Connection refused"));
      const res = await scanContentAsync("+39 333 1234567");
      // DB-up (eu_phone seeded isEnabled=false) leaves phones unredacted;
      // the DB-down fallback must behave identically (was: the const applied
      // eu_phone and diverged from the DB path).
      expect(res.matches.some(m => m.type === "eu_phone")).toBe(false);
      expect(res.redactedText).toBe("+39 333 1234567");
    });
  });

  it("DB path does NOT redact a DISABLED pattern (eu_phone shipped isEnabled=false)", async () => {
    // The DB is the source of truth: eu_phone is seeded disabled, so
    // getActiveCompiledPatterns (where isEnabled: true) never returns it.
    mockGetActiveCompiledPatterns.mockResolvedValue([
      // Only the enabled built-ins that the DB would serve post-migration.
      { type: "email", regex: /(?<![\p{L}\p{N}_])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?![\p{L}\p{N}_])/gu, replacement: "[REDACTED]" },
    ]);
    const res = await scanContentAsync("call +39 333 1234567");
    expect(res.hasMatch).toBe(false);
    expect(res.redactedText).toBe("call +39 333 1234567");
  });

  it("DB path redacts enabled EU/IT patterns but NOT the disabled eu_phone", async () => {
    mockGetActiveCompiledPatterns.mockResolvedValue([
      { type: "it_codice_fiscale", regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gu, replacement: "[REDACTED]" },
      { type: "iban", regex: /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/gu, replacement: "[REDACTED]" },
    ]);
    const res = await scanContentAsync("CF RSSMRA85T01A562S IBAN DE89370400440532013000 phone 3331234567");
    expect(res.redactedText).toContain("[REDACTED]");
    expect(res.redactedText).not.toContain("RSSMRA85T01A562S");
    expect(res.redactedText).not.toContain("DE89370400440532013000");
    expect(res.redactedText).toContain("phone 3331234567"); // eu_phone disabled → untouched
  });
});

describe("scanContent (sync) regression — untouched", () => {
  it("still scans with the built-in const", () => {
    const res = scanContent("card 4111111111111111 end");
    expect(res.hasMatch).toBe(true);
    expect(res.redactedText).toContain("[REDACTED]");
  });

  it("scanWithPatterns(text, DLP_PATTERNS) === scanContent(text)", () => {
    const text = "a@b.co and 4111111111111111 and sk-abcdefghijklmnopqrstuvwxyz123456";
    expect(scanWithPatterns(text, DLP_PATTERNS)).toEqual(scanContent(text));
  });

  it("scanWithPatterns honors a custom replacement", () => {
    const res = scanWithPatterns("bob@example.com", [
      { type: "email", regex: /[a-z]+@[a-z]+\.[a-z]+/g, replacement: "***" },
    ]);
    expect(res.redactedText).toBe("***");
  });

  it("scanWithPatterns zero-length guard terminates", () => {
    const res = scanWithPatterns("xyz", [{ type: "zero", regex: /x*/g }]);
    expect(res.hasMatch).toBeDefined();
  });
});