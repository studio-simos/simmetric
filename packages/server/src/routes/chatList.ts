// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireWorkspaceAccess } from "../middleware/rbac";
import prisma from "../utils/prisma";
import { parseMetadata } from "../utils/parseMetadata";

const router = Router();
router.use(authMiddleware);

// GET /api/workspaces/:workspaceId/chats — list chats in workspace
router.get("/:workspaceId/chats", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;

  try {
    const chats = await prisma.chat.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { updatedAt: "desc" } as const,
      include: {
        _count: { select: { messages: true } },
        pins: { where: { userId: req.userId! } },
      },
    });
    const result = chats.map((c: { _count: { messages: number }; pins: unknown[] }) => ({
      ...c,
      isPinned: c.pins.length > 0,
      messageCount: c._count.messages,
    }));
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /api/workspaces/:workspaceId/chats/:chatId/messages — get chat messages
router.get("/:workspaceId/chats/:chatId/messages", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;

  try {
    const messages = await prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" } as const,
    });

    // Resolve attached document names
    const docIds = messages.map((m: { attachedDocumentId: string | null }) => m.attachedDocumentId).filter((id): id is string => id !== null);
    const docs = docIds.length > 0
      ? await prisma.document.findMany({
          where: { id: { in: docIds }, deletedAt: null },
          select: { id: true, name: true },
        })
      : [];
    const docMap = new Map(docs.map((d) => [d.id, d.name]));

    // Parse metadata JSON for each message.
    // CSW-04: parseMetadata never returns null (it returns {} on bad/empty
    // JSON), but the ternary preserves the "no metadata column → null" shape
    // callers expect (absent vs. empty metadata).
    const parsed = messages.map((m: { attachedDocumentId: string | null; metadata: string | null }) => ({
      ...m,
      metadata: m.metadata ? parseMetadata(m.metadata) : null,
      attachedDocumentName: m.attachedDocumentId ? docMap.get(m.attachedDocumentId) || null : null,
    }));

    res.json(parsed);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;
