// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireWorkspaceAccess } from "../middleware/rbac";
import { exportWorkspaceChats, exportSingleChat, sanitizeFilename } from "../services/chatExportService";

const router = Router();
router.use(authMiddleware);

// GET /:workspaceId/chats/export — export all chats in workspace as JSON (per D-08/D-09/D-10)
router.get("/:workspaceId/chats/export", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;

  try {
    const exportData = await exportWorkspaceChats(workspaceId);
    const workspaceName = exportData.workspace.name.replace(/[^a-zA-Z0-9]/g, "_");
    const date = new Date().toISOString().split("T")[0];
    const filename = `${workspaceName}_${date}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.json(exportData);
  } catch (err: unknown) {
    if ((err instanceof Error ? err.message : String(err)) === "Workspace not found") {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /:workspaceId/chats/:chatId/export — download single chat as JSON (per D-09/D-10 schema)
router.get("/:workspaceId/chats/:chatId/export", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;
  const workspaceId = req.params.workspaceId as string;

  try {
    const exportData = await exportSingleChat(workspaceId, chatId);
    const chatTitle = exportData.chats[0]?.title || "chat";
    const filename = sanitizeFilename(chatTitle) + ".json";
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.json(exportData);
  } catch (err: unknown) {
    if ((err instanceof Error ? err.message : String(err)) === "Chat not found") {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;
