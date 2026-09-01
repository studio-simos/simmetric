// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { Request, Response, NextFunction } from "express";
import { isFeatureEnabled, getLicenseInfo, getFeatureLimit } from "../services/licenseService";
import type { FeatureFlag } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";

/** Middleware that blocks the request if the feature flag is disabled */
export function requireFeature(flag: FeatureFlag) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!isFeatureEnabled(flag)) {
      res.status(402).json({
        error: "This feature requires an Enterprise license",
        feature: flag,
        tier: getLicenseInfo().tier,
      });
      return;
    }
    next();
  };
}

/** Middleware that enforces numeric license limits (e.g. max_workspaces, max_projects, max_widgets) */
export function requireFeatureLimit(
  flag: FeatureFlag,
  model: "workspace" | "project" | "widget" | "synthesisRun" | "synthesis_run" | "backupDestination",
) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    const limit = getFeatureLimit(flag);
    // Infinity means no limit (Enterprise)
    if (limit === Infinity) {
      next();
      return;
    }

    try {
      let count: number;
      switch (model) {
        case "workspace":
          count = await prisma.workspace.count({ where: { deletedAt: null } });
          break;
        case "project":
          count = await prisma.project.count({ where: { deletedAt: null } });
          break;
        case "synthesisRun":
        case "synthesis_run":
          count = await prisma.synthesisRun.count();
          break;
        case "backupDestination":
          count = await prisma.backupDestination.count({ where: { deletedAt: null } });
          break;
        default:
          count = await prisma.widget.count({ where: { deletedAt: null } });
          break;
      }

      if (count >= limit) {
        res.status(402).json({
          error: `${model} limit reached. Your plan allows up to ${limit} ${model}s.`,
          feature: flag,
          limit,
          current: count,
          tier: getLicenseInfo().tier,
        });
        return;
      }
      next();
    } catch {
      // If the count query fails, don't block the request
      next();
    }
  };
}