// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Index route integration tests.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

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
  generateIndexFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/wikiEmbeddingService", () => ({
  indexAllWikiPages: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    req.user = {
      id: "admin-001",
      roles: [{
        role: {
          name: "admin",
          permissions: [
            { permissionName: "archive:read" },
            { permissionName: "archive:write" },
            { permissionName: "archive:delete" },
          ],
        },
      }],
    };
    next();
  },
  apiKeyMiddleware: (req: any, res: any, next: any) => next(),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";
import { indexAllWikiPages } from "../services/wikiEmbeddingService";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

function userAuth(userId: string, roles: any[]) {
  return { Authorization: `Bearer ${generateTestToken(userId)}` };
}

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const now = new Date("2025-06-01T00:00:00.000Z");

const mockArchive = {
  id: ARCHIVE_ID,
  slug: "test-archive",
  name: "Test Archive",
  description: "A test archive",
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/archives/:archiveId/index", () => {
  it("should return 200 and start indexing for owner", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/index`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.message).toBe("Indexing started");
    expect(res.body.archiveId).toBe(ARCHIVE_ID);
    expect(indexAllWikiPages).toHaveBeenCalledWith(ARCHIVE_ID);
  });

  it("should return 403 for non-owner non-admin user", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue({
      ...mockArchive,
      createdBy: "other-user-001",
    });

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/index`)
      .set(adminAuth())
      .expect(403);

    expect(res.body.error).toBe("Insufficient permissions");
    expect(indexAllWikiPages).not.toHaveBeenCalled();
  });

  it("should return 404 for missing archive", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/index`)
      .set(adminAuth())
      .expect(404);

    expect(res.body.error).toBe("Archive not found");
    expect(indexAllWikiPages).not.toHaveBeenCalled();
  });

  it("should return 404 for soft-deleted archive (D-09: findFirst + deletedAt:null filter)", async () => {
    // Soft-deleted archive returns null from findFirst({ where: { id, deletedAt: null } })
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/index`)
      .set(adminAuth())
      .expect(404);

    expect(res.body.error).toBe("Archive not found");
    // Verify the findFirst was called with deletedAt:null filter (D-09 pattern)
    const callArgs = (prisma.archive.findFirst as jest.Mock).mock.calls[0][0];
    expect(callArgs.where).toMatchObject({ id: ARCHIVE_ID, deletedAt: null });
    expect(indexAllWikiPages).not.toHaveBeenCalled();
  });

  it("should return 401 without auth", async () => {
    await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/index`)
      .expect(401);
  });
});
