// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 206 (VIS-01, Plan 03 Task 5 / VALIDATION W0) — visibility resolution
 * contract: DB override > permission-OR default, byte-identical fallback for
 * untouched installs, any-role union across roles, admin-only toggles.
 *
 * Service cases mock the prisma singleton (mockPrisma-style local factory);
 * endpoint cases run the REAL auth chain on the heavy-mock harness
 * (agencyRoutes.test.ts idiom).
 */

jest.mock("../utils/prisma", () => {
  const makePrisma = () => ({
    $transaction: jest.fn(),
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    userRole: { findMany: jest.fn() },
    organizationMember: { findFirst: jest.fn() },
    role: { findUnique: jest.fn() },
    roleSectionVisibility: { upsert: jest.fn() },
  });
  const instance = makePrisma();
  return { __esModule: true, default: instance };
});

jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn(async () => undefined) }));

let AUTH_USER_PAYLOAD: unknown = null;
jest.mock("../services/authService", () => ({
  verifyToken: jest.fn((token: string) => JSON.parse(Buffer.from(token, "base64").toString("utf8"))),
  generateToken: jest.fn((userId: string) => Buffer.from(JSON.stringify({ userId })).toString("base64")),
  getCachedUserWithRoles: jest.fn(async () => AUTH_USER_PAYLOAD),
  getUserWithRoles: jest.fn(),
  invalidateAuthCache: jest.fn(async () => undefined),
}));
jest.mock("../services/tokenRevocation", () => ({ isTokenRevoked: jest.fn(async () => false) }));
jest.mock("../services/apiKeyService", () => ({ validateApiKey: jest.fn() }));

import express from "express";
import request from "supertest";
import * as authService from "../services/authService";
import { logEvent } from "../services/eventLogService";
import { invalidateAuthCache } from "../services/authService";
import prisma from "../utils/prisma";
import { resolveUserSections, resolveRoleSections } from "../services/visibilityService";
import roleRoutes from "../routes/roles";

const p = prisma as unknown as Record<string, any>;

const ADMIN_ID = "admin-206";
const USER_ID = "user-206";

function rolesWithPermissions(perms: string[], opts?: { menuSections?: string[]; sectionVisibilities?: { sectionKey: string; visible: boolean }[] }) {
  return [
    {
      role: {
        menuSections: (opts?.menuSections ?? []).map((menuSection) => ({ menuSection })),
        sectionVisibilities: (opts?.sectionVisibilities ?? []).map((sv) => ({ sectionKey: sv.sectionKey, visible: sv.visible })),
        permissions: perms.map((permissionName) => ({ permissionName })),
      },
    },
  ];
}

beforeEach(() => {
  jest.resetAllMocks();
  (p.$transaction as jest.Mock).mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(p));
  AUTH_USER_PAYLOAD = null;
  // resetAllMocks wipes factory impls — rebind the auth-chain mocks (agencyRoutes idiom).
  (authService.verifyToken as jest.Mock).mockImplementation((token: string) =>
    JSON.parse(Buffer.from(token, "base64").toString("utf8")),
  );
  (authService.getCachedUserWithRoles as jest.Mock).mockImplementation(async () => AUTH_USER_PAYLOAD);
  (authService.invalidateAuthCache as jest.Mock).mockImplementation(async () => undefined);
  (logEvent as jest.Mock).mockImplementation(async () => undefined);
  // Tenant context membership lookup (every request).
  (p.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: "org-206",
    roleInOrg: "member",
  });
});

describe("visibilityService.resolveUserSections (VIS-01 D-15)", () => {
  it("fallback is byte-identical: user role, NO DB rows → permission-OR default + seeded menu rows", async () => {
    (p.user.findUnique as jest.Mock).mockResolvedValue({
      id: USER_ID,
      roles: rolesWithPermissions(["admin:roles", "admin:users", "admin:settings"], {
        menuSections: ["dashboard", "chat", "documents", "knowledgeBase", "workspaces", "widget", "uploads", "skills"],
      }),
    });
    const { resolveUserSections: resolve } = await import("../services/visibilityService");
    const resolved = await resolve(USER_ID);
    // Security tab: has admin:settings/admin:roles/admin:users → visible (OR)
    expect(resolved.settingsSections).toContain("security");
    // LLM tab: provider:read absent, admin:settings present → visible
    expect(resolved.settingsSections).toContain("llm");
    // Menu sections mirror the seeded rows exactly
    expect(resolved.menuSections).toEqual(
      expect.arrayContaining(["dashboard", "chat", "uploads", "skills"]),
    );
    expect(resolved.menuSections).not.toContain("eventLog");
  });

  it("DB row visible=false hides a section the permissions would allow", async () => {
    (p.user.findUnique as jest.Mock).mockResolvedValue({
      id: USER_ID,
      roles: rolesWithPermissions(["admin:settings"], {
        menuSections: ["dashboard", "chat"],
        sectionVisibilities: [{ sectionKey: "llm", visible: false }],
      }),
    });
    const { resolveUserSections: resolve } = await import("../services/visibilityService");
    const resolved = await resolve(USER_ID);
    expect(resolved.settingsSections).not.toContain("llm");
    expect(resolved.settingsSections).toContain("security");
  });

  it("DB row visible=true reveals a section the permissions do NOT satisfy (affirmative override)", async () => {
    (p.user.findUnique as jest.Mock).mockResolvedValue({
      id: USER_ID,
      roles: rolesWithPermissions(["chat:write"], {
        menuSections: ["dashboard", "chat"],
        sectionVisibilities: [{ sectionKey: "advanced", visible: true }],
      }),
    });
    const { resolveUserSections: resolve } = await import("../services/visibilityService");
    const resolved = await resolve(USER_ID);
    expect(resolved.settingsSections).toContain("advanced");
    expect(resolved.settingsSections).not.toContain("security");
  });

  it("unions across roles — any-role-visible wins (Pitfall 5)", async () => {
    (p.user.findUnique as jest.Mock).mockResolvedValue({
      id: USER_ID,
      roles: [
        ...rolesWithPermissions(["chat:write"], {
          menuSections: ["dashboard", "chat"],
          sectionVisibilities: [{ sectionKey: "advanced", visible: false }],
        }),
        ...rolesWithPermissions([], {
          menuSections: ["chat", "widget"],
          sectionVisibilities: [{ sectionKey: "advanced", visible: true }],
        }),
      ],
    });
    const { resolveUserSections: resolve } = await import("../services/visibilityService");
    const resolved = await resolve(USER_ID);
    expect(resolved.menuSections).toEqual(expect.arrayContaining(["dashboard", "chat", "widget"]));
    // advanced: role A hides, role B reveals → union keeps it visible
    expect(resolved.settingsSections).toContain("advanced");
  });
});

