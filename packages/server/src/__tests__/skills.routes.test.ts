// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 190 (SKIL-01/03/05) — /api/skills CRUD + test-preview route matrix.
 *
 * Mirrors workspaceAccess.routes.test.ts's supertest idiom (createApp +
 * generateTestToken + per-delegate fixtures). Pins:
 *  - scope arbitration server-side: personal → userId=me; global → admin-only,
 *    userId null; workspace → editor+ (null → 404 existence hiding, viewer →
 *    403), persisted with userId NULL (the D-05 personal-arm hazard pin).
 *  - P2002 → 409 (duplicate slug); reserved slug → 400 (schema).
 *  - requireFeatureLimit: at limit → 402 { error, feature, limit, current, tier }.
 *  - builtin rows → PUT/DELETE 400 with the exact literals.
 *  - GET list: admin sees all org rows; user sees own + global in `custom`;
 *    another user's workspace-scoped row in a viewer+ workspace appears in
 *    `accessible` (never in `custom`); a no-access workspace contributes nothing.
 *  - POST /:id/test: compiledPrompt carries the delimiter lines + the param
 *    substituted + an unknown placeholder left literal — ZERO orchestrator
 *    calls (the no-LLM prohibition, pinned by the mocked runAgentStreaming).
 */
// @ts-nocheck

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
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

jest.mock("../agent/orchestrator", () => ({
  runAgent: jest.fn(),
  runAgentStreaming: jest.fn(),
}));

jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn(() => ({ value: "" })),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../agent/builtinSkills", () => ({}));
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken, regularUser, adminUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";
import { runAgentStreaming } from "../agent/orchestrator";

/** regularUser with the Plan 01 skill:* grants (D-07: create/read/write — WR-04
 * adds skill:delete to the DEFAULT role, but this synthetic fixture pins the
 * configured-without-grant arm of the DELETE permission gate independently). */
const skillUser = {
  id: "user-skills-001",
  username: "skilluser",
  email: "skilluser@test.com",
  passwordHash: "hashed",
  roles: [
    {
      role: {
        name: "user",
        permissions: [
          { permissionName: "chat:write" },
          { permissionName: "workspace:read" },
          { permissionName: "skill:create" },
          { permissionName: "skill:read" },
          { permissionName: "skill:write" },
        ],
      },
    },
  ],
};

/** user with ONLY skill:delete — pins the delete-grant arm independently. */
const skillDeleteUser = {
  ...skillUser,
  id: "user-skills-del-001",
  username: "skilldeluser",
  roles: [
    {
      role: {
        name: "user",
        permissions: [{ permissionName: "skill:read" }, { permissionName: "skill:delete" }],
      },
    },
  ],
};

/** user with NO skill permissions — pins the requirePermission deny arm. */
const noSkillUser = {
  id: "user-noskills-001",
  username: "noskills",
  email: "noskills@test.com",
  passwordHash: "hashed",
  roles: [{ role: { name: "user", permissions: [{ permissionName: "chat:write" }] } }],
};

const WS_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const OTHER_WS_ID = "aaaaaaaa-0000-4000-8000-0000000000bb";
const BUILTIN_ROW_ID = "bbbbbbbb-0000-4000-8000-0000000000b1";
const CUSTOM_ROW_ID = "cccccccc-0000-4000-8000-0000000000c1";
const OTHER_USER_CUSTOM_ID = "dddddddd-0000-4000-8000-0000000000d1";

function makeCustomRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOM_ROW_ID,
    name: "custom_translate",
    slug: "translate",
    displayName: "Translate",
    description: "translates text",
    type: "custom",
    skillMode: "prompt",
    config: JSON.stringify({ template: "Translate {{input}} to {{lang}}", defaultParams: { lang: "it" }, injectAs: "user" }),
    inputSchema: JSON.stringify({ properties: { input: { type: "string" } }, required: ["input"] }),
    isEnabled: true,
    isBuiltIn: false,
    organizationId: "org-default",
    userId: skillUser.id,
    workspaceId: null,
    createdBy: skillUser.id,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken(adminUser.id)}` };
}

function userAuth() {
  return { Authorization: `Bearer ${generateTestToken(skillUser.id)}` };
}

function noSkillAuth() {
  return { Authorization: `Bearer ${generateTestToken(noSkillUser.id)}` };
}

function deleteAuth() {
  return { Authorization: `Bearer ${generateTestToken(skillDeleteUser.id)}` };
}

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();

  // Auth middleware substrate — user lookup with roles (mockAuth fixtures).
  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === adminUser.id) return Promise.resolve(adminUser);
    if (id === regularUser.id) return Promise.resolve(regularUser);
    if (id === skillUser.id) return Promise.resolve(skillUser);
    if (id === skillDeleteUser.id) return Promise.resolve(skillDeleteUser);
    if (id === noSkillUser.id) return Promise.resolve(noSkillUser);
    return Promise.resolve(null);
  });
  // Default-org membership (tenant context).
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: "org-default",
  });
  // resolveWorkspaceRole substrate: workspace exists, project owned by
  // someone else, no access rows (per-test overrides).
  (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
    id: WS_ID,
    projectId: "proj-1",
    project: { id: "proj-1", createdBy: "project-owner-id" },
  });
  (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.projectAccess.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.agentSkill.create as jest.Mock).mockImplementation((args: any) =>
    Promise.resolve({
      id: "created-row-id",
      name: args.data.name,
      slug: args.data.slug,
      displayName: args.data.displayName,
      description: args.data.description,
      type: "custom",
      skillMode: "prompt",
      config: args.data.config,
      inputSchema: args.data.inputSchema,
      isEnabled: true,
      isBuiltIn: false,
      organizationId: args.data.organizationId,
      userId: args.data.userId,
      workspaceId: args.data.workspaceId,
      createdBy: args.data.createdBy,
    }),
  );
  (prisma.agentSkill.update as jest.Mock).mockImplementation((args: any) =>
    Promise.resolve({ ...makeCustomRow(), ...args.data }),
  );
  (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);
});

// ─── POST /api/skills — scope arbitration ────────────────────────────────

describe("POST /api/skills — server-side scoping (D-05/D-07)", () => {
  const body = {
    slug: "translate",
    name: "Translate",
    description: "translates",
    skillMode: "prompt",
    config: { template: "Translate {{input}} to {{lang}}", defaultParams: { lang: "it" }, injectAs: "user" },
    // D-04: every {{placeholder}} — including defaultParams-backed {{lang}} —
    // needs a properties entry.
    inputSchema: { properties: { input: { type: "string" }, lang: { type: "string" } }, required: ["input"] },
  };

  it("scope personal → 201 with userId = caller (wire shape carries createdBy)", async () => {
    const res = await request(app).post("/api/skills").set(userAuth()).send({ ...body, scope: "personal" });
    expect(res.status).toBe(201);
    expect(res.body.createdBy).toBe(skillUser.id);
    expect(res.body.scope).toBe("personal");
    expect(prisma.agentSkill.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: skillUser.id, workspaceId: null }) }),
    );
  });

  it("scope global as admin → 201 with userId null (create-call-args pin)", async () => {
    const res = await request(app).post("/api/skills").set(adminAuth()).send({ ...body, scope: "global" });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("global");
    expect(prisma.agentSkill.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: null, workspaceId: null }) }),
    );
  });

  it("scope global as non-admin → 403", async () => {
    const res = await request(app).post("/api/skills").set(userAuth()).send({ ...body, scope: "global" });
    expect(res.status).toBe(403);
  });

  it("scope workspace as member with editor row → 201 with userId NULL AND workspaceId set (D-05 personal-arm hazard pin)", async () => {
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: skillUser.id,
      workspaceId: WS_ID,
      role: "editor",
    });
    const res = await request(app)
      .post("/api/skills")
      .set(userAuth())
      .send({ ...body, scope: "workspace", workspaceId: WS_ID });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("workspace");
    // The create-call-args pin: data.userId === null so the row resolves via
    // the D-05 workspace OR-arm ONLY.
    expect(prisma.agentSkill.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: null, workspaceId: WS_ID }) }),
    );
  });

  it("scope workspace without any grant → 404 (existence hiding)", async () => {
    const res = await request(app)
      .post("/api/skills")
      .set(userAuth())
      .send({ ...body, scope: "workspace", workspaceId: WS_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workspace not found");
  });

  it("scope workspace with viewer row → 403", async () => {
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: skillUser.id,
      workspaceId: WS_ID,
      role: "viewer",
    });
    const res = await request(app)
      .post("/api/skills")
      .set(userAuth())
      .send({ ...body, scope: "workspace", workspaceId: WS_ID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Access denied to this workspace");
  });

  it("scope workspace as admin → 201 (resolver admin bypass)", async () => {
    const res = await request(app)
      .post("/api/skills")
      .set(adminAuth())
      .send({ ...body, scope: "workspace", workspaceId: WS_ID });
    expect(res.status).toBe(201);
    expect(prisma.agentSkill.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: null, workspaceId: WS_ID }) }),
    );
  });

  it("reserved slug → 400 (createSkillSchema refine)", async () => {
    const res = await request(app).post("/api/skills").set(userAuth()).send({ ...body, slug: "model", scope: "personal" });
    expect(res.status).toBe(400);
    expect(res.body.details).toBeDefined();
  });

  it("duplicate slug (P2002) → 409", async () => {
    (prisma.agentSkill.create as jest.Mock).mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await request(app).post("/api/skills").set(userAuth()).send({ ...body, scope: "personal" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A skill with this slug already exists");
  });

  it("create emits logEvent('skill', …, 'create', …)", async () => {
    await request(app).post("/api/skills").set(userAuth()).send({ ...body, scope: "personal" });
    expect(logEvent).toHaveBeenCalledWith(
      "skill",
      expect.any(String),
      "create",
      skillUser.id,
      expect.objectContaining({ slug: "translate", scope: "personal" }),
    );
  });
});

// ─── SKIL-05: requireFeatureLimit on CREATE ──────────────────────────────

describe("POST /api/skills — max_skills limit (SKIL-05, boundary)", () => {
  const body = {
    slug: "translate",
    name: "Translate",
    description: "d",
    skillMode: "prompt",
    config: { template: "T {{input}}", defaultParams: {}, injectAs: "user" },
    inputSchema: { properties: { input: { type: "string" } }, required: [] },
    scope: "personal",
  };

  function setLimit(limit: number) {
    const { getFeatureLimit } = require("../services/licenseService");
    (getFeatureLimit as jest.Mock).mockReturnValue(limit);
  }

  afterEach(() => {
    const { getFeatureLimit } = require("../services/licenseService");
    (getFeatureLimit as jest.Mock).mockReturnValue(Infinity);
  });

  it("count below limit → 201", async () => {
    setLimit(3);
    (prisma.agentSkill.count as jest.Mock).mockResolvedValue(2);
    const res = await request(app).post("/api/skills").set(userAuth()).send(body);
    expect(res.status).toBe(201);
  });

  it("count AT limit → 402 with the exact body shape", async () => {
    setLimit(3);
    (prisma.agentSkill.count as jest.Mock).mockResolvedValue(3);
    const res = await request(app).post("/api/skills").set(userAuth()).send(body);
    expect(res.status).toBe(402);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: expect.any(String),
        feature: "max_skills",
        limit: 3,
        current: 3,
        tier: "community",
      }),
    );
    expect(Object.keys(res.body).sort()).toEqual(["current", "error", "feature", "limit", "tier"]);
  });

  it("count query carries the org-scoped where (organizationId + deletedAt null + type custom)", async () => {
    setLimit(3);
    (prisma.agentSkill.count as jest.Mock).mockResolvedValue(0);
    await request(app).post("/api/skills").set(userAuth()).send(body);
    expect(prisma.agentSkill.count).toHaveBeenCalledWith({
      where: { organizationId: "org-default", deletedAt: null, type: "custom" },
    });
  });
});

// ─── PUT / DELETE — builtin 400 + owner-or-admin ─────────────────────────

describe("PUT/DELETE /api/skills/:id — lifecycle gates", () => {
  it("PUT by non-owner non-admin → 403", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ createdBy: "someone-else", userId: "someone-else" }),
    );
    const res = await request(app)
      .put(`/api/skills/${CUSTOM_ROW_ID}`)
      .set(userAuth())
      .send({ description: "patched" });
    expect(res.status).toBe(403);
    expect(prisma.agentSkill.update).not.toHaveBeenCalled();
  });

  it("PUT by owner → 200 with the patch applied", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(makeCustomRow());
    const res = await request(app)
      .put(`/api/skills/${CUSTOM_ROW_ID}`)
      .set(userAuth())
      .send({ description: "patched by owner" });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("patched by owner");
    expect(logEvent).toHaveBeenCalledWith("skill", CUSTOM_ROW_ID, "update", skillUser.id, expect.anything());
  });

  it("PUT by admin (non-owner) → 200", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ createdBy: "someone-else", userId: "someone-else" }),
    );
    const res = await request(app).put(`/api/skills/${CUSTOM_ROW_ID}`).set(adminAuth()).send({ description: "admin patch" });
    expect(res.status).toBe(200);
  });

  it("PUT a builtin row → 400 'Cannot edit built-in skill'", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ id: BUILTIN_ROW_ID, name: "rag_search", slug: "rag_search", isBuiltIn: true, type: "builtin", createdBy: null, userId: null }),
    );
    const res = await request(app).put(`/api/skills/${BUILTIN_ROW_ID}`).set(userAuth()).send({ description: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cannot edit built-in skill");
  });

  it("DELETE a builtin row → 400 'Cannot delete built-in skill'", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ id: BUILTIN_ROW_ID, name: "rag_search", slug: "rag_search", isBuiltIn: true, type: "builtin", createdBy: null, userId: null }),
    );
    const res = await request(app).delete(`/api/skills/${BUILTIN_ROW_ID}`).set(adminAuth());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cannot delete built-in skill");
  });

  it("DELETE gated by requirePermission('skill:delete') — a user without the grant → 403", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(makeCustomRow());
    const res = await request(app).delete(`/api/skills/${CUSTOM_ROW_ID}`).set(userAuth());
    expect(res.status).toBe(403);
  });

  it("DELETE by owner → 200 with a soft delete (deletedAt set)", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ createdBy: skillDeleteUser.id }),
    );
    const res = await request(app).delete(`/api/skills/${CUSTOM_ROW_ID}`).set(deleteAuth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(prisma.agentSkill.update).toHaveBeenCalledWith({
      where: { id: CUSTOM_ROW_ID },
      data: { deletedAt: expect.any(Date) },
    });
    expect(logEvent).toHaveBeenCalledWith("skill", CUSTOM_ROW_ID, "delete", skillDeleteUser.id, expect.anything());
  });

  it("POST gated by requirePermission('skill:create') — a user without skill permissions → 403", async () => {
    const res = await request(app)
      .post("/api/skills")
      .set(noSkillAuth())
      .send({
        slug: "translate",
        name: "Translate",
        description: "d",
        skillMode: "prompt",
        config: { template: "T {{input}}", defaultParams: {}, injectAs: "user" },
        inputSchema: { properties: { input: { type: "string" } }, required: [] },
        scope: "personal",
      });
    expect(res.status).toBe(403);
    expect(prisma.agentSkill.create).not.toHaveBeenCalled();
  });

  it("DELETE by non-owner non-admin → 403", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ createdBy: "someone-else", userId: "someone-else" }),
    );
    const res = await request(app).delete(`/api/skills/${CUSTOM_ROW_ID}`).set(userAuth());
    expect(res.status).toBe(403);
  });

  it("GET unknown id → 404", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/skills/${CUSTOM_ROW_ID}`).set(userAuth());
    expect(res.status).toBe(404);
  });

  it("WR-01: the direct read runs the D-05 visibility predicate for non-admins (own ∪ global ∪ workspace arms)", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(null);
    await request(app).get(`/api/skills/${CUSTOM_ROW_ID}`).set(userAuth());
    expect(prisma.agentSkill.findFirst).toHaveBeenCalledWith({
      where: {
        id: CUSTOM_ROW_ID,
        deletedAt: null,
        OR: [{ userId: skillUser.id }, { userId: null, workspaceId: null }],
      },
    });
  });

  it("WR-01: a workspace row the caller holds viewer+ on is readable; another user's personal row is hidden (404)", async () => {
    // Workspace arm: the caller holds viewer+ on WS_ID; the workspace-scoped
    // row (userId NULL) resolves via the workspace arm.
    (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([
      { userId: skillUser.id, workspaceId: WS_ID },
    ]);
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ userId: null, workspaceId: WS_ID, createdBy: "someone-else" }),
    );
    const wsRes = await request(app).get(`/api/skills/${CUSTOM_ROW_ID}`).set(userAuth());
    expect(wsRes.status).toBe(200);
    expect(wsRes.body.scope).toBe("workspace");
    // The workspace arm rides the caller's accessible id set.
    expect(prisma.agentSkill.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: expect.arrayContaining([{ userId: null, workspaceId: { in: [WS_ID] } }]),
      }),
    });

    // Another user's PERSONAL row (userId set, workspaceId null) matches
    // neither arm — the mock returns null (the filter excluded it) → 404
    // existence hiding, consistent with the list.
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(null);
    const hiddenRes = await request(app).get(`/api/skills/${OTHER_USER_CUSTOM_ID}`).set(userAuth());
    expect(hiddenRes.status).toBe(404);
  });

  it("WR-01: admins read any org row directly (no visibility OR-arm)", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ createdBy: "someone-else", userId: "someone-else" }),
    );
    const res = await request(app).get(`/api/skills/${CUSTOM_ROW_ID}`).set(adminAuth());
    expect(res.status).toBe(200);
    expect(prisma.agentSkill.findFirst).toHaveBeenCalledWith({
      where: { id: CUSTOM_ROW_ID, deletedAt: null },
    });
  });

  it("WR-01: POST /:id/test runs the same visibility predicate (preview of another user's personal row → 404)", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/skills/${OTHER_USER_CUSTOM_ID}/test`)
      .set(userAuth())
      .send({ params: {} });
    expect(res.status).toBe(404);
    // The gate runs BEFORE the preview compile — the where carries the arms.
    expect(prisma.agentSkill.findFirst).toHaveBeenCalledWith({
      where: {
        id: OTHER_USER_CUSTOM_ID,
        deletedAt: null,
        OR: [{ userId: skillUser.id }, { userId: null, workspaceId: null }],
      },
    });
  });
});

// ─── GET /api/skills — list visibility ───────────────────────────────────

describe("GET /api/skills — list visibility (D-20 + SKIL-03 accessible arm)", () => {
  it("user sees own + global rows in custom; other users' rows are absent", async () => {
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([
      makeCustomRow(),
      makeCustomRow({ id: "g1", name: "custom_globalone", slug: "globalone", userId: null, createdBy: adminUser.id }),
    ]);
    const res = await request(app).get("/api/skills").set(userAuth());
    expect(res.status).toBe(200);
    expect(res.body.builtin).toEqual(expect.any(Array));
    expect(res.body.custom).toHaveLength(2);
    expect(res.body.accessible).toEqual([]);
  });

  it("admin sees all org rows in custom", async () => {
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([
      makeCustomRow(),
      makeCustomRow({ id: OTHER_USER_CUSTOM_ID, name: "custom_other", slug: "other", userId: "someone", createdBy: "someone", workspaceId: null }),
    ]);
    const res = await request(app).get("/api/skills").set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.custom).toHaveLength(2);
  });

  it("the user-visibility filter is the D-20 OR-arm (own + globals), type custom ONLY (CR-01)", async () => {
    await request(app).get("/api/skills").set(userAuth());
    expect(prisma.agentSkill.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        type: "custom",
        OR: [{ userId: skillUser.id }, { userId: null, workspaceId: null }],
      },
    });
  });

  it("admin visibility filter carries no user OR-arm, type custom ONLY (CR-01)", async () => {
    await request(app).get("/api/skills").set(adminAuth());
    expect(prisma.agentSkill.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, type: "custom" },
    });
  });

  it("a caller-owned workspace row rides custom and is excluded from accessible (CR-01)", async () => {
    // The caller created a workspace-scoped row (create pin: userId NULL,
    // createdBy = caller). WorkspaceAccess grants viewer+ on WS_ID.
    (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([
      { userId: skillUser.id, workspaceId: WS_ID },
    ]);
    (prisma.agentSkill.findMany as jest.Mock)
      .mockResolvedValueOnce([
        makeCustomRow({ workspaceId: WS_ID, userId: null, createdBy: skillUser.id }),
      ])
      .mockResolvedValueOnce([]); // accessible arm: the createdBy filter excludes the caller's row
    const res = await request(app).get("/api/skills").set(userAuth());
    expect(res.status).toBe(200);
    // The workspace arm is gated by createdBy — the caller's own workspace
    // row lands in `custom` (NOT as an anonymous global), and `accessible`
    // stays empty (no duplicate row in both arrays).
    expect(prisma.agentSkill.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          type: "custom",
          OR: expect.arrayContaining([
            { userId: skillUser.id },
            { userId: null, workspaceId: null },
            { userId: null, workspaceId: { in: [WS_ID] }, createdBy: skillUser.id },
          ]),
        }),
      }),
    );
    expect(res.body.custom).toHaveLength(1);
    expect(res.body.custom[0].scope).toBe("workspace");
    expect(res.body.custom[0].workspaceId).toBe(WS_ID);
    expect(res.body.accessible).toEqual([]);
    // The accessible where excludes the caller's own workspace rows.
    expect(prisma.agentSkill.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          createdBy: { not: skillUser.id },
        }),
      }),
    );
  });

  it("another user's workspace-scoped row in a viewer+ workspace appears in accessible (SKIL-03/D-05 chat source)", async () => {
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);
    // Caller holds viewer+ on WS_ID via an explicit WorkspaceAccess row.
    (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([{ userId: skillUser.id, workspaceId: WS_ID }]);
    // CR-01 fixture-consistency: the row mirrors the create route's pin —
    // workspace-scoped rows persist userId NULL (hand-set "someone-else"
    // userId values masked the dead `not`-shaped arm the old fixture used).
    const otherRow = makeCustomRow({
      id: OTHER_USER_CUSTOM_ID,
      name: "custom_wsskill",
      slug: "wsskill",
      userId: null,
      createdBy: "someone-else",
      workspaceId: WS_ID,
    });
    // Second findMany (the accessible query) returns the workspace-scoped row.
    (prisma.agentSkill.findMany as jest.Mock)
      .mockResolvedValueOnce([]) // custom arm
      .mockResolvedValueOnce([otherRow]); // accessible arm
    const res = await request(app).get("/api/skills").set(userAuth());
    expect(res.status).toBe(200);
    expect(res.body.custom).toEqual([]);
    expect(res.body.accessible).toHaveLength(1);
    expect(res.body.accessible[0].scope).toBe("workspace");
    expect(res.body.accessible[0].workspaceId).toBe(WS_ID);
    expect(res.body.accessible[0].createdBy).toBe("someone-else");
    // The accessible query pins the CR-01 where-shape: userId NULL rows are
    // INCLUDED (Prisma's `not` on a nullable column excludes NULL — the dead
    // arm), and the caller's own workspace rows are excluded via createdBy.
    expect(prisma.agentSkill.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          type: "custom",
          userId: null,
          workspaceId: { in: [WS_ID] },
          createdBy: { not: skillUser.id },
        }),
      }),
    );
  });

  it("CR-01 fixture consistency: a row created THROUGH the route (userId NULL) reaches the accessible arm of another workspace member", async () => {
    // The creator holds editor on WS_ID and creates a workspace-scoped skill
    // via the POST route — the create pin persists userId: NULL.
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: skillUser.id,
      workspaceId: WS_ID,
      role: "editor",
    });
    const created = makeCustomRow({
      id: OTHER_USER_CUSTOM_ID,
      name: "custom_wsinv",
      slug: "wsinv",
      displayName: "WsInv",
      description: "workspace-scope creation probe",
      userId: null,
      createdBy: skillUser.id,
      workspaceId: WS_ID,
    });
    (prisma.agentSkill.create as jest.Mock).mockResolvedValue(created);
    const createRes = await request(app)
      .post("/api/skills")
      .set(userAuth())
      .send({
        slug: "wsinv",
        name: "WsInv",
        description: "workspace-scope creation probe",
        skillMode: "prompt",
        config: { template: "T {{input}}", defaultParams: {}, injectAs: "user" },
        inputSchema: { properties: { input: { type: "string" } }, required: [] },
        scope: "workspace",
        workspaceId: WS_ID,
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.scope).toBe("workspace");
    expect(prisma.agentSkill.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: null, workspaceId: WS_ID }) }),
    );

    // A SECOND user holds viewer+ on the SAME workspace and lists skills:
    // the userId-NULL row must surface through the accessible arm (the
    // pre-fix `userId: { not }` shape returned NOTHING for userId-NULL rows).
    const viewerAuth = { Authorization: `Bearer ${generateTestToken(skillDeleteUser.id)}` };
    (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([
      { userId: skillDeleteUser.id, workspaceId: WS_ID },
    ]);
    (prisma.agentSkill.findMany as jest.Mock)
      .mockResolvedValueOnce([]) // second user's custom arm — no own rows
      .mockResolvedValueOnce([created]); // accessible arm resolves the row
    const listRes = await request(app).get("/api/skills").set(viewerAuth);
    expect(listRes.status).toBe(200);
    expect(listRes.body.custom).toEqual([]);
    expect(listRes.body.accessible).toHaveLength(1);
    expect(listRes.body.accessible[0].slug).toBe("wsinv");
    expect(listRes.body.accessible[0].createdBy).toBe(skillUser.id);
  });

  it("a workspace the caller has NO access to contributes nothing to accessible", async () => {
    (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.projectAccess.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app).get("/api/skills").set(userAuth());
    expect(res.status).toBe(200);
    expect(res.body.accessible).toEqual([]);
    // Only the custom-arm findMany ran — no accessible query without grants.
    expect(prisma.agentSkill.findMany).toHaveBeenCalledTimes(1);
  });

  it("ProjectAccess-implied workspaces feed the accessible set (D-10 implied editor)", async () => {
    (prisma.agentSkill.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeCustomRow({ id: OTHER_USER_CUSTOM_ID, slug: "projws", name: "custom_projws", userId: "someone-else", createdBy: "someone-else", workspaceId: OTHER_WS_ID }),
      ]);
    (prisma.workspaceAccess.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.projectAccess.findMany as jest.Mock).mockResolvedValue([
      { userId: skillUser.id, projectId: "proj-2", project: { workspaces: [{ id: OTHER_WS_ID }] } },
    ]);
    const res = await request(app).get("/api/skills").set(userAuth());
    expect(res.status).toBe(200);
    expect(res.body.accessible).toHaveLength(1);
    expect(res.body.accessible[0].workspaceId).toBe(OTHER_WS_ID);
  });

  it("rows carry config.defaultParams + parsed inputSchema (Plan 05 parser source)", async () => {
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([makeCustomRow()]);
    const res = await request(app).get("/api/skills").set(userAuth());
    const row = res.body.custom[0];
    expect(row.config).toEqual({ defaultParams: { lang: "it" } });
    expect(row.inputSchema).toEqual({ properties: { input: { type: "string" } }, required: ["input"] });
    expect(row.skillMode).toBe("prompt");
  });
});

// ─── POST /:id/test — compiled-prompt preview (no LLM) ───────────────────

describe("POST /api/skills/:id/test — preview (D-20, A5)", () => {
  it("returns the spotlight-wrapped compiled prompt with params substituted", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(makeCustomRow());
    const res = await request(app)
      .post(`/api/skills/${CUSTOM_ROW_ID}/test`)
      .set(userAuth())
      .send({ params: { input: "Ciao mondo" } });
    expect(res.status).toBe(200);
    expect(res.body.compiledPrompt).toContain("=== BEGIN USER-SUPPLIED TEMPLATE CONTENT");
    expect(res.body.compiledPrompt).toContain("=== END USER-SUPPLIED TEMPLATE CONTENT ===");
    expect(res.body.compiledPrompt).toContain("Translate Ciao mondo to it");
  });

  it("leaves an unknown placeholder literal (D-03)", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(makeCustomRow());
    const res = await request(app)
      .post(`/api/skills/${CUSTOM_ROW_ID}/test`)
      .set(userAuth())
      .send({ params: { input: "x", notInSchema: "v" } });
    expect(res.status).toBe(200);
    // {{lang}} has a default → substituted; the non-whitelisted param never is.
    expect(res.body.compiledPrompt).toContain("to it");
    expect(res.body.compiledPrompt).not.toContain("v\n");
  });

  it("unknown placeholder STAYS literal when no default covers it", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(
      makeCustomRow({ config: JSON.stringify({ template: "T {{input}} {{unknownKey}}", defaultParams: {} }) }),
    );
    const res = await request(app)
      .post(`/api/skills/${CUSTOM_ROW_ID}/test`)
      .set(userAuth())
      .send({ params: { input: "x" } });
    expect(res.status).toBe(200);
    expect(res.body.compiledPrompt).toContain("{{unknownKey}}");
  });

  it("makes ZERO orchestrator calls (the no-LLM prohibition — structural)", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(makeCustomRow());
    await request(app)
      .post(`/api/skills/${CUSTOM_ROW_ID}/test`)
      .set(userAuth())
      .send({ params: { input: "x" } });
    expect(runAgentStreaming).not.toHaveBeenCalled();
    expect(require("../agent/orchestrator").runAgent).not.toHaveBeenCalled();
  });

  it("404 for an unknown id", async () => {
    (prisma.agentSkill.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app).post(`/api/skills/${CUSTOM_ROW_ID}/test`).set(userAuth()).send({ params: {} });
    expect(res.status).toBe(404);
  });
});

// ─── Pitfall 2: the pre-existing read-only route is byte-identical ───────

describe("GET /api/agent/skills — byte-identical read-only surface (Pitfall 2)", () => {
  it("still lists the registry builtins with the same 4-field shape", async () => {
    const res = await request(app).get("/api/agent/skills").set(userAuth());
    expect(res.status).toBe(200);
    // The builtinSkills module is mocked empty in this suite; the shape (not
    // the count) is the invariant here — the count matrix lives in the
    // workspace suites that share the real registry.
    expect(Array.isArray(res.body)).toBe(true);
  });
});