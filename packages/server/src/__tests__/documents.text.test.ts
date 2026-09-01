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
  regularUserWithWorkspaceAccess,
  regularUserWithoutWorkspaceAccess,
} from "./helpers/mockAuth";
import prisma from "../utils/prisma";

const app = createApp();

const DOC_ID = "doc-text-001";
const WS_ID = "ws-1";
const PROJECT_ID = "proj-1";

/** Document fixture with out-of-order chunks — verifies chunkIndex ordering. */
const documentWithChunks = {
  id: DOC_ID,
  workspaceId: WS_ID,
  name: "report.md",
  type: "md",
  status: "completed",
  workspace: {
    id: WS_ID,
    projectId: PROJECT_ID,
    project: { id: PROJECT_ID, createdBy: "other-user" },
  },
  chunks: [
    { id: `${DOC_ID}-2`, chunkText: "second chunk", metadata: "{}" },
    { id: `${DOC_ID}-0`, chunkText: "first chunk", metadata: "{}" },
    { id: `${DOC_ID}-1`, chunkText: "middle chunk", metadata: "{}" },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();

  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === regularUser.id) return Promise.resolve(regularUser);
    if (id === regularUserWithWorkspaceAccess.id) return Promise.resolve(regularUserWithWorkspaceAccess);
    if (id === regularUserWithoutWorkspaceAccess.id) return Promise.resolve(regularUserWithoutWorkspaceAccess);
    return Promise.resolve(null);
  });

  (prisma.document.findFirst as jest.Mock).mockResolvedValue(documentWithChunks);

  (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
    const userId = args?.where?.userId;
    const workspaceId = args?.where?.workspaceId;
    if (workspaceId !== WS_ID) return Promise.resolve(null);
    const accessMap: Record<string, boolean> = {
      [regularUserWithWorkspaceAccess.id]: true,
    };
    return Promise.resolve(accessMap[userId] ? { userId, workspaceId } : null);
  });

  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
});

describe("GET /api/documents/:documentId/text — document text endpoint (DOC-01)", () => {
  it("returns 200 with chunks ordered by chunkIndex and no filePath", async () => {
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.text).toBe("first chunk\n\nmiddle chunk\n\nsecond chunk");
    expect(res.body.length).toBe(res.body.text.length);
    expect(res.body.name).toBe("report.md");
    expect(res.body.type).toBe("md");
    expect(res.body.status).toBe("completed");
    // T-78-02: filePath must never be exposed
    expect(res.body.filePath).toBeUndefined();
  });

  it("returns 404 for not-found or soft-deleted document", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/nonexistent/text`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Document not found");
  });

  it("returns 403 for user without workspace/project access (IDOR)", async () => {
    const token = generateTestToken(regularUserWithoutWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  it("returns 200 for project owner (createdBy === userId)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue({
      ...documentWithChunks,
      workspace: { ...documentWithChunks.workspace, project: { id: PROJECT_ID, createdBy: regularUser.id } },
    });
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.text).toBe("first chunk\n\nmiddle chunk\n\nsecond chunk");
  });
});