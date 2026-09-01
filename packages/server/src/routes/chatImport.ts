// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireWorkspaceAccess } from "../middleware/rbac";
import { generateImportPreview, importChats } from "../services/chatImportService";
import multer from "multer";

// Multer config for chat import uploads (50 MB limit per D-12).
// In-memory storage keeps PII chat history in RAM (req.file.buffer) instead of
// writing it to disk, eliminating data-residue risk on crash/kill (SEC-03).
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();
router.use(authMiddleware);

// POST /:workspaceId/chats/import/preview — preview import before confirming (per D-14)
router.post("/:workspaceId/chats/import/preview", requireWorkspaceAccess, importUpload.single("file"), async (req: Request, res: Response) => {

  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const fileContent = req.file!.buffer.toString("utf-8");
    let data: unknown;
    try {
      data = JSON.parse(fileContent);
    } catch {
      res.status(400).json({ error: "Invalid JSON file" });
      return;
    }

    const preview = generateImportPreview(data);
    if ("error" in preview) {
      res.status(400).json(preview);
      return;
    }
    res.json(preview);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /:workspaceId/chats/import/confirm — confirm and create imported chats (per D-13)
router.post("/:workspaceId/chats/import/confirm", requireWorkspaceAccess, importUpload.single("file"), async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  const userId = req.userId!;
  const format = req.body.format;

  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (!format) {
      res.status(400).json({ error: "Format is required. Use the preview endpoint to detect format." });
      return;
    }

    const fileContent = req.file!.buffer.toString("utf-8");
    let data: unknown;
    try {
      data = JSON.parse(fileContent);
    } catch {
      res.status(400).json({ error: "Invalid JSON file" });
      return;
    }

    const result = await importChats(workspaceId, userId, data, format);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;
