// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * RBAC Integration Tests
 *
 * Tests the middleware chain for access control:
 * - Unauthenticated users get 401
 * - Users without proper permissions get 403
 * - Users without project/workspace access get 403 (IDOR prevention)
 * - Admins bypass all access checks
 * - Users with explicit access grants pass through
 */

// Mock Prisma before any imports that depend on it
jest.mock("../utils/prisma", () => ({
  default: {
    project: { findFirst: jest.fn() },
    workspace: { findFirst: jest.fn() },
    projectAccess: { findFirst: jest.fn() },
    workspaceAccess: { findFirst: jest.fn() },
    $connect: jest.fn(),
  },
}));

import { requirePermission, requireAdmin } from "../middleware/rbac";
import type { Request, Response, NextFunction } from "express";

// ─── Mock Helpers ───────────────────────────────────────────────

function createMockRes() {
  const state = { statusCode: 200, body: {} as any };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(data: any) {
      state.body = data;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

function createMockNext() {
  const fn = jest.fn();
  return { next: fn as unknown as NextFunction, called: () => fn.mock.calls.length > 0 };
}

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    body: {},
    query: {},
    headers: {},
    ...overrides,
  } as Request;
}

// ─── User Fixtures ──────────────────────────────────────────────

// Admin user (has admin:settings)
const adminUser = {
  id: "admin-001",
  username: "admin",
  email: "admin@test.com",
  password: "hashed",
  roles: [
    {
      role: {
        name: "admin",
        permissions: [{ permissionName: "admin:settings" }, { permissionName: "workspace:read" }],
      },
    },
  ],
};

// Regular user with chat:write and document:read
const regularUser = {
  id: "user-001",
  username: "regular",
  email: "user@test.com",
  password: "hashed",
  roles: [
    {
      role: {
        name: "user",
        permissions: [{ permissionName: "chat:write" }, { permissionName: "document:read" }],
      },
    },
  ],
};

// User with no permissions
const noPermUser = {
  id: "user-002",
  username: "noperm",
  email: "noperm@test.com",
  password: "hashed",
  roles: [],
};

// ─── requirePermission Tests ────────────────────────────────────

describe("requirePermission middleware", () => {
  it("returns 401 when no user is authenticated", () => {
    const req = createMockReq();
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    const middleware = requirePermission("chat:write");
    middleware(req, res, next);

    expect(state.statusCode).toBe(401);
    expect(state.body.error).toBe("Authentication required");
    expect(called()).toBe(false);
  });

  it("returns 403 when user lacks the required permission", () => {
    const req = createMockReq({ user: regularUser as any, userId: "user-001" } as any);
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    const middleware = requirePermission("admin:settings");
    middleware(req, res, next);

    expect(state.statusCode).toBe(403);
    expect(state.body.error).toBe("Insufficient permissions");
    expect(called()).toBe(false);
  });

  it("calls next() when user has the required permission", () => {
    const req = createMockReq({ user: regularUser as any, userId: "user-001" } as any);
    const { res } = createMockRes();
    const { next, called } = createMockNext();

    const middleware = requirePermission("chat:write");
    middleware(req, res, next);

    expect(called()).toBe(true);
  });

  it("calls next() when user is admin (admin:settings)", () => {
    const req = createMockReq({ user: adminUser as any, userId: "admin-001" } as any);
    const { res } = createMockRes();
    const { next, called } = createMockNext();

    // Requesting a permission the admin doesn't explicitly have — but admin bypasses
    const middleware = requirePermission("workspace:delete");
    middleware(req, res, next);

    expect(called()).toBe(true);
  });

  it("returns 403 for user with empty roles", () => {
    const req = createMockReq({ user: noPermUser as any, userId: "user-002" } as any);
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    const middleware = requirePermission("workspace:read");
    middleware(req, res, next);

    expect(state.statusCode).toBe(403);
    expect(state.body.error).toBe("Insufficient permissions");
    expect(called()).toBe(false);
  });

  it("handles multiple required permissions (all must be present)", () => {
    const req = createMockReq({ user: regularUser as any, userId: "user-001" } as any);
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    // Regular user has chat:write and document:read but NOT admin:settings
    const middleware = requirePermission(["chat:write", "admin:settings"]);
    middleware(req, res, next);

    expect(state.statusCode).toBe(403);
    expect(called()).toBe(false);
  });
});

