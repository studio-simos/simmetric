// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { buildArchiveGraph } from "../services/archiveGraphService";

const router = Router();

// GET /:archiveId/graph — Return nodes and edges for D3.js force-directed graph
router.get("/:archiveId/graph", authMiddleware, requirePermission("archive:read"), async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    const graph = await buildArchiveGraph(archiveId);
    return res.json(graph);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

export default router;
