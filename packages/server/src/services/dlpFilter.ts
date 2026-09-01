// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP (Data Loss Prevention) Content Filter Service
 *
 * Regex-based PII pattern matching for air-gap compatible privacy protection.
 * Pure utility -- no DB access, no logging, no side effects.
 * Logging and event creation happen in the agent.ts route layer.
 *
 * Per D-12 through D-15 and D-13 (revised): scanContent detects PII patterns
 * and produces redacted text. Callers decide whether to log, redact, or both.
 */
interface DLPMatch {
  type: string;
  index: number;
  length: number;
  /** Phase 115: the actual matched substring from the original text */
  matchedText: string;
}

export interface DLPResult {
  hasMatch: boolean;
  matches: DLPMatch[];
  redactedText: string;
}

/**
 * Compiled regex patterns for common PII types.
 * All patterns use the 'g' (global) flag.
 * Module-scope for performance -- compiled once, not per invocation.
 *
 * Quick 260829-xb1: extended with 4 EU/IT built-ins (it_vat_iva,
 * it_codice_fiscale, iban, eu_phone). This const is the GRACEFUL-DEGRADATION
 * fallback used by scanContentAsync when the DB is unreachable — it must
 * mirror the 10 built-in rows seeded by the
 * 20260829120000_add_dlp_patterns + 20260829215854_add_dlp_patterns_eu
 * migrations (same sources + 'gu' flags). eu_phone is seeded DISABLED in the
 * DB (high false-positive risk, admin review required) — 260829-xxx fix: the
 * optional `enabled: false` flag makes the fallback mirror that state too.
 * Before the flag, scanContent (the sync fallback + the memory
 * classifySensitivity gate) denied every phone-like string while the DB path
 * allowed it — a silent DB-up/DB-down behavior divergence that also killed
 * the MEM-03 phone→medium soft bump (the bump regex \d{3}[-.]?\d{3}[-.]?\d{4}
 * is a strict subset of eu_phone's, so the bump branch was unreachable).
 * scanContent skips disabled entries; the regex stays exported for direct
 * pattern tests and for scanContentAsync's DB-down mapping (which filters by
 * DB isEnabled anyway).
 */
export const DLP_PATTERNS: Array<{ type: string; regex: RegExp; enabled?: boolean }> = [
  {
    type: "email",
    regex: /(?<![\p{L}\p{N}_])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?![\p{L}\p{N}_])/gu,
  },
  {
    type: "credit_card",
    regex: /(?<![\p{L}\p{N}_])(?:\p{N}[ -]*?){13,16}(?![\p{L}\p{N}_])/gu,
  },
  {
    type: "api_key",
    regex: /\b(sk-[a-zA-Z0-9]{32,})\b/g,
  },
  {
    type: "ssn",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    type: "aws_key",
    regex: /\b(AKIA[0-9A-Z]{16})\b/g,
  },
  {
    type: "private_key",
    regex: /-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----[\s\S]*?-----END (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/g,
  },
  // --- EU/IT built-ins (quick 260829-xb1) — mirror of the
  // 20260829215854_add_dlp_patterns_eu migration rows (sources + 'gu' flags).
  // FP profiles: label-anchored VAT, uppercase-only 16-char codice fiscale,
  // IBAN with country prefix + length >= 15, phone seeded DISABLED in the DB
  // (mirrored here for DB-down fallback parity only).
  {
    type: "it_vat_iva",
    // Label-anchored: the 11-digit number only matches after an explicit
    // "P. IVA" / "P.IVA." / "Partita IVA" label — a bare 11-digit number
    // (random invoice id) does NOT match.
    regex: /\b(?:P\.\s?IVA\.?|Partita\s+IVA)[:\s]*(?:IT)?\s?([0-9]{11})\b/gu,
  },
  {
    type: "it_codice_fiscale",
    // Classic 16-char codice fiscale, uppercase-only (canonical form):
    // lowercase prose like "foschi"/"FOSCHI" can never match.
    regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gu,
  },
  {
    type: "iban",
    // Country prefix (2 letters + 2 check digits) + total length >= 15, in a
    // compact OR single-space-grouped form. Two linear branches — no
    // nested-optional quantifier (ReDoS-safe). Lowercase runs never match.
    regex: /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/gu,
  },
  {
    type: "eu_phone",
    // Seeded DISABLED in the DB (high false-positive risk — matches order /
    // reference digit runs). 260829-xxx fix: `enabled: false` mirrors that
    // state in the fallback so DB-up and DB-down behave identically for
    // phones. The regex itself stays exported for direct pattern tests and
    // for scanContentAsync's DB-down mapping (which re-checks DB isEnabled).
    // See 20260829215854_add_dlp_patterns_eu.
    regex: /\b(?:\+39|39)?[\s.-]?\d{3}[\s.-]?\d{3,4}[\s.-]?\d{4}\b/gu,
    enabled: false,
  },
];

