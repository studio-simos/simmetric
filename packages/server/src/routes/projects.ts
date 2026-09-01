// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireProjectAccess, requirePermission } from "../middleware/rbac";
import { requireFeatureLimit } from "../middleware/license";
import prisma, { withSoftDelete } from "../utils/prisma";
import { createProjectSchema, updateProjectSchema } from "@simmetric-chat/shared";
import { logEvent } from "../services/eventLogService";
import { isAdmin } from "../utils/auth";

const router = Router();

// All project routes require authentication
router.use(authMiddleware);

// GET /api/projects — list projects accessible to the current user
router.get("/", async (req: Request, res: Response) => {
  try {
    let projects;
    if (isAdmin(req.user)) {
      projects = await prisma.project.findMany({ where: withSoftDelete({ deletedAt: null }) });
    } else {
      projects = await prisma.project.findMany({
        where: {
          deletedAt: null,
          OR: [
            { createdBy: req.userId! },
            { accessGrants: { some: { userId: req.userId! } } },
          ],
        },
      });
    }

    res.json(projects);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/projects — create a project
router.post("/", requirePermission("project:create"), requireFeatureLimit("max_projects", "project"), async (req: Request, res: Response) => {
  try {
    const validated = createProjectSchema.parse(req.body);

    const project = await prisma.project.create({
      data: {
        name: validated.name,
        description: validated.description,
        createdBy: req.userId!,
      },
    });

    await logEvent("project", project.id, "create", req.userId!);

    res.status(201).json(project);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "A project with this name already exists" });
      return;
    }
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// GET /api/projects/:projectId — get a specific project
router.get("/:projectId", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    const project = await prisma.project.findFirst({
      where: withSoftDelete({ id: req.params.projectId as string, deletedAt: null }),
      include: { workspaces: { where: withSoftDelete({ deletedAt: null }) } },
    });

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json(project);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/projects/:projectId/usage — pre-delete usage check (counts of related resources)
router.get("/:projectId/usage", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId as string;
    const project = await prisma.project.findFirst({
      where: withSoftDelete({ id: projectId, deletedAt: null }),
    });

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const [workspaces, chats, documents, mcpConnections, accessGrants] = await Promise.all([
      prisma.workspace.count({ where: { projectId, deletedAt: null } }),
      // Chat.workspace is the relation name; Chat has its own soft-delete (deletedAt)
      prisma.chat.count({ where: { workspace: { projectId, deletedAt: null }, deletedAt: null } }),
      prisma.document.count({ where: { workspace: { projectId, deletedAt: null }, deletedAt: null } }),
      prisma.mCPConnection.count({ where: { projectId } }),
      prisma.projectAccess.count({ where: { projectId } }),
    ]);

    await logEvent("project", projectId, "usage_check", req.userId!);

    res.json({ workspaces, chats, documents, mcpConnections, accessGrants });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/projects/:projectId/export — export project history as downloadable JSON
router.get("/:projectId/export", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId as string;
    const project = await prisma.project.findFirst({
      where: withSoftDelete({ id: projectId, deletedAt: null }),
    });

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const workspaces = await prisma.workspace.findMany({
      where: { projectId, deletedAt: null },
      include: {
        chats: {
          where: { deletedAt: null },
          orderBy: { createdAt: "asc" },
          include: {
            messages: {
              orderBy: { createdAt: "asc" },
              select: { id: true, role: true, content: true, createdAt: true, metadata: true },
            },
          },
        },
        documents: {
          where: { deletedAt: null },
          select: { id: true, name: true, status: true, createdAt: true },
        },
      },
    });

    const mcpConnections = await prisma.mCPConnection.findMany({
      where: { projectId },
      select: { id: true, name: true, enabled: true },
    });

    // Count chunks per document without N+1 — single grouped query.
    const allDocIds = workspaces.flatMap((w) => w.documents.map((d) => d.id));
    const chunkCounts = allDocIds.length
      ? await prisma.documentChunk.groupBy({
          by: ["documentId"],
          where: { documentId: { in: allDocIds } },
          _count: { _all: true },
        })
      : [];
    const chunkCountMap = new Map(chunkCounts.map((c) => [c.documentId, c._count._all]));

    const payload = {
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        chats: w.chats.map((c) => ({
          id: c.id,
          name: c.name,
          createdAt: c.createdAt,
          messages: c.messages,
        })),
        documents: w.documents.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          createdAt: d.createdAt,
          chunkCount: chunkCountMap.get(d.id) ?? 0,
        })),
      })),
      mcpConnections,
      exportedAt: new Date().toISOString(),
    };

    await logEvent("project", projectId, "export", req.userId!);

    const safeName = project.name.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "project";
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="project-${safeName}.json"`);
    res.json(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/projects/:projectId — update a project
router.put("/:projectId", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    const validated = updateProjectSchema.parse(req.body);

    const project = await prisma.project.update({
      where: { id: req.params.projectId as string },
      data: validated,
    });

    await logEvent("project", project.id, "update", req.userId!);

    res.json(project);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "A project with this name already exists" });
      return;
    }
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/projects/:projectId — soft-delete a project
router.delete("/:projectId", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    await prisma.project.update({
      where: { id: req.params.projectId as string },
      data: { deletedAt: new Date() },
    });

    await logEvent("project", req.params.projectId as string, "delete", req.userId!);

    res.json({ message: "Project deleted" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/projects/:projectId/usage — pre-delete usage counts (IDOR-safe)
router.get("/:projectId/usage", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    const id = req.params.projectId as string;
    const project = await prisma.project.findFirst({
      where: withSoftDelete({ id, deletedAt: null }),
    });
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const [workspaces, chats, documents, mcpConnections, accessGrants] = await Promise.all([
      prisma.workspace.count({ where: { projectId: id, deletedAt: null } }),
      // Chat has a deletedAt column — exclude soft-deleted chats.
      prisma.chat.count({ where: { workspace: { projectId: id, deletedAt: null }, deletedAt: null } }),
      prisma.document.count({ where: { workspace: { projectId: id, deletedAt: null }, deletedAt: null } }),
      prisma.mCPConnection.count({ where: { projectId: id } }),
      prisma.projectAccess.count({ where: { projectId: id } }),
    ]);

    await logEvent("project", id, "usage_check", req.userId!);

    res.json({ workspaces, chats, documents, mcpConnections, accessGrants });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/projects/:projectId/export — full project history JSON download (IDOR-safe)
router.get("/:projectId/export", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    const id = req.params.projectId as string;
    const project = await prisma.project.findFirst({
      where: withSoftDelete({ id, deletedAt: null }),
    });
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const workspaces = await prisma.workspace.findMany({
      where: { projectId: id, deletedAt: null },
      include: {
        chats: {
          where: { deletedAt: null },
          orderBy: { createdAt: "asc" },
          include: {
            messages: {
              orderBy: { createdAt: "asc" },
              select: { id: true, role: true, content: true, createdAt: true, metadata: true },
            },
          },
        },
        documents: {
          where: { deletedAt: null },
          select: { id: true, name: true, status: true, createdAt: true },
        },
      },
    });

    const mcpConnections = await prisma.mCPConnection.findMany({
      where: { projectId: id },
      select: { id: true, name: true, enabled: true },
    });

    // chunkCount per document — parallel counts to avoid N+1.
    const allDocs = workspaces.flatMap((w) => w.documents.map((d) => ({ ...d, workspaceId: w.id })));
    const chunkCounts = await Promise.all(
      allDocs.map((d) => prisma.documentChunk.count({ where: { documentId: d.id } })),
    );
    const chunkCountById = new Map(allDocs.map((d, idx) => [d.id, chunkCounts[idx]]));

    const payload = {
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        chats: w.chats.map((c) => ({
          id: c.id,
          title: c.name,
          createdAt: c.createdAt,
          messages: c.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            metadata: m.metadata,
          })),
        })),
        documents: w.documents.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          createdAt: d.createdAt,
          chunkCount: chunkCountById.get(d.id) ?? 0,
        })),
      })),
      mcpConnections,
      exportedAt: new Date().toISOString(),
    };

    const safeName = (project.name ?? "project").replace(/[^\w.-]+/g, "_");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="project-${safeName}.json"`);

    await logEvent("project", id, "export", req.userId!);

    res.json(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/projects/:projectId/access — grant a user access to a project
router.post("/:projectId/access", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    const userId: string = req.body.userId;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await prisma.projectAccess.upsert({
      where: {
        userId_projectId: { userId, projectId: req.params.projectId as string },
      },
      create: { userId, projectId: req.params.projectId as string },
      update: {},
    });

    res.json({ message: "Access granted" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/projects/:projectId/access — revoke a user's access to a project
router.delete("/:projectId/access", requireProjectAccess, async (req: Request, res: Response) => {
  try {
    const userId: string = req.body.userId;

    await prisma.projectAccess.deleteMany({
      where: { userId, projectId: req.params.projectId as string },
    });

    res.json({ message: "Access revoked" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

export default router;