describe("resolveRoleSections (admin UI view)", () => {
  it("tags override rows and defaults per section", async () => {
    (p.role.findUnique as jest.Mock).mockResolvedValue({
      id: "role-1",
      menuSections: [{ menuSection: "dashboard" }, { menuSection: "chat" }],
      sectionVisibilities: [{ sectionKey: "chat", visible: false }, { sectionKey: "llm", visible: true }],
    });
    const resolved = await resolveRoleSections("role-1");
    const chat = resolved!.sections.find((s) => s.sectionKey === "chat");
    const llm = resolved!.sections.find((s) => s.sectionKey === "llm");
    expect(chat).toMatchObject({ visible: false, source: "override" });
    expect(llm).toMatchObject({ visible: true, source: "override" });
    // settings keys always present with their default source
    const security = resolved!.sections.find((s) => s.sectionKey === "security");
    expect(security?.source).toBe("default");
  });
});

describe("GET/PUT /api/roles/* visibility endpoints (D-15/D-16/D-17)", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/roles", roleRoutes);
    return app;
  }

  it("returns { menuSections, settingsSections } for an authenticated user", async () => {
    AUTH_USER_PAYLOAD = { id: USER_ID, roles: [] };
    (p.user.findUnique as jest.Mock).mockResolvedValue({
      id: USER_ID,
      roles: rolesWithPermissions(["chat:write"], { menuSections: ["dashboard", "chat"] }),
    });
    const token = Buffer.from(JSON.stringify({ userId: USER_ID })).toString("base64");
    const res = await request(makeApp())
      .get("/api/roles/me/menu-sections")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ menuSections: expect.any(Array), settingsSections: expect.anything() });
    expect(Array.isArray(res.body.menuSections)).toBe(true);
  });

  it("PUT visibility: admin persists rows, audits, invalidates holder caches", async () => {
    AUTH_USER_PAYLOAD = { id: ADMIN_ID, roles: [{ role: { permissions: [{ permissionName: "admin:settings" }] } }] };
    (p.role.findUnique as jest.Mock).mockResolvedValue({ id: "role-1", name: "user" });
    (p.roleSectionVisibility.upsert as jest.Mock).mockResolvedValue({});
    (p.userRole.findMany as jest.Mock).mockResolvedValue([{ userId: USER_ID }]);
    const token = Buffer.from(JSON.stringify({ userId: ADMIN_ID })).toString("base64");
    const res = await request(makeApp())
      .put("/api/roles/11111111-1111-4111-8111-111111111111/visibility")
      .set("Authorization", `Bearer ${token}`)
      .send({ sections: [{ sectionKey: "llm", visible: false }] });
    expect(res.status).toBe(200);
    expect(p.roleSectionVisibility.upsert).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith("role", "11111111-1111-4111-8111-111111111111", "visibility.updated", ADMIN_ID, expect.anything());
    expect(invalidateAuthCache).toHaveBeenCalledWith(USER_ID);
  });

  it("PUT visibility non-admin → 403 (D-17 role routes stay requireAdmin)", async () => {
    AUTH_USER_PAYLOAD = { id: USER_ID, roles: [{ role: { permissions: [{ permissionName: "chat:write" }] } }] };
    const token = Buffer.from(JSON.stringify({ userId: USER_ID })).toString("base64");
    const res = await request(makeApp())
      .put("/api/roles/11111111-1111-4111-8111-111111111111/visibility")
      .set("Authorization", `Bearer ${token}`)
      .send({ sections: [{ sectionKey: "llm", visible: false }] });
    expect(res.status).toBe(403);
  });
});