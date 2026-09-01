// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireWorkspaceAccess } from "../middleware/rbac";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { parseMetadata } from "../utils/parseMetadata";

const router = Router();
router.use(authMiddleware);

/**
 * @openapi
 * /workspaces/{workspaceId}/chats/{chatId}/tokens:
 *   get:
 *     tags: [Chat]
 *     summary: Aggregate token usage for a single conversation
 *     description: |
 *       Sums per-message token usage (stored in ChatMessage.metadata.tokenUsage)
 *       for the given chat. Returns totals plus a per-message breakdown.
 *       Scoped to the authenticated user's accessible workspaces.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Token usage aggregation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalInput: { type: integer }
 *                 totalOutput: { type: integer }
 *                 total: { type: integer }
 *                 perMessage:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       role: { type: string }
 *                       input: { type: integer }
 *                       output: { type: integer }
 *                       total: { type: integer }
 *       404: { description: Chat not found }
 */
// GET /api/workspaces/:workspaceId/chats/:chatId/tokens — per-conversation token aggregation
router.get("/:workspaceId/chats/:chatId/tokens", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  const chatId = req.params.chatId as string;

  try {
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const messages = await prisma.chatMessage.findMany({
      where: { chatId },
      select: { id: true, role: true, metadata: true },
      orderBy: { createdAt: "asc" },
    });

    let totalInput = 0;
    let totalOutput = 0;
    const perMessage: Array<{ id: string; role: string; input: number; output: number; total: number }> = [];

    for (const msg of messages) {
      if (!msg.metadata) continue;
      // CSW-04: parseMetadata returns {} on bad JSON — the missing-tokenUsage
      // access below becomes undefined and the existing `if (!usage) continue`
      // handles it, so the inline try/catch is no longer needed.
      const meta = parseMetadata(msg.metadata);
      const usage = meta.tokenUsage as
        | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
        | null
        | undefined;
      if (!usage) continue;
      const input = Number(usage.promptTokens ?? 0) || 0;
      const output = Number(usage.completionTokens ?? 0) || 0;
      const total = Number(usage.totalTokens ?? input + output) || 0;
      totalInput += input;
      totalOutput += output;
      if (input > 0 || output > 0) {
        perMessage.push({ id: msg.id, role: msg.role, input, output, total });
      }
    }

    res.json({
      totalInput,
      totalOutput,
      total: totalInput + totalOutput,
      perMessage,
    });
  } catch (err: unknown) {
    logger.error("[chatTokens] Error aggregating chat tokens", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /workspaces/{workspaceId}/tokens/today:
 *   get:
 *     tags: [Chat]
 *     summary: Aggregate token usage for the current day (session)
 *     description: |
 *       Sums WorkspaceTokenUsage rows created since the start of the current
 *       calendar day (server local time) for the authenticated user within the
 *       given workspace. Used by the per-session token counter.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Today's token usage aggregation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalInput: { type: integer }
 *                 totalOutput: { type: integer }
 *                 total: { type: integer }
 *                 since: { type: string, format: date-time }
 */
// GET /api/workspaces/:workspaceId/tokens/today — per-session (today) token aggregation
router.get("/:workspaceId/tokens/today", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  const userId = req.userId!;

  try {
    // Start of today in server local time, expressed as a Date for Prisma.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const rows = await prisma.workspaceTokenUsage.aggregate({
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      where: { workspaceId, userId, createdAt: { gte: startOfDay } },
    });

    const totalInput = rows._sum.promptTokens ?? 0;
    const totalOutput = rows._sum.completionTokens ?? 0;
    const total = rows._sum.totalTokens ?? (totalInput + totalOutput);

    res.json({
      totalInput,
      totalOutput,
      total,
      since: startOfDay.toISOString(),
    });
  } catch (err: unknown) {
    logger.error("[chatTokens] Error aggregating today's tokens", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;