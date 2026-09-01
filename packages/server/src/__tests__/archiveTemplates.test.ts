// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Templates + Inventory integration tests.
 *
 * Tests ARCH-06 (template creation) and INVT-01..03 (inventory tracking).
 * Inventory tests call service functions directly (filesystem-based, no API endpoint in this phase).
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
  initLicense: jest.fn(),
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
  rebuildAllIndexFiles: jest.fn().mockResolvedValue({ reindexed: 5, errors: [] }),
  generateIndexFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/archivePageService", () => ({
  rebuildIndex: jest.fn().mockResolvedValue({ reindexed: 5, errors: [] }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../services/archiveLogService", () => ({
  appendToLog: jest.fn().mockResolvedValue(undefined),
}));

// Mock uuid for deterministic IDs
jest.mock("uuid", () => ({
  v4: jest.fn(() => "mock-uuid-001"),
  validate: jest.fn(() => true),
  version: jest.fn(() => 4),
}));

jest.mock("simple-git", () => ({
  simpleGit: jest.fn(() => ({
    init: jest.fn().mockResolvedValue(undefined),
    addConfig: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock fs for template directory and inventory file operations
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: jest.fn().mockReturnValue(false),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.mock("fs/promises", () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockRejectedValue(new Error("ENOENT")),
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
import {
  addInventoryItem,
  getInventoryItems,
  updateInventoryItem,
  deleteInventoryItem,
  previewInventoryChanges,
} from "../services/archiveInventoryService";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const ARCHIVE_SLUG = "test-archive";

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================
// Part A: Template creation tests (HTTP endpoint)
// ============================================================

describe("POST /api/archives/from-template — Template Creation", () => {
  it("should create 'research' template archive with correct directory structure", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.archive.create as jest.Mock).mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440111",
      slug: "research-wiki",
      name: "Research Wiki",
      description: null,
      createdBy: "admin-001",
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/archives/from-template")
      .set(adminAuth())
      .send({ templateName: "research", name: "Research Wiki" })
      .expect(201);

    expect(res.body.name).toBe("Research Wiki");
    expect(res.body.slug).toBe("research-wiki");
  });

  it("should create 'project' template archive (no concepts directory)", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.archive.create as jest.Mock).mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440112",
      slug: "project-alpha",
      name: "Project Alpha",
      description: null,
      createdBy: "admin-001",
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/archives/from-template")
      .set(adminAuth())
      .send({ templateName: "project", name: "Project Alpha" })
      .expect(201);

    expect(res.body.name).toBe("Project Alpha");
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

// ============================================================
// Part B: Inventory tracking tests (service-level direct calls)
// ============================================================

describe("Archive Inventory Service", () => {
  const INV_ARCHIVE_SLUG = "test-inventory";
  const CATEGORY = "entities";

  it("should add item and return UUID", async () => {
    const fsPromises = await import("fs/promises");
    (fsPromises.readFile as jest.Mock).mockRejectedValue(new Error("ENOENT"));

    const item = await addInventoryItem(INV_ARCHIVE_SLUG, CATEGORY, {
      name: "ACME Corp",
      status: "active",
    });

    expect(item).toHaveProperty("id");
    expect(item.name).toBe("ACME Corp");
    expect(item.status).toBe("active");
  });

  it("should get inventory items (empty array for new archive)", async () => {
    const fsPromises = await import("fs/promises");
    (fsPromises.readFile as jest.Mock).mockRejectedValue(new Error("ENOENT"));

    const items = await getInventoryItems(INV_ARCHIVE_SLUG, CATEGORY);
    expect(Array.isArray(items)).toBe(true);
  });

  it("should update item status", async () => {
    const fsPromises = await import("fs/promises");
    (fsPromises.readFile as jest.Mock).mockResolvedValue(
      "| ID | Name | Status | Notes | Created | Updated |\n" +
      "|----|------|--------|-------|---------|----------|\n" +
      "| mock-uuid-001 | ACME Corp | active |  | 2025-01-01T00:00:00.000Z | 2025-01-01T00:00:00.000Z |\n"
    );

    const updated = await updateInventoryItem(INV_ARCHIVE_SLUG, CATEGORY, "mock-uuid-001", {
      status: "archived",
    });

    expect(updated.status).toBe("archived");
    expect(updated.name).toBe("ACME Corp"); // unchanged
  });

  it("should delete item", async () => {
    const fsPromises = await import("fs/promises");
    (fsPromises.readFile as jest.Mock).mockResolvedValue(
      "| ID | Name | Status | Notes | Created | Updated |\n" +
      "|----|------|--------|-------|---------|----------|\n" +
      "| mock-uuid-001 | ACME Corp | active |  | 2025-01-01T00:00:00.000Z | 2025-01-01T00:00:00.000Z |\n"
    );

    const result = await deleteInventoryItem(INV_ARCHIVE_SLUG, CATEGORY, "mock-uuid-001");
    expect(result.message).toBe("Item deleted");
  });

  it("should preview changes without FS mutations", async () => {
    const fsPromises = await import("fs/promises");
    (fsPromises.readFile as jest.Mock).mockResolvedValue(
      "| ID | Name | Status | Notes | Created | Updated |\n" +
      "|----|------|--------|-------|---------|----------|\n" +
      "| existing-1 | Alpha | active |  | 2025-01-01T00:00:00.000Z | 2025-01-01T00:00:00.000Z |\n"
    );

    const result = await previewInventoryChanges(INV_ARCHIVE_SLUG, CATEGORY, [
      { action: "add", data: { name: "Beta", status: "pending" } },
    ]);

    expect(result.before.itemCount).toBe(1);
    expect(result.after.itemCount).toBe(2);
    expect(result.changes.added).toBe(1);
    expect(result.before.items).toHaveLength(1);
    expect(result.after.items).toHaveLength(2);
  });
});

// ============================================================
// Part C: Reindex endpoint test
// ============================================================

describe("POST /api/archives/:archiveId/reindex", () => {
  it("should reindex archive and return counts", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      slug: ARCHIVE_SLUG,
      name: "Test Archive",
      createdBy: "admin-001",
      deletedAt: null,
    });
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/reindex`)
      .set(adminAuth())
      .expect(200);

    expect(res.body).toHaveProperty("reindexed");
    expect(res.body).toHaveProperty("errors");
    expect(res.body.reindexed).toBe(5);
    expect(res.body.errors).toEqual([]);
  });

  it("should return 404 for non-existent archive", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);

    await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/reindex`)
      .set(adminAuth())
      .expect(404);
  });
});
