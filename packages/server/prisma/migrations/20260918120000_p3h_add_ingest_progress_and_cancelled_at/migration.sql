-- AlterTable
ALTER TABLE "archive_import_jobs" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ocr_jobs" ADD COLUMN     "cancelledAt" TIMESTAMP(3);

