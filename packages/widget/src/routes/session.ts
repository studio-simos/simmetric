// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response, type Router as RouterType } from "express";
import { widgetSessionCreateSchema } from "@simmetric-chat/shared";
import { createSession } from "../services/widgetApi";
import { logger } from "../utils/logger";

const router: RouterType = Router();

// POST / — create anonymous visitor session
router.post("/", async (req: Request, res: Response) => {
  const parsed = widgetSessionCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { widgetId } = parsed.data;

  try {
    const result = await createSession(widgetId, req.ip);
    res.status(201).json({
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt,
    });
  } catch (err: any) {
    if (err.response?.status === 404) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }
    // 151-02 (Task 7): upstream 402 = widget disabled by license (Community).
    // The client already has an error state — surface the unavailable status
    // gracefully (503) instead of a generic 500.
    if (err.response?.status === 402) {
      res.status(503).json({ error: "Widget disabled" });
      return;
    }
    logger.error("[widget/session] Failed to create session", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;