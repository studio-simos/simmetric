-- Phase 191 (KNOW-02 D-05): Chat.attachedArchiveIds — chat-attached wiki-
-- archive knowledge for per-chat persistence. Additive-only: a single ADD
-- COLUMN statement, so there is NO UPDATE/INSERT/DELETE/DROP backfill arm
-- (statement verbatim from `prisma migrate diff --from-migrations`).
--
-- Zero-DML rationale: the column is a scalar list defaulting to an empty
-- array (Prisma 7 scalar lists are inherently non-null at the Prisma level —
-- "Optional lists are not supported" — so `String[]` IS the "attach nothing"
-- state; the SQL column stays nullable, an implementation detail Prisma
-- never writes NULL through). Existing chats attach nothing until the user
-- does (no backfill, D-05); the org-scoped validated subset is mirrored by
-- archiveAttachmentService.syncChatAttachment at each send.
--
-- Statements: ALTER TABLE ADD COLUMN ×1. No INSERT/UPDATE/DELETE/DROP/TRUNCATE.

-- AlterTable
ALTER TABLE "chats" ADD COLUMN     "attachedArchiveIds" TEXT[];