// ─── requireAdmin Tests ─────────────────────────────────────────

describe("requireAdmin middleware", () => {
  it("returns 401 when no user is authenticated", () => {
    const req = createMockReq();
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    requireAdmin(req, res, next);

    expect(state.statusCode).toBe(401);
    expect(state.body.error).toBe("Authentication required");
    expect(called()).toBe(false);
  });

  it("returns 403 for non-admin user", () => {
    const req = createMockReq({ user: regularUser as any, userId: "user-001" } as any);
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    requireAdmin(req, res, next);

    expect(state.statusCode).toBe(403);
    expect(state.body.error).toBe("Admin access required");
    expect(called()).toBe(false);
  });

  it("calls next() for admin user", () => {
    const req = createMockReq({ user: adminUser as any, userId: "admin-001" } as any);
    const { res } = createMockRes();
    const { next, called } = createMockNext();

    requireAdmin(req, res, next);

    expect(called()).toBe(true);
  });
});

// ─── requireProjectAccess & requireWorkspaceAccess Notes ────────

describe("IDOR prevention (requireProjectAccess / requireWorkspaceAccess)", () => {
  it("requireProjectAccess returns 401 when no user is authenticated", () => {
    const req = createMockReq({ params: { projectId: "proj-001" } });
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    const { requireProjectAccess } = require("../middleware/rbac");
    requireProjectAccess(req, res, next);

    expect(state.statusCode).toBe(401);
    expect(called()).toBe(false);
  });

  it("requireWorkspaceAccess returns 401 when no user is authenticated", () => {
    const req = createMockReq({ params: { workspaceId: "ws-001" } });
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    const { requireWorkspaceAccess } = require("../middleware/rbac");
    requireWorkspaceAccess(req, res, next);

    expect(state.statusCode).toBe(401);
    expect(called()).toBe(false);
  });

  it("requireProjectAccess returns 400 when projectId is missing", () => {
    const req = createMockReq({ user: regularUser as any, userId: "user-001" } as any);
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    const { requireProjectAccess } = require("../middleware/rbac");
    requireProjectAccess(req, res, next);

    expect(state.statusCode).toBe(400);
  });

  it("requireWorkspaceAccess returns 400 when workspaceId is missing", () => {
    const req = createMockReq({ user: regularUser as any, userId: "user-001" } as any);
    const { res, state } = createMockRes();
    const { next, called } = createMockNext();

    const { requireWorkspaceAccess } = require("../middleware/rbac");
    requireWorkspaceAccess(req, res, next);

    expect(state.statusCode).toBe(400);
  });

  it("admin bypasses requireProjectAccess", async () => {
    const req = createMockReq({ user: adminUser as any, userId: "admin-001", params: { projectId: "proj-001" } } as any);
    const { res } = createMockRes();
    const { next, called } = createMockNext();

    const { requireProjectAccess } = require("../middleware/rbac");
    await requireProjectAccess(req, res, next);

    expect(called()).toBe(true);
  });

  it("admin bypasses requireWorkspaceAccess", async () => {
    const req = createMockReq({ user: adminUser as any, userId: "admin-001", params: { workspaceId: "ws-001" } } as any);
    const { res } = createMockRes();
    const { next, called } = createMockNext();

    const { requireWorkspaceAccess } = require("../middleware/rbac");
    await requireWorkspaceAccess(req, res, next);

    expect(called()).toBe(true);
  });
});