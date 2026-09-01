// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Pages CRUD + Search integration tests — supertest against Express app.
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
jest.mock("../services/ftsService", () => ({
  initPostgreSQLFTS: jest.fn(),
  // Phase 151 (RAG-01): the real multi-config fragment — archivePageService
  // embeds it via Prisma.raw; the mock must provide the same shape.
  MULTI_CONFIG_TSVECTOR:
    "to_tsvector('english', t) || to_tsvector('italian', t) || to_tsvector('german', t) || to_tsvector('french', t) || to_tsvector('spanish', t) || to_tsvector('russian', t) || to_tsvector('simple', t)",
}));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

jest.mock("../services/archiveIndexService", () => ({
  generateIndexFile: jest.fn().mockResolvedValue(undefined),
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
import matter from "gray-matter";
import fs from "fs/promises";
import { updatePageSchema } from "@simmetric-chat/shared";
import { validatePageContent } from "../services/archiveSchemaValidator";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";
import { logEvent } from "../services/eventLogService";
import { getPage, updatePage } from "../services/archivePageService";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const PAGE_ID = "660e8400-e29b-41d4-a716-446655440200";
const PAGE_SLUG = "acme-corporation";
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

const mockPage = {
  id: PAGE_ID,
  archiveId: ARCHIVE_ID,
  slug: PAGE_SLUG,
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
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/archives/:archiveId/pages", () => {
  it("should create page and return 201 with slug/title/category", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.archivePage.create as jest.Mock).mockResolvedValue(mockPage);

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/pages`)
      .set(adminAuth())
      .send({
        title: "ACME Corporation",
        slug: PAGE_SLUG,
        content: "# ACME Corp\n\nLeading enterprise software company.",
        category: "entities",
      })
      .expect(201);

    expect(res.body).toHaveProperty("id");
    expect(res.body.slug).toBe(PAGE_SLUG);
    expect(res.body.title).toBe("ACME Corporation");
    expect(res.body.category).toBe("entities");

    // quick 260811-lxh: the tsvector FTS column is maintained on page create.
    // Phase 151 (RAG-01): BOTH columns are populated in the same statement.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const execCall = (prisma.$executeRaw as jest.Mock).mock.calls[0];
    const sql = (execCall[0] as string[]).join("?");
    expect(sql).toContain("to_tsvector('english'");
    expect(sql).toContain('"searchVectorMulti"');
    // The multi-config fragment arrives as a Prisma.raw interpolation value
    // (an object with `strings`/`values` — the $executeRaw tag keeps it as a
    // placeholder rather than flattening it into the template strings).
    const values = execCall.slice(1);
    const fragment = values.find(
      (v: unknown) =>
        typeof v === "object" &&
        v !== null &&
        Array.isArray((v as { strings?: unknown }).strings),
    ) as { strings: string[] } | undefined;
    expect(fragment).toBeDefined();
    expect(fragment!.strings.join("?")).toContain("to_tsvector('italian', t)");
    expect(fragment!.strings.join("?")).toContain("to_tsvector('simple', t)");
    // Last interpolated value is the pageId (WHERE clause).
    expect(execCall[execCall.length - 1]).toBe(mockPage.id);
  });

  it("should return 400 with invalid category", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/pages`)
      .set(adminAuth())
      .send({
        title: "ACME Corporation",
        slug: PAGE_SLUG,
        content: "# ACME Corp",
        category: "invalid_category_not_allowed",
      })
      .expect(400);

    expect(res.body.error).toBe("Invalid request body");
  });

  it("should return 400 for invalid archive UUID", async () => {
    await request(app)
      .post("/api/archives/not-a-uuid/pages")
      .set(adminAuth())
      .send({
        title: "Test",
        slug: "test",
        content: "# Test",
        category: "entities",
      })
      .expect(400);
  });

  it("should return 404 for non-existent archive", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(null);

    await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/pages`)
      .set(adminAuth())
      .send({
        title: "Test",
        slug: "test",
        content: "# Test",
        category: "entities",
      })
      .expect(404);
  });

  it("soft-deleted slug collision resolves to a suffixed slug (re-upload of a deleted wiki page)", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    // The (archiveId, slug) unique index covers soft-deleted rows; a
    // deletedAt: null filter would miss the held slot and createPage would
    // throw P2002. resolveCollision must treat the soft-deleted row as taken.
    const deletedPage = { ...mockPage, slug: PAGE_SLUG, deletedAt: new Date("2025-06-02T00:00:00.000Z") };
    (prisma.archivePage.findFirst as jest.Mock)
      .mockResolvedValueOnce(deletedPage) // base slug held by soft-deleted row
      .mockResolvedValueOnce(null);        // acme-corporation-2 is free
    (prisma.archivePage.create as jest.Mock).mockResolvedValue({
      ...mockPage,
      slug: `${PAGE_SLUG}-2`,
    });

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/pages`)
      .set(adminAuth())
      .send({
        title: "ACME Corporation",
        slug: PAGE_SLUG,
        content: "# ACME Corp\n\nLeading enterprise software company.",
        category: "entities",
      })
      .expect(201);

    expect(res.body.slug).toBe("acme-corporation-2");
  });
});