/**
 * Scan text content for PII patterns.
 *
 * For each DLP pattern, collects match metadata (type, index, length)
 * from the original text and applies [REDACTED] replacement on a copy.
 * Disabled entries (enabled: false — mirroring DB-seeded isEnabled=false
 * rows) are skipped so the DB-down fallback matches the DB-up behavior.
 *
 * @param text - The content to scan
 * @returns DLPResult with match metadata and redacted version of the text
 */
export function scanContent(text: string): DLPResult {
  const matches: DLPMatch[] = [];
  let redactedText = text;

  for (const pattern of DLP_PATTERNS) {
    // 260829-xxx: skip disabled entries — the fallback must mirror the
    // seeded DB state (eu_phone isEnabled=false), not diverge from it.
    if (pattern.enabled === false) continue;
    // Reset lastIndex before each pattern -- global regex tracks state
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      matches.push({
        type: pattern.type,
        index: match.index,
        length: match[0].length,
        matchedText: match[0],
      });
    }
    // Replace matches on the redacted copy
    redactedText = redactedText.replace(pattern.regex, "[REDACTED]");
  }

  return {
    hasMatch: matches.length > 0,
    matches,
    redactedText,
  };
}

/**
 * Pattern-provider shape shared by the built-in DLP_PATTERNS const and the
 * DB-backed rows (quick 260829-ony). `replacement` is optional — built-in
 * const entries omit it and get the [REDACTED] default; DB rows carry their
 * per-row replacement.
 */
export interface ScanPattern {
  type: string;
  regex: RegExp;
  replacement?: string;
}

/**
 * Core scan over an EXPLICIT pattern list (quick 260829-ony).
 *
 * Same algorithm as scanContent, but the pattern set is a parameter:
 * - scanContent(text) === scanWithPatterns(text, DLP_PATTERNS)
 * - scanContentAsync(text) resolves the DB set (built-in fallback on DB
 *   failure) and delegates here.
 *
 * Ordering contract (spec §4.3): sequential redaction — the first pattern
 * that matches wins on a given span; already-redacted text is not re-scanned
 * because the replacement substitutes [REDACTED] before later patterns run.
 * Match INDICES are reported against the ORIGINAL text per pattern pass (each
 * pattern runs exec against the pristine `text`, replace runs on the mutated
 * copy) — same behavior as scanContent since Phase 100.
 */
export function scanWithPatterns(text: string, patterns: ScanPattern[]): DLPResult {
  const matches: DLPMatch[] = [];
  let redactedText = text;

  for (const pattern of patterns) {
    // Reset lastIndex before each pattern -- global regex tracks state
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      matches.push({
        type: pattern.type,
        index: match.index,
        length: match[0].length,
        matchedText: match[0],
      });
      if (match[0].length === 0) {
        // Zero-length match guard (DB patterns are admin-authored; `a*`-style
        // sources would spin forever). Force lastIndex progress.
        pattern.regex.lastIndex += 1;
        if (pattern.regex.lastIndex > text.length) break;
      }
    }
    // Replace matches on the redacted copy
    redactedText = redactedText.replace(pattern.regex, pattern.replacement ?? "[REDACTED]");
  }

  return {
    hasMatch: matches.length > 0,
    matches,
    redactedText,
  };
}

/**
 * Async DB-backed scan (quick 260829-ony — DLP_FEATURES_SPEC §2.3/§2.4).
 *
 * Resolution order:
 * 1. Compiled DB patterns via dlpPatternService.getActiveCompiledPatterns()
 *    (5-min TTL row cache + per-row compiled-regex cache — spec §4.5/§2.4).
 * 2. On ANY service error (DB unreachable): log + fall back to the built-in
 *    DLP_PATTERNS const (spec §2.4 graceful degradation).
 * 3. Empty ENABLED set (admin disabled everything or table seeded empty):
 *    NO scanning — an admin disabling all patterns means it (the built-in
 *    const is NOT re-merged here: the DB is the source of truth).
 *
 * The sync scanContent stays untouched for backward compatibility — the
 * per-token progressive flush keeps the sync built-in path in v1 (spec §4.1
 * v1 decision); this async variant applies to the dlp plugin inlet/outlet and
 * the end-of-stream final flush.
 */
