-- =============================================================================
-- Phase 151 (RAG Search Fixes — RAG-01) searchVectorMulti migration
-- D-02: strictly additive — ADD COLUMN + CREATE INDEX only, no data-rewriting
-- statements. The column is populated by the startup backfill
-- (searchVectorMultiBackfill.ts) and by all write sites; the old searchVector
-- column is retained until v1.3.
-- CJK limitation: the 'simple' config gives whole-run token matching only for
-- CJK text — semantic recall for zh comes from the vector leg (RESEARCH Pitfall 5).
-- =============================================================================

-- AlterTable
ALTER TABLE "archive_pages" ADD COLUMN     "searchVectorMulti" tsvector;

-- AlterTable
ALTER TABLE "document_chunks" ADD COLUMN     "searchVectorMulti" tsvector;

-- CreateIndex
CREATE INDEX "archive_pages_searchVectorMulti_idx" ON "archive_pages" USING GIN ("searchVectorMulti");

-- CreateIndex
CREATE INDEX "document_chunks_searchVectorMulti_idx" ON "document_chunks" USING GIN ("searchVectorMulti");
