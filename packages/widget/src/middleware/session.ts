// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { Request, Response, NextFunction } from "express";
import { validateSession, getWidgetConfig } from "../services/widgetApi";
import { logger } from "../utils/logger";
import type { WidgetConfigResponse } from "@simmetric-chat/shared";

// Extend Express Request type for widget session data
declare global {
  namespace Express {
    interface Request {
      widgetSession?: any;
      widgetConfig?: WidgetConfigResponse;
    }
  }
}

export async function sessionMiddleware(req: Request, res: Response, next: NextFunction) {
  const sessionToken = req.headers["x-session-token"] as string | undefined;

  if (!sessionToken) {
    res.status(401).json({ error: "Missing session token" });
    return;
  }

  try {
    const session = await validateSession(sessionToken);
    const config = await getWidgetConfig(session.widgetId);

    req.widgetSession = session;
    req.widgetConfig = config;
    next();
  } catch (err: any) {
    if (err.response?.status === 401) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    logger.error("[widget/session] Validation error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
}