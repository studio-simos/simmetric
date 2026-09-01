// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Test helper routes — only available in development/test environments.
 * Provides endpoints for E2E tests to manage mock MCP servers.
 */

import { Router, type Request, type Response } from "express";
import { start, stop } from "../__tests__/helpers/echoMcpServer";
import { logger } from "../utils/logger";

const router = Router();

let echoPort: number | null = null;

router.post("/start-echo-server", async (_req: Request, res: Response) => {
  try {
    if (echoPort !== null) {
      res.json({ port: echoPort });
      return;
    }
    echoPort = await start();
    logger.info(`[e2e-helper] Echo MCP server started on port ${echoPort}`);
    res.json({ port: echoPort });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[e2e-helper] Failed to start echo server", { error: message });
    res.status(500).json({ error: message });
  }
});

router.post("/stop-echo-server", async (_req: Request, res: Response) => {
  try {
    await stop();
    echoPort = null;
    logger.info("[e2e-helper] Echo MCP server stopped");
    res.json({ ok: true });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
