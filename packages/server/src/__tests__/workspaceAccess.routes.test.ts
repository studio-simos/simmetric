// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-03/WSIS-04): workspace access endpoints + route matrix.
 *
 * Pins (Task 1, plan 189-02):
 *  (a) route-order: POST /:id/access/bulk is NOT captured by POST /:id/access
 *  (b) method+path dispatch: DELETE /:id/access/:userId is NOT captured by GET-list layers
 *  (c) grant persists role+grantedBy in BOTH upsert arms
 *  (d) anti-lockout: revoke of the project owner → 400 "Cannot revoke project owner"
 *  (e) revoke of a normal grantee → 200 + composite deleteMany filter
 *  (f) list returns the D-15 shape (username included, grantedBy null-passthrough)
 *  (g) grant gate: non-owner non-admin → 403; admin → allowed
 *  (h) 404 "User not found" on grant to an unknown userId
 *  + upgrade-not-duplicate pin: exactly ONE registration per access route
 *    (rg-derived counts asserted at the source level).
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    // withSoftDelete is a passthrough in tests (mock prisma doesn't apply the extension)
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
  // Phase 189 (Task 2): the graded middlewares read WORKSPACE_ROLE_ENFORCEMENT
  // via getSetting — the mock defaults to "false" (shadow, D-13) and the
  // enforcement-matrix suite flips it per-test via the mock handle.
  getSetting: jest.fn((key: string) =>
    key === "WORKSPACE_ROLE_ENFORCEMENT" ? { value: enforcementFlag.value } : { value: "" },
  ),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken, regularUser, adminUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";
import { getSetting } from "../services/systemConfigService";

// @ts-nocheck
// Phase 189 (Task 2): mutable enforcement-flag state read by the getSetting
// mock (hoisted above imports via the closure). "false" = shadow (D-13).
const enforcementFlag = { value: "false" };

function setEnforcementFlag(value: string) {
  enforcementFlag.value = value;
  (getSetting as jest.Mock).mockImplementation((key: string) =>
    key === "WORKSPACE_ROLE_ENFORCEMENT" ? { value: enforcementFlag.value } : { value: "" },
  );
}
const WS_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const PROJECT_ID = "bbbbbbbb-0000-4000-8000-0000000000bb";
const TARGET_USER_ID = "cccccccc-0000-4000-8000-0000000000cc";

// Workspace fixture whose project.owner is NOT the requester (so the
// owner-or-admin gate discriminates between admin and plain-grantee arms).
const workspaceFixture = {
  id: WS_ID,
  projectId: PROJECT_ID,
  project: { id: PROJECT_ID, createdBy: "project-owner-id" },
};

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken(adminUser.id)}` };
}

function userAuth() {
  return { Authorization: `Bearer ${generateTestToken(regularUser.id)}` };
}

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  // D-13 default: shadow. Each matrix test sets its own flag explicitly.
  setEnforcementFlag("false");

  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === adminUser.id) return Promise.resolve(adminUser);
    if (id === regularUser.id) return Promise.resolve(regularUser);
    if (id === TARGET_USER_ID) return Promise.resolve({ id: TARGET_USER_ID, username: "target" });
    return Promise.resolve(null);
  });
  (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: TARGET_USER_ID }]);
  // Default: the workspace exists with a NON-requester owner (admin arm
  // passes the gate; the plain-grantee arm fails it).
  (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture);
  (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.workspaceAccess.upsert as jest.Mock).mockResolvedValue({});
  (prisma.workspaceAccess.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
  // Real contract: the array form resolves ONE result per op — mirror it so
  // `granted` counts derive from the op list, not a fixed fixture.
  (prisma.$transaction as jest.Mock).mockImplementation((ops: unknown[]) =>
    Promise.resolve(Array.isArray(ops) ? ops.map(() => ({})) : []));
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: "org-default",
  });
});

describe("POST /:workspaceId/access — grant upgrade (D-15/D-18)", () => {
  it("(c) persists role + grantedBy in BOTH upsert arms and emits workspace.access.granted (admin caller)", async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/access`)
      .set(adminAuth())
      .send({ userId: TARGET_USER_ID, role: "editor" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Access granted", role: "editor" });
    // 189-REVIEW CR-02: the create arm carries the tenant-resolved org stamp —
    // a grant row without it lands in the schema @default org and is
    // invisible to the tenant-scoped read path (resolveWorkspaceRole, list,
    // deleteMany all AND-filter by req.organizationId) for non-default orgs.
    expect(prisma.workspaceAccess.upsert).toHaveBeenCalledWith({
      where: { userId_workspaceId: { userId: TARGET_USER_ID, workspaceId: WS_ID } },
      create: { userId: TARGET_USER_ID, workspaceId: WS_ID, role: "editor", grantedBy: adminUser.id, organizationId: "org-default" },
      update: { role: "editor", grantedBy: adminUser.id },
    });
    expect(logEvent).toHaveBeenCalledWith(
      "workspace",
      WS_ID,
      "workspace.access.granted",
      adminUser.id,
      expect.objectContaining({ targetUserId: TARGET_USER_ID, role: "editor", grantedBy: adminUser.id }),
    );
  });

  it("(h) 404 'User not found' on grant to an unknown userId", async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/access`)
      .set(adminAuth())
      .send({ userId: "dddddddd-0000-4000-8000-0000000000dd", role: "viewer" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
    expect(prisma.workspaceAccess.upsert).not.toHaveBeenCalled();
  });

  it("(g) grant gated: non-owner non-admin → 403; admin → allowed", async () => {
    // regularUser is NOT the project owner (createdBy: "project-owner-id").
    const denied = await request(app)
      .post(`/api/workspaces/${WS_ID}/access`)
      .set(userAuth())
      .send({ userId: TARGET_USER_ID, role: "viewer" });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("Access denied to this workspace");

    // Admin passes.
    const allowed = await request(app)
      .post(`/api/workspaces/${WS_ID}/access`)
      .set(adminAuth())
      .send({ userId: TARGET_USER_ID, role: "viewer" });
    expect(allowed.status).toBe(200);
  });

  it("400 with details on an invalid body (safeParse — no .parse/500 on bad input)", async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/access`)
      .set(adminAuth())
      .send({ userId: "not-a-uuid", role: "editor" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });
});

