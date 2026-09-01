// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * wikilinks route tests — GET /maintenance (D-10 backward-compat) + POST .../merge (D-10/D-11).
 * Task 2 covers GET /maintenance; Task 3 appends the POST .../merge cases.
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

jest.mock("../services/archiveMaintenanceService", () => ({
  getMaintenanceSuggestions: jest.fn().mockResolvedValue({ suggestions: [], mergeSuggestions: [] }),
}));

jest.mock("../services/archivePageService", () => ({
  createPage: jest.fn(),
  getPage: jest.fn(),
  updatePage: jest.fn(),
}));

jest.mock("../services/wikiLinkService", () => ({
  resolveWikilinks: jest.fn().mockResolvedValue([]),
  redirectWikilinks: jest.fn().mockResolvedValue(undefined),
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
import matter from "gray-matter";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";
import { getMaintenanceSuggestions } from "../services/archiveMaintenanceService";
import { createPage, getPage } from "../services/archivePageService";
import { redirectWikilinks } from "../services/wikiLinkService";
import { logEvent } from "../services/eventLogService";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const PAGE_A_ID = "660e8400-e29b-41d4-a716-446655440201";
const PAGE_B_ID = "660e8400-e29b-41d4-a716-446655440202";
const PAGE_C_ID = "660e8400-e29b-41d4-a716-446655440203";

beforeEach(() => {
  jest.clearAllMocks();
});

// ===========================================================================
// GET /api/wikilinks/maintenance/:archiveId (D-10 backward-compatible extension)
// ===========================================================================
describe("GET /api/wikilinks/maintenance/:archiveId", () => {
  it("maintenance: returns JSON with both suggestions and mergeSuggestions fields", async () => {
    (getMaintenanceSuggestions as jest.Mock).mockResolvedValue({
      suggestions: [{ type: "stale", pageSlug: "foo", message: "stale page" }],
      mergeSuggestions: [{ pageA: "a", pageB: "b", similarity: 0.9, reason: "title-normalized" }],
    });

    const res = await request(app)
      .get(`/api/wikilinks/maintenance/${ARCHIVE_ID}`)
      .set(adminAuth())
      .expect(200);

    expect(res.body).toHaveProperty("suggestions");
    expect(res.body).toHaveProperty("mergeSuggestions");
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(Array.isArray(res.body.mergeSuggestions)).toBe(true);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.mergeSuggestions).toHaveLength(1);
    expect(getMaintenanceSuggestions).toHaveBeenCalledWith("", ARCHIVE_ID);
  });

  it("maintenance: returns 400 for invalid archive UUID", async () => {
    const res = await request(app)
      .get("/api/wikilinks/maintenance/not-a-uuid")
      .set(adminAuth())
      .expect(400);

    expect(res.body.error).toBe("Invalid archive ID");
  });
});

// ===========================================================================
// POST /api/wikilinks/maintenance/:archiveId/merge (D-10/D-11)
// ===========================================================================
describe("POST /api/wikilinks/maintenance/:archiveId/merge", () => {
  it("merge: 201 creates page C, soft-deletes A and B, redirects wikilinks, audit-logs", async () => {
    (getPage as jest.Mock)
      .mockResolvedValueOnce({
        id: PAGE_A_ID,
        archiveId: ARCHIVE_ID,
        slug: "page-a",
        title: "Page A",
        bodyText: "Body A content",
        frontmatter: { Fonti: ["[[raw_sources/a.md]]"] },
        category: "entities",
      })
      .mockResolvedValueOnce({
        id: PAGE_B_ID,
        archiveId: ARCHIVE_ID,
        slug: "page-b",
        title: "Page B",
        bodyText: "Body B content",
        frontmatter: { Fonti: ["[[raw_sources/b.md]]"] },
        category: "entities",
      });
    (createPage as jest.Mock).mockResolvedValue({
      id: PAGE_C_ID,
      archiveId: ARCHIVE_ID,
      slug: "merged-page",
      title: "Merged Page",
      category: "entities",
    });
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/wikilinks/maintenance/${ARCHIVE_ID}/merge`)
      .set(adminAuth())
      .send({
        pageA: "page-a",
        pageB: "page-b",
        title: "Merged Page",
        slug: "merged-page",
      })
      .expect(201);

    expect(res.body).toHaveProperty("pageC");
    expect(res.body.message).toBe("Merge complete");

    // createPage called once with composed content (matter.stringify)
    expect(createPage).toHaveBeenCalledTimes(1);
    const callArgs = (createPage as jest.Mock).mock.calls[0]!;
    expect(callArgs[0]).toBe(ARCHIVE_ID);
    expect(callArgs[2]).toBe("admin-001");
    const passedContent = callArgs[1].content as string;
    const parsed = matter(passedContent);
    expect(parsed.content).toContain("Body A content");
    expect(parsed.content).toContain("Body B content");
    expect(parsed.content).toContain("Merged from Page B");

    // A and B soft-deleted via prisma.archivePage.update with deletedAt
    expect(prisma.archivePage.update).toHaveBeenCalledTimes(2);
    const updateCalls = (prisma.archivePage.update as jest.Mock).mock.calls;
    const deletedIds = updateCalls.map((c: any[]) => (c[0].where as { id: string }).id);
    expect(deletedIds).toContain(PAGE_A_ID);
    expect(deletedIds).toContain(PAGE_B_ID);
    for (const c of updateCalls) {
      expect(c[0].data).toHaveProperty("deletedAt");
      expect(c[0].data.deletedAt).toBeInstanceOf(Date);
    }

    // redirectWikilinks called with { page-a: merged-page, page-b: merged-page }
    expect(redirectWikilinks).toHaveBeenCalledTimes(1);
    const redirectArgs = (redirectWikilinks as jest.Mock).mock.calls[0]!;
    expect(redirectArgs[0]).toBe(ARCHIVE_ID);
    expect(redirectArgs[1]).toEqual({ "page-a": "merged-page", "page-b": "merged-page" });
    expect(redirectArgs[2]).toBe("admin-001");

    // audit log
    expect(logEvent).toHaveBeenCalledTimes(1);
    const logArgs = (logEvent as jest.Mock).mock.calls[0]!;
    expect(logArgs[0]).toBe("archive_page");
    expect(logArgs[2]).toBe("archive_page.merged");
  });

  it("merge: 400 on invalid body (pageA === pageB)", async () => {
    const res = await request(app)
      .post(`/api/wikilinks/maintenance/${ARCHIVE_ID}/merge`)
      .set(adminAuth())
      .send({
        pageA: "same-slug",
        pageB: "same-slug",
        title: "Merged",
      })
      .expect(400);

    expect(res.body.error).toBe("Invalid merge body");
    expect(res.body).toHaveProperty("details");
  });

  it("merge: 400 on missing pageA", async () => {
    const res = await request(app)
      .post(`/api/wikilinks/maintenance/${ARCHIVE_ID}/merge`)
      .set(adminAuth())
      .send({
        pageB: "page-b",
        title: "Merged",
      })
      .expect(400);

    expect(res.body.error).toBe("Invalid merge body");
  });

  it("merge: 404 when pageA not found (getPage throws)", async () => {
    (getPage as jest.Mock).mockRejectedValue(new Error("Page not found"));

    const res = await request(app)
      .post(`/api/wikilinks/maintenance/${ARCHIVE_ID}/merge`)
      .set(adminAuth())
      .send({
        pageA: "missing-page",
        pageB: "page-b",
        title: "Merged",
      })
      .expect(404);

    expect(res.body.error).toBe("Page not found");
  });

  it("merge: created C content frontmatter has merged Fonti and merged_from marker", async () => {
    (getPage as jest.Mock)
      .mockResolvedValueOnce({
        id: PAGE_A_ID,
        archiveId: ARCHIVE_ID,
        slug: "page-a",
        title: "Page A",
        bodyText: "Body A",
        frontmatter: { Fonti: ["[[raw_sources/a.md]]"] },
        category: "entities",
      })
      .mockResolvedValueOnce({
        id: PAGE_B_ID,
        archiveId: ARCHIVE_ID,
        slug: "page-b",
        title: "Page B",
        bodyText: "Body B",
        frontmatter: { Fonti: ["[[raw_sources/b.md]]"] },
        category: "entities",
      });
    (createPage as jest.Mock).mockResolvedValue({
      id: PAGE_C_ID,
      slug: "merged",
      title: "Merged",
      category: "entities",
    });
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({});

    await request(app)
      .post(`/api/wikilinks/maintenance/${ARCHIVE_ID}/merge`)
      .set(adminAuth())
      .send({
        pageA: "page-a",
        pageB: "page-b",
        title: "Merged",
      })
      .expect(201);

    const passedContent = (createPage as jest.Mock).mock.calls[0]![1].content as string;
    const parsed = matter(passedContent);
    const fonti = parsed.data.Fonti as string[];
    expect(fonti).toContain("[[raw_sources/a.md]]");
    expect(fonti).toContain("[[raw_sources/b.md]]");
    expect(parsed.data.merged_from).toEqual(["page-a", "page-b"]);
  });
});