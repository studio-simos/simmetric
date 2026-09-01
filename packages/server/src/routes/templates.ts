// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { listTemplates, getTemplateById, saveTemplateToFile } from "../services/templateService";
import prisma from "../utils/prisma";
import { Prisma } from "@prisma/client";

const router = Router();

// GET /api/templates — list all templates (any authenticated user can browse)
router.get("/", authMiddleware, async (_req: Request, res: Response) => {
  try {
    const templates = await listTemplates();
    // Parse JSON fields for each template
    const parsed = templates.map((t) => ({
      ...t,
      skills: JSON.parse(t.skills),
      parsingConfig: JSON.parse(t.parsingConfig),
      constraints: JSON.parse(t.constraints),
    }));
    res.json(parsed);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/templates/:templateId — get a single template
router.get("/:templateId", authMiddleware, async (req: Request, res: Response) => {
  try {
    const template = await getTemplateById(req.params.templateId as string);
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    res.json({
      ...template,
      skills: JSON.parse(template.skills),
      parsingConfig: JSON.parse(template.parsingConfig),
      constraints: JSON.parse(template.constraints),
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/templates — create a custom template (any authenticated user)
router.post("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const { slug, name, description, icon, systemPrompt, skills, parsingConfig, constraints, embeddingModel, persistToDisk } = req.body;

    if (!slug || !name || !systemPrompt) {
      res.status(400).json({ error: "slug, name, and systemPrompt are required" });
      return;
    }

    const template = await prisma.workspaceTemplate.create({
      data: {
        slug,
        name,
        description: description || null,
        icon: icon || null,
        systemPrompt,
        skills: JSON.stringify(skills || ["rag_search", "workspace_memory"]),
        parsingConfig: JSON.stringify(parsingConfig || {}),
        constraints: JSON.stringify(constraints || {}),
        embeddingModel: embeddingModel || null,
        isBuiltIn: false,
      },
    });

    // Optionally persist to disk as a JSON file for re-seeding
    if (persistToDisk) {
      saveTemplateToFile({
        slug,
        name,
        description: description || "",
        icon: icon || "📋",
        systemPrompt,
        skills: skills || ["rag_search", "workspace_memory"],
        parsingConfig: parsingConfig || { ocrRequired: false },
        constraints: constraints || { localLLMOnly: false, hybridSearchForced: false, citationRequired: false },
        embeddingModel: embeddingModel || null,
      });
    }

    res.status(201).json({
      ...template,
      skills: JSON.parse(template.skills),
      parsingConfig: JSON.parse(template.parsingConfig),
      constraints: JSON.parse(template.constraints),
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const errCode = (err as { code?: string }).code;
    if (errCode === "P2002") {
      res.status(409).json({ error: "A template with this slug already exists" });
      return;
    }
    res.status(400).json({ error: message });
  }
});

// PUT /api/templates/:templateId — update a custom template (admin only)
router.put("/:templateId", authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const templateId = req.params.templateId as string;
    const existing = await getTemplateById(templateId);

    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    if (existing.isBuiltIn) {
      res.status(403).json({ error: "Built-in templates cannot be modified. Create a custom template instead." });
      return;
    }

    const { name, description, icon, systemPrompt, skills, parsingConfig, constraints, embeddingModel } = req.body;
    // D-08 (TYP-02): the Prisma model is `WorkspaceTemplate` (not `Template`),
    // so the generated type is `Prisma.WorkspaceTemplateUpdateInput`.
    const data: Prisma.WorkspaceTemplateUpdateInput = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (icon !== undefined) data.icon = icon;
    if (systemPrompt !== undefined) data.systemPrompt = systemPrompt;
    if (skills !== undefined) data.skills = JSON.stringify(skills);
    if (parsingConfig !== undefined) data.parsingConfig = JSON.stringify(parsingConfig);
    if (constraints !== undefined) data.constraints = JSON.stringify(constraints);
    if (embeddingModel !== undefined) data.embeddingModel = embeddingModel;

    const updated = await prisma.workspaceTemplate.update({
      where: { id: templateId },
      data,
    });

    res.json({
      ...updated,
      skills: JSON.parse(updated.skills),
      parsingConfig: JSON.parse(updated.parsingConfig),
      constraints: JSON.parse(updated.constraints),
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/templates/:templateId — delete a custom template (admin only)
router.delete("/:templateId", authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const templateId = req.params.templateId as string;
    const existing = await getTemplateById(templateId);

    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    if (existing.isBuiltIn) {
      res.status(403).json({ error: "Built-in templates cannot be deleted" });
      return;
    }

    await prisma.workspaceTemplate.delete({ where: { id: templateId } });
    res.json({ message: "Template deleted" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

export default router;