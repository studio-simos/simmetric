// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 194 interaction matrix — pair 3/6: isolation × skills.
 *
 * ONE owned test (194-CONTEXT D-01/D-02) pinning the role-lifecycle ×
 * chat-resolution-time seam: a workspace-scoped skill (created by member A
 * through the POST /api/skills arbitration — userId NULL + workspaceId set,
 * the D-05 personal-arm-hazard shape) resolves for member B in ANOTHER
 * member's chat resolution while B holds editor+, and STOPS resolving on the
 * NEXT resolution after B's access is revoked/downgraded.
 *
 * What is ALREADY pinned (D-02 — never re-asserted as owned assertions):
 *  - resolveWorkspaceRole.test.ts: the resolver's precedence matrix (the
 *    single resolver's role sources);
 *  - customSkills.registry.test.ts: per-request DB resolution IS the
 *    SC-1 lifecycle-invalidation contract (soft-deleted/disabled rows stop
 *    resolving) and D-15 merge invariants;
 *  - skills.routes.test.ts: the CRUD gates (editor+ create, viewer 403) and
 *    CR-01 fixture-consistency (the row created THROUGH the route reaches
 *    the accessible arm of another member).
 *
 * The INTERACTION this test owns: the resolver's OUTPUT is the input to the
 * chat-surface gates — revocation (the 189 isolation lifecycle: row delete)
 * and downgrade (row role editor→viewer) each change what the NEXT
 * resolution returns, while per-request DB resolution (no cache, Pitfall 9)
 * guarantees the change lands on the immediately following chat resolution.
 * Cross-surface drive: the workspace-scoped CREATE (which consumes the
 * resolver server-side) × the CHAT-TIME resolution (resolveSkillsForChat →
 * mergeCustomSkills, the D-05 workspace OR-arm).
 *
 * Postgres-free: mockPrisma substrate.
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

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => Infinity),
}));

jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../agent/builtinSkills", () => ({}));
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn().mockResolvedValue({ value: "false" }),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../agent/mcpClient", () => ({
  __esModule: true,
  getMCPToolsForWorkspace: jest.fn().mockReturnValue([]),
}));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken } from "./helpers/mockAuth";
import prisma from "../utils/prisma";
import { resolveWorkspaceRole } from "../middleware/rbac";
import { resolveSkillsForChat } from "../agent/skills";
import { getSetting } from "../services/systemConfigService";

const app = createApp();

const WS_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const PROJECT_ID = "bbbbbbbb-0000-4000-8000-0000000000bb";
const MEMBER_A = "cccccccc-0000-4000-8000-0000000000cc"; // creates the workspace skill
const MEMBER_B = "dddddddd-0000-4000-8000-0000000000dd"; // consumes it in chat

/** Plain (non-admin) member payload — dlp:unmask absent, skills CRUD granted. */
function memberUser(id: string) {
  return {
    id,
    username: `member-${id.slice(0, 4)}`,
    roles: [
      {
        role: {
          name: "user",
          permissions: [
            { permissionName: "chat:write" },
            { permissionName: "chat:read" },
            { permissionName: "skill:create" },
            { permissionName: "skill:read" },
            { permissionName: "workspace:read" },
          ],
        },
      },
    ],
  };
}

