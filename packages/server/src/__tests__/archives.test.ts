// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive CRUD integration tests — supertest against Express app.
 */
import "./helpers/setupEnv";
import fs from "fs";
import path from "path";

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
const ARCHIVE_SLUG = "acme-corp";
const now = new Date("2025-06-01T00:00:00.000Z");

const mockArchive = {
  id: ARCHIVE_ID,
  slug: ARCHIVE_SLUG,
  name: "ACME Corp Wiki",
  description: "Knowledge base for ACME Corporation",
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/archives", () => {
  it("should return list of non-deleted archives", async () => {
    (prisma.archive.findMany as jest.Mock).mockResolvedValue([mockArchive]);

    const res = await request(app)
      .get("/api/archives")
      .set(adminAuth())
      .expect(200);

    expect(res.body).toEqual([mockArchive]);
    expect(prisma.archive.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
  });

  it("should include filtered _count.pages excluding soft-deleted pages", async () => {
    // Mirrors Prisma filtered _count: include._count.select.pages.where = { deletedAt: null }
    (prisma.archive.findMany as jest.Mock).mockResolvedValue([
      { ...mockArchive, _count: { pages: 3 } },
    ]);

    await request(app)
      .get("/api/archives")
      .set(adminAuth())
      .expect(200);

    const call = (prisma.archive.findMany as jest.Mock).mock.calls[0][0];
    expect(call.include).toHaveProperty("_count");
    expect(call.include._count).toHaveProperty("select");
    expect(call.include._count.select).toHaveProperty("pages");
    expect(call.include._count.select.pages).toHaveProperty("where");
    expect(call.include._count.select.pages.where).toEqual({ deletedAt: null });
  });

  it("should return 401 without auth", async () => {
    await request(app)
      .get("/api/archives")
      .expect(401);
  });
});

describe("POST /api/archives", () => {
  it("should create archive and return 201", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.archive.create as jest.Mock).mockResolvedValue(mockArchive);

    const res = await request(app)
      .post("/api/archives")
      .set(adminAuth())
      .send({ name: "ACME Corp Wiki", description: "Knowledge base for ACME Corporation" })
      .expect(201);

    expect(res.body).toHaveProperty("id");
    expect(res.body.name).toBe("ACME Corp Wiki");
    expect(res.body.slug).toBe(ARCHIVE_SLUG);

    // WIKI-02 D-01: createArchive must scaffold raw_sources/ (not legacy raw/).
    // The on-disk dir uses the slug derived from the name ("ACME Corp Wiki" ->
    // "acme-corp-wiki"); the route response is mocked to ARCHIVE_SLUG, so derive
    // the real on-disk slug independently.
    const onDiskSlug = "acme-corp-wiki";
    const archiveDir = path.resolve(process.cwd(), "storage", "archives", onDiskSlug);
    expect(fs.existsSync(path.join(archiveDir, "raw_sources"))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, "raw"))).toBe(false);
  });

  it("should return 400 with empty name", async () => {
    const res = await request(app)
      .post("/api/archives")
      .set(adminAuth())
      .send({ name: "" })
      .expect(400);

    expect(res.body.error).toBe("Invalid request body");
  });

  it("should return 409 with the name message when create rejects P2002 on the name target (260809-wte)", async () => {
    const p2002NameError = Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
      code: "P2002",
      meta: { target: ["createdBy", "name"] },
    });
    (prisma.archive.create as jest.Mock).mockRejectedValue(p2002NameError);

    const res = await request(app)
      .post("/api/archives")
      .set(adminAuth())
      .send({ name: "ACME Corp Wiki" })
      .expect(409);

    expect(res.body.error).toBe("An archive with this name already exists");
  });

  it("should return 409 with the slug message when create rejects P2002 on the slug target (260809-wte)", async () => {
    const p2002SlugError = Object.assign(new Error("Unique constraint failed on the fields: (`slug`)"), {
      code: "P2002",
      meta: { target: ["slug"] },
    });
    (prisma.archive.create as jest.Mock).mockRejectedValue(p2002SlugError);

    const res = await request(app)
      .post("/api/archives")
      .set(adminAuth())
      .send({ name: "ACME Corp Wiki" })
      .expect(409);

    expect(res.body.error).toBe("An archive with this slug already exists");
  });

  it.skip("should return 403 without archive:write permission", async () => {
    // Dynamic permission mocking not supported with current global mock pattern.
    // Would require per-test auth middleware override.
    // Future: implement test-specific auth mock with token-based permission resolution.
  });
});

