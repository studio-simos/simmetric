-- =============================================================================
-- Phase 151 (RAG Search Fixes — 151-02, G-151-1b) widget sessionLimitPerDay
-- migration.
-- D-02: strictly additive — ADD COLUMN only, no data-rewriting statements.
-- The column carries the per-widget daily MESSAGE limit (null = global default
-- of 5 messages/day prod / 50/day dev); it is enforced by the widget service's
-- widgetDailyMessageLimiter on POST /api/chat/:widgetId/stream (per-widget+IP,
-- 24h window), reading the value from the Redis widget:config:{widgetId} cache
-- (which is populated from the internal config route response).
-- =============================================================================

-- AlterTable
ALTER TABLE "widgets" ADD COLUMN     "sessionLimitPerDay" INTEGER;
