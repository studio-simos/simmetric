// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireWorkspaceAccess } from "../middleware/rbac";
import prisma from "../utils/prisma";

const router = Router();
router.use(authMiddleware);

// GET /api/workspaces/:workspaceId/agent-config — get workspace agent config
router.get("/:workspaceId/agent-config", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;

  try {
    let config = await prisma.workspaceAgentConfig.findUnique({
      where: { workspaceId },
    });

    if (!config) {
      config = await prisma.workspaceAgentConfig.create({
        data: { workspaceId },
      });
    }

    res.json({
      ...config,
      enabledSkills: JSON.parse(config.enabledSkills),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PUT /api/workspaces/:workspaceId/agent-config — update workspace agent config
router.put("/:workspaceId/agent-config", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  // NOTE: `maxIterations` is still accepted here for backward compatibility
  // (the DB column remains) but is IGNORED by the orchestrator since the
  // ReAct loop is now `while (true)` with budget watchdogs. See
  // docs/agent-watchdogs.md and services/agentBudgetService.ts.
  const { systemPrompt, enabledSkills, model, temperature, maxIterations, providerId, planMode } = req.body;

  try {
    const config = await prisma.workspaceAgentConfig.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        systemPrompt,
        enabledSkills: enabledSkills ? JSON.stringify(enabledSkills) : undefined,
        model,
        temperature,
        maxIterations,
        ...(providerId !== undefined && { providerId }),
        ...(planMode !== undefined && { planMode: Boolean(planMode) }),
      },
      update: {
        ...(systemPrompt !== undefined && { systemPrompt }),
        ...(enabledSkills !== undefined && { enabledSkills: JSON.stringify(enabledSkills) }),
        ...(model !== undefined && { model }),
        ...(temperature !== undefined && { temperature }),
        ...(maxIterations !== undefined && { maxIterations }),
        ...(providerId !== undefined && { providerId }),
        ...(planMode !== undefined && { planMode: Boolean(planMode) }),
      },
    });

    res.json({
      ...config,
      enabledSkills: JSON.parse(config.enabledSkills),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;
