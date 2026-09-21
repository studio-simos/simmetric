// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 189-REVIEW WR-02 regression pin — DELETE /api/users/:id must clean up the
 * personal-workspace chain BEFORE the user hard-delete.
 *
 * The bug: Phase 189's lazy provisioning (D-01) guarantees every onboarded
 * user owns a personal Project with createdBy=<userId>, and
 * Project.creator is a required relation with Restrict (no onDelete action
 * — Prisma default). The pre-fix cleanup (userRole/projectAccess/
 * workspaceAccess) never reached the personal chain, so the first delete of
 * any onboarded user hit an FK violation → 500.
 *
 * Pins (mocked prisma — no DB):
 *  (a) the cleanup arms run in order: userRole → projectAccess →
 *      workspaceAccess → personal workspace deleteMany → personal project
 *      deleteMany → user.delete
 *  (b) the personal filters: workspace deleteMany keyed by the personal
 *      project ids; project deleteMany filtered isPersonal:true +
 *      createdBy
 *  (c) a user with NO personal project deletes without touching the
 *      personal chain (no FK-risky delete)
 *  (d) user.delete rejection (P2025) still maps to 404 (pre-existing shape)
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    organizationMember: {
      findFirst: jest.fn().mockResolvedValue({ organizationId: "org-default" }),
    },
    userRole: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    projectAccess: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    workspaceAccess: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    project: {
      findMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    workspace: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    user: {
      findUnique: jest.fn(),
      delete: jest.fn().mockResolvedValue({ id: "target-1", username: "victim", email: "v@t.co" }),
    },
    apiKey: { deleteMany: jest.fn() },
  },
  withSoftDelete: (where: unknown) => where,
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
  })),
}));

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: unknown, _res: unknown, next: () => void) => {
    const r = req as { userId: string; user: unknown };
    r.userId = "admin-001";
    r.user = {
      id: "admin-001",
      roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }] } }],
    };
    next();
  },
}));

jest.mock("../services/authService", () => ({
  invalidateAuthCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/avatarService", () => ({
  avatarUpload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
  resizeAvatar: jest.fn(),
  deleteOldAvatars: jest.fn(),
  removeAvatarFiles: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../middleware/rbac", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWorkspaceAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWorkspaceWriteAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWorkspaceRead: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireProjectAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceRole: jest.fn(async () => null),
}));

jest.mock("../services/personalWorkspaceService", () => ({
  createPersonalWorkspace: jest.fn(),
  PersonalWorkspaceConflictError: class extends Error {},
}));

jest.mock("../utils/auth", () => ({
  isAdmin: jest.fn(() => true),
  getEffectivePermissions: jest.fn(() => []),
}));

import request from "supertest";
import express from "express";
import userRoutes from "../routes/users";
import prisma from "../utils/prisma";

const app = express();
app.use(express.json());
app.use("/api/users", userRoutes);

const TARGET = "target-1";

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.project.findMany as jest.Mock).mockResolvedValue([{ id: "personal-p1" }, { id: "personal-p2" }]);
});

describe("DELETE /api/users/:id — personal-workspace cleanup (WR-02)", () => {
  it("(a) cleanup order: personal chain deleted BEFORE the user hard-delete", async () => {
    const res = await request(app).delete(`/api/users/${TARGET}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("User deleted");

    const order = [
      (prisma.project.findMany as jest.Mock),
      (prisma.workspace.deleteMany as jest.Mock),
      (prisma.project.deleteMany as jest.Mock),
      (prisma.user.delete as jest.Mock),
    ].map((fn) => fn.mock.invocationCallOrder[0] as number);
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
    expect(order[2]!).toBeLessThan(order[3]!);
  });

  it("(b) personal chain keyed by isPersonal projects of the deleted user", async () => {
    await request(app).delete(`/api/users/${TARGET}`);

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { createdBy: TARGET, isPersonal: true },
      select: { id: true },
    });
    expect(prisma.workspace.deleteMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["personal-p1", "personal-p2"] } },
    });
    expect(prisma.project.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["personal-p1", "personal-p2"] } },
    });
  });

  it("(c) no personal projects → the personal-chain delete arms never fire", async () => {
    (prisma.project.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app).delete(`/api/users/${TARGET}`);
    expect(res.status).toBe(200);
    expect(prisma.workspace.deleteMany).not.toHaveBeenCalled();
    expect(prisma.project.deleteMany).not.toHaveBeenCalled();
    expect(prisma.user.delete).toHaveBeenCalledTimes(1);
  });

  it("(d) P2025 on user.delete still maps to 404 (pre-existing shape preserved)", async () => {
    (prisma.user.delete as jest.Mock).mockRejectedValue(
      Object.assign(new Error("Record not found"), { code: "P2025" }),
    );
    const res = await request(app).delete(`/api/users/${TARGET}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
  });
});