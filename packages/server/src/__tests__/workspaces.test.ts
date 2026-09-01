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
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    project: {
      findFirst: jest.fn(),
    },
    projectAccess: {
      findFirst: jest.fn(),
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
