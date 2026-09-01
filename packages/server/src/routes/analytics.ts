// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import prisma from "../utils/prisma";

const router = Router();

router.use(authMiddleware, requireAdmin);

// GET /api/system/analytics/tokens — daily token usage for a date range
router.get("/tokens", async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;

    const since = new Date();
    since.setDate(since.getDate() - days);

    const usage = await prisma.workspaceTokenUsage.findMany({
      where: { createdAt: { gte: since } } as Record<string, unknown>,
      orderBy: { createdAt: "asc" as const },
    });

    // Group by day
    const dailyMap = new Map<string, { date: string; promptTokens: number; completionTokens: number; totalTokens: number; count: number }>();
    for (const entry of usage) {
      const day = entry.createdAt.toISOString().split("T")[0]!;
      const existing = dailyMap.get(day) ?? {
        date: day,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        count: 0,
      };
      existing.promptTokens += entry.promptTokens;
      existing.completionTokens += entry.completionTokens;
      existing.totalTokens += entry.totalTokens;
      existing.count += 1;
      dailyMap.set(day, existing);
    }

    res.json(Array.from(dailyMap.values()));
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/system/analytics/models — token usage breakdown by model
router.get("/models", async (req: Request, res: Response) => {
  try {
    // Phase 155 / CSW-06 (D-07): bound the aggregation query with a time-range
    // where (default 30-day lookback, replicating the /tokens pattern at
    // line 11-19) plus a take:10000 safety cap. Unbounded findMany is the OOM
    // surface as workspaceTokenUsage grows with users.
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const usage = await prisma.workspaceTokenUsage.findMany({
      where: { createdAt: { gte: since } } as Record<string, unknown>,
      take: 10000,
    });

    const modelMap = new Map<string, { model: string; modelDisplayName: string | null; totalTokens: number; promptTokens: number; completionTokens: number; count: number }>();
    for (const entry of usage) {
      const existing = modelMap.get(entry.model) || {
        model: entry.model,
        modelDisplayName: entry.modelDisplayName,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        count: 0,
      };
      if (!existing.modelDisplayName && entry.modelDisplayName) {
        existing.modelDisplayName = entry.modelDisplayName;
      }
      existing.totalTokens += entry.totalTokens;
      existing.promptTokens += entry.promptTokens;
      existing.completionTokens += entry.completionTokens;
      existing.count += 1;
      modelMap.set(entry.model, existing);
    }

    res.json(Array.from(modelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens));
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/system/analytics/top-users — most active users by token usage
router.get("/top-users", async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;

    // Phase 155 / CSW-06 (D-07): same time-range where + take cap as /models.
    // The existing slice(0, limit) below bounds the final enriched list; the
    // take:10000 bounds the source query so the in-memory Map aggregation can't
    // blow up on an unbounded table.
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const usage = await prisma.workspaceTokenUsage.findMany({
      where: { createdAt: { gte: since } } as Record<string, unknown>,
      take: 10000,
    });

    const userMap = new Map<string, { userId: string; totalTokens: number; promptTokens: number; completionTokens: number; count: number }>();
    for (const entry of usage) {
      const existing = userMap.get(entry.userId) || {
        userId: entry.userId,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        count: 0,
      };
      existing.totalTokens += entry.totalTokens;
      existing.promptTokens += entry.promptTokens;
      existing.completionTokens += entry.completionTokens;
      existing.count += 1;
      userMap.set(entry.userId, existing);
    }

    const topUsers = Array.from(userMap.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, limit);

    // Enrich with user details
    const enriched = await Promise.all(
      topUsers.map(async (u) => {
        const user = await prisma.user.findUnique({ where: { id: u.userId } });
        return {
          ...u,
          username: user?.username || "unknown",
          email: user?.email || "unknown",
        };
      })
    );

    res.json(enriched);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;