// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Config integration tests — supertest against Express app.
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

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/archives/:archiveId/config", () => {
  it("should return 404 when no config exists", async () => {
    (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/config`)
      .set(adminAuth())
      .expect(404);

    expect(res.body.error).toBe("Archive config not found");
  });

  it("should return config JSON when it exists", async () => {
    const config = { agentPersona: "balanced", linkingDensity: { min: 0.01, max: 0.15 } };
    (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue({
      id: "cfg-001",
      archiveId: ARCHIVE_ID,
      config,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/config`)
      .set(adminAuth())
      .expect(200);

    expect(res.body).toEqual(config);
  });
});

describe("PUT /api/archives/:archiveId/config", () => {
  it("should create config and return 200", async () => {
    const config = { agentPersona: "conservative" };
    (prisma.archiveConfig.upsert as jest.Mock).mockResolvedValue({
      id: "cfg-002",
      archiveId: ARCHIVE_ID,
      config,
    });

    const res = await request(app)
      .put(`/api/archives/${ARCHIVE_ID}/config`)
      .set(adminAuth())
      .send(config)
      .expect(200);

    expect(res.body.message).toBe("Config updated successfully");
    expect(prisma.archiveConfig.upsert).toHaveBeenCalled();
  });

  it("should return 400 with invalid body", async () => {
    const res = await request(app)
      .put(`/api/archives/${ARCHIVE_ID}/config`)
      .set(adminAuth())
      .send({ linkingDensity: "not-an-object" })
      .expect(400);

    expect(res.body.error).toBe("Invalid config");
    expect(res.body.details).toBeDefined();
  });
});

describe("DELETE /api/archives/:archiveId/config", () => {
  it("should delete config and return 200", async () => {
    (prisma.archiveConfig.delete as jest.Mock).mockResolvedValue({ id: "cfg-001" });

    const res = await request(app)
      .delete(`/api/archives/${ARCHIVE_ID}/config`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.message).toBe("Config deleted successfully");
    expect(prisma.archiveConfig.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { archiveId: ARCHIVE_ID } })
    );
  });
});
