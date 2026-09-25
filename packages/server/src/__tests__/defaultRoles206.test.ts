// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 206 (Task 5 / VALIDATION W0): default role constants for the RBAC
// foundation — Utente Cloud (CLOUD-01 D-18) + Web Agency (AGENCY-01..03 D-19)
// + the delegation denylist (D-08). These assertions are the security anchor
// for the whole phase: any later edit that leaks admin:* into a non-admin
// role fails here FIRST.

import {
  DEFAULT_ROLES,
  DEFAULT_ROLE_MENU_SECTIONS,
  DELEGATION_DENYLIST,
  isDelegatable,
  permissionNameSchema,
} from "@simmetric-chat/shared";
import { isAdmin } from "../utils/auth";
import type { PermissionName } from "@simmetric-chat/shared";

const UTENTE_CLOUD_PERMISSIONS: readonly string[] = [
  "workspace:read",
  "chat:read",
  "chat:write",
  "document:read",
  "document:write",
  "archive:read",
  "provider:read",
  "memory:read",
  "memory:write",
  "skill:read",
];

const WEB_AGENCY_PERMISSIONS: readonly string[] = [
  "workspace:read",
  "workspace:write",
  "chat:read",
  "chat:write",
  "document:read",
  "document:write",
  "archive:read",
  "archive:write",
  "provider:read",
  "project:create",
  "workspace:create",
  "memory:read",
  "memory:write",
  "skill:create",
  "skill:read",
  "skill:write",
  "skill:delete",
  "agency:users:manage",
];

/** Build the user payload shape getEffectivePermissions/isAdmin expect. */
function userWithPermissions(perms: readonly string[]) {
  return {
    roles: [
      {
        role: {
          permissions: perms.map((permissionName) => ({ permissionName })),
        },
      },
    ],
  };
}

describe("Phase 206 default roles (CLOUD-01 D-18 / AGENCY D-19)", () => {
  const cloudUser = DEFAULT_ROLES.find((r) => r.name === "Utente Cloud");
  const webAgency = DEFAULT_ROLES.find((r) => r.name === "Web Agency");

  it("Utente Cloud exists with EXACTLY the locked permission set (no more, no less)", () => {
    expect(cloudUser).toBeDefined();
    expect([...(cloudUser?.permissions ?? [])].sort()).toEqual(
      [...UTENTE_CLOUD_PERMISSIONS].sort(),
    );
  });

  it("Utente Cloud carries no admin:* permission", () => {
    expect((cloudUser?.permissions ?? []).some((p) => p.startsWith("admin:"))).toBe(false);
  });

  it("Web Agency includes agency:users:manage", () => {
    expect(webAgency?.permissions).toContain("agency:users:manage");
  });

  it("Web Agency carries zero admin:*-prefixed permissions (denylist prefix rule)", () => {
    const leaked = (webAgency?.permissions ?? []).filter((p) => p.startsWith("admin:"));
    expect(leaked).toEqual([]);
  });

  it("isAdmin(agencyUser) is false — admin:settings absent (the T-206-02 landmine)", () => {
    expect(isAdmin(userWithPermissions(webAgency?.permissions ?? []))).toBe(false);
  });

  it("DEFAULT_ROLE_MENU_SECTIONS has both new role names", () => {
    expect(DEFAULT_ROLE_MENU_SECTIONS["Utente Cloud"]).toEqual([
      "dashboard",
      "chat",
      "knowledgeBase",
      "documents",
      "widget",
    ]);
    expect(DEFAULT_ROLE_MENU_SECTIONS["Web Agency"]).toContain("settings");
    expect(DEFAULT_ROLE_MENU_SECTIONS["Web Agency"]).not.toContain("marketplace");
    expect(DEFAULT_ROLE_MENU_SECTIONS["Web Agency"]).not.toContain("eventLog");
    expect(DEFAULT_ROLE_MENU_SECTIONS["Web Agency"]).not.toContain("analytics");
  });
});

describe("Phase 206 delegation denylist (AGENCY-03 D-08)", () => {
  it("admin:* permissions are non-delegable (prefix rule)", () => {
    expect(isDelegatable("admin:users" as PermissionName)).toBe(false);
    expect(isDelegatable("admin:settings" as PermissionName)).toBe(false);
  });

  it("elevated exact entries are non-delegable", () => {
    expect(isDelegatable("plugins:manage")).toBe(false);
    expect(isDelegatable("backup:restore:write")).toBe(false);
    expect(isDelegatable("dlp:unmask")).toBe(false);
    expect(isDelegatable("mcp:oauth:manage")).toBe(false);
    expect(isDelegatable("connector:manage")).toBe(false);
    expect(isDelegatable("agency:users:manage")).toBe(false);
  });

  it("user-level permissions remain delegable", () => {
    expect(isDelegatable("chat:write")).toBe(true);
    expect(isDelegatable("workspace:read")).toBe(true);
    expect(isDelegatable("skill:delete")).toBe(true);
  });

  it("permissionNameSchema accepts agency:users:manage (41st entry)", () => {
    expect(permissionNameSchema.parse("agency:users:manage")).toBe("agency:users:manage");
  });

  it("denylist covers every backup:* family member declared", () => {
    for (const entry of DELEGATION_DENYLIST.exact) {
      expect(permissionNameSchema.safeParse(entry).success).toBe(true);
    }
  });
});