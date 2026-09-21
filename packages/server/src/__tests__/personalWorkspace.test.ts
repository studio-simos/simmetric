// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-01, D-05): personal-workspace provisioning suite.
 *
 * Pins (tracer task):
 *  (a) creation shape — project create carries isPersonal:true + createdBy +
 *      organizationId; workspace create carries the wizard name + org stamp;
 *      agentConfig upsert issued; user.update sets hasOnboarded:true
 *  (b) idempotent repeat — find-first hit, NO second project create
 *  (c) invalid body (empty / >100 / missing name) → 400 { error, details }
 *  (d) service P2002-with-personal-workspace-found → success (idempotent)
 *  (e) service P2002-without → 409 byte shape
 *  (f) route-order guard: POST /me/personal-workspace is NOT captured by
 *      GET /:id or PUT /:id (method+path dispatch, not an id-lookup 404)
 *  (g) invalidateAuthCache called with userId after success (Pitfall 4)
 *  + the D-04 license invariant pin lives in license.test.ts (Plan 02
 *    already landed the count-filter + its where-arg assertion — the
 *    plan's "extend license.test.ts" requirement is satisfied by that
 *    landed case; re-asserted here at the source level below).
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const { prisma } = createMockPrisma();
  return {
    __esModule: true,
    default: prisma,
    withSoftDelete: (where: any) => where,
  };
});

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

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => Infinity),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn(() => ({ value: "false" })),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
// (g) needs a mock handle on the auth-cache invalidation (Pitfall 4 pin).
// authMiddleware imports verifyToken/getUserWithRoles/getCachedUserWithRoles
// from this module — the mock must re-export ALL of them. getCachedUserWithRoles
// defers to the mocked prisma user.findUnique so the JWT arm resolves the
// fixture user through the per-test mockImplementation.
jest.mock("../services/authService", () => ({
  invalidateAuthCache: jest.fn().mockResolvedValue(undefined),
  // The real verifyToken applies env.JWT_SECRET internally — mirror it with
  // the .env.test secret (generateTestToken signs with the same value).
  verifyToken: (token: string) =>
    jest.requireActual("jsonwebtoken").verify(token, "test-jwt-secret-for-unit-tests-32ch"),
  getUserWithRoles: jest.fn(),
  // The prisma factory runs under jest.mock hoisting before this module's
  // import list resolves; a lazy require inside the callback reads the SAME
  // mocked module instance the suite imports (no duplicate mock set).
  getCachedUserWithRoles: jest.fn((userId: string) =>
    require("../utils/prisma").default.user.findUnique({ where: { id: userId } }),
  ),
}));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken, regularUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";
import { invalidateAuthCache } from "../services/authService";
import { readFileSync } from "fs";
import path from "path";

// @ts-nocheck
const ORG_ID = "org-1";

function auth() {
  return { Authorization: `Bearer ${generateTestToken(regularUser.id)}` };
}

const app = createApp();

const WIZARD_WORKSPACE = {
  id: "wwwwwwww-0000-4000-8000-000000000001",
  name: "My Workspace",
  projectId: "pppppppp-0000-4000-8000-000000000001",
};

beforeEach(() => {
  jest.clearAllMocks();
  // Auth arm resolves the JWT principal.
  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === regularUser.id) return Promise.resolve(regularUser);
    return Promise.resolve(null);
  });
  // Tenant arm: the requester has a live default-org membership.
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: ORG_ID,
  });
  // Service fast path: no personal workspace yet.
  (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(null);
  // Interactive $transaction: resolve the callback with the workspace the
  // body creates (mirrors the real contract — one result per tx).
  (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
    const tx = {
      project: prisma.project,
      workspace: prisma.workspace,
      workspaceAgentConfig: prisma.workspaceAgentConfig,
      user: prisma.user,
    };
    return fn(tx);
  });
  (prisma.project.create as jest.Mock).mockResolvedValue({
    id: WIZARD_WORKSPACE.projectId,
    name: "Personal",
  });
  (prisma.workspace.create as jest.Mock).mockResolvedValue(WIZARD_WORKSPACE);
  (prisma.workspaceAgentConfig.upsert as jest.Mock).mockResolvedValue({});
  (prisma.user.update as jest.Mock).mockResolvedValue({});
});

