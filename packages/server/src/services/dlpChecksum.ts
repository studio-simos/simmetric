// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP checksum validator tier (Phase 192 Task 2 — D-02).
 *
 * Pure validation utility for the document-scan pipeline: given a candidate
 * string, decide whether it is a CHECKSUM-VALID Italian Codice Fiscale,
 * Partita IVA, or a mod-97-valid IBAN. The scan pipeline (plan 02) runs
 * these behind the lexical DLP patterns; the eval suite (plan 06) runs them
 * OFFLINE — so this module is deliberately PURE: no prisma, no env, no
 * logger imports, no I/O, no clock.
 *
 * ── Validation arms (the plan's arm-switch clause, resolved) ──────────────
 *
 * Codice Fiscale — stdnum (lib/cjs/it/codicefiscale) is the PRIMARY arm for
 * the ODD/EVEN-table checksum, with OFFICIAL parity: verified this session
 * against the Wikipedia fixture VRNGNY07D68C351V and the codice-fiscale npm
 * fixture MRTMTT25D09F205Z. Two documented corrections:
 *
 * 1. Omocodia decode is OURS. stdnum 1.12.6's `checkRe` ACCEPTS omocodia
 *    letters in the digit slots but does NOT decode them before the checksum
 *    (a letter-substituted CF like RSSMRAU5ML1A001X fails its validate()).
 *    normalizeCodiceFiscale therefore performs the decode-FIRST
 *    normalization before handing the canonical form to stdnum.
 * 2. Parity correction. 192-RESEARCH.md's probe tables carry INVERTED
 *    parity (ODD table applied at 0-based even indices); its fixture
 *    RSSMRA85M01A001R is invalid under the official algorithm — the correct
 *    check letter for RSSMRA85M01A001 is X. The fixture battery was re-pinned
 *    to official parity: canonical RSSMRA85M01A001X and omocodia
 *    RSSMRAU5ML1A001X validate true; RSSMRA85M01A001R validates false.
 *
 * The omocodia slot list: the plan/research text says "1-based positions
 * 6,7,9,10,12,13,14", but those indices are the official DIGIT slots only
 * when read 0-BASED (1-based 7,8,10,11,13,14,15 — birth-year, birth-day and
 * comune digits; the research mislabeled the base). The probe-verified
 * decode below uses 0-based [6,7,9,10,12,13,14], letters LMNPQRSTUV → 0-9.
 *
 * Partita IVA — stdnum (lib/cjs/it/iva) primary arm, probe-verified:
 * 00743110157 true / 00743110158 false (research A2: only this verified
 * fixture pair is trusted).
 *
 * IBAN — VENDORED mod-97 (ISO 7064) arm: stdnum 1.12.6 ships NO IBAN
 * validator (no iban module in its lib/cjs tree — verified at install
 * time). Algorithm verbatim from 192-RESEARCH.md §Checksum Algorithms,
 * probe-verified: IT60X0542811101000000123456 true, one-digit-off false,
 * generic lengths ≥15 accepted (research A8), spaced 4-char groups
 * normalized at the boundary.
 *
 * Purity + DoS guard (T-192-03): every validator is a length-bounded,
 * branch-only function over its (short) input — no regex backtracking risk,
 * no unbounded loops. IBAN inputs are capped at the ISO 13616 maximum of 34
 * chars and must match the standard shape (2 letters + 2 check digits +
 * alphanumerics) before the mod-97 walk.
 */

import * as itCodiceFiscale from "stdnum/lib/cjs/it/codicefiscale";
import * as itIva from "stdnum/lib/cjs/it/iva";

/**
 * 0-BASED character slots that may carry omocodia letters (the official
 * digit slots of the CF: 1-based 7,8,10,11,13,14,15). See the header note
 * on the research's base labeling.
 */
const OMOCODIA_POSITIONS = [6, 7, 9, 10, 12, 13, 14] as const;

/** Omocodia letter → digit map (LMNPQRSTUV ↔ 0-9, probe-verified). */
const OMOCODIA_LETTER_TO_DIGIT: Record<string, string> = {
  L: "0",
  M: "1",
  N: "2",
  P: "3",
  Q: "4",
  R: "5",
  S: "6",
  T: "7",
  U: "8",
  V: "9",
};

/** Canonical 16-char CF shape AFTER omocodia decode (checksum still pending). */
const CANONICAL_CF_RE = /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/;

/** Standard IBAN shape: 2 country letters + 2 check digits + BBAN alphanumerics. */
const IBAN_SHAPE_RE = /^[A-Z]{2}\d{2}[A-Z0-9]+$/;

/** ISO 13616 length bounds (Norway's 15 is the minimum; 34 the maximum). */
const IBAN_MIN_LENGTH = 15;
const IBAN_MAX_LENGTH = 34;

/**
 * Normalize a candidate Codice Fiscale to its CANONICAL form:
 * uppercase, whitespace-stripped, omocodia letters at the digit slots
 * decoded back to digits. Returns null for anything that cannot be a
 * canonical 16-char CF after normalization (wrong length, characters the
 * canonical shape cannot accommodate). Does NOT validate the checksum —
 * isValidCodiceFiscale layers stdnum on top of this.
 */
export function normalizeCodiceFiscale(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (compact.length !== 16) return null;

  const chars = compact.split("");
  for (const idx of OMOCODIA_POSITIONS) {
    const letter = chars[idx] ?? "";
    const digit = OMOCODIA_LETTER_TO_DIGIT[letter];
    if (digit !== undefined) {
      chars[idx] = digit;
    }
  }
  const decoded = chars.join("");
  if (!CANONICAL_CF_RE.test(decoded)) return null;
  return decoded;
}

/**
 * Checksum-validated Codice Fiscale, omocodia-tolerant: the omocodia form
 * is decoded to canonical FIRST (stdnum does not decode), then stdnum's
 * official-parity table checksum runs on the canonical form.
 */
export function isValidCodiceFiscale(raw: string): boolean {
  const canonical = normalizeCodiceFiscale(raw);
  if (canonical === null) return false;
  return itCodiceFiscale.validate(canonical).isValid;
}

/**
 * Checksum-validated Partita IVA (11 digits, Luhn-variant): whitespace-
 * stripped, strict 11-digit guard at the boundary, then stdnum's
 * probe-verified validator (00743110157 true / 00743110158 false).
 */
export function isValidPartitaIva(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^\d{11}$/.test(compact)) return false;
  return itIva.validate(compact).isValid;
}

/**
 * Mod-97 (ISO 7064) IBAN validation, generic over country (research A8:
 * accept all lengths ≥15 so non-Italian IBANs stored in Italian documents
 * still validate). VENDORED because stdnum 1.12.6 ships no IBAN validator.
 * Accepts spaced 4-char groups and lowercase; enforces the standard shape
 * and the 15..34 length band before the 9-digit-chunk mod-97 walk.
 */
export function isValidIban(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (compact.length < IBAN_MIN_LENGTH || compact.length > IBAN_MAX_LENGTH) return false;
  if (!IBAN_SHAPE_RE.test(compact)) return false;

  const reordered = compact.slice(4) + compact.slice(0, 4);
  const numeric = reordered.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0n;
  for (const chunk of numeric.match(/.{1,9}/g) ?? []) {
    remainder = BigInt(remainder.toString() + chunk) % 97n;
  }
  return remainder === 1n;
}