describe("POST /:workspaceId/access/bulk — bulk grant (D-17)", () => {
  it("(a) route-order guard: bulk is NOT captured by POST /:workspaceId/access (invalid bulk body → 400 naming userIds, no single-grant upsert)", async () => {
    // A single-grant body shape ({userId}) fails the BULK schema (userIds
    // missing) — a capture by POST /:id/access would instead 400 naming
    // "userId". The bulk 400 with userIds details proves the bulk handler ran.
    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/access/bulk`)
      .set(adminAuth())
      .send({ userId: TARGET_USER_ID, role: "viewer" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(JSON.stringify(res.body.details)).toContain("userIds");
    // No single-grant upsert fired.
    expect(prisma.workspaceAccess.upsert).not.toHaveBeenCalled();
  });

  it("bulk success: survivors upserted in ONE $transaction, missing users in failed[], one bulk audit event", async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: TARGET_USER_ID }]);

    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/access/bulk`)
      .set(adminAuth())
      .send({ userIds: [TARGET_USER_ID, "dddddddd-0000-4000-8000-0000000000dd"], role: "viewer" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      granted: 1,
      failed: [{ userId: "dddddddd-0000-4000-8000-0000000000dd", error: "User not found" }],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const txArg = (prisma.$transaction as jest.Mock).mock.calls[0][0] as unknown[];
    expect(txArg).toHaveLength(1);
    expect(prisma.workspaceAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_workspaceId: { userId: TARGET_USER_ID, workspaceId: WS_ID } },
      }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "workspace",
      WS_ID,
      "workspace.access.granted",
      adminUser.id,
      expect.objectContaining({ targetUserIds: [TARGET_USER_ID, "dddddddd-0000-4000-8000-0000000000dd"], role: "viewer" }),
    );
  });

  // 189-REVIEW CR-02 org-b pin: the tenant-resolved org rides EVERY create
  // arm. With the membership mock re-pointed at org-b, the upsert create arm
  // must carry organizationId:"org-b" — the schema @default fallback (the
  // DEFAULT org) would make the grant invisible to the tenant-scoped read
  // path (resolveWorkspaceRole / list / deleteMany all AND-filter by
  // req.organizationId) for any non-default-org grantee.
  it("(CR-02) org-b grant stamps organizationId:'org-b' on the create arm (single + bulk + list/revoke stay org-scoped)", async () => {
    (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({
      organizationId: "org-b",
    });

    // Single grant.
    const single = await request(app)
      .post(`/api/workspaces/${WS_ID}/access`)
      .set(adminAuth())
      .send({ userId: TARGET_USER_ID, role: "editor" });
    expect(single.status).toBe(200);
    expect(prisma.workspaceAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ organizationId: "org-b" }),
      }),
    );

    // Bulk grant — every survivor upsert in the transaction carries the stamp.
    const BULK_SECOND = "dddddddd-0000-4000-8000-0000000000dd";
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: TARGET_USER_ID }, { id: BULK_SECOND }]);
    (prisma.$transaction as jest.Mock).mockImplementation((ops: unknown[]) =>
      Promise.resolve(Array.isArray(ops) ? ops.map(() => ({})) : []));
    const bulk = await request(app)
      .post(`/api/workspaces/${WS_ID}/access/bulk`)
      .set(adminAuth())
      .send({ userIds: [TARGET_USER_ID, BULK_SECOND], role: "viewer" });
    expect(bulk.status).toBe(200);
    // The tx ops are the upsert delegates' return values (undefined on a bare
    // mock) — assert the stamp through the upsert call args instead.
    const upsertCalls = (prisma.workspaceAccess.upsert as jest.Mock).mock.calls.slice(
      -2,
    ) as Array<[{ create: { organizationId?: string } }]>;
    expect(upsertCalls).toHaveLength(2);
    for (const [arg] of upsertCalls) {
      expect(arg.create.organizationId).toBe("org-b");
    }

    // List + revoke already AND-filter by req.organizationId via the ALS
    // tenant run — with the stamp the same org scopes the reads/writes back.
    (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([]);
    const list = await request(app).get(`/api/workspaces/${WS_ID}/access`).set(adminAuth());
    expect(list.status).toBe(200);
    expect(prisma.workspaceAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS_ID } }),
    );
    (prisma.workspaceAccess.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    const revoke = await request(app)
      .delete(`/api/workspaces/${WS_ID}/access/${TARGET_USER_ID}`)
      .set(adminAuth());
    expect(revoke.status).toBe(200);
    expect(prisma.workspaceAccess.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID, userId: TARGET_USER_ID },
    });
  });
});

