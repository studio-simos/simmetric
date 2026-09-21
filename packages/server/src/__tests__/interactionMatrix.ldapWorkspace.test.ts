// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 194 interaction matrix — pair 5/6: LDAP × workspace.
 *
 * ONE owned test (194-CONTEXT D-01) pinning the community-observable
 * JIT × isolation interaction: the enterprise login flow provisions the
 * JIT user's personal workspace through the pluginLoaderCore
 * `provisionPersonalWorkspace` delegate (the community seam — the
 * simmetric-enterprise repo is absent from this checkout; the delegate is
 * the ONLY community-observable surface the enterprise JIT arm drives),
 * and the 189 machinery ACCEPTS the result:
 *   (a) resolveWorkspaceRole on (freshUser, freshPersonalWorkspace)
 *       returns the creator role ("owner" — the implicit project.createdBy
 *       arm, D-08);
 *   (b) the workspace carries the personal/exempt flag shape the
 *       max_workspaces count filter excludes (project.isPersonal — the
 *       D-04 license exemption; the runtime invariant is pinned by
 *       license.test.ts, asserted here at the substrate level only);
 *   (c) a SECOND provisioning call for the same user hits the idempotent
 *       fast path (the same workspace returned, no second project create —
 *       the 193-02 JIT tolerance).
 *
 * No enterprise import, no LDAP wire: the test simulates the enterprise
 * JIT caller at the delegate boundary (mock the enterprise caller, drive
 * the REAL delegate + REAL createPersonalWorkspace against mockPrisma).
 *
 * What is ALREADY pinned (D-02 — never re-asserted as owned assertions):
 *  - personalWorkspace.test.ts: the creation shape (isPersonal + createdBy +
 *    org stamp + agentConfig parity + hasOnboarded flip + cache invalidation)
 *    and the idempotent/P2002 arms of the service;
 *  - resolveWorkspaceRole.test.ts: the resolver's precedence matrix;
 *  - authLdapComposite.test.ts: the composite login local-auth arm.
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
jest.mock("../services/authService", () => ({
  invalidateAuthCache: jest.fn().mockResolvedValue(undefined),
  verifyToken: (token: string) =>
    jest.requireActual("jsonwebtoken").verify(token, "test-jwt-secret-for-unit-tests-32ch"),
  getUserWithRoles: jest.fn(),
  getCachedUserWithRoles: jest.fn((userId: string) =>
    require("../utils/prisma").default.user.findUnique({ where: { id: userId } }),
  ),
}));

import { createApp } from "../index";
import prisma from "../utils/prisma";
import { buildPluginContext, type PluginRegistries } from "../services/pluginLoaderCore";
import { invalidateAuthCache } from "../services/authService";
import { resolveWorkspaceRole } from "../middleware/rbac";
import type { Express } from "express";

const ORG_ID = "org-ldap-1";
const JIT_USER = "jit-user-0001";
const WS_NAME = "Ldap Provisioned Workspace";

/** The fresh user + personal workspace the JIT arm would land on. */
const jitUserRow = {
  id: JIT_USER,
  username: "jdoe",
  email: "jdoe@example.com",
  roles: [
    {
      role: {
        name: "user",
        permissions: [{ permissionName: "chat:write" }, { permissionName: "workspace:read" }],
      },
    },
  ],
};

const PROJECT_ID = "proj-jit-0001";
const WS_ID = "ws-jit-0001";

beforeEach(() => {
  jest.clearAllMocks();

  (prisma.user.findUnique as jest.Mock).mockResolvedValue(jitUserRow);
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });

  // Service fast-path probe: NO personal workspace yet (first JIT login).
  (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(null);

  // Interactive $transaction — resolve with a live tx handle (personalWorkspace
  // fixture idiom: the real contract issues the four writes inside ONE tx).
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
    id: PROJECT_ID,
    name: "Personal",
    createdBy: JIT_USER,
    isPersonal: true,
    organizationId: ORG_ID,
  });
  (prisma.workspace.create as jest.Mock).mockResolvedValue({
    id: WS_ID,
    projectId: PROJECT_ID,
    name: WS_NAME,
    organizationId: ORG_ID,
  });
  (prisma.workspaceAgentConfig.upsert as jest.Mock).mockResolvedValue({});
  (prisma.user.update as jest.Mock).mockResolvedValue({});
});

