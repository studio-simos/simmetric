// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive graph route integration tests — supertest against Express app.
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
  rebuildAllIndexFiles: jest.fn().mockResolvedValue({ reindexed: 0, errors: [] }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
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

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const now = new Date("2025-06-01T00:00:00.000Z");

const mockPages = [
  {
    id: "660e8400-e29b-41d4-a716-446655440200",
    archiveId: ARCHIVE_ID,
    slug: "acme-corporation",
    title: "ACME Corporation",
    bodyText: "ACME Corporation is a leading enterprise software company.",
    bodyHtml: "<p>ACME Corporation is a leading enterprise software company.</p>",
    frontmatter: { title: "ACME Corporation", tags: ["enterprise", "saas"] },
    category: "entities",
    searchVector: null,
    createdBy: "admin-001",
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    wikilinks: ["acme-products"],
  },
  {
    id: "660e8400-e29b-41d4-a716-446655440201",
    archiveId: ARCHIVE_ID,
    slug: "acme-products",
    title: "ACME Products",
    bodyText: "List of ACME products.",
    bodyHtml: "<p>List of ACME products.</p>",
    frontmatter: { title: "ACME Products", tags: ["product"] },
    category: "entities",
    searchVector: null,
    createdBy: "admin-001",
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    wikilinks: ["acme-corporation"],
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/archives/:archiveId/graph", () => {
  it("should return 401 without auth", async () => {
    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/graph`)
      .expect(401);
  });

  it("should return 400 for invalid archive UUID", async () => {
    const res = await request(app)
      .get("/api/archives/not-a-uuid/graph")
      .set(adminAuth())
      .expect(400);

    expect(res.body.error).toBe("Invalid archive ID: must be a valid UUID");
  });

  it("should return 200 and valid graph JSON with nodes and edges", async () => {
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(mockPages);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/graph`)
      .set(adminAuth())
      .expect(200);

    expect(res.body).toHaveProperty("nodes");
    expect(res.body).toHaveProperty("edges");
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    expect(res.body.nodes).toHaveLength(2);
    expect(res.body.edges).toHaveLength(1);
    expect(res.body.nodes[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      category: expect.any(String),
      slug: expect.any(String),
    });
    expect(res.body.edges[0]).toMatchObject({
      source: expect.any(String),
      target: expect.any(String),
    });
  });

  it("should return empty arrays for archive with no pages", async () => {
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/graph`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.nodes).toEqual([]);
    expect(res.body.edges).toEqual([]);
  });

  it("should deduplicate bidirectional edges", async () => {
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(mockPages);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/graph`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.edges).toHaveLength(1);
  });
});
