// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

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
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

import request from "supertest";
import { createApp } from "../index";
import {
  generateTestToken,
  regularUser,
  adminUser,
  adminWithWorkspaceAccess,
  adminWithoutWorkspaceAccess,
  regularUserWithWorkspaceAccess,
  regularUserWithoutWorkspaceAccess,
} from "./helpers/mockAuth";
import prisma from "../utils/prisma";

const app = createApp();

const DOC_ID = "doc-001";
const WS_ID = "ws-1";
const PROJECT_ID = "proj-1";

/** Document fixture: belongs to ws-1, parent project createdBy "other-user". */
const documentFixture = {
  id: DOC_ID,
  workspaceId: WS_ID,
  name: "secret.pdf",
  type: "pdf",
  workspace: {
    id: WS_ID,
    projectId: PROJECT_ID,
    project: { id: PROJECT_ID, createdBy: "other-user" },
  },
  chunks: [],
};

beforeEach(() => {
  jest.clearAllMocks();

  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === regularUser.id) return Promise.resolve(regularUser);
    if (id === adminUser.id) return Promise.resolve(adminUser);
    if (id === adminWithWorkspaceAccess.id) return Promise.resolve(adminWithWorkspaceAccess);
    if (id === adminWithoutWorkspaceAccess.id) return Promise.resolve(adminWithoutWorkspaceAccess);
    if (id === regularUserWithWorkspaceAccess.id) return Promise.resolve(regularUserWithWorkspaceAccess);
    if (id === regularUserWithoutWorkspaceAccess.id) return Promise.resolve(regularUserWithoutWorkspaceAccess);
    return Promise.resolve(null);
  });

  (prisma.document.findFirst as jest.Mock).mockResolvedValue(documentFixture);

  // workspaceAccess.findFirst: returns a record only when userId has access to ws-1
  (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
    const userId = args?.where?.userId;
    const workspaceId = args?.where?.workspaceId;
    if (workspaceId !== WS_ID) return Promise.resolve(null);
    const accessMap: Record<string, boolean> = {
      [regularUserWithWorkspaceAccess.id]: true,
      [adminWithWorkspaceAccess.id]: true,
    };
    return Promise.resolve(accessMap[userId] ? { userId, workspaceId } : null);
  });

  (prisma.projectAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
    const userId = args?.where?.userId;
    // No test user has project access in this fixture (project owner is "other-user")
    return Promise.resolve(null);
  });
});

describe("GET /api/documents/:documentId — IDOR prevention (D-04)", () => {
  it("blocks non-access user (no workspaceAccess/projectAccess/project-owner) with 403", async () => {
    const token = generateTestToken(regularUserWithoutWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  it("allows access user (with workspaceAccess) with 200", async () => {
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(DOC_ID);
  });

  it("allows project owner (createdBy === userId) with 200", async () => {
    // Override document fixture: project createdBy === this user
    (prisma.document.findFirst as jest.Mock).mockResolvedValue({
      ...documentFixture,
      workspace: { ...documentFixture.workspace, project: { id: PROJECT_ID, createdBy: regularUser.id } },
    });
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("admin with workspace access returns 200 (D-04: admin requires access)", async () => {
    const token = generateTestToken(adminWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("admin without workspace access returns 403 (D-04: admin does not bypass)", async () => {
    const token = generateTestToken(adminWithoutWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });
});