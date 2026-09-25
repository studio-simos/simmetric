// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireAdmin } from "../middleware/rbac";
import { invalidateAuthCache } from "../services/authService";
import prisma from "../utils/prisma";

// Phase 185 (T-185-10, Pitfall-2 grep-gate): ALL findUnique/upsert sites in
// this file target User / Role / UserRole — GLOBAL identity models per the
// Phase-182 D-01/D-04 verdict (User is identity-pure, Role is global;
// getEffectivePermissions intact). None are in TENANT_READ_MODELS — exempt
// from the org-assertion gate by design.
import { createRoleSchema, updateRoleSchema, menuSectionSchema, roleIdParamSchema, roleSectionVisibilitySchema } from "@simmetric-chat/shared";
import { resolveRoleSections, resolveUserSections } from "../services/visibilityService";
import { logEvent } from "../services/eventLogService";

const router = Router();

// Apply auth to all role routes
router.use(authMiddleware);
// Phase 185 (D-09): chain order auth → tenant → permission. The tenant
// middleware resolves req.organizationId (D-01 membership lookup) and opens
// the ALS tenant run before any rbac/license gate.
router.use(tenantContextMiddleware);

// GET /api/roles/me/menu-sections — resolve per-user visibility (any authenticated user).
// Phase 206 (VIS-01, D-15): the response widens to { menuSections,
// settingsSections } — per-role RoleSectionVisibility rows WIN; absent rows
// fall back to the permission-OR defaults (byte-identical for untouched
// installs). Frontend consumers rewire in the SAME plan (atomic shape change).
router.get("/me/menu-sections", async (req, res) => {
  try {
    const userId = req.userId!;
    const user = await prisma.user.findUnique({
      where: { id: userId },
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

    // Phase 206 (VIS-01, D-15): the per-role DB override + permission-OR
    // default resolution lives in visibilityService (union across roles).
    const resolved = await resolveUserSections(userId);
    res.json(resolved);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /api/roles/:roleId/visibility — admin view of a role's resolved
// visibility (menu + settings sections, tagged override|default).
router.get("/:roleId/visibility", requireAdmin, async (req, res) => {
  try {
    const parsedId = roleIdParamSchema.safeParse(req.params.roleId);
    if (!parsedId.success) {
      res.status(400).json({ error: "Invalid role ID" });
      return;
    }
    const resolved = await resolveRoleSections(parsedId.data);
    if (!resolved) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    res.json(resolved);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PUT /api/roles/:roleId/visibility — admin per-section visible/hidden toggles
// (VIS-01 D-14/D-16). Explicit rows only (absent row = permission-OR default);
// writes audit-log + invalidates the auth cache of every user holding the role
// (Pitfall 3 — stale resolution kill).
router.put("/:roleId/visibility", requireAdmin, async (req, res) => {
  try {
    const parsedId = roleIdParamSchema.safeParse(req.params.roleId);
    if (!parsedId.success) {
      res.status(400).json({ error: "Invalid role ID" });
      return;
    }
    const parsed = roleSectionVisibilitySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const roleId = parsedId.data;
    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    for (const entry of parsed.data.sections) {
      await prisma.roleSectionVisibility.upsert({
        where: { roleId_sectionKey: { roleId, sectionKey: entry.sectionKey } },
        update: { visible: entry.visible },
        create: { roleId, sectionKey: entry.sectionKey, visible: entry.visible },
      });
    }

    logEvent("role", roleId, "visibility.updated", req.userId!, {
      sections: parsed.data.sections.length,
    }).catch(() => {});

    // Pitfall 3: kill the auth cache for every holder so the next request
    // re-resolves with the new visibility.
    const holders = await prisma.userRole.findMany({ where: { roleId }, select: { userId: true } });
    for (const holder of holders) {
      invalidateAuthCache(holder.userId).catch(() => {});
    }

    res.json({ updated: parsed.data.sections.length });
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