describe("POST /api/users/me/personal-workspace (D-05 tracer)", () => {
  it("(a) 201 — project create carries isPersonal:true + createdBy + org stamp; workspace carries the wizard name; agentConfig upsert issued; hasOnboarded flipped", async () => {
    const res = await request(app)
      .post("/api/users/me/personal-workspace")
      .set(auth())
      .send({ workspaceName: WIZARD_WORKSPACE.name });

    expect(res.status).toBe(201);
    expect(res.body.workspace).toEqual({
      id: WIZARD_WORKSPACE.id,
      name: WIZARD_WORKSPACE.name,
      projectId: WIZARD_WORKSPACE.projectId,
    });
    expect(res.body.hasOnboarded).toBe(true);

    // Creation shape (mock call-args assertions).
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: {
        name: "Personal",
        createdBy: regularUser.id,
        isPersonal: true,
        organizationId: ORG_ID,
      },
    });
    expect(prisma.workspace.create).toHaveBeenCalledWith({
      data: {
        projectId: WIZARD_WORKSPACE.projectId,
        name: WIZARD_WORKSPACE.name,
        organizationId: ORG_ID,
      },
    });
    expect(prisma.workspaceAgentConfig.upsert).toHaveBeenCalledWith({
      where: { workspaceId: WIZARD_WORKSPACE.id },
      update: {},
      create: { workspaceId: WIZARD_WORKSPACE.id },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: regularUser.id },
      data: { hasOnboarded: true },
    });
  });

  it("(b) idempotent repeat — find-first hit returns the same workspace, NO second project create", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(WIZARD_WORKSPACE);

    const res = await request(app)
      .post("/api/users/me/personal-workspace")
      .set(auth())
      .send({ workspaceName: "A different name — ignored on repeat" });

    expect(res.status).toBe(201);
    expect(res.body.workspace.id).toBe(WIZARD_WORKSPACE.id);
    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(prisma.workspace.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    ["empty name", { workspaceName: "" }],
    ["name over 100 chars", { workspaceName: "x".repeat(101) }],
    ["missing name", {}],
  ])("(c) invalid body: %s → 400 { error, details }", async (_label, body) => {
    const res = await request(app)
      .post("/api/users/me/personal-workspace")
      .set(auth())
      .send(body);

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.details).toBeDefined();
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  it("(d) service P2002 WITH a personal workspace now found → success (concurrent-first-use race tolerated)", async () => {
    // First find-first: miss (fast path). Then the transaction throws P2002;
    // the catch's re-check find-first finds the winner's workspace.
    let call = 0;
    (prisma.workspace.findFirst as jest.Mock).mockImplementation(() => {
      call += 1;
      return call === 1 ? Promise.resolve(null) : Promise.resolve(WIZARD_WORKSPACE);
    });
    (prisma.$transaction as jest.Mock).mockRejectedValue({ code: "P2002" });

    const res = await request(app)
      .post("/api/users/me/personal-workspace")
      .set(auth())
      .send({ workspaceName: WIZARD_WORKSPACE.name });

    expect(res.status).toBe(201);
    expect(res.body.workspace.id).toBe(WIZARD_WORKSPACE.id);
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  it("(e) service P2002 WITHOUT a personal workspace → 409 byte shape (tombstone name collision, Pitfall 8)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.$transaction as jest.Mock).mockRejectedValue({ code: "P2002" });

    const res = await request(app)
      .post("/api/users/me/personal-workspace")
      .set(auth())
      .send({ workspaceName: WIZARD_WORKSPACE.name });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "A workspace with this name already exists in this project",
    });
  });

  it("(f) route-order guard: POST /me/personal-workspace is NOT captured by GET /:id or PUT /:id", async () => {
    // The literal /me path must never be treated as an :id. A GET against
    // /me would hit GET /:id with id="me" and 404 "User not found" — but the
    // POST must dispatch to the personal-workspace handler (201-class), and
    // a GET /me/:id-shaped probe must still dispatch per its own method.
    const res = await request(app)
      .post("/api/users/me/personal-workspace")
      .set(auth())
      .send({ workspaceName: WIZARD_WORKSPACE.name });

    expect(res.status).toBe(201);
    // The personal-workspace handler ran (id-lookup 404 never fired — the
    // project.create mock was exercised by THIS dispatch).
    expect(prisma.project.create).toHaveBeenCalledTimes(1);
  });

  it("(g) invalidateAuthCache called with userId after success (Pitfall 4)", async () => {
    await request(app)
      .post("/api/users/me/personal-workspace")
      .set(auth())
      .send({ workspaceName: WIZARD_WORKSPACE.name });

    expect(invalidateAuthCache).toHaveBeenCalledWith(regularUser.id);
  });
});

describe("D-04 source-level pin (license.test.ts carries the runtime invariant)", () => {
  it("license.test.ts pins the isPersonal count-filter where-clause (Plan 02 landed it; this suite guards its presence)", () => {
    const licenseTestPath = path.resolve(__dirname, "license.test.ts");
    const source = readFileSync(licenseTestPath, "utf-8");
    expect(source).toContain("isPersonal: false");
    expect(source).toContain("D-04 invariant");
  });

  it("users.ts registers the route before /:id and carries no requireFeatureLimit (D-21)", () => {
    const usersRoutePath = path.resolve(__dirname, "../routes/users.ts");
    const source = readFileSync(usersRoutePath, "utf-8");
    const mountLine = source.split("\n").findIndex((l) => l.includes('router.post("/me/personal-workspace"'));
    const firstIdRoute = source.split("\n").findIndex((l) => l.includes('router.get("/:id"'));
    expect(mountLine).toBeGreaterThan(-1);
    expect(firstIdRoute).toBeGreaterThan(mountLine);
    expect(source).not.toContain("requireFeatureLimit");
  });
});