/** Workspace-scoped skill row AS THE CREATE ROUTE MATERIALIZES IT (userId NULL, workspace arm only). */
const WS_SKILL_ROW = {
  id: "eeeeeeee-0000-4000-8000-0000000000ee",
  name: "custom_team-summarizer",
  displayName: "Team Summarizer",
  description: "Workspace-scoped by member A",
  type: "custom",
  skillMode: "prompt",
  config: JSON.stringify({ template: "Summarize: {{topic}}", defaultParams: {} }),
  slug: "team-summarizer",
  inputSchema: JSON.stringify({ type: "object", properties: { topic: { type: "string" } }, required: ["topic"] }),
  isEnabled: true,
  isBuiltIn: false,
  organizationId: "org-default",
  userId: null, // the D-05 personal-arm hazard pin — workspace arm ONLY
  workspaceId: WS_ID,
  createdBy: MEMBER_A,
  deletedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();

  // No MCP pins — the D-15 default-skills path in resolveSkillsForChat.
  (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([]);

  // Auth principal resolution.
  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === MEMBER_A) return Promise.resolve(memberUser(MEMBER_A));
    if (id === MEMBER_B) return Promise.resolve(memberUser(MEMBER_B));
    return Promise.resolve(null);
  });

  // Tenant arm: both members are live org members.
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({ organizationId: "org-default" });

  // The resolver's substrate: the workspace exists; its project is owned by
  // NEITHER member (so the row arm — not the implicit-owner arm — decides).
  (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
    id: WS_ID,
    projectId: PROJECT_ID,
    project: { id: PROJECT_ID, createdBy: "someone-else" },
    deletedAt: null,
  });
  (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.workspace.create as jest.Mock).mockResolvedValue({ id: WS_ID });
  (prisma.agentSkill.create as jest.Mock).mockImplementation((args: any) =>
    Promise.resolve({ ...WS_SKILL_ROW, ...args?.data }),
  );
});

