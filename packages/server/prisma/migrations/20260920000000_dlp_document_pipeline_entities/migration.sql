-- Phase 192 (DLP-01..04, D-03/D-04/D-05-via-A3): DLP document-pipeline
-- entities. Additive-only, zero-DML (statement set verbatim from
-- `prisma migrate diff --from-migrations … --to-schema prisma --script`):
-- - dlp_entities table (D-04): the mapping table IS the re-composition
--   source of truth — placeholder → AES-256-GCM-encrypted original
--   (encryptionService output only; no plaintext column exists).
-- - documents.dlpScannedAt / dlpScanState (D-12 marker + scan-state UX).
-- - workspaces.dlpDocumentScanEnabled (D-05 per-workspace toggle, research
--   A3/Pitfall-8: the SystemConfig cascade is org-granular, the column is
--   the honest per-workspace shape; default off — eval gate DLP-05 first).
--
-- No INSERT/UPDATE/DELETE/DROP/TRUNCATE statements.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "dlpScanState" TEXT,
ADD COLUMN     "dlpScannedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "dlpDocumentScanEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "dlp_entities" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkId" TEXT,
    "entityClass" TEXT NOT NULL,
    "placeholder" TEXT NOT NULL,
    "originalEncrypted" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dlp_entities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dlp_entities_documentId_idx" ON "dlp_entities"("documentId");

-- AddForeignKey
ALTER TABLE "dlp_entities" ADD CONSTRAINT "dlp_entities_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;