describe("GET /api/archives/:archiveId", () => {
  it("should return archive by ID", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.id).toBe(ARCHIVE_ID);
    expect(res.body.name).toBe("ACME Corp Wiki");
  });

  it("should return 400 for invalid UUID", async () => {
    await request(app)
      .get("/api/archives/not-a-uuid")
      .set(adminAuth())
      .expect(400);
  });

  it("should return 404 for non-existent archive", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);

    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}`)
      .set(adminAuth())
      .expect(404);
  });
});

describe("PUT /api/archives/:archiveId", () => {
  it("should update archive name and return updated archive", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    const updatedArchive = { ...mockArchive, name: "ACME Corp Updated", updatedAt: new Date() };
    (prisma.archive.update as jest.Mock).mockResolvedValue(updatedArchive);

    const res = await request(app)
      .put(`/api/archives/${ARCHIVE_ID}`)
      .set(adminAuth())
      .send({ name: "ACME Corp Updated" })
      .expect(200);

    expect(res.body.name).toBe("ACME Corp Updated");
    expect(res.body.slug).toBe(ARCHIVE_SLUG); // slug unchanged
  });

  it("should return 400 with empty name", async () => {
    const res = await request(app)
      .put(`/api/archives/${ARCHIVE_ID}`)
      .set(adminAuth())
      .send({ name: "" })
      .expect(400);

    expect(res.body.error).toBe("Invalid request body");
  });
});

describe("DELETE /api/archives/:archiveId", () => {
  it("should soft-delete archive and return 200", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    const deletedArchive = { ...mockArchive, deletedAt: new Date() };
    (prisma.archive.update as jest.Mock).mockResolvedValue(deletedArchive);

    const res = await request(app)
      .delete(`/api/archives/${ARCHIVE_ID}`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.message).toBe("Archive deleted successfully");
  });

  it("should return 404 for subsequent GET after delete", async () => {
    // First: archive exists
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    const deletedArchive = { ...mockArchive, deletedAt: new Date() };
    (prisma.archive.update as jest.Mock).mockResolvedValue(deletedArchive);

    await request(app)
      .delete(`/api/archives/${ARCHIVE_ID}`)
      .set(adminAuth())
      .expect(200);

    // Then: GET returns 404 since filtered by deletedAt: null
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);
    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}`)
      .set(adminAuth())
      .expect(404);
  });
});

describe("POST /api/archives/from-template", () => {
  it("should create archive from 'research' template", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);
    // Template creation writes to filesystem — mock archiveService to avoid FS operations
    jest.mock("../services/archiveService", () => ({
      createArchiveFromTemplate: jest.fn().mockResolvedValue({
        ...mockArchive,
        id: "550e8400-e29b-41d4-a716-446655440101",
        slug: "my-research",
        name: "My Research",
      }),
    }));

    // Since jest.mock hoists, we need to requery the module. Use direct prisma mock for now.
    const templateArchive = {
      ...mockArchive,
      id: "550e8400-e29b-41d4-a716-446655440101",
      slug: "my-research",
      name: "My Research",
    };
    (prisma.archive.create as jest.Mock).mockResolvedValue(templateArchive);

    const res = await request(app)
      .post("/api/archives/from-template")
      .set(adminAuth())
      .send({ templateName: "research", name: "My Research" })
      .expect(201);

    expect(res.body.name).toBe("My Research");
    expect(res.body.slug).toBe("my-research");
  });

  it("should return 400 for invalid template name", async () => {
    const res = await request(app)
      .post("/api/archives/from-template")
      .set(adminAuth())
      .send({ templateName: "nonexistent", name: "Bad Template" })
      .expect(400);

    expect(res.body.error).toBe("Invalid request body");
  });
});
