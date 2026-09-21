-- Quick 260917-qoh (privacy consent + per-widget prompt): additive columns.
-- Additive-only: every added column is nullable or carries a default, so
-- there is NO UPDATE/INSERT/DELETE backfill arm (statement set in the
-- `prisma migrate diff` shape — one ALTER TABLE per table, verbatim format).
--
--   widgets.privacyUrl              TEXT NULL   — per-widget privacy policy
--                                                 page URL (shown beside the
--                                                 lead consent checkbox)
--   widget_leads.privacyConsented   BOOLEAN NOT NULL DEFAULT false — archived
--                                                 consent decision (always
--                                                 true for post-feature rows;
--                                                 the default keeps
--                                                 pre-existing rows parsing)
--   widget_leads.privacyConsentAt   TIMESTAMP(3) NULL — SERVER clock at
--                                                 submission (never
--                                                 client-supplied, T-Q02)
--
-- No DROP/TRUNCATE/ALTER COLUMN TYPE. No index/constraint changes.

-- AlterTable
ALTER TABLE "widgets" ADD COLUMN     "privacyUrl" TEXT;

-- AlterTable
ALTER TABLE "widget_leads" ADD COLUMN     "privacyConsentAt" TIMESTAMP(3),
ADD COLUMN     "privacyConsented" BOOLEAN NOT NULL DEFAULT false;