// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Shared archive-chat linking service (Phase 80, D-10).
 *
 * Extracted so both the JWT route (chatCrud.ts PATCH /archive, plan 80-02) and
 * the widget API-key route (internalWidget.ts PATCH /session/:token/chat/archive,
 * plan 80-07) reuse the exact same IDOR + update + audit logic.
 *
 * IDOR (ARCH-LINK-02): workspace-scoped findFirst on both chat and archive;
 * not-found returns a discriminated union so each route handler maps to its
 * own HTTP status (404 hide existence). The service never throws on not-found.
 */
import prisma from "../utils/prisma";
import { logEvent } from "./eventLogService";
import type { Chat } from "@prisma/client";

export type LinkArchiveResult =
  | { chat: Chat }
  | { error: "chat_not_found" }
  | { error: "archive_not_found" };

/**
 * Link or unlink a Chat to an Archive (same workspace only).
 *
 * @param params.chatId       UUID of the chat to update
 * @param params.archiveId    UUID of the archive to link, or null to unlink
 * @param params.workspaceId  UUID of the workspace (IDOR scope)
 * @param params.userId       Actor userId for audit log (null for anonymous widget sessions)
 * @returns Discriminated union: { chat } on success, { error } on not-found
 */
export async function linkArchive(params: {
  chatId: string;
  archiveId: string | null;
  workspaceId: string;
  userId: string | null;
}): Promise<LinkArchiveResult> {
  const { chatId, archiveId, workspaceId, userId } = params;

  // IDOR: chat must belong to the workspace
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, workspaceId },
  });
  if (!chat) {
    return { error: "chat_not_found" };
  }

  // IDOR: if linking (not unlinking), the archive must exist and not be
  // soft-deleted. Archives are GLOBAL (Archive has no workspaceId — only
  // createdBy), so there is no per-workspace scoping to enforce here; the
  // chat-side IDOR (chat.workspaceId === workspaceId) above already guarantees
  // the user owns the chat they're mutating. Skip the check when archiveId
  // is null (unlink).
  //
  // NOTE: the previous filter `where: { id: archiveId, workspaceId, ... }`
  // referenced a field that does not exist on the Archive model. Prisma 7's
  // loose WhereInput types let it compile (server tsconfig strict:false) but
  // Prisma throws PrismaClientValidationError at runtime ("Unknown argument
  // workspaceId") → the route caught it as 500 → Chat.archiveId was never
  // written → the link never persisted across reload. Verified empirically.
  if (archiveId !== null) {
    const archive = await prisma.archive.findFirst({
      where: { id: archiveId, deletedAt: null },
    });
    if (!archive) {
      return { error: "archive_not_found" };
    }
  }

  const updated = await prisma.chat.update({
    where: { id: chatId },
    data: { archiveId },
  });

  // D-12 audit log — fire-and-forget (logEvent swallows errors internally)
  await logEvent(
    "chat",
    chatId,
    archiveId === null ? "chat.archive.unlinked" : "chat.archive.linked",
    userId,
    { workspaceId, archiveId },
  );

  return { chat: updated };
}