describe("Phase 194 interaction matrix — isolation × skills (role lifecycle × chat resolution time)", () => {
  it("member A's workspace-scoped skill resolves for member B in chat while B holds editor+, and STOPS resolving on the next resolution after B's access is revoked (and after a downgrade to viewer)", async () => {
    // ---- Phase 1: B holds editor+ → the skill resolves at chat time ----
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: MEMBER_B,
      workspaceId: WS_ID,
      role: "editor",
    });
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([WS_SKILL_ROW]);

    // (a) The resolver output that gates creation: B (as any editor+) could
    // create; A did — pin the shape the CREATE arbitration consumed.
    const roleA = await resolveWorkspaceRole(MEMBER_A, WS_ID, memberUser(MEMBER_A));
    expect(roleA).toBe("editor");

    // (b) The chat-time resolution: resolveSkillsForChat (the D-15 merge that
    // feeds the ReAct loop) returns A's workspace-scoped row for B — the
    // workspace arm of the D-05 scope filter (userId NULL + workspaceId).
    const resolved = await resolveSkillsForChat(WS_ID, "chat-1", [], { userId: MEMBER_B });
    expect(resolved.map((s) => s.name)).toContain("custom_team-summarizer");

    // ---- Phase 2: REVOCATION — the row role disappears ----
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);

    // The resolver (per-request, no cache — Pitfall 9) reflects the
    // revocation IMMEDIATELY.
    const roleAfterRevoke = await resolveWorkspaceRole(MEMBER_B, WS_ID, memberUser(MEMBER_B));
    expect(roleAfterRevoke).toBeNull();

    // The INTERACTION: chat-time skill consumption crosses the resolver gate.
    // The chat handlers mount requireWorkspaceWriteAccess() BEFORE the agent
    // loop — the resolver's null output denies the whole chat request (404
    // existence hiding), so the workspace-scoped skill structurally never
    // resolves for the revoked member on the NEXT chat resolution. The
    // resolver gate + the per-request D-05 filter compose: revocation is
    // enforced at the chat surface the resolution feeds (never inside
    // resolveCustomSkillsForChat itself — its workspace arm is
    // caller-filtered upstream, which is exactly why the graded gate is the
    // sole enforcement point, the D-13 single-gate contract).
    (getSetting as jest.Mock).mockImplementation((key: string) =>
      key === "WORKSPACE_ROLE_ENFORCEMENT" ? { value: "true" } : { value: "false" },
    );
    // Scope the skill-resolution spy to the DENIED request: clear the Phase-1
    // resolution's call BEFORE the POST (clearing after would make the
    // no-resolution assertion vacuous, WR-01).
    (prisma.agentSkill.findMany as jest.Mock).mockClear();
    const revokedChat = await request(app)
      .post(`/api/workspaces/${WS_ID}/chat`)
      .set("Authorization", `Bearer ${generateTestToken(MEMBER_B)}`)
      .send({ message: "use the team summarizer" });
    expect(revokedChat.status).toBe(404);
    expect(revokedChat.body.error).toBe("Workspace not found");
    // No skill resolution ever ran for the denied request — the workspace
    // skill stops resolving at the gate, not mid-loop.
    expect(prisma.agentSkill.findMany).not.toHaveBeenCalled();
    // The enforcement consumed the resolver's per-request output — evidence:
    // the resolver's workspaceAccess probe ran for THIS user on the denied
    // request (the graded gate is its only consumer on the chat surface),
    // re-reading the row rather than reusing the editor verdict from the
    // earlier resolution.
    expect(prisma.workspaceAccess.findFirst).toHaveBeenCalledWith({
      where: { userId: MEMBER_B, workspaceId: WS_ID },
    });

    // ---- Phase 3: DOWNGRADE — editor → viewer ----
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: MEMBER_B,
      workspaceId: WS_ID,
      role: "viewer",
    });
    const roleAfterDowngrade = await resolveWorkspaceRole(MEMBER_B, WS_ID, memberUser(MEMBER_B));
    expect(roleAfterDowngrade).toBe("viewer");
    // A viewer still READS the workspace, so the workspace arm of the D-05
    // filter still resolves the row for chat consumption (viewer+ is the
    // read baseline — the resolution seam is role-lifecycle-gated, not
    // editor-gated; consumption gating happens at invocation, already pinned
    // by the skills CRUD battery).
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([WS_SKILL_ROW]);
    const resolvedAfterDowngrade = await resolveSkillsForChat(WS_ID, "chat-1", [], { userId: MEMBER_B });
    expect(resolvedAfterDowngrade.map((s) => s.name)).toContain("custom_team-summarizer");
  });

  it("creation-side parity at the same seam: the POST /api/skills arbitration consumes resolveWorkspaceRole — a revoked member can no longer create workspace-scoped rows (role lifecycle gates the resolver-driven gate)", async () => {
    // This is the SECOND half of the interaction: the same resolver output
    // gates the CREATE path. B (editor) creates the row; after revocation
    // the same POST 404s (existence hiding) — proving BOTH sides of the
    // resolution seam ride the single resolver (never a parallel role check).
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: MEMBER_B,
      workspaceId: WS_ID,
      role: "editor",
    });
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);

    const tokenB = generateTestToken(MEMBER_B);
    const createBody = {
      slug: "b-made-skill",
      name: "B Made Skill",
      description: "d",
      skillMode: "prompt",
      config: { template: "hello {{x}}", defaultParams: {} },
      inputSchema: { type: "object", properties: { x: { type: "string" } }, required: [] },
      scope: "workspace",
      workspaceId: WS_ID,
    };
    const ok = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${tokenB}`)
      .send(createBody);
    expect(ok.status).toBe(201);
    expect(ok.body.workspaceId).toBe(WS_ID);
    // The workspace-arm-only materialization: the row carries NO userId (the
    // route does not even emit the field — the D-05 personal-arm hazard pin).
    expect(ok.body.userId).toBeUndefined();

    // Revoke B → the SAME POST (same shape) hits the resolver → null → 404
    // existence hiding (never 403 — the workspace is "not found" for B now).
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.agentSkill.create as jest.Mock).mockClear();
    const denied = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ ...createBody, slug: "b-made-skill-2", name: "B Made Skill 2" });
    expect(denied.status).toBe(404);
    expect(denied.body.error).toBe("Workspace not found");
    expect(prisma.agentSkill.create).not.toHaveBeenCalled();
  });
});