export async function scanContentAsync(text: string): Promise<DLPResult> {
  let patterns: ScanPattern[];
  try {
    const { getActiveCompiledPatterns } = await import("./dlpPatternService");
    patterns = await getActiveCompiledPatterns();
  } catch (err: unknown) {
    // Lazy import keeps the unit-test surface (dlpPlugin.test.ts mocks the
    // service module wholesale) and avoids a module-load cycle.
    try {
      const { logDbFallback } = await import("./dlpPatternService");
      logDbFallback(err);
    } catch {
      // Service module itself unresolvable (should never happen) — stay silent,
      // the built-in fallback below is the behavior that matters.
    }
    void err;
    // 260829-xxx: filter disabled entries (eu_phone mirrors its DB
    // isEnabled=false seed) so the DB-down fallback matches DB-up behavior.
    patterns = DLP_PATTERNS
      .filter((p) => p.enabled !== false)
      .map((p) => ({ type: p.type, regex: p.regex }));
  }
  return scanWithPatterns(text, patterns);
}

/**
 * Progressive DLP flush result.
 * - safePrefix: DLP-scanned portion of the buffer safe to emit to the client
 *   (already redacted if any PII pattern matched). Empty while inside the
 *   holdback window.
 * - remaining: the tail of the buffer held back for the next flush (may
 *   complete a PII pattern that started near the boundary).
 * - hadMatch: true if scanContent found a PII match in the safe prefix.
 */
export interface ProgressiveFlushResult {
  safePrefix: string;
  remaining: string;
  hadMatch: boolean;
  /**
   * Matches found in the flushed safe prefix (empty when hadMatch is false).
   * quick 260829-m6p: lets the streaming route accumulate per-flush matches
   * so the end-of-run dlp.output_match event can carry the full match list
   * instead of deriving it from the last tail scan only.
   */
  matches: DLPMatch[];
}

/**
 * D-01 tail-holdback progressive flush.
 *
 * Splits `buffer` into a DLP-scanned safe prefix and a held-back tail. The
 * holdback window (default 64 char) is >= the longest DLP pattern (35 char
 * `sk-[a-zA-Z0-9]{32,}`) so PII can never be split across flush boundaries:
 * any pattern that would straddle the boundary is kept entirely in the
 * remaining tail until more data arrives or the stream ends.
 *
 * Callers MUST run a final `scanContent(remaining)` (or, since 260829-ony,
 * `await scanContentAsync(remaining)`) at end-of-stream to redact any PII
 * that completed inside the held-back tail.
 *
 * @param buffer - accumulated streaming text so far
 * @param holdback - tail length to retain (default 64, >= longest DLP pattern)
 * @param patterns - optional explicit pattern set (quick 260829-ony). Defaults
 *   to the built-in DLP_PATTERNS const — the per-token progressive flush stays
 *   sync on the built-ins in v1 (spec §4.1); the end-of-stream FINAL flush
 *   uses scanContentAsync instead of extending this call.
 */
export function progressiveDLPFlush(
  buffer: string,
  holdback: number = 64,
  patterns: ScanPattern[] = DLP_PATTERNS,
): ProgressiveFlushResult {
  if (buffer.length <= holdback) {
    return { safePrefix: "", remaining: buffer, hadMatch: false, matches: [] };
  }
  let safeEnd = buffer.length - holdback;
  if (safeEnd > 0) {
    const codeUnit = buffer.charCodeAt(safeEnd - 1);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      safeEnd += 1;
    }
  }
  const rawSafePrefix = buffer.slice(0, safeEnd);
  const scan = scanWithPatterns(rawSafePrefix, patterns);
  return {
    safePrefix: scan.hasMatch ? scan.redactedText : rawSafePrefix,
    remaining: buffer.slice(safeEnd),
    hadMatch: scan.hasMatch,
    matches: scan.matches,
  };
}
