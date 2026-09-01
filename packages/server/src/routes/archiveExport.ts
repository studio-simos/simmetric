// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import {
  exportArchiveAsZip,
  exportArchiveAsPdf,
} from "../services/archiveExportService";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { isAdmin } from "../utils/auth";

const router = Router();

/**
 * GET /api/archives/:archiveId/export?format=zip|pdf
 *
 * Export an archive as a zip bundle (Obsidian-compatible markdown)
 * or a PDF bundle with clickable wikilink anchors.
 *
 * Ownership: same-user or admin only.
 */
router.get(
  "/:archiveId/export",
  authMiddleware,
  requirePermission("archive:read"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = req.params.archiveId as string;
      const format = req.query.format as string;

      if (!format || !["zip", "pdf"].includes(format)) {
        return res
          .status(400)
          .json({ error: "Invalid format. Use 'zip' or 'pdf'." });
      }

      // Ownership check — WR-02: include `deletedAt: null` so a soft-deleted
      // archive can't be exported by its creator (or an admin), consistent with
      // the soft-delete contract used by the other archive routes.
      const archive = await prisma.archive.findFirst({
        where: { id: archiveId, deletedAt: null },
      });
      if (!archive) {
        return res.status(404).json({ error: "Archive not found" });
      }

      const isOwner = archive.createdBy === req.userId;
      const admin = isAdmin(req.user);

      if (!isOwner && !admin) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      if (format === "zip") {
        await exportArchiveAsZip(archiveId, res);
      } else {
        await exportArchiveAsPdf(archiveId, res);
      }
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        logger.error("[archiveExport] Export error", {
          error: message,
          archiveId: req.params.archiveId,
        });
        return res.status(500).json({ error: message });
      }
    }
  },
);

export default router;
