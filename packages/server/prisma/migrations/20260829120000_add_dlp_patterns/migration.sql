-- =============================================================================
-- Quick 260829-ony (DLP_FEATURES_SPEC §2.3) — DLP pattern configuration.
--
-- Strictly ADDITIVE: one new table + its index + 6 idempotent built-in seed
-- rows. No column/table drops, no data rewrites (additive-only policy — see
-- docs/MIGRATION_SAFETY.md).
--
-- The 6 seeded rows mirror the hardcoded DLP_PATTERNS const in
-- packages/server/src/services/dlpFilter.ts (pattern source string + flags).
-- They keep that const's behavior alive as DB rows so scanContentAsync serves
-- the same redaction set from the DB, while the const remains the fallback
-- when the DB is unreachable (spec §2.4 graceful degradation).
--
-- INSERT ... ON CONFLICT (name) DO NOTHING makes this migration safe to replay
-- against any environment that already seeded the rows (idempotent), and gives
-- EXISTING deployments the 6 built-ins without running db:seed (spec Fase 3 —
-- migration-seed approach, chosen over a boot-seed path).
-- =============================================================================

-- CreateTable
CREATE TABLE IF NOT EXISTS "dlp_patterns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "patternFlags" TEXT NOT NULL DEFAULT 'gu',
    "replacement" TEXT NOT NULL DEFAULT '[REDACTED]',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dlp_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "dlp_patterns_name_key" ON "dlp_patterns"("name");

-- Seed the 6 built-in patterns (idempotent replay; name is the natural key).
-- pattern source strings are copied verbatim from DLP_PATTERNS in dlpFilter.ts
-- (unicode property escapes need the 'u' flag — flags are 'gu' for all six).
INSERT INTO "dlp_patterns" ("id", "name", "displayName", "pattern", "patternFlags", "replacement", "isEnabled", "isBuiltIn", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'email', 'Email', '(?<![\p{L}\p{N}_])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?![\p{L}\p{N}_])', 'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'credit_card', 'Credit Card', '(?<![\p{L}\p{N}_])(?:\p{N}[ -]*?){13,16}(?![\p{L}\p{N}_])', 'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP + interval '1 millisecond', CURRENT_TIMESTAMP + interval '1 millisecond'),
  (gen_random_uuid()::text, 'api_key', 'API Key', '\b(sk-[a-zA-Z0-9]{32,})\b', 'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP + interval '2 milliseconds', CURRENT_TIMESTAMP + interval '2 milliseconds'),
  (gen_random_uuid()::text, 'ssn', 'SSN', '\b\d{3}-\d{2}-\d{4}\b', 'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP + interval '3 milliseconds', CURRENT_TIMESTAMP + interval '3 milliseconds'),
  (gen_random_uuid()::text, 'aws_key', 'AWS Key', '\b(AKIA[0-9A-Z]{16})\b', 'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP + interval '4 milliseconds', CURRENT_TIMESTAMP + interval '4 milliseconds'),
  (gen_random_uuid()::text, 'private_key', 'Private Key', '-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----[\s\S]*?-----END (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----', 'gu', '[REDACTED]', true, true, CURRENT_TIMESTAMP + interval '5 milliseconds', CURRENT_TIMESTAMP + interval '5 milliseconds')
ON CONFLICT ("name") DO NOTHING;