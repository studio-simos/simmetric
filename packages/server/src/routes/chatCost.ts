// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 203 (MCC-02, 203-02 Task 1/3) — workspace + system cost endpoints.
 *
 * GET /:workspaceId/chats/:chatId/cost — per-chat per-currency totals +
 * per-message breakdown, member-gated (requireWorkspaceAccess — the
 * chatTokens.ts:153 idiom).
 * GET /:workspaceId/cost/today — today's per-currency totals.
 * GET /api/system/analytics/cost + /cost-by-model — admin-gated per-currency.
 */

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireWorkspaceAccess } from "../middleware/rbac";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

const router = Router();
router.use(authMiddleware, tenantContextMiddleware);

// The usage-write seam stamps Decimal columns — Prisma returns Decimal
// objects; res.json throws on non-JSON types (the BigInt/pollOffset class).
// Serialize: Decimal → number via Prisma.Decimal.toString → parseFloat.
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

// GET /:workspaceId/chats/:chatId/cost — per-chat cost + per-message breakdown.
router.get(
  "/:workspaceId/chats/:chatId/cost",
  requireWorkspaceAccess,
  async (req: Request, res: Response) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const chatId = String(req.params.chatId);
      const rows = await prisma.workspaceTokenUsage.findMany({
        where: { workspaceId, chatId },
        orderBy: { createdAt: "asc" },
      });
      const totalByCurrency: Record<string, number> = {};
      const breakdown = rows.map((r) => ({
        messageId: r.id,
        promptCost: r.promptCost === null ? null : Number(r.promptCost),
        completionCost: r.completionCost === null ? null : Number(r.completionCost),
        totalCost: r.totalCost === null ? null : Number(r.totalCost),
        currency: r.currency,
      }));
      for (const r of rows) {
        if (r.totalCost === null || !r.currency) continue;
        totalByCurrency[r.currency] = (totalByCurrency[r.currency] ?? 0) + Number(r.totalCost);
      }
      res.json({ totalByCurrency, breakdown });
    } catch (err: unknown) {
      logger.error("[chatCost] Error computing chat cost", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// GET /:workspaceId/cost/today — per-currency totals for today.
router.get(
  "/:workspaceId/cost/today",
  requireWorkspaceAccess,
  async (req: Request, res: Response) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const rows = await prisma.workspaceTokenUsage.findMany({
        where: { workspaceId, createdAt: { gte: startOfDay } },
      });
      const totalByCurrency: Record<string, number> = {};
      for (const r of rows) {
        if (r.totalCost === null || !r.currency) continue;
        totalByCurrency[r.currency] = (totalByCurrency[r.currency] ?? 0) + Number(r.totalCost);
      }
      res.json({ totalByCurrency });
    } catch (err: unknown) {
      logger.error("[chatCost] Error computing today cost", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;