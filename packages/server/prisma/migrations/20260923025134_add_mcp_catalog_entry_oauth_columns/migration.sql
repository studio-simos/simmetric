-- AlterTable
ALTER TABLE "mcp_catalog_entries" ADD COLUMN     "authType" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "oauthProvider" TEXT;