describe("GET /api/archives/:archiveId/pages", () => {
  it("should return pages array", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([mockPage]);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/pages`)
      .set(adminAuth())
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].slug).toBe(PAGE_SLUG);
  });

  it("should filter by category", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([mockPage]);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/pages?category=entities`)
      .set(adminAuth())
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].category).toBe("entities");
    expect(prisma.archivePage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ category: "entities" }) })
    );
  });

  it("should return empty array when no pages exist", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/pages`)
      .set(adminAuth())
      .expect(200);

    expect(res.body).toEqual([]);
  });

  // Quick 260723-ke9: the list route augments each page with a read-only
  // `relatedCount` (topic-overlap related page count). The Jaccard algorithm
  // itself is covered by archiveRelatedService.test.ts; here we only assert
  // the field is wired into the response (single-page archive → 0).
  it("augments each page with a numeric relatedCount (quick 260723-ke9)", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([mockPage]);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/pages`)
      .set(adminAuth())
      .expect(200);

    expect(res.body[0]).toHaveProperty("relatedCount");
    expect(typeof res.body[0].relatedCount).toBe("number");
    expect(res.body[0].relatedCount).toBe(0);
  });
});

describe("GET /api/archives/:archiveId/pages/:slug", () => {
  it("should return page with bodyText", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/pages/${PAGE_SLUG}`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.slug).toBe(PAGE_SLUG);
    expect(res.body.bodyText).toBe(mockPage.bodyText);
  });

  it("should return 404 for non-existent page", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(null);

    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/pages/nonexistent-page`)
      .set(adminAuth())
      .expect(404);
  });

  it("should return 400 for invalid slug characters", async () => {
    // The slug regex validates safe slug characters — special chars should fail validation
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/pages/invalid!slug`)
      .set(adminAuth())
      .expect(400);

    // Slug format validation rejects this
    expect(res.body).toHaveProperty("error");
  });
});

describe("PUT /api/archives/:archiveId/pages/:slug", () => {
  it("should update title without changing slug", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);
    const updatedPage = { ...mockPage, title: "ACME Corp Updated", updatedAt: new Date() };
    (prisma.archivePage.update as jest.Mock).mockResolvedValue(updatedPage);

    const res = await request(app)
      .put(`/api/archives/${ARCHIVE_ID}/pages/${PAGE_SLUG}`)
      .set(adminAuth())
      .send({ title: "ACME Corp Updated" })
      .expect(200);

    expect(res.body.title).toBe("ACME Corp Updated");
    expect(res.body.slug).toBe(PAGE_SLUG); // slug unchanged

    // quick 260811-lxh: the tsvector FTS column is maintained on page update.
    // Phase 151 (RAG-01): BOTH columns are populated in the same statement.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const execCall = (prisma.$executeRaw as jest.Mock).mock.calls[0];
    const sql = (execCall[0] as string[]).join("?");
    expect(sql).toContain("to_tsvector('english'");
    expect(sql).toContain('"searchVectorMulti"');
    // Last interpolated value is the pageId (WHERE clause).
    expect(execCall[execCall.length - 1]).toBe(mockPage.id);
  });

  // D-09 non-regression: the updatePage service already calls
  // logEvent("archive_page", ..., "archive_page.updated", ...) at
  // archivePageService.ts:386-395. The route must NOT add a second logEvent
  // (would double-log every update). This assertion guards against that
  // regression when Task 2 adds the body-only branch.
  it("D-09: archive_page.updated fires exactly once on PUT (no double-log)", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);
    const updatedPage = { ...mockPage, title: "ACME Corp Updated", updatedAt: new Date() };
    (prisma.archivePage.update as jest.Mock).mockResolvedValue(updatedPage);

    await request(app)
      .put(`/api/archives/${ARCHIVE_ID}/pages/${PAGE_SLUG}`)
      .set(adminAuth())
      .send({ title: "ACME Corp Updated" })
      .expect(200);

    const logEventMock = logEvent as jest.Mock;
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledWith(
      "archive_page",
      expect.any(String),
      "archive_page.updated",
      "admin-001",
      expect.objectContaining({ archiveId: ARCHIVE_ID, slug: PAGE_SLUG }),
    );
  });

  // D-04 landmine (T-77-02): a body-only PUT must preserve the existing
  // frontmatter. The route recomposes `matter.stringify(body, oldPage.frontmatter)`
  // into `content` before calling `updatePage`; the service re-parses the
  // recomposed file and writes `frontmatter` + `bodyText` from it. Without
  // recomposition the service would write the bare body as the whole .md
  // file, erasing the frontmatter (incl. Phase 79 WIKI-01 `Fonti`).
  it("D-04: body-only PUT preserves existing frontmatter and writes new bodyText", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);
    const newBody = "Updated body text for ACME.";
    const updatedPage = {
      ...mockPage,
      bodyText: newBody,
      updatedAt: new Date(),
    };
    (prisma.archivePage.update as jest.Mock).mockResolvedValue(updatedPage);

    const res = await request(app)
      .put(`/api/archives/${ARCHIVE_ID}/pages/${PAGE_SLUG}`)
      .set(adminAuth())
      .send({ body: newBody })
      .expect(200);

    // Service re-parsed the recomposed file and persisted frontmatter + bodyText.
    expect(prisma.archivePage.update).toHaveBeenCalledTimes(1);
    const updateCall = (prisma.archivePage.update as jest.Mock).mock.calls[0][0];
    // frontmatter from recomposed file matches the original mockPage frontmatter
    expect(updateCall.data.frontmatter).toEqual(mockPage.frontmatter);
    // bodyText is the new body (matter.stringify appends a trailing newline,
    // so the service's matter().content includes it — trim before comparing).
    expect(String(updateCall.data.bodyText).trim()).toBe(newBody);
    // The recomposed content written to disk contains the frontmatter fence
    // (verified indirectly via the service's matter() re-parse above; the
    // frontmatter field would be {} if recomposition had been skipped).
    expect(res.status).toBe(200);
  });

  // D-04 + Pitfall 2: validatePageContent must run on the raw body, not the
  // recomposed file. We assert the route does not pass the recomposed string
  // (which contains a `---` frontmatter block) to the validator. This is
  // covered structurally by the route code (contentToValidate = validatedData.body
  // in the body branch); the integration assertion above confirms the
  // end-to-end flow produces a valid update without spurious 400s.

  // T-77-04: 409 concurrent conflict mapping still works on body-only PUT.
  it("D-04: body-only PUT returns 409 on concurrent conflict (P2025)", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);
    (prisma.archivePage.update as jest.Mock).mockRejectedValue({ code: "P2025" });

    const res = await request(app)
      .put(`/api/archives/${ARCHIVE_ID}/pages/${PAGE_SLUG}`)
      .set(adminAuth())
      .send({ body: "concurrent body edit" })
      .expect(409);

    expect(res.body.error).toMatch(/concurrently/i);
  });

  // D-09 no double-log on body-only PUT either.
  it("D-09: body-only PUT logs archive_page.updated exactly once", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);
    const updatedPage = { ...mockPage, bodyText: "new body", updatedAt: new Date() };
    (prisma.archivePage.update as jest.Mock).mockResolvedValue(updatedPage);

    await request(app)
      .put(`/api/archives/${ARCHIVE_ID}/pages/${PAGE_SLUG}`)
      .set(adminAuth())
      .send({ body: "new body" })
      .expect(200);

    const logEventMock = logEvent as jest.Mock;
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledWith(
      "archive_page",
      expect.any(String),
      "archive_page.updated",
      "admin-001",
      expect.objectContaining({ archiveId: ARCHIVE_ID }),
    );
  });
});

// ---- Wave 0: D-04 assumption tests (A1/A2/A3) ----
// These run BEFORE the route change in Task 2 to verify the three assumptions
// the route-side frontmatter recomposition depends on:
//   A1 — gray-matter stringify/parse round-trip preserves body + frontmatter
//   A2 — validatePageContent on a bare body (no `---` block) does not emit
//        spurious frontmatter-related violations/warnings
//   A3 — oldPage.frontmatter (Prisma JSON) is YAML-serializable via matter.stringify
// Plus a direct schema test for the new `body` field + the at-least-one-field refine.
describe("Wave 0: D-04 assumptions", () => {
  // A1 — matter.stringify(body, frontmatter) round-trip. gray-matter appends
  // a trailing newline after the body; the round-trip preserves body content
  // and frontmatter data, so we compare trimmed content + deep-equal data.
  it("A1: matter.stringify(body, frontmatter) round-trips through matter()", () => {
    const body = "# Body\n\nSome text.";
    const frontmatter = { title: "T", tags: ["x", "y"] };
    const recomposed = matter.stringify(body, frontmatter);
    const parsed = matter(recomposed);
    expect(parsed.content.trim()).toBe(body);
    expect(parsed.data).toEqual(frontmatter);
  });

  // A2 — validatePageContent on bare body (no frontmatter) does not emit
  // spurious frontmatter-related violations/warnings
  it("A2: validatePageContent on bare body produces no spurious violations", () => {
    const config = {
      requiredFrontmatter: {
        title: { type: "string", required: true },
      },
      lintRules: [],
    };
    const result = validatePageContent("# Heading\n\nBody text.", config, "human");
    // requiredFrontmatter is config-driven: bare body has no frontmatter, so
    // the `title` required check fires as a violation (expected behavior — the
    // route passes the body, not the recomposed file). The assertion is that
    // NO violation references a *parsing* problem (no "frontmatter parse" rule,
    // no spurious "line empty" / "heading missing" warnings). Only the
    // required-title rule may fire.
    const spurious = result.violations.concat(result.warnings).filter(
      (v) => v.rule !== "frontmatter_required",
    );
    expect(spurious).toEqual([]);
  });

  // A3 — mockPage.frontmatter (Prisma JSON shape) is YAML-serializable
  it("A3: matter.stringify(body, mockPage.frontmatter) does not throw", () => {
    expect(() => {
      matter.stringify("body text", mockPage.frontmatter);
    }).not.toThrow();
    const recomposed = matter.stringify("body text", mockPage.frontmatter);
    const parsed = matter(recomposed);
    expect(parsed.data).toEqual(mockPage.frontmatter);
  });
});

describe("updatePageSchema body field (D-04)", () => {
  it("accepts a body-only payload", () => {
    const result = updatePageSchema.safeParse({ body: "new body text" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty payload (at-least-one-field refine)", () => {
    const result = updatePageSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an empty body", () => {
    const result = updatePageSchema.safeParse({ body: "" });
    expect(result.success).toBe(false);
  });

  it("accepts title + body together", () => {
    const result = updatePageSchema.safeParse({ title: "T", body: "B" });
    expect(result.success).toBe(true);
  });
});

describe("DELETE /api/archives/:archiveId/pages/:slug", () => {
  it("should soft-delete page, subsequent GET returns 404", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);
    const deletedPage = { ...mockPage, deletedAt: new Date() };
    (prisma.archivePage.update as jest.Mock).mockResolvedValue(deletedPage);

    const res = await request(app)
      .delete(`/api/archives/${ARCHIVE_ID}/pages/${PAGE_SLUG}`)
      .set(adminAuth())
      .expect(200);

    expect(res.body.message).toBe("Page deleted successfully");

    // Subsequent GET returns 404
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(null);
    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/pages/${PAGE_SLUG}`)
      .set(adminAuth())
      .expect(404);
  });
});

