// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Quick task 260809-cxp — Workspace update data contract.
 *
 * Regression: PUT /api/workspaces/:workspaceId failed with Prisma
 * "Unknown argument `templateId`. Did you mean `template`?" when saving
 * workspace options from the frontend (WorkspaceRow.tsx handleSave).
 *
 * Root cause: `skills` was NOT destructured in the PUT handler, so it fell
 * into `...rest` and was spread into prisma.workspace.update data (`skills`
 * is not a Workspace field), which flipped Prisma from the unchecked input
 * (accepts the `templateId` scalar) to the checked WorkspaceUpdateInput
 * (exposes only the `template` relation), producing the error above.
 *
 * These tests pin the exact update data shape: no `skills` key, no
 * `templateId` scalar, template changes via `template: { connect }` /
 * `template: { disconnect: true }`.
 */
import "./helpers/setupEnv";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

// --- Prisma mock ----------------------------------------------------------
// Only the members the PUT path touches are needed; the mock object is lazy
// (routes access members at call time).
// Phase 185 (185-01 tracer): routes/workspaces.ts now mounts
// tenantContextMiddleware after authMiddleware (D-09 chain) — the JWT arm
// resolves the org via prisma.organizationMember.findFirst, so the mock needs
// the delegate (default-org membership → 200s keep flowing).
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    project: {
      findFirst: jest.fn(),
    },
    projectAccess: {
      findFirst: jest.fn(),
    },
    organizationMember: {
      findFirst: jest.fn().mockResolvedValue({ organizationId: "org-default" }),
    },
    workspace: {
      update: jest.fn().mockResolvedValue({ id: "ws-1" }),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    workspaceAgentConfig: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    workspaceAccess: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  },
  withSoftDelete: (where: unknown) => where,
}));
const mockPrisma = require("../utils/prisma").default;

// --- eventLogService mock -------------------------------------------------
jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));
const mockLogEvent = require("../services/eventLogService").logEvent as jest.Mock;

// --- logger mock ----------------------------------------------------------
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// --- auth/rbac mocks (controllable per-test via mockState) ----------------
type AuthMode = "ok" | "no-auth" | "no-permission";

jest.mock("../middleware/auth", () => {
  const mockState: { authMode: AuthMode; userId: string | null } = {
    authMode: "ok",
    userId: "admin-user-id",
  };
  return {
    authMiddleware: (req: Request, res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-auth") {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.userId = mockState.userId ?? undefined;
      (req as unknown as { user: unknown }).user = { id: mockState.userId };
      next();
    },
    __mockState: mockState,
  };
});

jest.mock("../middleware/rbac", () => {
  const mockState = require("../middleware/auth").__mockState;
  return {
  // Phase 189 (189-02 sweep): routes now import the graded middlewares —
  // the mock must export them (shadow no-op) or express throws at load.
  requireWorkspaceWriteAccess: () => (_req: any, _res: any, next: any) => next(),
  requireWorkspaceRead: () => (_req: any, _res: any, next: any) => next(),

    // requireWorkspaceAccess is mocked to pass through so it never touches
    // prisma.workspace.findFirst.
    requireWorkspaceAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
    requirePermission: (_perm: string) => (_req: Request, _res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-permission") {
        _res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
      next();
    },
    requireAdmin: (_req: Request, _res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-permission") {
        _res.status(403).json({ error: "Admin access required" });
        return;
      }
      next();
    },
  };
});
const mockState: { authMode: AuthMode; userId: string | null } = require("../middleware/auth").__mockState;

