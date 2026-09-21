-- Phase 194 gate fix (D-03): align the live column with schema.prisma's
-- `embedding Unsupported("vector(384)?")` (nullable). The init migration
-- authored the column NOT NULL, so every manual memory create (which writes
-- NULL and defers embedding to 97-03 auto-extraction) failed with 23502.
ALTER TABLE "memories" ALTER COLUMN "embedding" DROP NOT NULL;