describe("GET /api/archives/:archiveId/search", () => {
  it("should return matching search results", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    // Search route uses $queryRaw for PostgreSQL tsvector
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      {
        id: PAGE_ID,
        slug: PAGE_SLUG,
        title: "ACME Corporation",
        body_text: mockPage.bodyText,
        category: "entities",
        rank: 0.95,
      },
    ]);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/search?query=acme`)
      .set(adminAuth())
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe("ACME Corporation");
  });

  it("should return empty array for no matches", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/search?query=zzznotfound`)
      .set(adminAuth())
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it("should return 400 for missing query parameter", async () => {
    await request(app)
      .get(`/api/archives/${ARCHIVE_ID}/search`)
      .set(adminAuth())
      .expect(400);
  });
});

// ---- Phase 79-03 D-07: lazy migrate sources -> Fonti ----
// Direct service-level tests for maybeMigrateFonti (read path) and the
// inline updatePage migrate (write path). Spies on fs.writeFile to assert
// the migrated content without relying on real disk state.
describe("Phase 79-03 D-07: lazy migrate sources -> Fonti", () => {
  const legacyPage = {
    ...mockPage,
    frontmatter: { sources: [{ fileName: "foo.md" }, { fileName: "bar.md" }] },
  };

  it("a. getPage lazy-migrates sources -> Fonti (DB + file persist)", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(legacyPage);
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({});
    const writeFileSpy = jest.spyOn(fs, "writeFile").mockResolvedValue(undefined as never);

    const page = await getPage(ARCHIVE_ID, PAGE_SLUG);

    expect(page.frontmatter).toEqual({ Fonti: ["[[raw_sources/foo.md]]", "[[raw_sources/bar.md]]"] });
    expect((page.frontmatter as any).sources).toBeUndefined();
    // DB persist called with migrated frontmatter.
    const updateCall = (prisma.archivePage.update as jest.Mock).mock.calls.find(
      (c) => (c[0] as any)?.where?.id === PAGE_ID,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.frontmatter).toEqual({
      Fonti: ["[[raw_sources/foo.md]]", "[[raw_sources/bar.md]]"],
    });
    // File persist: writeFile called with matter-stringified content carrying Fonti: line.
    expect(writeFileSpy).toHaveBeenCalled();
    const written = String(writeFileSpy.mock.calls[0]![1]);
    expect(written).toContain("Fonti:");
    expect(written).not.toContain("sources:");
    writeFileSpy.mockRestore();
  });

  it("b. getPage idempotent — page with Fonti already returns unchanged, no update", async () => {
    const fontiPage = {
      ...mockPage,
      frontmatter: { Fonti: ["[[raw_sources/foo.md]]"] },
    };
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(fontiPage);
    (prisma.archivePage.update as jest.Mock).mockClear();

    const page = await getPage(ARCHIVE_ID, PAGE_SLUG);

    expect(page.frontmatter).toEqual({ Fonti: ["[[raw_sources/foo.md]]"] });
    expect(prisma.archivePage.update).not.toHaveBeenCalled();
  });

  it("c. updatePage lazy-migrates on write — written content has Fonti: line, no sources: line", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);
    const updatedPage = { ...mockPage, updatedAt: new Date() };
    (prisma.archivePage.update as jest.Mock).mockResolvedValue(updatedPage);
    const writeFileSpy = jest.spyOn(fs, "writeFile").mockResolvedValue(undefined as never);
    jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    jest.spyOn(fs, "unlink").mockResolvedValue(undefined as never);

    const newContent = matter.stringify("Updated body.", {
      sources: [{ fileName: "foo.md" }],
      synthesis_generation: 2,
      confidence: "high",
    });

    await updatePage(ARCHIVE_ID, PAGE_SLUG, { content: newContent }, "admin-001");

    expect(writeFileSpy).toHaveBeenCalled();
    const written = String(writeFileSpy.mock.calls[0]![1]);
    const parsed = matter(written);
    expect(parsed.data.Fonti).toEqual(["[[raw_sources/foo.md]]"]);
    expect(parsed.data.sources).toBeUndefined();
    // DB frontmatter persisted the migrated shape.
    const updateCall = (prisma.archivePage.update as jest.Mock).mock.calls[0];
    expect(updateCall![0].data.frontmatter.Fonti).toEqual(["[[raw_sources/foo.md]]"]);
    expect(updateCall![0].data.frontmatter.sources).toBeUndefined();

    writeFileSpy.mockRestore();
    (fs.mkdir as jest.Mock).mockRestore();
    (fs.unlink as jest.Mock).mockRestore();
  });

  it("d. updatePage preserves synthesis_generation + confidence through the matter.stringify round-trip", async () => {
    (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(mockPage);
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({ ...mockPage, updatedAt: new Date() });
    const writeFileSpy = jest.spyOn(fs, "writeFile").mockResolvedValue(undefined as never);
    jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    jest.spyOn(fs, "unlink").mockResolvedValue(undefined as never);

    const newContent = matter.stringify("Body text.", {
      sources: [{ fileName: "foo.md" }],
      synthesis_generation: 5,
      confidence: "medium",
      last_synthesis: "2026-01-01T00:00:00.000Z",
    });

    await updatePage(ARCHIVE_ID, PAGE_SLUG, { content: newContent }, "admin-001");

    const written = String(writeFileSpy.mock.calls[0]![1]);
    const parsed = matter(written);
    expect(parsed.data.synthesis_generation).toBe(5);
    expect(parsed.data.confidence).toBe("medium");
    expect(parsed.data.last_synthesis).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.data.Fonti).toEqual(["[[raw_sources/foo.md]]"]);

    writeFileSpy.mockRestore();
    (fs.mkdir as jest.Mock).mockRestore();
    (fs.unlink as jest.Mock).mockRestore();
  });
});