// --- license middleware mock ----------------------------------------------
jest.mock("../middleware/license", () => ({
  requireFeatureLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// --- auth utils mock -------------------------------------------------------
jest.mock("../utils/auth", () => ({
  isAdmin: () => true,
}));

import workspaceRoutes from "../routes/workspaces";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/workspaces", workspaceRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.authMode = "ok";
  mockState.userId = "admin-user-id";
});

describe("PUT /api/workspaces/:workspaceId — update data contract (260809-cxp)", () => {
  it("Test 1: full frontend payload with templateId: null → disconnect, no skills/templateId keys, skills persisted to agentConfig", async () => {
    const app = buildApp();
    const res = await request(app).put("/api/workspaces/ws-1").send({
      name: "Updated Workspace",
      instructions: null,
      systemPrompt: "You are a helpful assistant.",
      icon: null,
      skills: ["rag_search"],
      constraints: {},
      parsingConfig: {},
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      templateId: null,
    });

    expect(res.status).toBe(200);

    expect(mockPrisma.workspace.update).toHaveBeenCalledTimes(1);
    const updateArg = mockPrisma.workspace.update.mock.calls[0][0];
    const data = updateArg.data;
    expect(updateArg.where).toEqual({ id: "ws-1" });

    expect(data).not.toHaveProperty("skills");
    expect(data).not.toHaveProperty("templateId");
    expect(data).toHaveProperty("template", { disconnect: true });
    expect(data.name).toBe("Updated Workspace");

    expect(mockPrisma.workspaceAgentConfig.upsert).toHaveBeenCalledTimes(1);
    const agentConfigArg = mockPrisma.workspaceAgentConfig.upsert.mock.calls[0][0];
    expect(agentConfigArg.where).toEqual({ workspaceId: "ws-1" });
    expect(agentConfigArg.update.enabledSkills).toBe(JSON.stringify(["rag_search"]));
    expect(agentConfigArg.update.systemPrompt).toBe("You are a helpful assistant.");

    expect(mockLogEvent).toHaveBeenCalledWith("workspace", "ws-1", "update", "admin-user-id");
  });

  it("Test 2: templateId set to a uuid → template: { connect: { id } }", async () => {
    const app = buildApp();
    const templateId = "00000000-0000-4000-8000-000000000001";
    const res = await request(app)
      .put("/api/workspaces/ws-1")
      .send({ name: "Workspace", templateId });

    expect(res.status).toBe(200);

    const data = mockPrisma.workspace.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("skills");
    expect(data).not.toHaveProperty("templateId");
    expect(data).toHaveProperty("template", { connect: { id: templateId } });
  });

  it("Test 3: templateId absent → no template key in update data", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/workspaces/ws-1")
      .send({ name: "Workspace" });

    expect(res.status).toBe(200);

    const data = mockPrisma.workspace.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("skills");
    expect(data).not.toHaveProperty("templateId");
    expect(data).not.toHaveProperty("template");
  });

  it("Test 4: skills only, no templateId (pure regression) → 200, no skills key in update data", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/workspaces/ws-1")
      .send({ name: "Workspace", skills: ["workspace_memory"] });

    expect(res.status).toBe(200);

    const data = mockPrisma.workspace.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("skills");
    expect(data).not.toHaveProperty("templateId");
    expect(data).not.toHaveProperty("template");
  });
});

// --- P2002 → 409 conflict mapping (quick 260809-wte) ------------------------
// The DB partial unique index (workspaces_projectId_name_key, WHERE
// "deletedAt" IS NULL) is the enforcement point; the route maps the Prisma
// P2002 error to a clean 409 message. No route-level pre-checks.
const p2002Error = Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
  code: "P2002",
  meta: { target: ["projectId", "name"] },
});

