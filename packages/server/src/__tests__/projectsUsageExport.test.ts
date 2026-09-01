// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Task 1 (RED) — GET /api/projects/:projectId/usage + /export contract tests.
 *
 * Verifies:
 *  - 404 for missing/soft-deleted project on both endpoints.
 *  - 200 with 5 integer counts on /usage.
 *  - 200 with project + workspaces + chats + messages + documents + chunkCount
 *    + mcpConnections + exportedAt on /export, plus Content-Disposition attachment.
 *  - Audit logEvent called with "usage_check" / "export".
 */
import "./helpers/setupEnv";

// NOTE: mock objects live INSIDE the factory to avoid TDZ under @swc/jest.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    project: { findFirst: jest.fn() },
    workspace: { count: jest.fn(), findMany: jest.fn() },
    chat: { count: jest.fn() },
    document: { count: jest.fn() },
    mCPConnection: { count: jest.fn(), findMany: jest.fn() },
    projectAccess: { count: jest.fn() },
    documentChunk: { count: jest.fn(), groupBy: jest.fn() },
  },
  withSoftDelete: (w: Record<string, unknown>) => ({ deletedAt: null, ...w }),
}));
const mockProject = require("../utils/prisma").default.project;
const mockWorkspace = require("../utils/prisma").default.workspace;
const mockChat = require("../utils/prisma").default.chat;
const mockDocument = require("../utils/prisma").default.document;
const mockMCPConnection = require("../utils/prisma").default.mCPConnection;
const mockProjectAccess = require("../utils/prisma").default.projectAccess;
const mockDocumentChunk = require("../utils/prisma").default.documentChunk;

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/archiveIndexService", () => ({
  rebuildAllIndexFiles: jest.fn().mockResolvedValue({ reindexed: 0, errors: [] }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));
const logEventMock = require("../services/eventLogService").logEvent as jest.Mock;

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.userId = "admin-001";
    req.user = {
      id: "admin-001",
      roles: [{
        role: {
          name: "admin",
          permissions: [{ permissionName: "project:read" }, { permissionName: "project:write" }, { permissionName: "project:delete" }, { permissionName: "project:create" }],
        },
      }],
    };
    next();
  },
  apiKeyMiddleware: (req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireProjectAccess: (req: any, res: any, next: any) => {
    // IDOR-safe: in unit tests we trust the param and let the route handler
    // decide 404 via prisma.project.findFirst. This mirrors production behaviour
    // where the access check is DB-backed.
    next();
  },
  requireWorkspaceAccess: (req: any, res: any, next: any) => next(),
}));

jest.mock("../middleware/license", () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
  requireFeatureLimit: () => (_req: any, _res: any, next: any) => next(),
}));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/projects/:projectId/usage", () => {
  it("returns 404 when project is missing or soft-deleted", async () => {
    mockProject.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/projects/proj-missing/usage")
      .set(adminAuth());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
  });

  it("returns 200 with five non-negative integer counts + logs usage_check", async () => {
    mockProject.findFirst.mockResolvedValue({ id: "proj-1", name: "P", deletedAt: null });
    mockWorkspace.count.mockResolvedValue(2);
    mockChat.count.mockResolvedValue(5);
    mockDocument.count.mockResolvedValue(7);
    mockMCPConnection.count.mockResolvedValue(1);
    mockProjectAccess.count.mockResolvedValue(3);

    const res = await request(app)
      .get("/api/projects/proj-1/usage")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workspaces: 2,
      chats: 5,
      documents: 7,
      mcpConnections: 1,
      accessGrants: 3,
    });
    for (const v of Object.values(res.body)) {
      expect(typeof v).toBe("number");
      expect((v as number) >= 0).toBe(true);
    }
    expect(logEventMock).toHaveBeenCalledWith("project", "proj-1", "usage_check", "admin-001");
  });
});

describe("GET /api/projects/:projectId/export", () => {
  it("returns 404 when project is missing", async () => {
    mockProject.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/projects/proj-missing/export")
      .set(adminAuth());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
  });

  it("returns 200 with full project history + Content-Disposition attachment + logs export", async () => {
    mockProject.findFirst.mockResolvedValue({
      id: "proj-1",
      name: "Project One",
      description: "desc",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      deletedAt: null,
    });
    mockWorkspace.findMany.mockResolvedValue([
      {
        id: "ws-1",
        name: "Workspace 1",
        chats: [
          {
            id: "chat-1",
            title: "Chat 1",
            createdAt: new Date("2026-01-03"),
            messages: [
              { id: "m1", role: "user", content: "hi", createdAt: new Date("2026-01-03"), metadata: null },
            ],
          },
        ],
        documents: [
          { id: "doc-1", name: "Doc 1", status: "completed", createdAt: new Date("2026-01-04") },
        ],
      },
    ]);
    mockMCPConnection.findMany.mockResolvedValue([
      { id: "mcp-1", name: "MCP A", enabled: true },
    ]);
    mockDocumentChunk.groupBy.mockResolvedValue([
      { documentId: "doc-1", _count: { _all: 4 } },
    ]);

    const res = await request(app)
      .get("/api/projects/proj-1/export")
      .set(adminAuth());

    expect(res.status).toBe(200);
    const cd = res.headers["content-disposition"] as string | undefined;
    expect(cd).toMatch(/^attachment; filename=/);
    expect(cd).toContain("project-");
    expect(res.body.project).toMatchObject({ id: "proj-1", name: "Project One" });
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0].chats).toHaveLength(1);
    expect(res.body.workspaces[0].chats[0].messages).toHaveLength(1);
    expect(res.body.workspaces[0].documents[0]).toMatchObject({ id: "doc-1", chunkCount: 4 });
    expect(res.body.mcpConnections).toEqual([{ id: "mcp-1", name: "MCP A", enabled: true }]);
    expect(res.body.exportedAt).toBeDefined();
    expect(logEventMock).toHaveBeenCalledWith("project", "proj-1", "export", "admin-001");
  });
});