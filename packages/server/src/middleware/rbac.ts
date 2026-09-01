// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { Request, Response, NextFunction } from "express";
import type { PermissionName } from "@simmetric-chat/shared";
import prisma, { withSoftDelete } from "../utils/prisma";
import { getEffectivePermissions, isAdmin } from "../utils/auth";



/**
 * Check if the authenticated user has the specified permission(s).
 * Admins always pass. Regular users must have the permission in their roles.
 */
export function requirePermission(permission: PermissionName | PermissionName[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // Admins have all permissions
    if (isAdmin(req.user)) {
      return next();
    }

    const permissions = getEffectivePermissions(req.user);
    const required = Array.isArray(permission) ? permission : [permission];
    const hasPermission = required.every((p) => permissions.includes(p));

    if (!hasPermission) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}

/**
 * Check if user is an admin (has the admin settings permission).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (!isAdmin(req.user)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  next();
}

/**
 * IDOR prevention: verify the user has access to a specific project.
 * Admins can access any project. Regular users must be the creator or have explicit access.
 */
export async function requireProjectAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const projectId = req.params.projectId;
  if (!projectId) {
    res.status(400).json({ error: "Project ID required" });
    return;
  }

  // Admins have global access
  if (isAdmin(req.user)) {
    return next();
  }

  const project = await prisma.project.findFirst({
    where: withSoftDelete({ id: projectId as string, deletedAt: null }),
  });

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.createdBy === req.userId) {
    return next();
  }

  const access = await prisma.projectAccess.findFirst({
    where: { userId: req.userId, projectId } as Record<string, unknown>,
  });

  if (!access) {
    res.status(403).json({ error: "Access denied to this project" });
    return;
  }

  next();
}

/**
 * IDOR prevention: verify the user has access to a specific workspace.
 * Admins can access any workspace. Regular users must have explicit access or own the parent project.
 */
export async function requireWorkspaceAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const workspaceId = req.params.workspaceId as string;
  if (!workspaceId) {
    res.status(400).json({ error: "Workspace ID required" });
    return;
  }

  // Admins have global access
  if (isAdmin(req.user)) {
    return next();
  }

  const workspace = await prisma.workspace.findFirst({
    where: withSoftDelete({ id: workspaceId as string, deletedAt: null }),
    include: { project: true },
  });

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  // Check if user owns the parent project
  if (workspace.project?.createdBy === req.userId) {
    return next();
  }

  // Check explicit workspace access
  const access = await prisma.workspaceAccess.findFirst({
    where: { userId: req.userId!, workspaceId },
  });

  if (!access) {
    // Also check project-level access
    const projectAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: workspace.project?.id },
    });

    if (!projectAccess) {
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }
  }

  next();
}