describe("POST /api/workspaces — P2002 → 409 conflict mapping (260809-wte)", () => {
  it("returns 409 with the clean message when workspace.create rejects P2002", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    (mockPrisma.project.findFirst as jest.Mock).mockResolvedValue({ id: projectId, createdBy: "admin-user-id" });
    (mockPrisma.workspace.create as jest.Mock).mockRejectedValue(p2002Error);

    const app = buildApp();
    const res = await request(app)
      .post("/api/workspaces")
      .send({ projectId, name: "E2E Test Workspace" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A workspace with this name already exists in this project");
  });
});

describe("PUT /api/workspaces/:workspaceId — P2002 → 409 conflict mapping (260809-wte)", () => {
  it("returns 409 with the clean message when rename rejects P2002", async () => {
    (mockPrisma.workspace.update as jest.Mock).mockRejectedValue(p2002Error);

    const app = buildApp();
    const res = await request(app)
      .put("/api/workspaces/ws-1")
      .send({ name: "E2E Test Workspace" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A workspace with this name already exists in this project");
  });
});

// --- Access grants management (D-07 follow-up → Phase 189 D-15..D-17) ------

// Workspace fixture for the owner-or-admin gates the Phase 189 handlers add.
// The test user is "admin-user-id" (isAdmin mocked true), so the gate passes
// via the admin arm; the workspace-load shape is still asserted.
const accessWorkspaceFixture = {
  id: "ws-1",
  project: { id: "proj-1", createdBy: "admin-user-id" },
};

describe("GET /api/workspaces/:workspaceId/access — list grants", () => {
  it("returns the grants reshaped to the D-15 wire shape (no raw user object)", async () => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessWorkspaceFixture);
    (mockPrisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([
      {
        userId: "user-1",
        workspaceId: "ws-1",
        role: "editor",
        grantedAt: new Date("2026-09-15T00:00:00.000Z"),
        grantedBy: null,
        user: { username: "alice" },
      },
    ]);

    const app = buildApp();
    const res = await request(app).get("/api/workspaces/ws-1/access");

    expect(res.status).toBe(200);
    // D-15 shape: {userId, workspaceId, username, role, grantedAt, grantedBy}
    // — no raw user:{id,email,...} passthrough (T-189-11), grantedAt ISO
    // string, legacy grantedBy null-passthrough.
    expect(res.body).toEqual([
      {
        userId: "user-1",
        workspaceId: "ws-1",
        username: "alice",
        role: "editor",
        grantedAt: "2026-09-15T00:00:00.000Z",
        grantedBy: null,
      },
    ]);
    expect(mockPrisma.workspaceAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } })
    );
  });
});

describe("DELETE /api/workspaces/:workspaceId/access/:userId — revoke grant", () => {
  it("revokes an existing grant → 200 + workspace.access.revoked event (D-22 rename)", async () => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessWorkspaceFixture);
    (mockPrisma.workspaceAccess.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await request(app).delete("/api/workspaces/ws-1/access/user-1");

    expect(res.status).toBe(200);
    expect(mockPrisma.workspaceAccess.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-1" },
    });
    expect(mockLogEvent).toHaveBeenCalledWith(
      "workspace",
      "ws-1",
      "workspace.access.revoked",
      "admin-user-id",
      expect.objectContaining({ targetUserId: "user-1", revokedBy: "admin-user-id" }),
    );
  });

  it("returns 404 when no grant exists (existing workspace)", async () => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessWorkspaceFixture);
    (mockPrisma.workspaceAccess.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    const app = buildApp();
    const res = await request(app).delete("/api/workspaces/ws-1/access/user-1");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Access grant not found");
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("returns 404 'Workspace not found' for an unknown workspace (existence hiding)", async () => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app).delete("/api/workspaces/ws-unknown/access/user-1");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workspace not found");
    expect(mockPrisma.workspaceAccess.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 400 'Cannot revoke project owner' when target === project.createdBy (D-16 anti-lockout)", async () => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessWorkspaceFixture);

    const app = buildApp();
    const res = await request(app).delete("/api/workspaces/ws-1/access/admin-user-id");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cannot revoke project owner");
    expect(mockPrisma.workspaceAccess.deleteMany).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/:workspaceId/access — grant (Phase 189 D-15/D-18)", () => {
  // Route schemas validate userIds as UUIDs — fixtures follow.
  const GRANT_USER = "cccccccc-0000-4000-8000-0000000000cc";
  const GHOST_USER = "dddddddd-0000-4000-8000-0000000000dd";
  const USER2 = "eeeeeeee-0000-4000-8000-0000000000ee";

  it("persists role + grantedBy in BOTH upsert arms and emits workspace.access.granted", async () => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessWorkspaceFixture);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: GRANT_USER, username: "alice" });

    const app = buildApp();
    const res = await request(app)
      .post("/api/workspaces/ws-1/access")
      .send({ userId: GRANT_USER, role: "editor" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Access granted", role: "editor" });
    // 189-REVIEW CR-02: explicit org stamp on the create arm (the tenant
    // middleware mock resolves org-default — a @default-landed row would be
    // invisible to the tenant-scoped read path in non-default orgs).
    expect(mockPrisma.workspaceAccess.upsert).toHaveBeenCalledWith({
      where: { userId_workspaceId: { userId: GRANT_USER, workspaceId: "ws-1" } },
      create: { userId: GRANT_USER, workspaceId: "ws-1", role: "editor", grantedBy: "admin-user-id", organizationId: "org-default" },
      update: { role: "editor", grantedBy: "admin-user-id" },
    });
    expect(mockLogEvent).toHaveBeenCalledWith(
      "workspace",
      "ws-1",
      "workspace.access.granted",
      "admin-user-id",
      expect.objectContaining({ targetUserId: GRANT_USER, role: "editor" }),
    );
  });

  it("returns 404 when the target user does not exist", async () => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessWorkspaceFixture);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post("/api/workspaces/ws-1/access")
      .send({ userId: GHOST_USER, role: "editor" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
    expect(mockPrisma.workspaceAccess.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 with details on an invalid body (safeParse, not .parse → 500)", async () => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessWorkspaceFixture);

    const app = buildApp();
    const res = await request(app)
      .post("/api/workspaces/ws-1/access")
      .send({ userId: "not-a-uuid", role: "editor" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });
});

describe("POST /api/workspaces/:workspaceId/access/bulk — bulk grant (D-17)", () => {
  it("upserts survivors in ONE $transaction and returns { granted, failed }", async () => {
    const GRANT_USER = "cccccccc-0000-4000-8000-0000000000cc";
    const GHOST_USER = "dddddddd-0000-4000-8000-0000000000dd";
    const USER2 = "eeeeeeee-0000-4000-8000-0000000000ee";
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessWorkspaceFixture);
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([{ id: GRANT_USER }, { id: USER2 }]);
    // Real contract: the array form resolves ONE result per op.
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: unknown[]) =>
      Promise.resolve(Array.isArray(ops) ? ops.map(() => ({})) : []));

    const app = buildApp();
    const res = await request(app)
      .post("/api/workspaces/ws-1/access/bulk")
      .send({ userIds: [GRANT_USER, USER2, GHOST_USER], role: "viewer" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      granted: 2,
      failed: [{ userId: GHOST_USER, error: "User not found" }],
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    const txArg = (mockPrisma.$transaction as jest.Mock).mock.calls[0][0] as unknown[];
    expect(txArg).toHaveLength(2);
    expect(mockLogEvent).toHaveBeenCalledWith(
      "workspace",
      "ws-1",
      "workspace.access.granted",
      "admin-user-id",
      expect.objectContaining({ targetUserIds: [GRANT_USER, USER2, GHOST_USER], role: "viewer" }),
    );
  });
});

