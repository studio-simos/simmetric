// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 70 — Plan 70-02 Task 1.
 *
 * Unit tests for the new `GET /api/roles/:roleId` endpoint (D-10, SC-3).
 * Mounts only the `roles` router on an isolated Express app — no full
 * index.ts. Mocks prisma singleton + authMiddleware (admin / non-admin
 * injection) + requireAdmin (real for the 403 test, pass-through
 * otherwise).
 *
 * SC-3 coverage:
 *   - GET /:roleId returns role with permissions + menuSections from DB
 *     (not hardcoded defaults)
 *   - GET /:roleId returns 404 { error: "Role not found" } when missing
 *   - GET /:roleId rejects non-admin (requireAdmin gate → 403)
 *   - Route ordering: /me/menu-sections declared before /:roleId so
 *     "me" is not captured as :roleId
 */
import "./helpers/setupEnv";

// --- Prisma mock (custom factory — role only is exercised here) -------------
// NOTE: mock object lives INSIDE the factory to avoid TDZ under @swc/jest
// (SWC hoists ESM imports above `const`; factory runs at import-time before
// the outer const would initialize). Exposed via require() after jest.mock.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    role: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  },
}));
const mockPrisma = require("../utils/prisma").default;

// --- authService: partial mock (sso.test.ts pattern) ------------------------
// The real `invalidateAuthCache` is safe in unit tests (getRedis() returns
// null without REDIS_URL in .env.test — early return, no Redis contact), but
// SWC transpiles the ESM export to a non-configurable CJS property, so
// jest.spyOn cannot redefine it. Spread the actual module and override
// `invalidateAuthCache` with a jest.fn() so the test can assert the call.
const mockInvalidateAuthCache = jest.fn((_userId: string) => Promise.resolve());
jest.mock("../services/authService", () => {
  const actual = jest.requireActual("../services/authService");
  return {
    ...actual,
    invalidateAuthCache: (userId: string) => mockInvalidateAuthCache(userId),
  };
});

// --- auth middleware: inject admin or non-admin via mutable global -----------
// Faithful to the production `isAdmin` semantics (utils/auth.ts): the real
// implementation reads `user.roles[].role.permissions[].permissionName` and
// returns true only when `admin:settings` is present. It does NOT short-circuit
// on `role === "admin"` / `role === "superuser"`, nor on a flat
// `user.permissions` array, nor on an `admin:*` wildcard. Keeping the mock
// aligned with the real extractor lets this suite catch requireAdmin
// regressions rather than exercising a fictional auth model.
const DEFAULT_AUTH_USER = {
  id: "admin-001",
  role: "admin",
  roles: [{ role: { permissions: [{ permissionName: "admin:settings" }] } }],
} as any;
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.userId = (global as any).__AUTH_USER_ID__ ?? "admin-001";
    req.user = (global as any).__AUTH_USER__ ?? DEFAULT_AUTH_USER;
    next();
  },
}));

// --- rbac: real requireAdmin for the 403 test, but allow override via global --
// Mirrors `getEffectivePermissions` (utils/auth.ts:15-29) + `isAdmin`
// (utils/auth.ts:39-41): walk the nested `user.roles[].role.permissions[]`
// and return true iff `admin:settings` is among the effective permissions.
// No `role === "admin"` shortcut, no `startsWith("admin:")` wildcard —
// matching production exactly so the 403 test exercises the same gate the
// route mounts in production.
jest.mock("../middleware/rbac", () => {
  const isAdmin = (user: any) => {
    const perms: string[] = [];
    for (const ur of user?.roles ?? []) {
      for (const rp of ur?.role?.permissions ?? []) {
        if (rp?.permissionName) perms.push(rp.permissionName);
      }
    }
    return perms.includes("admin:settings");
  };
  return {
    requireAdmin: (req: any, res: any, next: any) => {
      const user = (global as any).__AUTH_USER__ ?? DEFAULT_AUTH_USER;
      // Sync req.user with the current global (authMiddleware already set it,
      // but reset here for clarity when globals mutate between tests).
      req.user = user;
      if (!isAdmin(user)) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    requireProjectAccess: (_req: any, _res: any, next: any) => next(),
    requireWorkspaceAccess: (_req: any, _res: any, next: any) => next(),
  };
});

import express, { type Express } from "express";
import request from "supertest";
import rolesRouter from "../routes/roles";

let app: Express;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use("/api/roles", rolesRouter);
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset auth globals to the admin default.
  (global as any).__AUTH_USER__ = { ...DEFAULT_AUTH_USER };
  (global as any).__AUTH_USER_ID__ = "admin-001";
});

afterAll(() => {
  delete (global as any).__AUTH_USER__;
  delete (global as any).__AUTH_USER_ID__;
});

// ─── GET /api/roles/:roleId (D-10, SC-3) ──────────────────────────────────

describe("GET /api/roles/:roleId", () => {
  it("returns the role with permissions + menuSections from DB (not defaults)", async () => {
    const roleId = "00000000-0000-4000-8000-000000000001";
    mockPrisma.role.findUnique.mockResolvedValueOnce({
      id: roleId,
      name: "Custom",
      description: "Custom role",
      isDefault: false,
      permissions: [
        { permissionName: "document:read" },
        { permissionName: "archive:write" },
      ],
      menuSections: [{ menuSection: "dashboard" }, { menuSection: "chat" }],
    });

    const res = await request(app).get(`/api/roles/${roleId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: roleId,
      name: "Custom",
      description: "Custom role",
      isDefault: false,
      permissions: ["document:read", "archive:write"],
      menuSections: ["dashboard", "chat"],
    });
    // No createdAt/updatedAt in the response (matches PUT return shape).
    expect(res.body).not.toHaveProperty("createdAt");
    expect(res.body).not.toHaveProperty("updatedAt");
    // findUnique called with the right id.
    expect(mockPrisma.role.findUnique).toHaveBeenCalledTimes(1);
    const callArg = mockPrisma.role.findUnique.mock.calls[0][0];
    expect(callArg.where.id).toBe(roleId);
  });

  it("returns 404 { error: 'Role not found' } when role missing", async () => {
    mockPrisma.role.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/roles/00000000-0000-4000-8000-000000000099");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Role not found" });
  });

  it("rejects non-admin users with 403 (requireAdmin gate)", async () => {
    (global as any).__AUTH_USER__ = {
      id: "user-001",
      role: "user",
      roles: [
        {
          role: {
            permissions: [
              { permissionName: "chat:read" },
              { permissionName: "document:read" },
            ],
          },
        },
      ],
    };

    const res = await request(app).get("/api/roles/role-custom-001");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Admin access required" });
    // findUnique must NOT be called when requireAdmin blocks the request.
    expect(mockPrisma.role.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 + invalidates the auth cache when the DB user is gone (stale-cache user)", async () => {
    // Contract (T-260813-01): a user who passed authMiddleware only because
    // of a stale Redis `auth:user:*` cache entry, but whose DB row is gone,
    // must fail closed — 401 (not 404) so the frontend's TanStack retry loop
    // stops (401/403/429 are not retried) and the existing logout path runs,
    // plus fire-and-forget cache invalidation so the next request 401s at
    // the middleware.
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/roles/me/menu-sections");

    // menu-sections handler returns 401 "User not found" when user is null.
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "User not found" });
    // Stale cache entry for the authenticated user is invalidated.
    expect(mockInvalidateAuthCache).toHaveBeenCalledWith("admin-001");
    // Crucially, the /:roleId handler would have called role.findUnique —
    // it must not be called here (route ordering preserved).
    expect(mockPrisma.role.findUnique).not.toHaveBeenCalled();
  });
});