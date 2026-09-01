// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP Filter Service Unit Tests
 *
 * Tests scanContent regex patterns for detection, redaction, and edge cases.
 * dlpFilter.ts is a pure utility -- no jest.mock needed.
 */
import { scanContent, progressiveDLPFlush, DLP_PATTERNS } from "../services/dlpFilter";

describe("DLP Filter", () => {
  // Verify module constants are exported and available
  it("DLP_PATTERNS contains all 6 original pattern types (now 10 total)", () => {
    const types = DLP_PATTERNS.map(p => p.type);
    expect(types).toContain("email");
    expect(types).toContain("credit_card");
    expect(types).toContain("api_key");
    expect(types).toContain("ssn");
    expect(types).toContain("aws_key");
    expect(types).toContain("private_key");
    expect(DLP_PATTERNS.length).toBe(10); // 6 originals + 4 EU/IT (quick 260829-xb1)
  });

  describe("EU/IT built-in patterns (quick 260829-xb1)", () => {
    it("DLP_PATTERNS now contains 10 patterns including the 4 EU/IT built-ins", () => {
      const types = DLP_PATTERNS.map(p => p.type);
      expect(types).toContain("it_vat_iva");
      expect(types).toContain("it_codice_fiscale");
      expect(types).toContain("iban");
      expect(types).toContain("eu_phone");
      expect(DLP_PATTERNS.length).toBe(10); // 6 originals + 4 EU/IT
    });

    describe("it_vat_iva (label-anchored Partita IVA)", () => {
      const scanVat = (text: string) => scanContent(text).matches.filter(m => m.type === "it_vat_iva");

      it("matches 'P. IVA: 01234567890'", () => {
        const m = scanVat("P. IVA: 01234567890");
        expect(m).toHaveLength(1);
        expect(m[0]!.matchedText).toBe("P. IVA: 01234567890");
      });

      it("matches 'Partita IVA IT01234567890'", () => {
        const m = scanVat("Partita IVA IT01234567890");
        expect(m).toHaveLength(1);
        expect(m[0]!.matchedText).toBe("Partita IVA IT01234567890");
      });

      it("matches compact 'P.IVA 12345678901'", () => {
        expect(scanVat("P.IVA 12345678901")).toHaveLength(1);
      });

      it("does NOT match a bare 11-digit number without the label", () => {
        expect(scanVat("invoice 01234567890")).toHaveLength(0);
      });

      it("does NOT match an 11-digit number inside a longer digit run", () => {
        expect(scanVat("ref 012345678901234567")).toHaveLength(0);
      });

      it("does NOT match a lowercase label (case-sensitive by design)", () => {
        expect(scanVat("p. iva 01234567890")).toHaveLength(0);
      });

      it("redacts the whole labelled span", () => {
        const res = scanContent("P. IVA: 01234567890 end");
        expect(res.redactedText).toBe("[REDACTED] end");
      });
    });

    describe("it_codice_fiscale (uppercase 16-char CF)", () => {
      const scanCf = (text: string) => scanContent(text).matches.filter(m => m.type === "it_codice_fiscale");

      it("matches a valid CF 'RSSMRA85T01A562S'", () => {
        const m = scanCf("RSSMRA85T01A562S");
        expect(m).toHaveLength(1);
        expect(m[0]!.matchedText).toBe("RSSMRA85T01A562S");
      });

      it("matches a CF inside a sentence", () => {
        expect(scanCf("codice fiscale RSSMRA75T01A562S please")).toHaveLength(1);
      });

      it("does NOT match the lowercase word 'foschi'", () => {
        expect(scanCf("il foschi di oggi")).toHaveLength(0);
      });

      it("does NOT match the uppercase word 'FOSCHI' (6 letters, no digit tail)", () => {
        expect(scanCf("FOSCHI")).toHaveLength(0);
      });

      it("does NOT match a lowercase CF (uppercase-only by design)", () => {
        expect(scanCf("rssmra85t01a562s")).toHaveLength(0);
      });

      it("redacts the CF", () => {
        const res = scanContent("CF RSSMRA85T01A562S ok");
        expect(res.redactedText).not.toContain("RSSMRA85T01A562S");
      });
    });

    describe("iban (country prefix + length >= 15)", () => {
      const scanIban = (text: string) => scanContent(text).matches.filter(m => m.type === "iban");

      it("matches a compact Italian IBAN", () => {
        const m = scanIban("IT60X0542811101000000123456");
        expect(m).toHaveLength(1);
        expect(m[0]!.matchedText).toBe("IT60X0542811101000000123456");
      });

      it("matches a compact German IBAN", () => {
        expect(scanIban("DE89370400440532013000")).toHaveLength(1);
      });

      it("matches a space-grouped German IBAN", () => {
        const m = scanIban("DE89 3704 0044 0532 0130 00");
        expect(m).toHaveLength(1);
        expect(m[0]!.matchedText).toBe("DE89 3704 0044 0532 0130 00");
      });

      it("matches GB/FR/ES IBANs", () => {
        expect(scanIban("GB29NWBK60161331926819")).toHaveLength(1);
        expect(scanIban("FR1420041010050500013M02606")).toHaveLength(1);
        expect(scanIban("ES91 2100 0418 4502 0005 1332")).toHaveLength(1);
      });

      it("matches an IBAN inside a sentence", () => {
        expect(scanIban("wire to IT60X0542811101000000123456 today")).toHaveLength(1);
      });

      it("does NOT match a random lowercase hex string", () => {
        expect(scanIban("hash deadbeefcafebabe01234567890abcdef end")).toHaveLength(0);
      });

      it("does NOT match a random uppercase alphanumeric run (no country+digit prefix shape)", () => {
        expect(scanIban("DEADBEEFCAFEBABE01234567890FFFF")).toHaveLength(0);
      });

      it("does NOT match short or prefix-only strings", () => {
        expect(scanIban("ABC123")).toHaveLength(0);
        expect(scanIban("AB12")).toHaveLength(0);
        expect(scanIban("XX12 abc")).toHaveLength(0);
      });

      it("does NOT match inside a longer word", () => {
        expect(scanIban("xIT60X0542811101000000123456x")).toHaveLength(0);
      });
    });

    describe("eu_phone (mirrored in the const; DISABLED in the DB seed AND in the fallback — 260829-xxx)", () => {
      // 260829-xxx: eu_phone carries enabled:false in DLP_PATTERNS (mirrors
      // its DB isEnabled=false seed). scanContent skips it, so the pattern's
      // FP/TP profile is verified against the exported regex DIRECTLY, and
      // the disabled behavior gets its own explicit assertions.
      const euPhone = DLP_PATTERNS.find(p => p.type === "eu_phone")!;
      const matchRegex = (text: string) => {
        euPhone.regex.lastIndex = 0;
        return euPhone.regex.test(text);
      };

      it("the const entry matches a labelled IT mobile", () => {
        expect(matchRegex("+39 333 1234567")).toBe(true);
      });

      it("the const entry does NOT match short digit runs or SSN shapes", () => {
        expect(matchRegex("12345678")).toBe(false);      // 8 digits
        expect(matchRegex("123456789")).toBe(false);     // 9 digits
        expect(matchRegex("123-45-6789")).toBe(false);   // SSN shape (10 w/ dashes)
      });

      it("enabled:false — scanContent does NOT apply eu_phone (fallback mirrors the DB seed)", () => {
        // DB-up (eu_phone isEnabled=false) allows phone-like content; the
        // DB-down fallback must behave identically. Before 260829-xxx the
        // fallback applied eu_phone and diverged.
        const res = scanContent("+39 333 1234567");
        expect(res.matches.filter(x => x.type === "eu_phone")).toHaveLength(0);
        expect(res.hasMatch).toBe(false);
      });

      it("the 16-digit card number does not reach eu_phone (credit_card wins its span)", () => {
        const res = scanContent("4111111111111111");
        // credit_card (earlier in the const) covers the span; eu_phone adds nothing
        expect(res.matches.some(x => x.type === "credit_card")).toBe(true);
        expect(res.matches.some(x => x.type === "eu_phone")).toBe(false);
      });
    });
  });

  describe("detection", () => {
    it("detects email addresses", () => {
      const result = scanContent("Contact user@example.com for help");
      expect(result.hasMatch).toBe(true);
      expect(result.matches.some(m => m.type === "email")).toBe(true);
      const emailMatch = result.matches.find(m => m.type === "email")!;
      expect(emailMatch.matchedText).toBe("user@example.com");
    });

    it("detects credit card numbers (13-16 digit sequences)", () => {
      const result = scanContent("Card: 4111111111111111");
      expect(result.hasMatch).toBe(true);
      expect(result.matches.some(m => m.type === "credit_card")).toBe(true);
      const cardMatch = result.matches.find(m => m.type === "credit_card")!;
      expect(cardMatch.matchedText).toBe("4111111111111111");
    });

    it("detects API keys (sk- prefix patterns)", () => {
      const result = scanContent("Key: sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(result.hasMatch).toBe(true);
      expect(result.matches.some(m => m.type === "api_key")).toBe(true);
      const keyMatch = result.matches.find(m => m.type === "api_key")!;
      expect(keyMatch.matchedText).toBe("sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });

    it("detects SSN patterns (XXX-XX-XXXX format)", () => {
      const result = scanContent("SSN: 123-45-6789");
      expect(result.hasMatch).toBe(true);
      expect(result.matches.some(m => m.type === "ssn")).toBe(true);
      const ssnMatch = result.matches.find(m => m.type === "ssn")!;
      expect(ssnMatch.matchedText).toBe("123-45-6789");
    });

    it("detects AWS access keys (AKIA prefix)", () => {
      const result = scanContent("AWS: AKIAIOSFODNN7EXAMPLE");
      expect(result.hasMatch).toBe(true);
      expect(result.matches.some(m => m.type === "aws_key")).toBe(true);
      const awsMatch = result.matches.find(m => m.type === "aws_key")!;
      expect(awsMatch.matchedText).toBe("AKIAIOSFODNN7EXAMPLE");
    });

    it("detects private key blocks (BEGIN/END markers)", () => {
      const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
      const result = scanContent(pem);
      expect(result.hasMatch).toBe(true);
      expect(result.matches.some(m => m.type === "private_key")).toBe(true);
      const pkMatch = result.matches.find(m => m.type === "private_key")!;
      expect(pkMatch.matchedText).toContain("BEGIN RSA PRIVATE KEY");
      expect(pkMatch.matchedText).toContain("END RSA PRIVATE KEY");
    });
  });

  describe("redaction", () => {
    it("replaces detected PII with [REDACTED]", () => {
      const result = scanContent("Contact user@example.com for help");
      expect(result.hasMatch).toBe(true);
      expect(result.redactedText).not.toContain("user@example.com");
      expect(result.redactedText).toContain("[REDACTED]");
    });

    it("redacts multiple patterns in the same text", () => {
      const text = "Email: old@test.com or admin@site.org";
      const result = scanContent(text);
      expect(result.hasMatch).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(2);
      expect(result.redactedText).not.toContain("old@test.com");
      expect(result.redactedText).not.toContain("admin@site.org");
      expect(result.redactedText).toContain("[REDACTED]");
    });

    it("preserves non-PII text unchanged", () => {
      const result = scanContent("Contact user@example.com for help");
      expect(result.hasMatch).toBe(true);
      expect(result.redactedText).toContain("Contact ");
      expect(result.redactedText).toContain(" for help");
    });
  });

  describe("edge cases", () => {
    it("returns hasMatch=false and original text unchanged when no PII present", () => {
      const text = "This is a normal message with no sensitive data.";
      const result = scanContent(text);
      expect(result.hasMatch).toBe(false);
      expect(result.matches).toEqual([]);
      expect(result.redactedText).toBe(text);
    });

    it("handles empty string input gracefully", () => {
      const result = scanContent("");
      expect(result.hasMatch).toBe(false);
      expect(result.matches).toEqual([]);
      expect(result.redactedText).toBe("");
    });

    it("handles text with only non-matching content", () => {
      const text = "Hello world 123 testing some numbers 456789";
      const result = scanContent(text);
      expect(result.hasMatch).toBe(false);
      expect(result.matches).toEqual([]);
      expect(result.redactedText).toBe(text);
    });

    it("returns unique match types from matchTypes deduplication", () => {
      const text = "a@b.com c@d.com sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const result = scanContent(text);
      expect(result.hasMatch).toBe(true);
      const types = new Set(result.matches.map(m => m.type));
      expect(types.has("email")).toBe(true);
      expect(types.has("api_key")).toBe(true);
      expect(types.size).toBe(result.matches.map(m => m.type).filter((v, i, arr) => arr.indexOf(v) === i).length);
    });
  });

  describe("progressiveDLPFlush (D-01 tail-holdback)", () => {
    const HOLDBACK = 64;

    it("buffer under holdback returns empty safePrefix and full remaining", () => {
      const result = progressiveDLPFlush("short", HOLDBACK);
      expect(result.safePrefix).toBe("");
      expect(result.remaining).toBe("short");
      expect(result.hadMatch).toBe(false);
    });

    it("buffer over holdback returns safe prefix + held-back tail", () => {
      const buffer = "a".repeat(100);
      const result = progressiveDLPFlush(buffer, HOLDBACK);
      // safeEnd = 100 - 64 = 36
      expect(result.safePrefix).toBe("a".repeat(36));
      expect(result.remaining).toBe("a".repeat(64));
      expect(result.hadMatch).toBe(false);
    });

    it("PII in safe prefix is redacted (scanContent applied)", () => {
      // 35-char api_key: sk- + 32 chars, surrounded by spaces (word boundaries)
      const apiKey = "sk-" + "A".repeat(32);
      // Place the key well inside the safe prefix with non-word chars on both sides
      const padding = "x".repeat(80);
      const buffer = padding + " " + apiKey + " " + "y".repeat(HOLDBACK + 10);
      const result = progressiveDLPFlush(buffer, HOLDBACK);
      expect(result.hadMatch).toBe(true);
      expect(result.safePrefix).not.toContain(apiKey);
      expect(result.safePrefix).toContain("[REDACTED]");
    });

    it("PII straddling the holdback boundary is held back (not flushed)", () => {
      // Construct a buffer where the sk- prefix starts in the last HOLDBACK
      // chars so the key straddles the safe-prefix/remaining boundary.
      const key = "sk-" + "B".repeat(32); // 35 chars
      const prefix = "z".repeat(120);
      // safeEnd = buffer.length - 64. We want the key to start a few chars
      // before safeEnd so it straddles. Insert key at offset = prefix.length - 5.
      const insertAt = prefix.length - 5;
      const buffer = prefix.slice(0, insertAt) + " " + key + " " + prefix.slice(insertAt) + "tail";
      const result = progressiveDLPFlush(buffer, HOLDBACK);
      // The partial key in the safe prefix must NOT contain the full key
      expect(result.safePrefix).not.toContain(key);
      // The full key must be retained in the remaining tail for the final flush
      expect(result.remaining).toContain(key);
    });

    it("hadMatch flag propagates true when scanContent finds a match in safe prefix", () => {
      const apiKey = "sk-" + "C".repeat(32);
      const buffer = "padding " + apiKey + " padding " + "q".repeat(HOLDBACK + 20);
      const result = progressiveDLPFlush(buffer, HOLDBACK);
      expect(result.hadMatch).toBe(true);
    });

    it("default holdback is 64 when omitted", () => {
      const buffer = "a".repeat(100);
      const result = progressiveDLPFlush(buffer);
      expect(result.safePrefix).toBe("a".repeat(36));
      expect(result.remaining).toBe("a".repeat(64));
    });
  });

  describe("matchedText capture (Phase 115 DLP Visibility)", () => {
    it("scanContent returns DLPMatch with matchedText for email patterns", () => {
      const result = scanContent("Contact user@example.com for help");
      expect(result.hasMatch).toBe(true);
      const emailMatch = result.matches.find(m => m.type === "email");
      expect(emailMatch).toBeDefined();
      expect(emailMatch!.matchedText).toBe("user@example.com");
    });

    it("scanContent returns DLPMatch with matchedText for credit_card patterns", () => {
      const result = scanContent("Card: 4111111111111111");
      expect(result.hasMatch).toBe(true);
      const cardMatch = result.matches.find(m => m.type === "credit_card");
      expect(cardMatch?.matchedText).toBe("4111111111111111");
    });

    it("scanContent returns DLPMatch with matchedText for api_key patterns", () => {
      const result = scanContent("Key: sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(result.hasMatch).toBe(true);
      const keyMatch = result.matches.find(m => m.type === "api_key");
      expect(keyMatch?.matchedText).toBe("sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });

    it("scanContent returns DLPMatch with matchedText for ssn patterns", () => {
      const result = scanContent("SSN: 123-45-6789");
      expect(result.hasMatch).toBe(true);
      const ssnMatch = result.matches.find(m => m.type === "ssn");
      expect(ssnMatch?.matchedText).toBe("123-45-6789");
    });

    it("scanContent returns DLPMatch with matchedText for aws_key patterns", () => {
      const result = scanContent("AWS: AKIAIOSFODNN7EXAMPLE");
      expect(result.hasMatch).toBe(true);
      const awsMatch = result.matches.find(m => m.type === "aws_key");
      expect(awsMatch?.matchedText).toBe("AKIAIOSFODNN7EXAMPLE");
    });

    it("scanContent returns DLPMatch with matchedText for private_key patterns", () => {
      const result = scanContent("-----BEGIN RSA PRIVATE KEY-----\nABCD\n-----END RSA PRIVATE KEY-----");
      expect(result.hasMatch).toBe(true);
      const pkMatch = result.matches.find(m => m.type === "private_key");
      expect(pkMatch).toBeDefined();
      expect(pkMatch!.matchedText).toContain("BEGIN RSA PRIVATE KEY");
    });

    it("matchedText is additive and backward compatible with existing DLPMatch fields", () => {
      const text = "Email: old@test.com";
      const result = scanContent(text);
      expect(result.matches.length).toBeGreaterThan(0);
      const match = result.matches[0]!;
      // Existing fields still work
      expect(match.type).toBe("email");
      expect(match.index).toBeGreaterThanOrEqual(0);
      expect(match.length).toBeGreaterThan(0);
      // New field
      expect(match.matchedText).toBe("old@test.com");
    });

    it("scanContent returns multiple matches each with correct matchedText", () => {
      const text = "Contact user@test.com or admin@site.org";
      const result = scanContent(text);
      expect(result.matches.length).toBeGreaterThanOrEqual(2);
      const texts = result.matches.filter(m => m.type === "email").map(m => m.matchedText);
      expect(texts).toContain("user@test.com");
      expect(texts).toContain("admin@site.org");
    });
  });

  describe("progressiveDLPFlush (D-01 tail-holdback)", () => {
    const HOLDBACK = 64;

    it("buffer under holdback returns empty safePrefix and full remaining", () => {
      // Simulate end-of-stream: a key that completed inside the remaining tail
      const key = "sk-" + "D".repeat(32);
      const remaining = "lead-in " + key + " trailing";
      // Mirrors chat.ts end-of-stream: scanContent(remaining) on held-back tail
      const finalScan = scanContent(remaining);
      expect(finalScan.hasMatch).toBe(true);
      expect(finalScan.redactedText).not.toContain(key);
      expect(finalScan.redactedText).toContain("[REDACTED]");
    });

    it("default holdback is 64 when omitted", () => {
      const buffer = "a".repeat(100);
      const result = progressiveDLPFlush(buffer);
      expect(result.safePrefix).toBe("a".repeat(36));
      expect(result.remaining).toBe("a".repeat(64));
    });
  });
});
