/*
  Warnings:

  - Made the column `embedding` on table `memories` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "memories" ALTER COLUMN "embedding" SET NOT NULL;

-- CreateTable
CREATE TABLE "plugin_installs" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "displayName" TEXT,
    "version" TEXT,
    "apiVersion" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'installed',
    "lastError" TEXT,
    "packageJson" JSONB NOT NULL,
    "licenseKeyEncrypted" TEXT,
    "licenseMode" TEXT NOT NULL DEFAULT 'none',
    "licenseStatus" TEXT,
    "licenseCheckedAt" TIMESTAMP(3),
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_installs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plugin_installs_slug_key" ON "plugin_installs"("slug");
