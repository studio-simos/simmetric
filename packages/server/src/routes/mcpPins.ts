// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import {
  chatIdParamSchema,
  createMcpPinSchema,
  mcpPinIdParamSchema,
} from "@simmetric-chat/shared";
import prisma, { withSoftDelete } from "../utils/prisma";
import { logger } from "../utils/logger";

const router = Router();

// All pin operations require authentication
// D-11: any workspace member can manage pins (not admin-only)
// Workspace access verified inline in each handler by loading the chat and checking membership
router.use(authMiddleware);

// GET /:chatId/pins — List all MCP pins for a chat (MCP-07, per D-10)
router.get("/:chatId/pins", async (req: Request, res: Response) => {
  try {
    const paramResult = chatIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: paramResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { chatId } = paramResult.data;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, workspaceId: true },
    });
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    // D-11: any workspace member — check ownership or WorkspaceAccess
    const userId = req.userId!;
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: chat.workspaceId, deletedAt: null }),
      include: { project: true },
    });
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    // Check if user owns the parent project
    const isOwner = (workspace as unknown as { project: { createdBy: string } }).project.createdBy === userId;
    if (!isOwner) {
      // Check explicit workspace access
      const wsAccess = await prisma.workspaceAccess.findFirst({
        where: { userId, workspaceId: chat.workspaceId } as Record<string, unknown>,
      });
      if (!wsAccess) {
        // Also check project-level access
        const projAccess = await prisma.projectAccess.findFirst({
          where: { userId, projectId: (workspace as unknown as { projectId: string }).projectId } as Record<string, unknown>,
        });
        if (!projAccess) {
          res.status(403).json({ error: "Insufficient permissions" });
          return;
        }
      }
    }

    const pins = await prisma.chatMCPPin.findMany({
      where: { chatId },
      include: {
        connection: {
          select: {
            id: true,
            name: true,
            url: true,
            transportType: true,
            enabled: true,
            workspaceId: true,
            source: true,
            catalogEntryId: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json(pins);
  } catch (err: unknown) {
    logger.error("[mcpPins] Error listing pins", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:chatId/pins — Pin an MCP connection to a chat (MCP-07, per D-10)
router.post("/:chatId/pins", async (req: Request, res: Response) => {
  try {
    const paramResult = chatIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: paramResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { chatId } = paramResult.data;

    const parsed = createMcpPinSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { connectionId } = parsed.data;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, workspaceId: true },
    });
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const userId = req.userId!;
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: chat.workspaceId, deletedAt: null }),
      include: { project: true },
    });
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    // Check if user owns the parent project
    const isOwner = (workspace as unknown as { project: { createdBy: string } }).project.createdBy === userId;
    if (!isOwner) {
      // Check explicit workspace access
      const wsAccess = await prisma.workspaceAccess.findFirst({
        where: { userId, workspaceId: chat.workspaceId } as Record<string, unknown>,
      });
      if (!wsAccess) {
        // Also check project-level access
        const projAccess = await prisma.projectAccess.findFirst({
          where: { userId, projectId: (workspace as unknown as { projectId: string }).projectId } as Record<string, unknown>,
        });
        if (!projAccess) {
          res.status(403).json({ error: "Insufficient permissions" });
          return;
        }
      }
    }

    // Cross-workspace prevention: verify connection belongs to same workspace
    // as chat. Global connections (workspaceId null AND projectId null) are
    // admin-configured tools usable from any workspace — D-14 semantics,
    // mirrored from getMCPToolsForWorkspace (mcpClient.ts). Project-scoped
    // connections (workspaceId null, projectId set) are rejected: they are not
    // usable from a workspace chat (D-14 filters them out of tool resolution).
    const connection = await prisma.mCPConnection.findFirst({
      where: {
        id: connectionId,
        OR: [{ workspaceId: chat.workspaceId }, { workspaceId: null, projectId: null }],
      },
    });
    if (!connection) {
      res.status(404).json({
        error: "MCP connection not found in this workspace",
      });
      return;
    }

    const pin = await prisma.chatMCPPin.create({
      data: { chatId, connectionId, userId },
      include: {
        connection: {
          select: { id: true, name: true, url: true, enabled: true },
        },
      },
    });

    res.status(201).json(pin);
  } catch (err: unknown) {
    // Duplicate pin: Prisma P2002 unique violation on @@unique([chatId, connectionId])
    if ((err as Record<string, unknown>).code === "P2002") {
      res.status(409).json({
        error: "This connection is already pinned to this chat",
      });
      return;
    }
    logger.error("[mcpPins] Error creating pin", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:chatId/pins/:pinId — Remove an MCP pin from a chat (MCP-07, per D-10)
router.delete("/:chatId/pins/:pinId", async (req: Request, res: Response) => {
  try {
    const chatParamResult = chatIdParamSchema.safeParse(req.params);
    if (!chatParamResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: chatParamResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { chatId } = chatParamResult.data;

    const pinParamResult = mcpPinIdParamSchema.safeParse(req.params);
    if (!pinParamResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: pinParamResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { pinId } = pinParamResult.data;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, workspaceId: true },
    });
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const userId = req.userId!;
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: chat.workspaceId, deletedAt: null }),
      include: { project: true },
    });
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    // Check if user owns the parent project
    const isOwner = (workspace as unknown as { project: { createdBy: string } }).project.createdBy === userId;
    if (!isOwner) {
      // Check explicit workspace access
      const wsAccess = await prisma.workspaceAccess.findFirst({
        where: { userId, workspaceId: chat.workspaceId } as Record<string, unknown>,
      });
      if (!wsAccess) {
        // Also check project-level access
        const projAccess = await prisma.projectAccess.findFirst({
          where: { userId, projectId: (workspace as unknown as { projectId: string }).projectId } as Record<string, unknown>,
        });
        if (!projAccess) {
          res.status(403).json({ error: "Insufficient permissions" });
          return;
        }
      }
    }

    const pin = await prisma.chatMCPPin.findFirst({
      where: { id: pinId, chatId },
    });
    if (!pin) {
      res.status(404).json({ error: "Pin not found" });
      return;
    }

    await prisma.chatMCPPin.delete({ where: { id: pinId } });

    res.json({ message: "Pin removed" });
  } catch (err: unknown) {
    logger.error("[mcpPins] Error deleting pin", { error: (err instanceof Error ? err.message : String(err)) });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
