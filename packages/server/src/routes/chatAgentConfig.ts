// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireWorkspaceAccess } from "../middleware/rbac";
import prisma from "../utils/prisma";
import { scopeToOrg } from "../utils/tenantContext";

const router = Router();
router.use(authMiddleware);
// Phase 185 (D-09): chain order auth → tenant → permission. The tenant
// middleware resolves req.organizationId (D-01 membership lookup) and opens
// the ALS tenant run before any rbac/license gate.
router.use(tenantContextMiddleware);

// GET /api/workspaces/:workspaceId/agent-config — get workspace agent config
router.get("/:workspaceId/agent-config", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;

  try {
    // T-185-10 (Pitfall-2 grep-gate): PK-keyed lookup restructured to a
    // scoped findFirst — cross-org config resolves null (fail-closed 404)
    // instead of leaking the row. The router-level requireWorkspaceAccess
    // already proved workspace access; the org filter is defense-in-depth.
    const config = await prisma.workspaceAgentConfig.findFirst(
      { where: scopeToOrg(req.organizationId!, { workspaceId }) },
    );

    if (!config) {
      res.status(404).json({ error: "Workspace not found" });
      return;
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
    // T-185-10 (Pitfall-2 grep-gate): the upsert's PK-keyed where cannot
    // carry the org filter — the workspace binding is proven by
    // requireWorkspaceAccess upstream (the workspaceId param IS the
    // access-checked row), so the create/update arms write inside the
    // caller's already-verified workspace. Documented disposition:
    // access-verified parent, no post-fetch assert needed.
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
