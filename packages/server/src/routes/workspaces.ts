// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireWorkspaceAccess, requirePermission, requireAdmin } from "../middleware/rbac";
import { requireFeatureLimit } from "../middleware/license";
import prisma, { withSoftDelete } from "../utils/prisma";
import { createWorkspaceSchema, updateWorkspaceSchema, createFolderSchema, updateFolderSchema, grantWorkspaceAccessSchema, permanentDeleteWorkspacesSchema } from "@simmetric-chat/shared";
import { logEvent } from "../services/eventLogService";
import { isAdmin } from "../utils/auth";

const router = Router();

router.use(authMiddleware);

/**
 * @openapi
 * /workspaces:
 *   get:
 *     tags: [Workspaces]
 *     summary: List workspaces accessible to the current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Array of workspaces }
 */
// GET /api/workspaces — list workspaces accessible to the current user
router.get("/", async (req: Request, res: Response) => {
  try {
    const showDeleted = req.query.deleted === "true";

    let workspaces;
    if (isAdmin(req.user)) {
      workspaces = await prisma.workspace.findMany({
        where: withSoftDelete(showDeleted ? { deletedAt: { not: null } } : { deletedAt: null }),
        include: {
          project: { select: { createdBy: true, name: true, creator: { select: { username: true, firstName: true, lastName: true } } } },
          _count: { select: { chats: true, documents: true } },
          agentConfig: true,
        },
      });
    } else {
      workspaces = await prisma.workspace.findMany({
        where: {
          ...(showDeleted ? { deletedAt: { not: null } } : { deletedAt: null }),
          OR: [
            { project: { createdBy: req.userId! } },
            { accessGrants: { some: { userId: req.userId! } } },
            { project: { accessGrants: { some: { userId: req.userId! } } } },
          ],
        },
        include: {
          project: { select: { createdBy: true, name: true, creator: { select: { username: true, firstName: true, lastName: true } } } },
          _count: { select: { chats: true, documents: true } },
          agentConfig: true,
        },
      });
    }

    res.json(workspaces);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /workspaces:
 *   post:
 *     tags: [Workspaces]
 *     summary: Create a workspace in a project
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, projectId]
 *             properties:
 *               name: { type: string, example: "My Workspace" }
 *               projectId: { type: string }
 *               instructions: { type: string }
 *               embeddingModel: { type: string, example: "Xenova/all-MiniLM-L6-v2" }
 *               templateId: { type: string }
 *               systemPrompt: { type: string }
 *               skills: { type: array, items: { type: string } }
 *     responses:
 *       201: { description: Workspace created }
 *       400: { description: Validation error }
 *       402: { description: Workspace limit reached (Community tier) }
 *       403: { description: Access denied to project }
 *       404: { description: Project not found }
 */
// POST /api/workspaces — create a workspace in a project
router.post("/", requirePermission("workspace:create"), requireFeatureLimit("max_workspaces", "workspace"), async (req: Request, res: Response) => {
  try {
    const validated = createWorkspaceSchema.parse(req.body);

    // Verify user has access to the parent project
    const project = await prisma.project.findFirst({
      where: withSoftDelete({ id: validated.projectId, deletedAt: null }),
    });

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const admin = isAdmin(req.user);
    const isOwner = project.createdBy === req.userId;
    const hasAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: validated.projectId },
    });

    if (!admin && !isOwner && !hasAccess) {
      res.status(403).json({ error: "Access denied to this project" });
      return;
    }

    // Resolve configuration: request body > template > defaults
    let embeddingModel = validated.embeddingModel;
    let systemPrompt: string | undefined;
    let enabledSkills: string | undefined;

    if (validated.templateId) {
      const template = await prisma.workspaceTemplate.findUnique({
        where: { id: validated.templateId },
      });

      if (template) {
        // Template's embeddingModel overrides the default if set
        if (template.embeddingModel) {
          embeddingModel = template.embeddingModel;
        }
        systemPrompt = template.systemPrompt;
        enabledSkills = template.skills; // already JSON string
      }
    }

    // Request body overrides take precedence over template values
    if (validated.systemPrompt !== undefined) {
      systemPrompt = validated.systemPrompt;
    }
    if (validated.skills !== undefined) {
      enabledSkills = JSON.stringify(validated.skills);
    }
    if (validated.embeddingModel !== undefined && validated.embeddingModel !== "") {
      // User explicitly set an embedding model (or template set one)
      embeddingModel = validated.embeddingModel;
    }

    const workspace = await prisma.workspace.create({
      data: {
        projectId: validated.projectId,
        name: validated.name,
        instructions: validated.instructions,
        embeddingModel,
        templateId: validated.templateId || null,
        allowMemberUploads: validated.allowMemberUploads,
        icon: validated.icon || null,
      },
    });

    // Create agent config with resolved configuration
    await prisma.workspaceAgentConfig.upsert({
      where: { workspaceId: workspace.id },
      update: {},
      create: {
        workspaceId: workspace.id,
        systemPrompt: systemPrompt || "You are a helpful AI assistant with access to workspace documents and tools.",
        enabledSkills: enabledSkills || "[\"rag_search\",\"workspace_memory\"]",
        constraints: validated.constraints ? JSON.stringify(validated.constraints) : "{}",
        parsingConfig: validated.parsingConfig ? JSON.stringify(validated.parsingConfig) : "{}",
      },
    });

    await logEvent("workspace", workspace.id, "create", req.userId!);

    res.status(201).json(workspace);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "A workspace with this name already exists in this project" });
      return;
    }
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// GET /api/workspaces/:workspaceId — get a specific workspace
router.get("/:workspaceId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: req.params.workspaceId as string, deletedAt: null }),
      include: {
        documents: { where: withSoftDelete({ deletedAt: null }) },
        agentConfig: true,
      },
    });

    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    res.json(workspace);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/workspaces/:workspaceId — update a workspace
