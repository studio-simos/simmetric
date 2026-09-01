// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { sessionMiddleware } from "../middleware/session";
import { submitLead } from "../services/widgetApi";
import { widgetLeadSubmitSchema } from "@simmetric-chat/shared";
import { logger } from "../utils/logger";

const router: Router = Router();

// POST /api/lead/:widgetId -- submit lead from widget visitor (ADM-04)
router.post("/:widgetId", sessionMiddleware, async (req: Request, res: Response) => {
  try {
    const widgetId = req.params.widgetId as string;
    const config = req.widgetConfig;
    const session = req.widgetSession;

    if (!config) {
      res.status(400).json({ error: "Widget config not available" });
      return;
    }

    // Check lead capture is enabled for this widget (D-07)
    if (!config.leadCaptureEnabled) {
      res.status(403).json({ error: "Lead capture is not enabled for this widget" });
      return;
    }

    // Validate request body with Zod schema (per CLAUDE.md: all request validation uses Zod)
    const parsed = widgetLeadSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { email, name, transcript } = parsed.data;

    // Pass the session DATABASE ID (UUID), NOT the sessionToken string.
    // WidgetLead.sessionId is a FK referencing WidgetSession.id (UUID).
    const sessionId = session?.id || null;

    const result = await submitLead(
      widgetId,
      email,
      name || undefined,
      transcript,
      sessionId
    );

    res.status(201).json(result);
  } catch (err: any) {
    if (err.response?.status === 429) {
      res.status(429).json({ error: "Too many lead submissions. Please try again later." });
      return;
    }
    logger.error("[widget/lead] Error submitting lead", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;