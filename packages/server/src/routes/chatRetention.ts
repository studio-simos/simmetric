// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { chatRetentionSchema } from "@simmetric-chat/shared";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { getSetting } from "../services/systemConfigService";
import { logEvent } from "../services/eventLogService";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";

const router = Router();

/**
 * @openapi
 * /system/chat-retention:
 *   put:
 *     tags: [System]
 *     summary: Set chat message retention (data-loss confirmed)
 *     description: |
 *       Sole audited write path for `chat_message_retention_days`.
 *       `confirmDataLoss` MUST be `true` — the sibling-field contract is
 *       enforced at the route boundary. `retentionDays: null` disables
 *       retention (OFF). The bulk `PUT /api/system/settings` endpoint
 *       rejects this key (D-09).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [retentionDays, confirmDataLoss]
 *             properties:
 *               retentionDays:
 *                 type: integer
 *                 nullable: true
 *                 minimum: 1
 *                 description: Retention window in days; null = OFF
 *               confirmDataLoss:
 *                 type: boolean
 *                 description: Must be true to acknowledge data loss
 *     responses:
 *       200:
 *         description: Chat retention updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 retentionDays:
 *                   type: integer
 *                   nullable: true
 *       400:
 *         description: Invalid body or confirmDataLoss not true
 *       401:
 *         description: Authentication required
 *       403:
 *         description: admin:settings permission required
 *       500:
 *         description: Internal server error
 */
router.put(
  "/chat-retention",
  authMiddleware,
  requirePermission("admin:settings"),
  async (req: Request, res: Response) => {
    try {
      const parsed = chatRetentionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      const { retentionDays, confirmDataLoss } = parsed.data;
      // Double-guard the sibling-field contract at the route boundary
      // (schema refine already enforces, but guard against bypass).
      if (!confirmDataLoss) {
        res.status(400).json({ error: "confirmDataLoss must be true" });
        return;
      }
      const value = retentionDays === null ? "" : String(retentionDays);
      // Read previous value for the audit trail (Open Question 2 — low scope cost).
      const previous = await getSetting("chat_message_retention_days");
      const prevRaw = previous.value;
      const previousRetentionDays =
        prevRaw && Number.isFinite(Number(prevRaw)) && Number(prevRaw) > 0
          ? Number(prevRaw)
          : null;
      // D-09: bypass updateSettings (it rejects this key). Direct upsert is the
      // SOLE write path for chat_message_retention_days.
      await prisma.systemConfig.upsert({
        where: { key: "chat_message_retention_days" },
        create: { key: "chat_message_retention_days", value },
        update: { value },
      });
      await logEvent("chat", "system", "retention.updated", req.userId!, {
        retentionDays,
        previousRetentionDays,
      });
      res.json({ message: "Chat retention updated", retentionDays });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[chat-retention] update failed", { error: message });
      res.status(500).json({ error: message });
    }
  }
);

export default router;