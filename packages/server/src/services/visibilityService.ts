// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 206 (VIS-01, D-14/D-15): DB-driven per-role visibility resolution.
// Per-role: an explicit RoleSectionVisibility row WINS (visible true/false);
// absent rows fall back to the permission-OR defaults (SETTINGS_TAB_PERMISSIONS
// .some() semantics for settings sections; the role's RoleMenuSection rows for
// menu sections) — byte-identical to pre-206 behavior for untouched installs.
// Multi-role users: UNION across roles (any-role-visible wins — Pitfall 5).

import { SETTINGS_TAB_PERMISSIONS } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { getEffectivePermissions } from "../utils/auth";
import { logger } from "../utils/logger";

export interface ResolvedSections {
  menuSections: string[];
  settingsSections: string[];
}

/** @latentByDesign — paired type of resolveRoleSections (admin UI consumes the wire shape). */
export interface RoleVisibilityEntry {
  sectionKey: string;
  visible: boolean;
  /** "override" = explicit RoleSectionVisibility row; "default" = resolved fallback. */
  source: "override" | "default";
}

/**
 * Resolve the effective visibility for ONE role (admin UI view): menu
 * sections (MENU_SECTIONS domain) + settings sections (SETTINGS_TAB_PERMISSIONS
 * domain), each tagged with its source.
 */
export async function resolveRoleSections(roleId: string) {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { menuSections: true, sectionVisibilities: true },
  });
  if (!role) return null;
  const overrides = new Map(role.sectionVisibilities.map((v) => [v.sectionKey, v.visible]));
  const menuKeys = new Set(role.menuSections.map((m) => m.menuSection));

  const sections: RoleVisibilityEntry[] = [];
  for (const menuKey of [...menuKeys]) {
    const override = overrides.get(menuKey);
    sections.push({
      sectionKey: menuKey,
      visible: override === undefined ? true : override,
      source: override === undefined ? "default" : "override",
    });
  }
  for (const [key, requiredPerms] of Object.entries(SETTINGS_TAB_PERMISSIONS)) {
    const override = overrides.get(key);
    sections.push({
      sectionKey: key,
      visible: override === undefined ? true : override,
      source: override === undefined ? "default" : "override",
    });
  }
  return { sections };
}

/**
 * Resolve the effective visibility for a USER (union across roles).
 * This is the server-side enforcement point (VIS-01 "enforced server-side"):
 * the frontend renders what the server resolved — it never recomputes the
 * permission-OR defaults when the payload is present.
 */
export async function resolveUserSections(userId: string): Promise<ResolvedSections> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: {
            include: {
              menuSections: true,
              sectionVisibilities: true,
              // getEffectivePermissions needs the permission rows (OR defaults)
              permissions: { select: { permissionName: true } },
            },
          },
        },
      },
    },
  });
  if (!user) {
    // Fail-closed identity miss (roles.ts stale-cache precedent: 401 upstream).
    logger.warn(`[visibilityService] user not found: ${userId}`);
    return { menuSections: [], settingsSections: [] };
  }

  const permissions = getEffectivePermissions(user);
  const menuSet = new Set<string>();
  const settingsSet = new Set<string>();

  for (const userRole of user.roles) {
    const role = userRole.role;
    const overrides = new Map(role.sectionVisibilities.map((v) => [v.sectionKey, v.visible]));
    const menuKeys = new Set(role.menuSections.map((m) => m.menuSection));

    // MENU domain: DB menu-section rows are the default source (already
    // seeded per-role at boot); an explicit visibility row overrides.
    for (const key of menuKeys) {
      const override = overrides.get(key);
      if (override === false) continue;
      menuSet.add(key);
    }
    for (const [key, visible] of overrides) {
      // Affirmative admin override can REVEAL a section the role's menu rows omit.
      if (visible === true && !menuKeys.has(key)) menuSet.add(key);
    }

    // SETTINGS domain: explicit row wins; absent → permission-OR default.
    for (const [key, requiredPerms] of Object.entries(SETTINGS_TAB_PERMISSIONS)) {
      const override = overrides.get(key);
      if (override === true) {
        settingsSet.add(key);
        continue;
      }
      if (override === false) continue;
      if (requiredPerms.length === 0 || requiredPerms.some((p) => permissions.includes(p))) {
        settingsSet.add(key);
      }
    }
  }

  return { menuSections: [...menuSet], settingsSections: [...settingsSet] };
}