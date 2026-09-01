// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import {
  createArchiveSchema,
  updateArchiveSchema,
} from "@simmetric-chat/shared";
import type { CreateArchiveInput } from "@simmetric-chat/shared";
import { createArchive, getArchive, getArchives, updateArchive, deleteArchive, createArchiveFromTemplate } from "../services/archiveService";
import { rebuildIndex } from "../services/archivePageService";
import { rebuildAllIndexFiles } from "../services/archiveIndexService";
import { logEvent } from "../services/eventLogService";
import { logger } from "../utils/logger";

const router = Router();

// Template name validation schema
import { z } from "zod";
const createFromTemplateSchema = z.object({
  templateName: z.enum(["research", "project", "personal"], {
    message: "Template name must be one of: research, project, personal",
  }),
  name: z.string().min(1, "Archive name is required").max(200, "Archive name must be at most 200 characters"),
});

// GET / — List all archives (global visibility per D-02)
router.get("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const archives = await getArchives();
    res.json(archives);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archives] Error listing archives", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — Create a new archive
router.post("/", authMiddleware, requirePermission("archive:write"), async (req: Request, res: Response) => {
  try {
    const result = createArchiveSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: result.error.flatten().fieldErrors,
      });
      return;
    }

    const validatedData: CreateArchiveInput = result.data;
    const archive = await createArchive(validatedData, req.userId!);

    res.status(201).json(archive);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const errCode = (err as { code?: string }).code;
    logger.error("[archives] Error creating archive", { error: message });

    // Check for slug collision (unlikely after resolveCollision, but defensive)
    if (errCode === "P2002") {
      const target = (err as { meta?: { target?: string[] } }).meta?.target;
      if (target?.includes("slug")) {
        res.status(409).json({ error: "An archive with this slug already exists" });
      } else {
        res.status(409).json({ error: "An archive with this name already exists" });
      }
      return;
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:archiveId — Get single archive
router.get("/:archiveId", authMiddleware, async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    try {
      const archive = await getArchive(archiveId);
      res.json(archive);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (message?.includes("not found")) {
        res.status(404).json({ error: "Archive not found" });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archives] Error fetching archive", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /:archiveId — Update archive
router.put("/:archiveId", authMiddleware, requirePermission("archive:write"), async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    const result = updateArchiveSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: result.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const updated = await updateArchive(archiveId, result.data);
      res.json(updated);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if ((err as { code?: string }).code === "P2002") {
        res.status(409).json({ error: "An archive with this name already exists" });
        return;
      }
      if (message?.includes("not found")) {
        res.status(404).json({ error: "Archive not found" });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archives] Error updating archive", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:archiveId — Soft-delete archive
router.delete("/:archiveId", authMiddleware, requirePermission("archive:delete"), async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    try {
      const result = await deleteArchive(archiveId);
      res.json(result);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (message?.includes("not found")) {
        res.status(404).json({ error: "Archive not found" });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archives] Error deleting archive", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /from-template — Create archive from template (ARCH-06)
router.post("/from-template", authMiddleware, requirePermission("archive:write"), async (req: Request, res: Response) => {
  try {
    const result = createFromTemplateSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: result.error.flatten().fieldErrors,
      });
      return;
    }

    const { templateName, name } = result.data;

    try {
      const archive = await createArchiveFromTemplate(templateName, name, req.userId!);
      res.status(201).json(archive);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if ((err as { code?: string }).code === "P2002") {
        res.status(409).json({ error: "An archive with this name already exists" });
        return;
      }
      if (message?.includes("Unknown template")) {
        res.status(400).json({ error: message });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archives] Error creating archive from template", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:archiveId/reindex — Admin-only reindex
router.post("/:archiveId/reindex", authMiddleware, requirePermission("archive:write"), async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    // Verify archive exists (rebuildIndex also checks, but explicit guard
    // lets the catch block return 404 before any FS operations start)
    await getArchive(archiveId);

    // Rebuild DB index from filesystem
    const reindexResult = await rebuildIndex(archiveId);

    // Regenerate _index.md files
    await rebuildAllIndexFiles(archiveId);

    logger.info("[archives] Reindex complete", {
      archiveId,
      reindexed: reindexResult.reindexed,
      errors: reindexResult.errors,
    });

    // Log event
    logEvent("archive", archiveId, "archive.reindexed", req.userId!, {
      reindexed: reindexResult.reindexed,
      errors: reindexResult.errors,
    }).catch((err) => {
      logger.error("[archives] Failed to log event", { error: err.message, archiveId });
    });

    res.json({
      message: "Reindex complete",
      ...reindexResult,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    if (message?.includes("not found")) {
      res.status(404).json({ error: "Archive not found" });
      return;
    }
    logger.error("[archives] Error reindexing archive", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
