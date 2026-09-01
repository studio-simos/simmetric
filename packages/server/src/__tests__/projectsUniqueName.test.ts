// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Quick task 260809-wte — P2002 → 409 conflict mapping on project create/rename.
 *
 * The DB partial unique index (projects_createdBy_name_key, WHERE "deletedAt"
 * IS NULL) is the enforcement point; the route only maps the Prisma P2002
 * error to a clean 409 message the frontend surfaces verbatim (ApiError
 * carries body.error). No route-level pre-checks — pure error-shape mapping.
 */
import "./helpers/setupEnv";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

// --- Prisma mock (lazy — routes access members at call time) ---------------
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    project: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));
const mockPrisma = require("../utils/prisma").default;

// --- eventLogService mock --------------------------------------------------
jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// --- logger mock ------------------------------------------------------------
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// --- auth/rbac mocks (controllable per-test via mockState) -----------------
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
    requireProjectAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
    requirePermission: (_perm: string) => (_req: Request, _res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-permission") {
        _res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
      next();
    },
  };
});
const mockState: { authMode: AuthMode; userId: string | null } = require("../middleware/auth").__mockState;

// --- license middleware mock ------------------------------------------------
jest.mock("../middleware/license", () => ({
  requireFeatureLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// --- auth utils mock --------------------------------------------------------
jest.mock("../utils/auth", () => ({
  isAdmin: () => true,
}));

import projectRoutes from "../routes/projects";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects", projectRoutes);
  return app;
}

// P2002 error shape as Prisma 7 emits it for the projects_createdBy_name_key index.
const p2002Error = Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
  code: "P2002",
  meta: { target: ["createdBy", "name"] },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockState.authMode = "ok";
  mockState.userId = "admin-user-id";
});

describe("POST /api/projects — P2002 → 409 conflict mapping (260809-wte)", () => {
  it("returns 409 with the clean message when prisma.project.create rejects P2002", async () => {
    (mockPrisma.project.create as jest.Mock).mockRejectedValue(p2002Error);

    const app = buildApp();
    const res = await request(app)
      .post("/api/projects")
      .send({ name: "E2E Test Project" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A project with this name already exists");
  });

  it("still returns 201 on the happy path", async () => {
    (mockPrisma.project.create as jest.Mock).mockResolvedValue({
      id: "proj-1",
      name: "Fresh Project",
      createdBy: "admin-user-id",
      deletedAt: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post("/api/projects")
      .send({ name: "Fresh Project" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Fresh Project");
  });
});

describe("PUT /api/projects/:projectId — P2002 → 409 conflict mapping (260809-wte)", () => {
  it("returns 409 with the clean message when rename rejects P2002", async () => {
    (mockPrisma.project.update as jest.Mock).mockRejectedValue(p2002Error);

    const app = buildApp();
    const res = await request(app)
      .put("/api/projects/proj-1")
      .send({ name: "E2E Test Project" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A project with this name already exists");
  });
});