router.put("/:workspaceId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const validated = updateWorkspaceSchema.parse(req.body);

    const {
      name,
      instructions,
      embeddingModel,
      allowMemberUploads,
      icon,
      templateId,
      systemPrompt,
      constraints,
      parsingConfig,
      skills,
    } = validated;

    const workspace = await prisma.workspace.update({
      where: { id: req.params.workspaceId as string },
      data: {
        ...(name !== undefined && { name }),
        ...(instructions !== undefined && { instructions }),
        ...(embeddingModel !== undefined && { embeddingModel }),
        ...(allowMemberUploads !== undefined && { allowMemberUploads }),
        ...(icon !== undefined && { icon }),
        ...(templateId !== undefined && { template: templateId ? { connect: { id: templateId } } : { disconnect: true } }),
      },
    });

    if (systemPrompt !== undefined || skills !== undefined || constraints !== undefined || parsingConfig !== undefined) {
      const agentConfigData: {
        systemPrompt?: string;
        enabledSkills?: string;
        constraints?: string;
        parsingConfig?: string;
      } = {};
      if (systemPrompt !== undefined) agentConfigData.systemPrompt = systemPrompt;
      if (skills !== undefined) agentConfigData.enabledSkills = JSON.stringify(skills) as string;
      if (constraints !== undefined) agentConfigData.constraints = JSON.stringify(constraints);
      if (parsingConfig !== undefined) agentConfigData.parsingConfig = JSON.stringify(parsingConfig);

      await prisma.workspaceAgentConfig.upsert({
        where: { workspaceId: req.params.workspaceId as string },
        update: agentConfigData,
        create: {
          workspaceId: req.params.workspaceId as string,
          systemPrompt: agentConfigData.systemPrompt ?? "You are a helpful AI assistant with access to workspace documents and tools.",
          enabledSkills: agentConfigData.enabledSkills ?? "[\"rag_search\",\"workspace_memory\"]",
          constraints: agentConfigData.constraints ?? "{}",
          parsingConfig: agentConfigData.parsingConfig ?? "{}",
        },
      });
    }

    await logEvent("workspace", workspace.id, "update", req.userId!);

    res.json(workspace);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "A workspace with this name already exists in this project" });
      return;
    }
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * @openapi
 * /workspaces/permanent:
 *   delete:
 *     tags: [Workspaces]
 *     summary: Permanently delete multiple soft-deleted workspaces (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids: { type: array, items: { type: string } }
 *     responses:
 *       200: { description: Workspaces permanently deleted }
 *       400: { description: Validation error }
 *       403: { description: Admin access required }
 */
router.delete("/permanent", requireAdmin, async (req: Request, res: Response) => {
  try {
    const validated = permanentDeleteWorkspacesSchema.parse(req.body);
    const result = await prisma.workspace.deleteMany({
      where: { id: { in: validated.ids }, deletedAt: { not: null } },
    });

    res.json({ deleted: result.count });

    setImmediate(() => {
      for (const id of validated.ids) {
        logEvent("workspace", id, "permanent-delete", req.userId!).catch(() => {});
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/workspaces/:workspaceId — soft-delete a workspace
router.delete("/:workspaceId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    await prisma.workspace.update({
      where: { id: req.params.workspaceId as string },
      data: { deletedAt: new Date() },
    });

    await logEvent("workspace", req.params.workspaceId as string, "delete", req.userId!);

    res.json({ message: "Workspace deleted" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /workspaces/{workspaceId}/restore:
 *   put:
 *     tags: [Workspaces]
 *     summary: Restore a soft-deleted workspace
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Workspace restored }
 *       404: { description: Workspace not found }
 */
// PUT /api/workspaces/:workspaceId/restore — restore a soft-deleted workspace
router.put("/:workspaceId/restore", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const workspace = await prisma.workspace.update({
      where: { id: req.params.workspaceId as string },
      data: { deletedAt: null },
    });

    await logEvent("workspace", workspace.id, "restore", req.userId!);

    res.json(workspace);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/workspaces/:workspaceId/access — grant workspace access
router.post("/:workspaceId/access", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const validated = grantWorkspaceAccessSchema.parse(req.body);
    const workspaceId = req.params.workspaceId as string;

    await prisma.workspaceAccess.upsert({
      where: {
        userId_workspaceId: { userId: validated.userId, workspaceId },
      },
      create: { userId: validated.userId, workspaceId },
      update: {},
    });

    res.json({ message: "Access granted" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// GET /api/workspaces/:workspaceId/folders — list folders in workspace
router.get("/:workspaceId/folders", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  try {
    const folders = await prisma.chatFolder.findMany({
      where: { workspaceId, deletedAt: null },
    });
    res.json(folders);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/workspaces/:workspaceId/folders — create a folder
router.post("/:workspaceId/folders", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  try {
    const validated = createFolderSchema.parse(req.body);
    const folder = await prisma.chatFolder.create({
      data: { workspaceId, name: validated.name },
    });
    res.status(201).json(folder);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// PUT /api/workspaces/:workspaceId/folders/:folderId — update a folder
router.put("/:workspaceId/folders/:folderId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const folderId = req.params.folderId as string;
  const workspaceId = req.params.workspaceId as string;
  try {
    const validated = updateFolderSchema.parse(req.body);
    const folder = await prisma.chatFolder.findFirst({
      where: { id: folderId, workspaceId, deletedAt: null },
    });
    if (!folder) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    const updated = await prisma.chatFolder.update({
      where: { id: folderId },
      data: { name: validated.name },
    });
    res.json(updated);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/workspaces/:workspaceId/folders/:folderId — soft-delete a folder
router.delete("/:workspaceId/folders/:folderId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const folderId = req.params.folderId as string;
  const cascade = req.query.cascade === "true";
  try {
    if (cascade) {
      await prisma.$transaction([
        prisma.chat.updateMany({
          where: { folderId, deletedAt: null },
          data: { deletedAt: new Date() },
        }),
        prisma.chatFolder.update({
          where: { id: folderId },
          data: { deletedAt: new Date() },
        }),
      ]);
    } else {
      await prisma.$transaction([
        prisma.chat.updateMany({
          where: { folderId, deletedAt: null },
          data: { folderId: null },
        }),
        prisma.chatFolder.update({
          where: { id: folderId },
          data: { deletedAt: new Date() },
        }),
      ]);
    }
    res.json({ message: "Folder deleted", cascade });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/workspaces/:workspaceId/folders/:folderId/restore — restore a soft-deleted folder
router.put("/:workspaceId/folders/:folderId/restore", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const folderId = req.params.folderId as string;
  const workspaceId = req.params.workspaceId as string;
  try {
    const folder = await prisma.chatFolder.findFirst({
      where: { id: folderId, workspaceId, deletedAt: { not: null } },
    });
    if (!folder) {
      res.status(404).json({ error: "Folder not found or not deleted" });
      return;
    }
    const restored = await prisma.chatFolder.update({
      where: { id: folderId },
      data: { deletedAt: null },
    });
    res.json(restored);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;