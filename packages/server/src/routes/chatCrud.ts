// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requirePermission, requireWorkspaceAccess } from "../middleware/rbac";
import prisma, { withSoftDelete } from "../utils/prisma";
import { renameChatSchema, updateChatModelSchema, moveChatSchema, editMessageSchema, linkArchiveSchema } from "@simmetric-chat/shared";
import { z } from "zod";
import { linkArchive } from "../services/chatArchiveService";
import { parseMetadata } from "../utils/parseMetadata";

const router = Router();
router.use(authMiddleware);

// PUT /api/workspaces/:workspaceId/chats/:chatId — rename a chat
router.put("/:workspaceId/chats/:chatId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    const validated = renameChatSchema.parse(req.body);

    const chat = await prisma.chat.findFirst({
      where: { id: chatId, workspaceId },
    });

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    // D-01 (Phase 98): set titleSource="user" atomically with name so
    // generateAutoTitle skips this chat (Pitfall 10 — no overwrite user rename).
    const updated = await prisma.chat.update({
      where: { id: chatId },
      data: { name: validated.name, titleSource: "user" },
    });

    res.json(updated);
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PATCH /api/workspaces/:workspaceId/chats/:chatId/model — update chat model selection
router.patch("/:workspaceId/chats/:chatId/model", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    const validated = updateChatModelSchema.parse(req.body);

    const chat = await prisma.chat.findFirst({
      where: { id: chatId, workspaceId },
    });

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const updated = await prisma.chat.update({
      where: { id: chatId },
      data: {
        ...(validated.providerId !== undefined && { providerId: validated.providerId }),
        ...(validated.model !== undefined && { model: validated.model }),
      } as Record<string, unknown>,
    });

    res.json({
      providerId: updated.providerId,
      model: updated.model,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body", details: err.flatten().fieldErrors });
      return;
    }
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PATCH /api/workspaces/:workspaceId/chats/:chatId/archive — link/unlink a workspace archive (D-09, D-11, D-12)
// Mirrors PATCH /model but ADDS requirePermission("chat:write") (Pitfall 1 — /model omits it).
// Delegates to shared linkArchive service (D-10) so the widget API-key route (80-07) reuses the same logic.
router.patch(
  "/:workspaceId/chats/:chatId/archive",
  requireWorkspaceAccess,
  requirePermission("chat:write"),
  async (req: Request, res: Response) => {
    const chatId = req.params.chatId as string;
    const workspaceId = req.params.workspaceId as string;

    try {
      const validated = linkArchiveSchema.parse(req.body);

      const result = await linkArchive({
        chatId,
        archiveId: validated.archiveId,
        workspaceId,
        userId: req.userId!,
      });

      if ("error" in result) {
        if (result.error === "chat_not_found") {
          res.status(404).json({ error: "Chat not found" });
          return;
        }
        // archive_not_found — IDOR hide existence (ARCH-LINK-02)
        res.status(404).json({ error: "Archive not found" });
        return;
      }

      // D-11 — return the full updated Chat entity
      res.json(result.chat);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body", details: err.flatten().fieldErrors });
        return;
      }
      res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
    }
  },
);

// DELETE /api/workspaces/:workspaceId/chats/:chatId/messages/:messageId — delete a single message
router.delete("/:workspaceId/chats/:chatId/messages/:messageId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const messageId = req.params.messageId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    // Verify chat belongs to workspace
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, workspaceId },
    });

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
    });

    if (!message || message.chatId !== chatId) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    await prisma.chatMessage.delete({ where: { id: messageId } });

    res.json({ id: messageId, status: "deleted" });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PUT /api/workspaces/:workspaceId/chats/:chatId/messages/:messageId — edit a user message
router.put("/:workspaceId/chats/:chatId/messages/:messageId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const messageId = req.params.messageId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    const validated = editMessageSchema.parse(req.body);

    const chat = await prisma.chat.findFirst({
      where: { id: chatId, workspaceId },
    });
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
    });
    if (!message || message.chatId !== chatId) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    if (message.role !== "user") {
      res.status(400).json({ error: "Only user messages can be edited" });
      return;
    }

    const updated = await prisma.chatMessage.update({
      where: { id: messageId },
      data: {
        content: validated.content,
        updatedAt: new Date(),
      },
    });

    res.json({
      ...updated,
      // CSW-04: ternary preserves the "no metadata column → null" shape
      // (parseMetadata itself never returns null — it returns {} on bad/empty).
      metadata: updated.metadata ? parseMetadata(updated.metadata) : null,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body", details: err.flatten().fieldErrors });
      return;
    }
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /api/workspaces/:workspaceId/chats/:chatId — delete a chat and its messages
router.delete("/:workspaceId/chats/:chatId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    // Verify chat belongs to workspace and is not already deleted
    const chat = await prisma.chat.findFirst({
      where: withSoftDelete({ id: chatId, workspaceId, deletedAt: null }),
    });

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    // Soft-delete chat (set deletedAt timestamp instead of hard delete)
    await prisma.chat.update({
      where: { id: chatId },
      data: { deletedAt: new Date() },
    });

    res.json({ id: chatId, status: "deleted" });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PUT /api/workspaces/:workspaceId/chats/:chatId/move — move chat to a folder
router.put("/:workspaceId/chats/:chatId/move", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    const validated = moveChatSchema.parse(req.body);

    // Verify chat belongs to workspace
    const chat = await prisma.chat.findFirst({
      where: withSoftDelete({ id: chatId, workspaceId, deletedAt: null }),
    });

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    // If folderId is provided, verify folder belongs to same workspace
    if (validated.folderId) {
      const folder = await prisma.chatFolder.findFirst({
        where: withSoftDelete({ id: validated.folderId, workspaceId, deletedAt: null }),
      });
      if (!folder) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }
    }

    const updated = await prisma.chat.update({
      where: { id: chatId },
      data: { folderId: validated.folderId },
    });

    res.json(updated);
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /api/workspaces/:workspaceId/chats/:chatId/pin — pin a chat
router.post("/:workspaceId/chats/:chatId/pin", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, workspaceId },
    });

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    await prisma.chatPin.create({
      data: { userId: req.userId!, chatId },
    });

    res.json({ pinned: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /api/workspaces/:workspaceId/chats/:chatId/pin — unpin a chat
router.delete("/:workspaceId/chats/:chatId/pin", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, workspaceId },
    });

    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    await prisma.chatPin.delete({
      where: { userId_chatId: { userId: req.userId!, chatId } },
    });

    res.json({ pinned: false });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;