describe("Phase 194 interaction matrix — LDAP × workspace (community JIT → personal-workspace contract)", () => {
  it("the pluginLoaderCore provisionPersonalWorkspace delegate provisions the JIT user's personal workspace, the 189 machinery resolves the creator role on it, the personal flag shape is license-exempt, and a second JIT call is idempotent", async () => {
    // ── (1) The community seam: the REAL delegate, driven exactly as the
    // enterprise JIT arm calls it (fresh user, wizard name, org). No
    // enterprise import — the delegate IS the boundary.
    const app = createApp();
    const registries: PluginRegistries = { schedulers: new Map(), shutdownCallbacks: [] };
    const ctx = buildPluginContext(app as unknown as Express, registries);
    const provisioned = (await ctx.provisionPersonalWorkspace(JIT_USER, WS_NAME, ORG_ID)) as {
      id: string;
      projectId: string;
    };

    expect(provisioned.id).toBe(WS_ID);
    expect(provisioned.projectId).toBe(PROJECT_ID);

    // The delegate forwarded verbatim to createPersonalWorkspace — the four
    // writes issued (creation shape pinned by personalWorkspace.test.ts;
    // asserted here only as the substrate the resolver consumes).
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: { name: "Personal", createdBy: JIT_USER, isPersonal: true, organizationId: ORG_ID },
    });
    expect(prisma.workspace.create).toHaveBeenCalledWith({
      data: { projectId: PROJECT_ID, name: WS_NAME, organizationId: ORG_ID },
    });

    // ── (2) The 189 machinery ACCEPTS the JIT output: resolveWorkspaceRole on
    // (freshUser, freshPersonalWorkspace) returns the creator role. The
    // resolver consumes the project.createdBy arm — the freshly created pair
    // satisfies it with ZERO extra grants (no WorkspaceAccess row, no
    // ProjectAccess row — the mock returns null for both).
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: WS_ID,
      projectId: PROJECT_ID,
      deletedAt: null,
      project: { id: PROJECT_ID, createdBy: JIT_USER },
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    const role = await resolveWorkspaceRole(JIT_USER, WS_ID, jitUserRow);
    expect(role).toBe("owner");

    // ── (3) The personal flag shape the max_workspaces count filter excludes
    // (the D-04 license exemption substrate — the runtime where-shape
    // invariant is pinned by license.test.ts; here the freshly provisioned
    // pair carries the exempting flags).
    const createdProject = (prisma.project.create as jest.Mock).mock.calls[0][0].data;
    expect(createdProject.isPersonal).toBe(true);
    expect(createdProject.createdBy).toBe(JIT_USER);

    // ── (4) Idempotent re-provisioning (193-02 JIT tolerance): a SECOND
    // JIT login for the same user hits the fast path — the same workspace,
    // NO second project create.
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: WS_ID,
      projectId: PROJECT_ID,
      name: WS_NAME,
      organizationId: ORG_ID,
      project: { id: PROJECT_ID, createdBy: JIT_USER, isPersonal: true },
    });
    (prisma.project.create as jest.Mock).mockClear();
    (prisma.workspace.create as jest.Mock).mockClear();
    const second = (await ctx.provisionPersonalWorkspace(JIT_USER, "A Different Name — ignored", ORG_ID)) as {
      id: string;
    };
    expect(second.id).toBe(WS_ID);
    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(prisma.workspace.create).not.toHaveBeenCalled();
    // Defensive cache invalidation on the repeat arm (Pitfall 4).
    expect(invalidateAuthCache).toHaveBeenCalledWith(JIT_USER);
  });

  it("the community composite login route stays a separate surface from the JIT provisioning (no LDAP wire in the delegate seam)", () => {
    // Source-level guard: the personal-workspace service never references
    // LDAP or SSO machinery — the JIT interaction flows through the loader
    // delegate ONLY (D-01: community seam, no enterprise dependency).
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../services/personalWorkspaceService.ts"),
      "utf8",
    );
    expect(src).not.toContain("ldap");
    expect(src).not.toContain("Ldap");
    expect(src).not.toContain("ssoConfig");
    // And the delegate forwards to the service (the one true seam).
    const loader = fs.readFileSync(
      path.resolve(__dirname, "../services/pluginLoaderCore.ts"),
      "utf8",
    );
    expect(loader).toContain("createPersonalWorkspace");
  });
});