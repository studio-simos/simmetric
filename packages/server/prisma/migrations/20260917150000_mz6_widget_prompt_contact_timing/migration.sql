-- Quick 260917-mz6 (widget grounding + contact options + lead timing):
-- additive columns on the widgets table. Additive-only: every added column
-- is nullable or carries a default, so there is NO UPDATE/INSERT/DELETE
-- backfill arm (Prisma generated none — statement set verbatim from
-- `prisma migrate diff --from-migrations`).
--
--   systemPrompt              TEXT NULL   — per-widget grounding prompt; null
--                                           = the code default (widgetChatPrompt.ts)
--   contactConfig             JSONB NULL  — contact-options blob shown when
--                                           the daily response limit trips
--   leadCaptureTiming         TEXT NOT NULL DEFAULT 'end' — email-capture
--                                           moment ("start" | "end" | "timeout");
--                                           existing rows read "end" (the
--                                           pre-feature behavior)
--   leadCaptureTimeoutSeconds INTEGER NULL — pairs with timing = "timeout"
--
-- No DROP/TRUNCATE/ALTER COLUMN TYPE. No index/constraint changes.

-- AlterTable
ALTER TABLE "widgets" ADD COLUMN     "contactConfig" JSONB,
ADD COLUMN     "leadCaptureTimeoutSeconds" INTEGER,
ADD COLUMN     "leadCaptureTiming" TEXT NOT NULL DEFAULT 'end',
ADD COLUMN     "systemPrompt" TEXT;