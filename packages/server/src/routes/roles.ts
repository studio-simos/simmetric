// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { invalidateAuthCache } from "../services/authService";
import prisma from "../utils/prisma";
import { createRoleSchema, updateRoleSchema, menuSectionSchema, roleIdParamSchema } from "@simmetric-chat/shared";

const router = Router();

// Apply auth to all role routes
router.use(authMiddleware);

// GET /api/roles/me/menu-sections — get menu sections for current user (any authenticated user)
router.get("/me/menu-sections", async (req, res) => {
  try {
    const userId = req.userId!;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: {
          include: {
            role: {
              include: { menuSections: true },
            },
          },
        },
      },
    });

    if (!user) {
      // T-260813-01: the user passed authMiddleware only because of a stale
      // Redis `auth:user:*` cache entry. Fail closed: 401 (stops the
      // frontend's TanStack retry loop — 401/403/429 are not retried — and
      // drives the existing logout path) and invalidate the stale cache so
      // subsequent requests 401 at the middleware immediately.
      invalidateAuthCache(userId).catch(() => {});
      res.status(401).json({ error: "User not found" });
      return;
    }

    // Collect unique menu sections from all roles
    const sectionSet = new Set<string>();
    for (const userRole of user.roles) {
      for (const ms of userRole.role.menuSections) {
        sectionSet.add(ms.menuSection);
      }
    }

    res.json([...sectionSet]);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// ===== Admin-only routes =====

// GET /api/roles — list all roles with permissions and menu sections
router.get("/", requireAdmin, async (_req, res) => {
  try {
    const roles = await prisma.role.findMany({
      include: {
        permissions: { include: { permission: true } },
        menuSections: true,
      },
    });

    const formatted = roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      isDefault: role.isDefault,
      permissions: role.permissions.map((p) => p.permissionName),
      menuSections: (role as unknown as { menuSections: Array<{ menuSection: string }> }).menuSections.map((ms) => ms.menuSection),
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    }));

    res.json(formatted);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /api/roles/:roleId — fetch a single role with its effective permissions
