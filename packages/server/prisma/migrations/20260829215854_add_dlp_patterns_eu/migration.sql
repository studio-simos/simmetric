-- =============================================================================
-- Quick 260829-xb1 — DLP patterns: EU/IT built-ins (data-only, additive).
--
-- Strictly ADDITIVE: no schema change (dlp_patterns table already exists from
-- 20260829120000_add_dlp_patterns). Data-only: 4 idempotent built-in seed rows
-- via INSERT ... ON CONFLICT (name) DO NOTHING (additive-only policy — see
-- docs/MIGRATION_SAFETY.md).
--
-- The 4 new rows mirror additions to the hardcoded DLP_PATTERNS const in
-- packages/server/src/services/dlpFilter.ts (pattern source string + flags),
-- so the DB-down graceful-degradation fallback (DLP_FEATURES_SPEC §2.4)
-- covers the same set. DB is the source of truth; admins can disable any
-- built-in row at runtime. Total built-ins after this migration: 10 (6 + 4).
--
-- Idempotent replay: ON CONFLICT (name) DO NOTHING — safe to re-apply against
-- any environment that already has the rows. ids use gen_random_uuid()::text
-- (same as the 2026-08-29 built-ins); updatedAt must be non-NULL (table DDL
-- has no default) so CURRENT_TIMESTAMP is provided explicitly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- it_vat_iva — Partita IVA (Italian VAT number), 11 digits.
--
-- FALSE-POSITIVE PROFILE (low): label-anchored — the 11-digit number is ONLY
-- matched when explicitly preceded by "P. IVA" / "P.IVA." / "Partita IVA".
-- A bare 11-digit number (e.g. a random invoice id) does NOT match. Verified:
-- "P. IVA: 01234567890" matches; bare "01234567890" does not. The (IT)?
-- prefix covers the "Partita IVA IT01234567890" written form. Matching is
-- intentionally case-sensitive: the "P. IVA" label is canonical.
-- -----------------------------------------------------------------------------
INSERT INTO "dlp_patterns" ("id", "name", "displayName", "pattern", "patternFlags", "replacement", "isEnabled", "isBuiltIn", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'it_vat_iva', 'Partita IVA (IT)',
        '\b(?:P\.\s?IVA\.?|Partita\s+IVA)[:\s]*(?:IT)?\s?([0-9]{11})\b',
        'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

-- -----------------------------------------------------------------------------
-- it_codice_fiscale — Italian tax ID, classic 16-char uppercase form
-- (6 letters + 2 digits + letter + 2 digits + letter + 3 digits + letter).
--
-- FALSE-POSITIVE PROFILE (low): uppercase-only by design — CFs are canonically
-- uppercase, so lowercase prose ("foschi" or "FOSCHI", 6 letters, no digit
-- tail) can never match. Verified: RSSMRA85T01A562S matches; FOSCHI /
-- "foschi" do not. A lowercase CF in text will not match (accepted for v1 to
-- keep the FP rate at zero; see changelog).
-- -----------------------------------------------------------------------------
INSERT INTO "dlp_patterns" ("id", "name", "displayName", "pattern", "patternFlags", "replacement", "isEnabled", "isBuiltIn", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'it_codice_fiscale', 'Codice Fiscale (IT)',
        '\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b',
        'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP + interval '1 millisecond', CURRENT_TIMESTAMP + interval '1 millisecond')
ON CONFLICT ("name") DO NOTHING;

-- -----------------------------------------------------------------------------
-- iban — International Bank Account Number.
--
-- FALSE-POSITIVE PROFILE (low): requires the strong self-describing structure
-- — 2-letter country code + 2 check digits + >= 11 more uppercase alphanumerics
-- (total length >= 15). Two linear branches (no nested-optional quantifier —
-- ReDoS-safe, verified a 204-char near-miss runs in microseconds):
--   1. compact form:  IT60X0542811101000000123456
--   2. space-grouped: DE89 3704 0044 0532 0130 00
-- Per-country exact lengths are overkill for v1. Uppercase-only: lowercase
-- hex/base64 runs never match. NOTE (ordering, spec §4.3 first-match-wins):
-- a space-grouped IBAN contains a 13-16-digit consecutive span in the
-- trailing groups; in the built-in const credit_card runs first and redacts
-- the trailing digit span (the country+check prefix is left intact). DB order
-- is createdAt-ascending and matches the const for the same reason.
-- -----------------------------------------------------------------------------
INSERT INTO "dlp_patterns" ("id", "name", "displayName", "pattern", "patternFlags", "replacement", "isEnabled", "isBuiltIn", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'iban', 'IBAN',
        '\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b',
        'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP + interval '2 milliseconds', CURRENT_TIMESTAMP + interval '2 milliseconds')
ON CONFLICT ("name") DO NOTHING;

-- -----------------------------------------------------------------------------
-- eu_phone — Phone numbers IT/EU.
--
-- FALSE-POSITIVE PROFILE (HIGH — seeded DISABLED, spec-locked v1 decision).
-- Any structured phone regex (>= 8 digit characters in grouped runs, with or
-- without the +39/39 prefix) necessarily matches order numbers, invoice ids,
-- reference codes etc. This row is seeded with isEnabled = false so admins
-- must review and enable it deliberately (Settings → Advanced → DLP
-- Patterns); scanContentAsync only loads isEnabled rows, so the shipped
-- behavior does NOT redact phone-like digit runs. displayName carries the
-- warning; the built-in DLP_PATTERNS const in dlpFilter.ts mirrors the same
-- source for DB-down fallback parity only — the fallback serves the same
-- enabled/disabled intent as the DB set.
-- -----------------------------------------------------------------------------
INSERT INTO "dlp_patterns" ("id", "name", "displayName", "pattern", "patternFlags", "replacement", "isEnabled", "isBuiltIn", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'eu_phone', 'Phone (IT/EU) — high false positives',
        '\b(?:\+39|39)?[\s.-]?\d{3}[\s.-]?\d{3,4}[\s.-]?\d{4}\b',
        'gu', '[REDACTED]', false, true, CURRENT_TIMESTAMP + interval '3 milliseconds', CURRENT_TIMESTAMP + interval '3 milliseconds')
ON CONFLICT ("name") DO NOTHING;