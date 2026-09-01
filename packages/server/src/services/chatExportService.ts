// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma, { withSoftDelete } from "../utils/prisma";
import type { ChatExportData, ChatExportItem, ChatExportMessage } from "@simmetric-chat/shared";
import { parseMetadata } from "../utils/parseMetadata";

/**
 * Sanitize a string for use as a filename.
 * Replaces non-alphanumeric characters (except underscores and hyphens) with underscores,
 * then truncates to 50 characters.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
}

/**
 * Export all non-deleted chats from a workspace as D-09/D-10 compliant JSON.
 */
export async function exportWorkspaceChats(workspaceId: string): Promise<ChatExportData> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId, deletedAt: null },
    select: { name: true },
  });

  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const chats = await prisma.chat.findMany({
    where: withSoftDelete({ workspaceId, deletedAt: null }),
    include: {
      messages: { orderBy: { createdAt: "asc" as const } },
      folder: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" as const },
  });

  const exportChats: ChatExportItem[] = chats.map((chat) => ({
    id: chat.id,
    title: chat.name,
    folderName: chat.folder?.name ?? null,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    messages: chat.messages.map((m) => {
      // CSW-04: parseMetadata returns {} on null/undefined/malformed JSON —
      // the `if (m.metadata)` guard and inline try/catch are no longer needed.
      const model = (parseMetadata(m.metadata).model as string | null | undefined) ?? null;
      return {
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        model,
      };
    }),
  }));

  return {
    exportDate: new Date().toISOString(),
    version: "1.0",
    workspace: { name: workspace.name },
    chats: exportChats,
  };
}

/**
 * Export a single chat from a workspace as D-09/D-10 compliant JSON.
 * Returns a ChatExportData with a single chat in the chats array.
 */
export async function exportSingleChat(workspaceId: string, chatId: string): Promise<ChatExportData> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId, deletedAt: null },
    select: { name: true },
  });

  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const chat = await prisma.chat.findFirst({
    where: withSoftDelete({ id: chatId, workspaceId, deletedAt: null }),
    include: {
      messages: { orderBy: { createdAt: "asc" as const } },
      folder: { select: { name: true } },
    },
  });

  if (!chat) {
    throw new Error("Chat not found");
  }

  // D-08: `chat.messages` is the Prisma `ChatMessage[]` relation (included
  // above). The previous `as any[]` cast is dropped — the Prisma relation
  // type already carries `role`, `content`, `createdAt`, `metadata` (String?).
  const messages = chat.messages;

  const exportMessages: ChatExportMessage[] = messages.map((m) => {
    // CSW-04: parseMetadata returns {} on null/undefined/malformed JSON,
    // so the `if (m.metadata)` guard and the inline try/catch are no
    // longer needed — `model` resolves to `undefined ?? null` => null.
    const model = (parseMetadata(m.metadata).model as string | null | undefined) ?? null;
    return {
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      timestamp: m.createdAt.toISOString(),
      model,
    };
  });

  const exportChat: ChatExportItem = {
    id: chat.id,
    title: chat.name,
    folderName: chat.folder?.name ?? null,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    messages: exportMessages,
  };

  return {
    exportDate: new Date().toISOString(),
    version: "1.0",
    workspace: { name: workspace.name },
    chats: [exportChat],
  };
}