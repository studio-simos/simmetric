-- Phase 207 (CLOUD-03/04/06): quota engine — additive only.
-- QuotaReset ledger (D-02): anchor rows bound rolling windows; usage/cost
-- history is never deleted or rewritten (203 snapshot doctrine).
CREATE TABLE "quota_resets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_resets_pkey" PRIMARY KEY ("id")
);

-- D-11 idempotency backstop: one anchor per user/kind/instant.
CREATE UNIQUE INDEX "quota_resets_user_id_kind_at_key" ON "quota_resets"("userId", "kind", "at");
CREATE INDEX "quota_resets_user_id_kind_at_idx" ON "quota_resets"("userId", "kind", "at");

-- Phase 207 (D-07): per-user quota settings on User — additive nullable
-- columns (206 D-11 idiom). Unset = unlimited (D-08 fail-open resolution).
ALTER TABLE "users" ADD COLUMN "tokenQuotaLimit" INTEGER,
  ADD COLUMN "storageQuotaGb" DECIMAL(12,2),
  ADD COLUMN "tokenQuotaUnlimited" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storageQuotaUnlimited" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "resetAnchorDate" TIMESTAMP(3);

-- Add foreign key
ALTER TABLE "quota_resets" ADD CONSTRAINT "quota_resets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
