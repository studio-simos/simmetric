-- Phase 184 M6 (SAAS-03): additive storageKey — ADD COLUMN + null-guarded backfill
-- storageKey = filePath (path-as-key), NO file moves, zero destructive ops.
--
-- Prisma: storageKey String? on Document + UploadDraft — nullable, NO @default
-- (write sites set it explicitly; keys are row-unique).
--
-- Backfill shape (M3 discipline): plain WHERE "storageKey" IS NULL — covers ALL
-- rows including soft-deleted tombstones. Legacy rows carry the existing
-- cwd-relative filePath (e.g. "storage/uploads/file.pdf", "storage/uploads/
-- drafts/x.pdf", or the "https://…" URL sentinel) as their key; the LocalFS
-- provider's legacy arm resolves them byte-identically to today's path.resolve.
-- NO physical file moves anywhere.
--
-- Additive-only: ALTER TABLE ADD COLUMN (metadata-only in PG) + null-guarded
-- UPDATE. Zero row-removal statements of any kind.

-- documents
ALTER TABLE "documents" ADD COLUMN "storageKey" TEXT;
UPDATE "documents" SET "storageKey" = "filePath" WHERE "storageKey" IS NULL;

-- upload_drafts
ALTER TABLE "upload_drafts" ADD COLUMN "storageKey" TEXT;
UPDATE "upload_drafts" SET "storageKey" = "filePath" WHERE "storageKey" IS NULL;