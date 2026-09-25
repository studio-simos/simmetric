-- AlterTable
ALTER TABLE "provider_models" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "inputCostPerToken" DECIMAL(18,10),
ADD COLUMN     "lastCostUpdated" TIMESTAMP(3),
ADD COLUMN     "lastCostUpdatedBy" TEXT,
ADD COLUMN     "outputCostPerToken" DECIMAL(18,10);

-- AlterTable
ALTER TABLE "workspace_token_usage" ADD COLUMN     "completionCost" DECIMAL(18,6),
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "promptCost" DECIMAL(18,6),
ADD COLUMN     "totalCost" DECIMAL(18,6);

-- Phase 203 (MCC-01, D2): local models default $0.00 (explicit "free") —
-- unset cloud models stay NULL ("N/A"). Historical usage rows keep cost
-- columns NULL (snapshot contract: no backfill recalculation).
UPDATE "provider_models" SET "inputCostPerToken" = 0, "outputCostPerToken" = 0, "currency" = 'USD' WHERE "isLocal" = true;