// and menuSections from the DB (D-10, SC-3). Used by SettingsRoles.startEdit
// so the edit form sees the real DB state, not the in-memory list snapshot.
//
// Route ordering note (Pitfall in PLAN.md interfaces): declared AFTER
// `GET /me/menu-sections` (line 13) so Express does not capture "me" as a
// :roleId. The list endpoint `GET /` is declared above; this handler sits
// between the list and POST.
router.get("/:roleId", requireAdmin, async (req, res) => {
  try {
    const roleId = req.params.roleId as string;
    // WR-01: validate UUID at the handler entry. A non-UUID `roleId` (e.g.
    // "me") would otherwise reach `prisma.role.findUnique` and surface a
    // Prisma error via the 500 catch-all. Return 400 `{ error, details }`
    // consistent with the CLAUDE.md validation-error convention.
    const paramParse = roleIdParamSchema.safeParse(roleId);
    if (!paramParse.success) {
      res.status(400).json({
        error: "Invalid roleId",
        details: { roleId: paramParse.error.issues[0]?.message ?? "Invalid" },
      });
      return;
    }
    const role = await prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: { include: { permission: true } }, menuSections: true },
    });

    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    // Mirror the PUT return shape exactly (roles.ts:148-156): no
    // createdAt/updatedAt in the response. SC-3 letterale: the body must
    // carry the effective DB permissions/menuSections, not hardcoded defaults.
    const typed = role as unknown as {
      id: string;
      name: string;
      description: string;
      isDefault: boolean;
      permissions: Array<{ permissionName: string }>;
      menuSections: Array<{ menuSection: string }>;
    };
    res.json({
      id: typed.id,
      name: typed.name,
      description: typed.description,
      isDefault: typed.isDefault,
      permissions: typed.permissions.map((p) => p.permissionName),
      menuSections: typed.menuSections.map((ms) => ms.menuSection),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /api/roles — create a new role
router.post("/", requireAdmin, async (req, res) => {
  try {
    const validated = createRoleSchema.parse(req.body);

    const role = await prisma.role.create({
      data: {
        name: validated.name,
        description: validated.description,
        isDefault: false,
        permissions: {
          create: validated.permissionNames.map((permName) => ({
            permissionName: permName,
          })),
        },
      },
      include: { permissions: { include: { permission: true } } },
    });

    res.status(201).json({
      id: role.id,
      name: role.name,
      description: role.description,
      isDefault: role.isDefault,
      permissions: role.permissions.map((p) => p.permissionName),
      menuSections: [],
    });
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PUT /api/roles/:roleId — update a role's permissions and/or menu sections
router.put("/:roleId", requireAdmin, async (req, res) => {
  try {
    const roleId = req.params.roleId as string;
    // WR-01 (extended): same UUID validation as GET /:roleId. Prevents
    // Prisma-error leak on non-UUID `roleId` via the 400 catch-all path.
    const paramParse = roleIdParamSchema.safeParse(roleId);
    if (!paramParse.success) {
      res.status(400).json({
        error: "Invalid roleId",
        details: { roleId: paramParse.error.issues[0]?.message ?? "Invalid" },
      });
      return;
    }
    const validated = updateRoleSchema.parse(req.body);

    const existing = await prisma.role.findUnique({ where: { id: roleId } });
    if (!existing) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    // Update name/description if provided
    if (validated.name || validated.description !== undefined) {
      await prisma.role.update({
        where: { id: roleId },
        data: {
          ...(validated.name && { name: validated.name }),
          ...(validated.description !== undefined && { description: validated.description }),
        },
      });
    }

    // Replace permissions if provided
    if (validated.permissionNames) {
      await prisma.rolePermission.deleteMany({ where: { roleId } });
      await prisma.rolePermission.createMany({
        data: validated.permissionNames.map((permName) => ({
          roleId,
          permissionName: permName,
        })),
      });
    }

    const updated = await prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: { include: { permission: true } }, menuSections: true },
    });

    const typed = updated as unknown as { id: string; name: string; description: string; isDefault: boolean; permissions: Array<{ permissionName: string }>; menuSections: Array<{ menuSection: string }> };
    res.json({
      id: typed.id,
      name: typed.name,
      description: typed.description,
      isDefault: typed.isDefault,
      permissions: typed.permissions.map((p) => p.permissionName),
      menuSections: typed.menuSections.map((ms) => ms.menuSection),
    });
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PUT /api/roles/:roleId/menu-sections — replace menu sections for a role
router.put("/:roleId/menu-sections", requireAdmin, async (req, res) => {
  try {
    const roleId = req.params.roleId as string;
    const { menuSections } = req.body as { menuSections: string[] };

    if (!Array.isArray(menuSections)) {
      res.status(400).json({ error: "menuSections must be an array" });
      return;
    }

    // Validate each menu section
    for (const section of menuSections) {
      const parsed = menuSectionSchema.safeParse(section);
      if (!parsed.success) {
        res.status(400).json({ error: `Invalid menu section: ${section}` });
        return;
      }
    }

    const existing = await prisma.role.findUnique({ where: { id: roleId } });
    if (!existing) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    // Replace menu sections
    await prisma.roleMenuSection.deleteMany({ where: { roleId } });
    if (menuSections.length > 0) {
      await prisma.roleMenuSection.createMany({
        data: menuSections.map((section) => ({
          roleId,
          menuSection: section,
        })),
      });
    }

    res.json({ roleId, menuSections });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /api/roles/:roleId — delete a non-default role
router.delete("/:roleId", requireAdmin, async (req, res) => {
  try {
    const roleId = req.params.roleId as string;

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    if (role.isDefault) {
      res.status(400).json({ error: "Cannot delete default roles" });
      return;
    }

    await prisma.role.delete({ where: { id: roleId } });
    res.json({ message: "Role deleted" });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /api/roles/assign — assign a role to a user
router.post("/assign", requireAdmin, async (req, res) => {
  try {
    const { userId, roleId } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    await prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      create: { userId, roleId },
      update: {},
    });

    // T-104-01: invalidate auth cache so role change takes effect immediately
    invalidateAuthCache(userId).catch(() => {});

    res.json({ message: "Role assigned" });
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /api/roles/revoke — revoke a role from a user
router.post("/revoke", requireAdmin, async (req, res) => {
  try {
    const { userId, roleId } = req.body;

    await prisma.userRole.deleteMany({
      where: { userId, roleId },
    });

    // T-104-01: invalidate auth cache so role change takes effect immediately
    invalidateAuthCache(userId).catch(() => {});

    res.json({ message: "Role revoked" });
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;