describe("POST /api/workspaces — preventive auto-grant (D-07 follow-up → Phase 189 D-12)", () => {
  it("auto-grants WorkspaceAccess (role editor) when the creator is neither project owner nor project-access holder", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    // Creator (admin-user-id) is NOT the project owner (d68aa2eb scenario)
    (mockPrisma.project.findFirst as jest.Mock).mockResolvedValue({
      id: projectId,
      createdBy: "other-admin-id",
    });
    (mockPrisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.workspace.create as jest.Mock).mockResolvedValue({ id: "ws-1" });

    const app = buildApp();
    const res = await request(app)
      .post("/api/workspaces")
      .send({ projectId, name: "Cross-admin workspace" });

    expect(res.status).toBe(201);
    // 189-REVIEW CR-02: the auto-grant create arm carries the org stamp too.
    expect(mockPrisma.workspaceAccess.upsert).toHaveBeenCalledWith({
      where: { userId_workspaceId: { userId: "admin-user-id", workspaceId: "ws-1" } },
      create: { userId: "admin-user-id", workspaceId: "ws-1", role: "editor", organizationId: "org-default" },
      update: {},
    });
  });

  it("does NOT auto-grant when the creator already has project access", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    (mockPrisma.project.findFirst as jest.Mock).mockResolvedValue({
      id: projectId,
      createdBy: "other-admin-id",
    });
    (mockPrisma.projectAccess.findFirst as jest.Mock).mockResolvedValue({ id: "pa-1" });
    (mockPrisma.workspace.create as jest.Mock).mockResolvedValue({ id: "ws-1" });

    const app = buildApp();
    const res = await request(app)
      .post("/api/workspaces")
      .send({ projectId, name: "Project-access workspace" });

    expect(res.status).toBe(201);
    expect(mockPrisma.workspaceAccess.upsert).not.toHaveBeenCalled();
  });
});
