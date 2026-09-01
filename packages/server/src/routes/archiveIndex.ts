// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { indexAllWikiPages } from "../services/wikiEmbeddingService";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

const router = Router();

router.post("/:archiveId/index", authMiddleware, requirePermission("archive:write"), async (req, res) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Ownership check
    // D-09 (KB-02 audit): findFirst + deletedAt:null (WR-02 pattern from archiveExport.ts).
    // findUnique cannot filter by deletedAt on PK — a soft-deleted archiveId must return 404,
    // never the tombstoned data. Prevents PHI leak on Medical-template archives (AI-SPEC failure mode 4).
    const archive = await prisma.archive.findFirst({ where: { id: archiveId, deletedAt: null } });
    if (!archive) return res.status(404).json({ error: "Archive not found" });
    if (archive.createdBy !== req.userId && !req.user?.roles?.some((r: { role: { name: string } }) => r.role.name === "Admin")) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Trigger indexing in background (do not await full completion to avoid timeout)
    indexAllWikiPages(archiveId).catch((err: unknown) => {
      logger.error(`[archiveIndex] Background indexing failed for ${archiveId}`, { error: (err instanceof Error ? err.message : String(err)) });
    });

    return res.json({ message: "Indexing started", archiveId });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

export default router;
