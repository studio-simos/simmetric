-- quick 260918-qts: soft delete for individual MCP marketplace catalog entries
-- Additive-only: nullable timestamp column, no data touched.
ALTER TABLE "mcp_catalog_entries" ADD COLUMN "deletedAt" TIMESTAMP(3);