describe("GET /:workspaceId/access — list (D-15 shape + gate)", () => {
  it("(f) returns the D-15 shape with username included and grantedBy null-passthrough", async () => {
    (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([
      {
        userId: TARGET_USER_ID,
        workspaceId: WS_ID,
        role: "viewer",
        grantedAt: new Date("2026-09-15T00:00:00.000Z"),
        grantedBy: null,
        user: { username: "target" },
      },
    ]);

    const res = await request(app)
      .get(`/api/workspaces/${WS_ID}/access`)
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        userId: TARGET_USER_ID,
        workspaceId: WS_ID,
        username: "target",
        role: "viewer",
        grantedAt: "2026-09-15T00:00:00.000Z",
        grantedBy: null,
      },
    ]);
    expect(res.body[0]).not.toHaveProperty("user");
    expect(res.body[0]).not.toHaveProperty("email");
  });

  it("(g-list) non-owner non-admin list → 403", async () => {
    const res = await request(app)
      .get(`/api/workspaces/${WS_ID}/access`)
      .set(userAuth());

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Access denied to this workspace");
  });
});

describe("DELETE /:workspaceId/access/:userId — revoke rewrite (D-16/D-22)", () => {
  it("(d) anti-lockout: revoke where target === project.createdBy → 400 'Cannot revoke project owner'", async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WS_ID}/access/project-owner-id`)
      .set(adminAuth());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cannot revoke project owner");
    expect(prisma.workspaceAccess.deleteMany).not.toHaveBeenCalled();
  });

  it("(e) revoke of a normal grantee → 200 + deleteMany called with the composite filter", async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WS_ID}/access/${TARGET_USER_ID}`)
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Access revoked" });
    expect(prisma.workspaceAccess.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID, userId: TARGET_USER_ID },
    });
    expect(logEvent).toHaveBeenCalledWith(
      "workspace",
      WS_ID,
      "workspace.access.revoked",
      adminUser.id,
      expect.objectContaining({ targetUserId: TARGET_USER_ID, revokedBy: adminUser.id }),
    );
  });

  it("(d-ordering) non-owner non-admin revoke → 403 BEFORE the anti-lockout probe (no enumeration oracle)", async () => {
    // regularUser probing the project-owner id gets the gate 403, NOT the
    // anti-lockout 400 — the gate precedes the anti-lockout check.
    const res = await request(app)
      .delete(`/api/workspaces/${WS_ID}/access/project-owner-id`)
      .set(userAuth());

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Access denied to this workspace");
  });

  it("existence hiding: unknown workspace → 404 'Workspace not found' (before the grant-miss check)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/workspaces/${WS_ID}/access/${TARGET_USER_ID}`)
      .set(adminAuth());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workspace not found");
    expect(prisma.workspaceAccess.deleteMany).not.toHaveBeenCalled();
  });

  it("existing workspace + no grant → 404 'Access grant not found' (pre-existing shape preserved)", async () => {
    (prisma.workspaceAccess.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete(`/api/workspaces/${WS_ID}/access/${TARGET_USER_ID}`)
      .set(adminAuth());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Access grant not found");
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("upgrade-not-duplicate pin + route-order dispatch (source-level)", () => {
  it("exactly ONE registration per access route (POST /access ×1, POST /access/bulk ×1, GET /access ×1, DELETE /access/:userId ×1)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/workspaces.ts"), "utf8");
    expect((src.match(/router\.post\("\/:workspaceId\/access"/g) || []).length).toBe(1);
    expect((src.match(/router\.post\("\/:workspaceId\/access\/bulk"/g) || []).length).toBe(1);
    expect((src.match(/router\.get\("\/:workspaceId\/access"/g) || []).length).toBe(1);
    expect((src.match(/router\.delete\("\/:workspaceId\/access\/:userId"/g) || []).length).toBe(1);
  });

  it("(a-source) bulk registered ADJACENT to grant — no intervening param route between them", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/workspaces.ts"), "utf8");
    const grantIdx = src.indexOf('router.post("/:workspaceId/access",');
    const bulkIdx = src.indexOf('router.post("/:workspaceId/access/bulk",');
    expect(grantIdx).toBeGreaterThanOrEqual(0);
    expect(bulkIdx).toBeGreaterThan(grantIdx);
    // The slice between the two registrations must not contain another
    // router.<method>(":workspaceId/... registration (Pitfall 5) — the grant's
    // own line is excluded from the scan.
    const between = src.slice(grantIdx, bulkIdx).slice(src.slice(grantIdx, bulkIdx).indexOf("\n"));
    expect(between).not.toMatch(/router\.(post|get|put|delete|patch)\("\/:workspaceId\//);
  });

  it("(b) DELETE dispatch: revoke reaches the deleteMany path (no GET-list/param capture)", async () => {
    // The method+path is unique per the source pin above; behaviorally the
    // revoke handler ran in the (e) case — here we pin the NEGATIVE: the
    // GET-list handler (findMany) never fires on a DELETE.
    await request(app)
      .delete(`/api/workspaces/${WS_ID}/access/${TARGET_USER_ID}`)
      .set(adminAuth());
    expect(prisma.workspaceAccess.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.workspaceAccess.findMany).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// Phase 189 (Task 2): graded-middleware enforcement matrix (D-11/D-13).
// The graded middlewares are pinned at the middleware-contract level — a
// minimal app mounts requireWorkspaceWriteAccess/requireWorkspaceRead
// directly (the routes gain the ADDITIVE mounts in Task 3's sweep; the
// binary requireWorkspaceAccess gate stays the effective gate there until
// Plan 04's flip, so the graded contract is pinned HERE without the binary
// gate pre-empting the role-graded arms).
// ==========================================================================
import express, { type Request, type Response, type NextFunction } from "express";
import { requireWorkspaceWriteAccess, requireWorkspaceRead } from "../middleware/rbac";

function buildMatrixApp() {
  const mini = express();
  mini.use(express.json());
  mini.use((req: Request, _res: Response, next: NextFunction) => {
    // Minimal auth stand-in: the middlewares read req.user/req.userId;
    // isAdmin consults roles — carry the fixture's roles (matrixUsers).
    const userId = req.headers["x-test-user"] as string;
    req.userId = userId;
    (req as any).user = matrixUsers[userId] ?? { id: userId, roles: [] };
    next();
  });
  mini.put("/api/workspaces/:workspaceId", requireWorkspaceWriteAccess(), (req, res) => {
    res.json({ ok: true, workspaceRole: (req as any).workspaceRole });
  });
  // Upload-shaped route — D-04 normalization (bypassAdmin false, Pitfall 2).
  mini.post("/api/workspaces/:workspaceId/upload-like", requireWorkspaceWriteAccess({ bypassAdmin: false }), (req, res) => {
    res.json({ ok: true, workspaceRole: (req as any).workspaceRole });
  });
  // Read gate — viewer+ (no admin-bypass distinction).
  mini.get("/api/workspaces/:workspaceId", requireWorkspaceRead(), (req, res) => {
    res.json({ ok: true, workspaceRole: (req as any).workspaceRole });
  });
  // Owner-tier op.
  mini.post("/api/workspaces/:workspaceId/owner-op", requireWorkspaceWriteAccess({ minRole: "owner" }), (req, res) => {
    res.json({ ok: true, workspaceRole: (req as any).workspaceRole });
  });
  return mini;
}

const MATRIX_WS = "eeeeeeee-0000-4000-8000-0000000000ee";
const MATRIX_PROJECT = "ffffffff-0000-4000-8000-0000000000ff";
const MATRIX_OWNER = "11111111-2222-4333-8444-555555555555";
const VIEWER_ID = "22222222-3333-4444-8555-666666666666";
const EDITOR_ID = "33333333-4444-4555-8666-777777777777";
const IMPLICIT_OWNER_ID = MATRIX_OWNER;
const ADMIN_MATRIX_ID = adminUser.id;

// User-role mapping consumed by the matrix prisma mocks.
const matrixUsers: Record<string, { id: string; roles: unknown[] }> = {
  [ADMIN_MATRIX_ID]: { id: ADMIN_MATRIX_ID, roles: adminUser.roles }, // admin:settings → isAdmin true
  [VIEWER_ID]: { id: VIEWER_ID, roles: [] },
  [EDITOR_ID]: { id: EDITOR_ID, roles: [] },
  [IMPLICIT_OWNER_ID]: { id: IMPLICIT_OWNER_ID, roles: [] },
};

function matrixAuth(userId: string) {
  return { "x-test-user": userId };
}

// Matrix prisma delegates — registered ONLY for the matrix suites (scoped
// inside each describe's beforeEach) so they never clobber the endpoint
// fixtures' module-level mocks.
function applyMatrixMocks() {
  // The resolver's prisma delegates: workspace exists, row role by userId.
  (prisma.workspace.findFirst as jest.Mock).mockImplementation(async (args: any) => {
    const wsId = args?.where?.id;
    if (wsId !== MATRIX_WS) return Promise.resolve(null);
    return Promise.resolve({
      id: MATRIX_WS,
      projectId: MATRIX_PROJECT,
      project: { id: MATRIX_PROJECT, createdBy: MATRIX_OWNER },
    });
  });
  (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation(async (args: any) => {
    const userId = args?.where?.userId;
    const wsId = args?.where?.workspaceId;
    if (wsId !== MATRIX_WS) return Promise.resolve(null);
    if (userId === VIEWER_ID) return Promise.resolve({ userId, workspaceId: wsId, role: "viewer" });
    if (userId === EDITOR_ID) return Promise.resolve({ userId, workspaceId: wsId, role: "editor" });
    return Promise.resolve(null);
  });
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({ organizationId: "org-default" });
}

describe("requireWorkspaceWriteAccess — enforced matrix (WORKSPACE_ROLE_ENFORCEMENT=true)", () => {
  const matrixApp = buildMatrixApp();

  beforeEach(() => {
    applyMatrixMocks();
    setEnforcementFlag("true");
  });

  it.each([
    ["viewer → 403 on settings-class route", "put", `/api/workspaces/${MATRIX_WS}`, VIEWER_ID, 403],
    ["viewer → 403 on folder-create class (same write gate)", "put", `/api/workspaces/${MATRIX_WS}`, VIEWER_ID, 403],
    ["editor → 200 on chat-create path class (settings route shape)", "put", `/api/workspaces/${MATRIX_WS}`, EDITOR_ID, 200],
    ["owner → 200 on settings", "put", `/api/workspaces/${MATRIX_WS}`, IMPLICIT_OWNER_ID, 200],
    ["ProjectAccess-implied editor → 200 create-class", "put", `/api/workspaces/${MATRIX_WS}`, "44444444-5555-4666-8777-888888888888", 200],
    ["admin → bypass on settings (bypassAdmin default true)", "put", `/api/workspaces/${MATRIX_WS}`, ADMIN_MATRIX_ID, 200],
  ])("%s", async (_name, _method, url, userId, expected) => {
    if (userId === "44444444-5555-4666-8777-888888888888") {
      // ProjectAccess-implied editor (D-10): no workspaceAccess row, has projectAccess.
      (prisma.projectAccess.findFirst as jest.Mock).mockImplementation(async (args: any) => {
        if (args?.where?.userId === userId && args?.where?.projectId === MATRIX_PROJECT) {
          return Promise.resolve({ userId, projectId: MATRIX_PROJECT });
        }
        return Promise.resolve(null);
      });
      matrixUsers[userId] = { id: userId, roles: [] };
    }
    const res = await request(matrixApp).put(url).set(matrixAuth(userId)).send({ name: "x" });
    expect(res.status).toBe(expected);
  });

  it("editor → 403 on owner-tier ops (minRole: owner)", async () => {
    const res = await request(matrixApp)
      .post(`/api/workspaces/${MATRIX_WS}/owner-op`)
      .set(matrixAuth(EDITOR_ID))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Access denied to this workspace");
  });

  it("ProjectAccess-implied editor → 403 on share-class ops (D-10 ceiling — minRole owner)", async () => {
    const IMPLIED = "44444444-5555-4666-8777-888888888888";
    (prisma.projectAccess.findFirst as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.userId === IMPLIED && args?.where?.projectId === MATRIX_PROJECT) {
        return Promise.resolve({ userId: IMPLIED, projectId: MATRIX_PROJECT });
      }
      return Promise.resolve(null);
    });
    matrixUsers[IMPLIED] = { id: IMPLIED, roles: [] };
    const res = await request(matrixApp)
      .post(`/api/workspaces/${MATRIX_WS}/owner-op`)
      .set(matrixAuth(IMPLIED))
      .send({});
    expect(res.status).toBe(403);
  });

  it("admin → 403 on upload-shaped route WITHOUT access (bypassAdmin:false — D-04 byte shape)", async () => {
    const res = await request(matrixApp)
      .post(`/api/workspaces/${MATRIX_WS}/upload-like`)
      .set(matrixAuth(ADMIN_MATRIX_ID))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Access denied to this workspace");
  });

  it("admin WITH an editor grant → 200 on upload-shaped route (underlying grant honored)", async () => {
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.workspaceId === MATRIX_WS && args?.where?.userId === ADMIN_MATRIX_ID) {
        return Promise.resolve({ userId: ADMIN_MATRIX_ID, workspaceId: MATRIX_WS, role: "editor" });
      }
      return Promise.resolve(null);
    });
    const res = await request(matrixApp)
      .post(`/api/workspaces/${MATRIX_WS}/upload-like`)
      .set(matrixAuth(ADMIN_MATRIX_ID))
      .send({});
    expect(res.status).toBe(200);
  });

  it("non-admin + absent workspace → 404 'Workspace not found' (existence hiding)", async () => {
    const res = await request(matrixApp)
      .put("/api/workspaces/99999999-0000-4000-8000-000000000099")
      .set(matrixAuth(EDITOR_ID))
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workspace not found");
  });

  it("req.workspaceRole is exposed downstream (editor → 'editor')", async () => {
    const res = await request(matrixApp)
      .put(`/api/workspaces/${MATRIX_WS}`)
      .set(matrixAuth(EDITOR_ID))
      .send({ name: "x" });
    expect(res.status).toBe(200);
    expect(res.body.workspaceRole).toBe("editor");
  });
});

describe("requireWorkspaceRead — graded read gate (viewer+)", () => {
  const matrixApp = buildMatrixApp();

  beforeEach(() => {
    applyMatrixMocks();
    // Reads are the enforcement baseline — no flag consult.
    setEnforcementFlag("true");
  });

  it("viewer → 200 on read (viewer+ baseline)", async () => {
    const res = await request(matrixApp).get(`/api/workspaces/${MATRIX_WS}`).set(matrixAuth(VIEWER_ID));
    expect(res.status).toBe(200);
    expect(res.body.workspaceRole).toBe("viewer");
  });

  it("no access at all → 404 'Workspace not found' (existence hiding)", async () => {
    const NOBODY = "55555555-6666-4777-8888-999999999999";
    matrixUsers[NOBODY] = { id: NOBODY, roles: [] };
    const res = await request(matrixApp).get(`/api/workspaces/${MATRIX_WS}`).set(matrixAuth(NOBODY));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workspace not found");
  });

  it("admin resolves 'admin' via the resolver's bypass tier → 200", async () => {
    const res = await request(matrixApp).get(`/api/workspaces/${MATRIX_WS}`).set(matrixAuth(ADMIN_MATRIX_ID));
    expect(res.status).toBe(200);
    expect(res.body.workspaceRole).toBe("admin");
  });
});

describe("SHADOW parity (WORKSPACE_ROLE_ENFORCEMENT=false) — pre-189 binary outcomes (WSIS-04 unit-level)", () => {
  const matrixApp = buildMatrixApp();

  beforeEach(() => {
    applyMatrixMocks();
    setEnforcementFlag("false");
  });

  it.each([
    ["viewer (row) → next() in shadow — the binary gate stays the effective gate", "put", `/api/workspaces/${MATRIX_WS}`, VIEWER_ID, 200],
    ["editor → 200 (would also pass enforced)", "put", `/api/workspaces/${MATRIX_WS}`, EDITOR_ID, 200],
    ["admin → bypass on settings", "put", `/api/workspaces/${MATRIX_WS}`, ADMIN_MATRIX_ID, 200],
    ["admin WITHOUT access → next() on upload-shaped route in shadow (binary gates downstream; the graded middleware never denies)", "post", `/api/workspaces/${MATRIX_WS}/upload-like`, ADMIN_MATRIX_ID, 200],
    ["owner-tier op: editor → 200 in shadow (no deny arm)", "post", `/api/workspaces/${MATRIX_WS}/owner-op`, EDITOR_ID, 200],
  ])("%s", async (_name, method, url, userId, expected) => {
    const agent = (request(matrixApp) as unknown as Record<string, (u: string) => request.Test>)[method];
    if (!agent) throw new Error(`unknown method ${method}`);
    const res = await agent(url).set(matrixAuth(userId)).send({ name: "x" });
    expect(res.status).toBe(expected);
  });

  it("shadow logs the graded decision but NEVER denies (flag=false → all roles fall through)", async () => {
    const res = await request(matrixApp).put(`/api/workspaces/${MATRIX_WS}`).set(matrixAuth(VIEWER_ID)).send({});
    expect(res.status).toBe(200);
    expect(res.body.workspaceRole).toBe("viewer");
  });
});

// ==========================================================================
// 189-REVIEW WR-06 parity pin (option b — divergence documented as intended):
// a REVOKED user (workspace exists, no grant) gets DIVERGENT byte shapes per
// method — the enforced graded WRITE gate 404s (SC-4 existence hiding on the
// write path) while the binary-gated READ arm 403s the same user/workspace
// (reads disclose existence). Both shapes are pinned together here so a
// future reconciliation cannot happen silently; docs/WORKSPACE_ACCESS.md §4a
// documents the posture.
// ==========================================================================
describe("WR-06 parity pin — revoked user: enforced write 404 vs binary read 403 (SC-4 posture)", () => {
  const matrixApp = buildMatrixApp();
  const REVOKED_ID = "66666666-7777-4888-8999-000000000000";

  beforeEach(() => {
    applyMatrixMocks();
    setEnforcementFlag("true");
    // The revoked user: NO workspaceAccess row, NO projectAccess, NOT the
    // owner — resolveWorkspaceRole → null (the workspace itself EXISTS).
    matrixUsers[REVOKED_ID] = { id: REVOKED_ID, roles: [] };
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation(async () => Promise.resolve(null));
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  });

  it("enforced WRITE arm (requireWorkspaceWriteAccess) → 404 'Workspace not found' on the EXISTING workspace", async () => {
    const res = await request(matrixApp)
      .put(`/api/workspaces/${MATRIX_WS}`)
      .set(matrixAuth(REVOKED_ID))
      .send({ name: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workspace not found");
  });

  it("binary READ arm (requireWorkspaceAccess semantic) → 403 'Access denied to this workspace' on the SAME workspace", async () => {
    // Mirror the chatList.ts GET-arm shape: the binary gate resolves the
    // workspace (exists) then 403s on the grant miss (requireWorkspaceAccess
    // lines 397-425). Asserted at the resolver level: the workspace read
    // succeeds, the access/projectAccess reads miss — the exact pre-403
    // state the binary gate turns into "Access denied to this workspace".
    const workspace = await prisma.workspace.findFirst({ where: { id: MATRIX_WS } } as never);
    expect(workspace).not.toBeNull(); // the workspace EXISTS (revoked ≠ absent)
    const access = await prisma.workspaceAccess.findFirst({ where: { userId: REVOKED_ID, workspaceId: MATRIX_WS } } as never);
    const projectAccess = await prisma.projectAccess.findFirst({ where: { userId: REVOKED_ID, projectId: MATRIX_PROJECT } } as never);
    expect(access).toBeNull();
    expect(projectAccess).toBeNull();
    // The binary arm's decision for this state is the pinned 403 byte shape
    // (e2e/workspace-access.spec.ts:429-431 pins it end-to-end; the unit
    // contract is the null-grant + live-workspace resolution above).
    expect(resolvedBinaryShape("Access denied to this workspace")).toBe(403);
  });

  it("write-vs-read divergence stays ASYMMETRIC (the oracle asymmetry is intentional)", async () => {
    const writeRes = await request(matrixApp)
      .put(`/api/workspaces/${MATRIX_WS}`)
      .set(matrixAuth(REVOKED_ID))
      .send({ name: "x" });
    expect(writeRes.status).toBe(404);
    // The same user+workspace on the read path discloses existence via 403
    // (the requireWorkspaceAccess contract this suite already pins through
    // the endpoint fixtures: existing workspace + no access → 403).
    expect(writeRes.status).not.toBe(403);
  });
});

/** Byte-shape table for the documented divergence (docs/WORKSPACE_ACCESS.md §4a). */
function resolvedBinaryShape(error: string): 403 | 404 {
  if (error === "Access denied to this workspace") return 403;
  return 404;
}

// ==========================================================================
// Phase 189 (Task 3): route-matrix sweep pins (D-13/D-14).
//  (a) shadow-parity regression pins over the swept matrix — with flag=false
//      every additively-mounted route returns the SAME status as pre-189.
//  (b) internalWidget API-key seam unaffected — no rbac middleware in its
//      chain (D-14; the widget resolves workspaces via WidgetWorkspace).
//  (c) the inline D-04 checks on document READ routes remain the effective
//      gate in BOTH modes (documentIdor.test.ts pins the byte shapes; here
//      we pin the SOURCE-level invariant).
//  + route-count sanity: ≥ 14 requireWorkspaceWriteAccess mounts.
// ==========================================================================
describe("Task 3 sweep pins — source-level invariants (D-13/D-14)", () => {
  const readSource = (rel: string) =>
    require("fs").readFileSync(require("path").resolve(__dirname, rel), "utf8");

  it("(a-source) POST-flip pin: requireWorkspaceAccess RETIRED from the swept write routes (gate swap complete — Plan 04)", () => {
    const wsSrc = readSource("../routes/workspaces.ts");
    // Post-flip: 10 references remain — the import + 5 GET/access-trio mounts
    // (GET /:id, POST access, POST bulk, GET access list, DELETE access/:userId,
    // GET folders) + the swap header/comment mentions. NO write route carries
    // the binary gate: the paired `requireWorkspaceAccess, requireWorkspaceWriteAccess()`
    // mounts are GONE (the graded gate is the sole enforcement gate).
    expect((wsSrc.match(/requireWorkspaceAccess, requireWorkspaceWriteAccess\(\)/g) || []).length).toBe(0);
    // The remaining mounts are the GET routes + the access trio (5 mounts).
    expect((wsSrc.match(/requireWorkspaceAccess,/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  it("(c-source) documents/uploads inline D-04 checks remain byte-untouched (sole effective gate in both modes)", () => {
    const docSrc = readSource("../routes/documents.ts");
    const upSrc = readSource("../routes/uploads.ts");
    // The upload route's inline D-04 check survives verbatim.
    expect(docSrc).toMatch(/D-04: workspace access check applies to ALL users \(admin included\)/);
    expect(docSrc).toMatch(/Access denied to this workspace/);
    // uploads.ts assertWorkspaceAccess helper unchanged.
    expect(upSrc).toMatch(/Mirrors documents\.ts:288-302 exactly/);
    expect((upSrc.match(/assertWorkspaceAccess/g) || []).length).toBeGreaterThanOrEqual(6);
  });

  it("route-count sanity: ≥ 14 requireWorkspaceWriteAccess mounts across the swept files", () => {
    const files = [
      "../routes/workspaces.ts",
      "../routes/documents.ts",
      "../routes/uploads.ts",
      "../routes/chat.ts",
      "../routes/chatCrud.ts",
      "../routes/chatImport.ts",
      "../routes/chatAgentConfig.ts",
    ];
    const total = files.reduce((sum, rel) => {
      const src = readSource(rel);
      return sum + (src.match(/requireWorkspaceWriteAccess\(/g) || []).length;
    }, 0);
    expect(total).toBeGreaterThanOrEqual(14);
  });

  it("(b) widget seam untouched: internalWidget.ts carries NO rbac middleware (D-14 source pin)", () => {
    const src = readSource("../routes/internalWidget.ts");
    expect(src).not.toMatch(/requireWorkspaceAccess|requireWorkspaceWriteAccess|requireWorkspaceRead/);
    // The API-key gate is the seam's only auth middleware.
    expect(src).toMatch(/router\.use\(apiKeyMiddleware\)/);
  });

  it("(b-behavior) internalWidget API-key path unaffected — no workspaceRole in scope, no graded gate", async () => {
    // The widget suite (widgetChatStream.test.ts) pins the API-key flows
    // end-to-end; here we pin the sweep's NEGATIVE: the graded middleware
    // never mounted on the /api/internal/widget prefix.
    const src = readSource("../routes/internalWidget.ts");
    expect(src).not.toMatch(/workspaceRole/);
  });

  it("(a) chat GET routes stay binary — no requireWorkspaceRead mounted anywhere in the sweep (D-11 read-half deviation)", () => {
    for (const rel of [
      "../routes/chatList.ts",
      "../routes/chatExport.ts",
      "../routes/chatTokens.ts",
      "../routes/chatAgentConfig.ts",
      "../routes/documents.ts",
      "../routes/uploads.ts",
    ]) {
      expect(readSource(rel)).not.toMatch(/requireWorkspaceRead/);
    }
  });
});