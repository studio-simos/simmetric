// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { invalidateAuthCache } from "../services/authService";
import { updateUserSchema } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { avatarUpload, resizeAvatar, deleteOldAvatars, removeAvatarFiles } from "../services/avatarService";
import { isAdmin } from "../utils/auth";

const router = Router();

const SALT_ROUNDS = 12;

// GET /api/users — list all users (admin-only)
router.get("/", authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        avatar: true,
        customInstructions: true,
        createdAt: true,
        updatedAt: true,
        roles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
                isDefault: true,
                permissions: {
                  select: { permissionName: true },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const result = users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      avatar: u.avatar,
      customInstructions: u.customInstructions,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      roles: u.roles.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        isDefault: ur.role.isDefault,
        permissions: ur.role.permissions.map((p) => p.permissionName),
      })),
    }));

    res.json(result);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/users/:id/avatar — upload avatar (admin or self)
router.post("/:id/avatar", authMiddleware, (req: Request, res: Response, next: NextFunction) => {
  avatarUpload.single("avatar")(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    next();
  });
}, async (req: Request, res: Response) => {
  const targetId = req.params.id as string;
  const requesterId = req.userId!;
  const admin = isAdmin(req.user);

  // Non-admins can only upload their own avatar
  if (!admin && targetId !== requesterId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  try {
    const userId = targetId;

    // Look up current avatar path for cleanup
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatar: true },
    });

    // Resize avatar to multiple sizes
    const primaryPath = await resizeAvatar(req.file.path, userId);

    // Delete old avatar files if they exist
    if (currentUser?.avatar) {
      await deleteOldAvatars(currentUser.avatar);
    }

    // Update user record with new avatar path
    await prisma.user.update({
      where: { id: userId },
      data: { avatar: primaryPath },
    });

    res.json({ avatar: primaryPath });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// DELETE /api/users/:id/avatar — remove avatar (admin or self)
router.delete("/:id/avatar", authMiddleware, async (req, res) => {
  const targetId = req.params.id as string;
  const requesterId = req.userId!;
  const admin = isAdmin(req.user);

  // Non-admins can only remove their own avatar
  if (!admin && targetId !== requesterId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: { avatar: true },
    });

    if (!user || !user.avatar) {
      res.json({ message: "No avatar to remove" });
      return;
    }

    // Delete avatar files from disk
    await removeAvatarFiles(user.avatar);

    // Clear avatar field in database
    await prisma.user.update({
      where: { id: targetId },
      data: { avatar: null },
    });

    res.json({ message: "Avatar removed" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/users/:id — get a single user (admin or self)
router.get("/:id", authMiddleware, async (req, res) => {
  const targetId = req.params.id as string;
  const requesterId = req.userId!;
  const admin = isAdmin(req.user);

  // Non-admins can only view their own profile
  if (!admin && targetId !== requesterId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: targetId },
      include: {
        roles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
                isDefault: true,
                permissions: {
                  select: { permissionName: true },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      customInstructions: user.customInstructions,
      textSize: user.textSize,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roles: user.roles.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        isDefault: ur.role.isDefault,
        permissions: ur.role.permissions.map((p) => p.permissionName),
      })),
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/users/:id — update user (admin or self, with restrictions)
router.put("/:id", authMiddleware, async (req, res) => {
  await updateUserHandler(req, res);
});

// PATCH /api/users/:id — partial update (same handler)
router.patch("/:id", authMiddleware, async (req, res) => {
  await updateUserHandler(req, res);
});

async function updateUserHandler(req: Request, res: Response) {
  const targetId = req.params.id as string;
  const requesterId = req.userId!;
  const admin = isAdmin(req.user);

  // Non-admins can only update their own profile
  if (!admin && targetId !== requesterId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { username, email, password, firstName, lastName, customInstructions, textSize } = parsed.data;

  // Non-admins cannot change their own password via this endpoint
  // (they should use a dedicated change-password endpoint with current password verification)
  if (!admin && password) {
    res.status(403).json({ error: "Use the change-password endpoint to update your password" });
    return;
  }

  try {
    // Check for duplicate username/email
    if (username || email) {
      const existing = await prisma.user.findFirst({
        where: {
          OR: [
            ...(username ? [{ username }] : []),
            ...(email ? [{ email }] : []),
          ],
          id: { not: targetId },
        },
      });

      if (existing) {
        res.status(409).json({ error: "Username or email already in use" });
        return;
      }
    }

    const data: Record<string, any> = {};
    if (username) data.username = username;
    if (email) data.email = email;
    if (firstName !== undefined) data.firstName = firstName;
    if (lastName !== undefined) data.lastName = lastName;
    if (customInstructions !== undefined) data.customInstructions = customInstructions;
    if (textSize !== undefined) data.textSize = textSize;

    if (password) {
      const salt = await bcrypt.genSalt(SALT_ROUNDS);
      data.passwordHash = await bcrypt.hash(password, salt);
      data.salt = salt;
    }

    const user = await prisma.user.update({
      where: { id: targetId },
      data,
      include: {
        roles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
                isDefault: true,
                permissions: {
                  select: { permissionName: true },
                },
              },
            },
          },
        },
      },
    });

    // T-104-01: invalidate auth cache on password/role change
    if (password) {
      invalidateAuthCache(targetId).catch(() => {});
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      customInstructions: user.customInstructions,
      textSize: user.textSize,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roles: user.roles.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        isDefault: ur.role.isDefault,
        permissions: ur.role.permissions.map((p) => p.permissionName),
      })),
    });
  } catch (err: unknown) {
    const errCode = (err as { code?: string }).code;
    if (errCode === "P2025") {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
}

// DELETE /api/users/:id — delete user (admin-only)
router.delete("/:id", authMiddleware, requireAdmin, async (req, res) => {
  const targetId = req.params.id as string;

  // Prevent admin from deleting themselves
  if (targetId === req.userId) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }

  try {
    // Clean up user relations first
    await prisma.userRole.deleteMany({ where: { userId: targetId } });
    await prisma.projectAccess.deleteMany({ where: { userId: targetId } });
    await prisma.workspaceAccess.deleteMany({ where: { userId: targetId } });

    const user = await prisma.user.delete({
      where: { id: targetId },
      select: { id: true, username: true, email: true },
    });

    // T-104-01: clear auth cache for deleted user (hygiene — prevents stale cache entry)
    invalidateAuthCache(targetId).catch(() => {});

    res.json({ message: "User deleted", user });
  } catch (err: unknown) {
    const errCode = (err as { code?: string }).code;
    if (errCode === "P2025") {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;