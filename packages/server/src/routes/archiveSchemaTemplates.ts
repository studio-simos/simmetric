// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { requirePermission, requireAdmin } from "../middleware/rbac";
import { listTemplates, getTemplate, createTemplate, applyTemplate } from "../services/archiveSchemaTemplatesService";
import { archiveSchemaTemplateSchema } from "@simmetric-chat/shared";

const router = Router();

router.get("/", authMiddleware, requirePermission("archive:read"), async (req, res) => {
  try {
    const templates = await listTemplates(req.query.archiveId as string | undefined);
    return res.json(templates);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

router.get("/:id", authMiddleware, requirePermission("archive:read"), async (req, res) => {
  try {
    const templateId = req.params.id as string;
    const template = await getTemplate(templateId);
    if (!template) return res.status(404).json({ error: "Template not found" });
    return res.json(template);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

router.post("/", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = archiveSchemaTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid template", details: parsed.error.flatten().fieldErrors });
    }
    const template = await createTemplate({ ...parsed.data, archiveId: req.body.archiveId });
    return res.status(201).json(template);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

router.post("/:id/apply", authMiddleware, requirePermission("archive:write"), async (req, res) => {
  try {
    const { archiveId } = req.body;
    if (!archiveId || typeof archiveId !== "string") {
      return res.status(400).json({ error: "archiveId is required" });
    }
    const templateId = req.params.id as string;
    const template = await applyTemplate(archiveId, templateId);
    return res.json({ message: "Template applied successfully", template });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

export default router;
