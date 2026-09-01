// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Schema Templates integration tests — supertest against Express app.
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
            { permissionName: "admin:settings" },
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

const TEMPLATE_ID = "550e8400-e29b-41d4-a716-446655440200";
const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/archive-schema-templates", () => {
  it("should return list of templates including built-ins", async () => {
    const templates = [
      { id: TEMPLATE_ID, name: "Research", isBuiltIn: true, config: {} },
      { id: "550e8400-e29b-41d4-a716-446655440201", name: "Custom", isBuiltIn: false, archiveId: ARCHIVE_ID, config: {} },
    ];
    (prisma.archiveSchemaTemplate.findMany as jest.Mock).mockResolvedValue(templates);

    const res = await request(app)
      .get("/api/archive-schema-templates")
      .set(adminAuth())
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });
});

describe("GET /api/archive-schema-templates/:id", () => {
  it("should return a single template", async () => {
    const template = { id: TEMPLATE_ID, name: "Research", isBuiltIn: true, config: {} };
    (prisma.archiveSchemaTemplate.findUnique as jest.Mock).mockResolvedValue(template);

    const res = await request(app)
      .get(`/api/archive-schema-templates/${TEMPLATE_ID}`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.id).toBe(TEMPLATE_ID);
  });

  it("should return 404 for unknown template", async () => {
    (prisma.archiveSchemaTemplate.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/archive-schema-templates/${TEMPLATE_ID}`)
      .set(adminAuth())
      .expect(404);

    expect(res.body.error).toBe("Template not found");
  });
});

describe("POST /api/archive-schema-templates", () => {
  it("should create a template (admin auth)", async () => {
    const template = { id: TEMPLATE_ID, name: "Project", config: { agentPersona: "balanced" } };
    (prisma.archiveSchemaTemplate.create as jest.Mock).mockResolvedValue(template);

    const res = await request(app)
      .post("/api/archive-schema-templates")
      .set(adminAuth())
      .send({ name: "Project", config: { agentPersona: "balanced" } })
      .expect(201);

    expect(res.body.name).toBe("Project");
    expect(prisma.archiveSchemaTemplate.create).toHaveBeenCalled();
  });
});

describe("POST /api/archive-schema-templates/:id/apply", () => {
  it("should apply template to archive", async () => {
    const template = { id: TEMPLATE_ID, name: "Research", config: { agentPersona: "conservative" } };
    (prisma.archiveSchemaTemplate.findUnique as jest.Mock).mockResolvedValue(template);
    (prisma.archiveConfig.upsert as jest.Mock).mockResolvedValue({ id: "cfg-001", archiveId: ARCHIVE_ID });

    const res = await request(app)
      .post(`/api/archive-schema-templates/${TEMPLATE_ID}/apply`)
      .set(adminAuth())
      .send({ archiveId: ARCHIVE_ID })
      .expect(200);

    expect(res.body.message).toBe("Template applied successfully");
    expect(prisma.archiveConfig.upsert).toHaveBeenCalled();
  });

  it("should return 400 without archiveId", async () => {
    const res = await request(app)
      .post(`/api/archive-schema-templates/${TEMPLATE_ID}/apply`)
      .set(adminAuth())
      .send({})
      .expect(400);

    expect(res.body.error).toBe("archiveId is required");
  });
});
