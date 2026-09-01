// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive export route integration tests — supertest against Express app.
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
  initLicense: jest.fn(() => ({
    tier: "community",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  getLicenseInfo: jest.fn(() => ({
    tier: "community",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({
  seedTemplates: jest.fn(),
}));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
}));
jest.mock("../services/ftsService", () => ({
  initPostgreSQLFTS: jest.fn(),
}));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

jest.mock("../services/archiveIndexService", () => ({
  rebuildAllIndexFiles: jest.fn().mockResolvedValue({ reindexed: 0, errors: [] }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../middleware/auth", () => {
  const { generateTestToken } = jest.requireActual("./helpers/mockAuth");
  const {
    adminUser,
    regularUser,
    noPermUser,
  } = jest.requireActual("./helpers/mockAuth");

  const adminToken = generateTestToken("admin-001");
  const regularToken = generateTestToken("user-001");
  const noPermToken = generateTestToken("user-002");

  return {
    authMiddleware: (req: any, res: any, next: any) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const token = authHeader.replace("Bearer ", "");

      if (token === regularToken) {
        req.userId = "user-001";
        req.user = regularUser;
      } else if (token === noPermToken) {
        req.userId = "user-002";
        req.user = noPermUser;
      } else {
        req.userId = "admin-001";
        req.user = adminUser;
      }
      next();
    },
    apiKeyMiddleware: (req: any, res: any, next: any) => next(),
  };
});

jest.mock("../services/archiveExportService", () => ({
  exportArchiveAsZip: jest.fn().mockImplementation((_archiveId: string, res: any) => {
    res.setHeader("Content-Type", "application/zip");
    res.end("zip-content");
    return Promise.resolve();
  }),
  exportArchiveAsPdf: jest.fn().mockImplementation((_archiveId: string, res: any) => {
    res.setHeader("Content-Type", "application/pdf");
    res.end("pdf-content");
    return Promise.resolve();
  }),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import {
  exportArchiveAsZip,
  exportArchiveAsPdf,
} from "../services/archiveExportService";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

const adminToken = generateTestToken("admin-001");
const regularToken = generateTestToken("user-001");
const noPermToken = generateTestToken("user-002");

function adminAuth() {
  return { Authorization: `Bearer ${adminToken}` };
}

function regularAuth() {
  return { Authorization: `Bearer ${regularToken}` };
}

function noPermAuth() {
  return { Authorization: `Bearer ${noPermToken}` };
}

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const ARCHIVE_SLUG = "acme-corp";
const now = new Date("2025-06-01T00:00:00.000Z");

const mockArchive = {
  id: ARCHIVE_ID,
  slug: ARCHIVE_SLUG,
  name: "ACME Corp Wiki",
  description: "Knowledge base for ACME Corporation",
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/archives/:archiveId/export", () => {
  it("should return 401 without auth", async () => {
    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export?format=zip`)
      .expect(401);
  });

  it("should return 403 without archive:read permission", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);

    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export?format=zip`)
      .set(noPermAuth())
      .expect(403);
  });

  it("should return 400 for invalid format", async () => {
    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export?format=invalid`)
      .set(adminAuth())
      .expect(400);

    expect(res.body.error).toContain("Invalid format");
  });

  it("should return 400 for missing format", async () => {
    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export`)
      .set(adminAuth())
      .expect(400);

    expect(res.body.error).toContain("Invalid format");
  });

  it("should return 404 for non-existent archive", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);

    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export?format=zip`)
      .set(adminAuth())
      .expect(404);
  });

  it("should return 403 for non-owner non-admin", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue({
      ...mockArchive,
      createdBy: "other-user",
    });

    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export?format=zip`)
      .set(regularAuth())
      .expect(403);
  });

  it("should allow admin to export any archive", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue({
      ...mockArchive,
      createdBy: "other-user",
    });

    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export?format=zip`)
      .set(adminAuth())
      .expect(200);

    expect(exportArchiveAsZip).toHaveBeenCalledWith(ARCHIVE_ID, expect.anything());
  });

  it("should return 200 with zip format and call exportArchiveAsZip", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);

    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export?format=zip`)
      .set(adminAuth())
      .expect(200);

    expect(exportArchiveAsZip).toHaveBeenCalledWith(ARCHIVE_ID, expect.anything());
    expect(exportArchiveAsPdf).not.toHaveBeenCalled();
  });

  it("should return 200 with pdf format and call exportArchiveAsPdf", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);

    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/export?format=pdf`)
      .set(adminAuth())
      .expect(200);

    expect(exportArchiveAsPdf).toHaveBeenCalledWith(ARCHIVE_ID, expect.anything());
    expect(exportArchiveAsZip).not.toHaveBeenCalled();
  });
});
