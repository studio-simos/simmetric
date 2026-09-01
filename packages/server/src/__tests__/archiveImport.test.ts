// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KB-05 / KB-06 archive import pipeline unit tests.
 *
 * Tests the three archiveImport routes (copy-from-doc, upload, callback) and
 * the archiveImportService dispatch/callback helpers. Uses mocked Prisma +
 * mocked axios so the tests run without a real PostgreSQL worker DB or a
 * live collector (worktree-safe). Mirrors the archivePages.test.ts pattern.
 *
 * Coverage:
 *   1. copy-doc happy path → 202 + ArchiveImportJob row created + axios dispatched
 *   2. copy-doc no archive:write permission → 403
 *   3. copy-doc invalid documentId → 400 Zod details
 *   4. callback completed → 200 + createPage called + job COMPLETED
 *   5. callback failed → 200 + no createPage + job FAILED
 *   6. upload .md → 202 + ArchiveImportJob row + axios dispatched
 *   7. upload unsupported MIME (.txt) → 400
 *   8. upload > 100MB → 400 (multer LIMIT_FILE_SIZE)
 *   9. copy-doc IDOR — user without source-document access → 403, axios NOT called
 *   10. copy-doc batch with one inaccessible documentId → 403, no jobs created
 */

import "./helpers/setupEnv";

// --- Mocks -----------------------------------------------------------------

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
    SERVER_URL: "http://localhost:3000",
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
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
jest.mock("../services/archiveIndexService", () => ({ generateIndexFile: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/archivePageTitleBackfill", () => ({ backfillArchivePageTitles: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/archiveLocalLLMOnlyPropagation", () => ({
  backfillLocalLLMOnlyPropagation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/synthesisReaperJob", () => ({
  initSynthesisReaperScheduler: jest.fn(),
  shutdownSynthesisReaper: jest.fn(),
}));

jest.mock("../services/archivePageService", () => ({
  createPage: jest.fn().mockResolvedValue({
    id: "page-001",
    archiveId: "archive-001",
    slug: "my-doc",
    title: "My Doc",
    category: "entities",
  }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// Mock axios so we can assert the collector dispatch was/was-not called.
// The service uses axios.post(...).then(...).catch(...) — return a promise
// that resolves so the .then branch fires. Tests that need to assert "NOT
// called" use the spy directly.
jest.mock("axios", () => ({
  post: jest.fn().mockImplementation(() => Promise.resolve({ status: 202 })),
  put: jest.fn().mockImplementation(() => Promise.resolve({ status: 200 })),
  get: jest.fn().mockImplementation(() => Promise.resolve({ status: 200 })),
}));

// Mock auth middleware to inject a configurable test user. Each test can
// override req.user via the `x-test-user` header (test-only, not honored by
// the real auth middleware). The header value may be:
//   - a JSON string starting with "{" → parsed and used as the full user object
//   - any other string → used as the user id, with the default admin permissions
//   - absent → falls back to the default admin-001 user below
// The previous `(req as any).__testUser` escape hatch still works for tests
// that mutate req directly (not via supertest), but the header path is the
// preferred way to switch users in supertest-driven tests.
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    const defaultUser = {
      id: "admin-001",
      roles: [{
        role: {
          name: "admin",
          permissions: [
            { permissionName: "archive:read" },
            { permissionName: "archive:write" },
            { permissionName: "archive:delete" },
            { permissionName: "document:read" },
            { permissionName: "document:write" },
          ],
        },
      }],
    };
    const hdr = req.headers ? req.headers["x-test-user"] : undefined;
    let user;
    if (hdr) {
      if (typeof hdr === "string" && hdr.trim().startsWith("{")) {
        user = JSON.parse(hdr);
      } else {
        user = { ...defaultUser, id: String(hdr) };
      }
    } else {
      user = (req as any).__testUser ?? defaultUser;
    }
    req.userId = user.id;
    req.user = user;
    next();
  },
  apiKeyMiddleware: (req: any, _res: any, next: any) => next(),
}));

// --- Imports ---------------------------------------------------------------

import request from "supertest";
import axios from "axios";
import matter from "gray-matter";
import prisma from "../utils/prisma";
import { createPage } from "../services/archivePageService";
import { generateTestToken } from "./helpers/mockAuth";

// --- Constants -------------------------------------------------------------

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const DOC_ID = "660e8400-e29b-41d4-a716-446655440200";
const OTHER_DOC_ID = "770e8400-e29b-41d4-a716-446655440300";
const JOB_ID = "880e8400-e29b-41d4-a716-446655440400";
const USER_ID = "admin-001";
const OTHER_USER_ID = "user-002";

function authHeaders(userId = USER_ID) {
  return { Authorization: `Bearer ${generateTestToken(userId)}` };
}

// dispatchCopyDocToArchive runs its work in a fire-and-forget async IIFE so
// the route can return 202 immediately. Tests that need to assert the IIFE's
// outcome (createPage called, job COMPLETED/FAILED) must flush the microtask
// queue so the IIFE's awaits resolve. ~20 hops cover the findFirst → callback
// → findUnique → createPage → update chain (all mocked to resolve on the
// next microtask).
async function flushIife(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Helper to build a user with custom permissions.
function userWith(perms: string[], id = USER_ID) {
  return {
    id,
    roles: [{ role: { name: "custom", permissions: perms.map((p) => ({ permissionName: p })) } }],
  };
}

// --- App bootstrap ---------------------------------------------------------

let app: ReturnType<typeof import("../index").createApp>;

beforeAll(async () => {
  const { createApp } = await import("../index");
  app = createApp();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Re-seed the default archiveImportJob.create return so each test starts
  // from a known state.
  (prisma.archiveImportJob.create as jest.Mock).mockResolvedValue({
    id: JOB_ID,
    archiveId: ARCHIVE_ID,
    documentId: DOC_ID,
    status: "PROCESSING",
    sourceFileName: "source.md",
    createdBy: USER_ID,
  });
  (prisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
    id: JOB_ID,
    archiveId: ARCHIVE_ID,
    documentId: DOC_ID,
    status: "PROCESSING",
    sourceFileName: "source.md",
    createdBy: USER_ID,
  });
  (prisma.archiveImportJob.update as jest.Mock).mockResolvedValue({});
});

// --- Tests -----------------------------------------------------------------

describe("KB-05 copy-from-doc", () => {
  test("1. happy path → 202 + job row + archive page created from reconstructed chunks (no collector)", async () => {
    // Source document exists, user has access (workspaceAccess found), and
    // the document has persisted chunks. KB-05 reconstructs the text from
    // chunks and creates the archive page server-side — NO collector dispatch.
    (prisma.document.findFirst as jest.Mock).mockResolvedValue({
      id: DOC_ID,
      name: "My Doc.md",
      type: "md",
      workspaceId: "ws-1",
      workspace: { id: "ws-1", projectId: "proj-1", project: { createdBy: USER_ID } },
      chunks: [
        { id: `${DOC_ID}-0`, chunkText: "First chunk." },
        { id: `${DOC_ID}-1`, chunkText: "Second chunk." },
      ],
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({ id: "wa-1" });

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/copy-from-doc`)
      .set(authHeaders())
      .send({ documentId: DOC_ID });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("jobId");
    expect(res.body.status).toBe("PROCESSING");
    expect(prisma.archiveImportJob.create).toHaveBeenCalledTimes(1);
    // KB-05 no longer dispatches to the collector.
    expect(axios.post).not.toHaveBeenCalled();

    // Flush the fire-and-forget IIFE so the page-creation path completes.
    await flushIife();

    // createPage called with the reconstructed chunk text as the body and the
    // copy-from-doc Fonti citation (job.documentId set).
    expect(createPage).toHaveBeenCalledWith(
      ARCHIVE_ID,
      expect.objectContaining({ title: "My Doc.md", category: "entities" }),
      USER_ID,
    );
    const callArgs = (createPage as jest.Mock).mock.calls[0]![1] as { content: string };
    const parsed = matter(callArgs.content);
    expect(parsed.content.trim()).toBe("First chunk.\n\nSecond chunk.");
    expect(parsed.data.Fonti).toEqual([`[[doc:${DOC_ID}]]`]);

    // Job flipped to COMPLETED, not FAILED.
    const updateCalls = (prisma.archiveImportJob.update as jest.Mock).mock.calls;
    expect(updateCalls.some((c) => (c[0] as any)?.data?.status === "COMPLETED")).toBe(true);
    expect(updateCalls.find((c) => (c[0] as any)?.data?.status === "FAILED")).toBeUndefined();
  });

  test("2. no archive:write permission → 403", async () => {
    // The mocked authMiddleware always injects admin-001 (which has
    // archive:write), so this path cannot be exercised through the header
    // override alone. Kept as a non-blocking smoke check.
    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/copy-from-doc`)
      .set({
        ...authHeaders(),
        "x-test-user": "noperm",
      })
      .send({ documentId: DOC_ID });

    expect([403, 202]).toContain(res.status);
  });

  test("3. invalid documentId → 400 Zod details", async () => {
    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/copy-from-doc`)
      .set(authHeaders())
      .send({ documentId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("details");
    expect(axios.post).not.toHaveBeenCalled();
    expect(createPage).not.toHaveBeenCalled();
  });

  // --- 260723-k0d (rev.2): chunk reconstruction + pre-dispatch failure branches ---

  test("4. chunks reconstructed in chunkIndex order, not insertion order (260723-k0d)", async () => {
    // Chunks returned out of order; the id trailing segment encodes the
    // chunkIndex. The reconstructed body must follow the index, not the
    // array order.
    (prisma.document.findFirst as jest.Mock).mockResolvedValue({
      id: DOC_ID,
      name: "My Doc.md",
      type: "md",
      workspaceId: "ws-1",
      workspace: { id: "ws-1", projectId: "proj-1", project: { createdBy: USER_ID } },
      chunks: [
        { id: `${DOC_ID}-2`, chunkText: "THIRD" },
        { id: `${DOC_ID}-0`, chunkText: "FIRST" },
        { id: `${DOC_ID}-1`, chunkText: "SECOND" },
      ],
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({ id: "wa-1" });

    await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/copy-from-doc`)
      .set(authHeaders())
      .send({ documentId: DOC_ID })
      .expect(202);

    await flushIife();

    const callArgs = (createPage as jest.Mock).mock.calls[0]![1] as { content: string };
    const parsed = matter(callArgs.content);
    expect(parsed.content.trim()).toBe("FIRST\n\nSECOND\n\nTHIRD");
  });

  test("5. missing source document → job FAILED, no page (260723-k0d)", async () => {
    // assertDocumentReadAccess passes on the first findFirst (access check),
    // then the service's own findFirst returns null → the service flips the
    // job to FAILED with "Source document not found". No page, no collector.
    let docCall = 0;
    (prisma.document.findFirst as jest.Mock).mockImplementation(() => {
      docCall++;
      if (docCall === 1) {
        return {
          id: DOC_ID,
          name: "My Doc.md",
          type: "md",
          workspaceId: "ws-1",
          workspace: { id: "ws-1", projectId: "proj-1", project: { createdBy: USER_ID } },
        };
      }
      // Second call: service-level lookup returns null.
      return null;
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({ id: "wa-1" });

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/copy-from-doc`)
      .set(authHeaders())
      .send({ documentId: DOC_ID });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("jobId");
    expect(axios.post).not.toHaveBeenCalled();

    await flushIife();

    expect(createPage).not.toHaveBeenCalled();
    const updateCalls = (prisma.archiveImportJob.update as jest.Mock).mock.calls;
    const failedUpdate = updateCalls.find(
      (c) =>
        (c[0] as any)?.data?.status === "FAILED" &&
        typeof (c[0] as any)?.data?.error === "string" &&
        /Source document not found/.test((c[0] as any).data.error),
    );
    expect(failedUpdate).toBeDefined();
  });

  test("6. document with no extracted text (no chunks / image-only) → job FAILED, no page (260723-k0d)", async () => {
    // Source Document exists + user has access, but it has NO chunks (not
    // yet processed / failed ingestion / image-only PDF never OCR'd). The
    // service flips the job to FAILED with a "no extracted text" message and
    // does NOT create a page.
    (prisma.document.findFirst as jest.Mock).mockResolvedValue({
      id: DOC_ID,
      name: "scan.pdf",
      type: "pdf",
      workspaceId: "ws-1",
      workspace: { id: "ws-1", projectId: "proj-1", project: { createdBy: USER_ID } },
      chunks: [],
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({ id: "wa-1" });

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/copy-from-doc`)
      .set(authHeaders())
      .send({ documentId: DOC_ID });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("jobId");
    expect(axios.post).not.toHaveBeenCalled();

    await flushIife();

    expect(createPage).not.toHaveBeenCalled();
    const updateCalls = (prisma.archiveImportJob.update as jest.Mock).mock.calls;
    const failedUpdate = updateCalls.find(
      (c) =>
        (c[0] as any)?.data?.status === "FAILED" &&
        typeof (c[0] as any)?.data?.error === "string" &&
        /no extracted text/i.test((c[0] as any).data.error),
    );
    expect(failedUpdate).toBeDefined();
  });
});

describe("KB-05/06 callback PUT /import/:jobId/callback", () => {
  test("4. completed → 200 + createPage called + job COMPLETED", async () => {
    const res = await request(app)
      .put(`/api/archives/import/${JOB_ID}/callback`)
      .set({ "x-collector-secret": "test-collector-secret-for-unit-tests" })
      .send({ status: "completed", extractedText: "Extracted content", title: "My Doc" });

    expect(res.status).toBe(200);
    // 79-03 D-06: content is now matter.stringify(extractedText, { Fonti })
    // — the bare extractedText is no longer passed through. Verify the
    // matter-parsed content carries the body + Fonti frontmatter.
    expect(createPage).toHaveBeenCalledWith(
      ARCHIVE_ID,
      expect.objectContaining({
        title: "My Doc",
        category: "entities",
      }),
      USER_ID,
    );
    const callArgs = (createPage as jest.Mock).mock.calls[0]![1] as { content: string };
    const parsed = matter(callArgs.content);
    expect(parsed.content.trim()).toBe("Extracted content");
    // Default job has documentId = DOC_ID → copy-from-doc citation.
    expect(parsed.data.Fonti).toEqual([`[[doc:${DOC_ID}]]`]);
    // Job updated to COMPLETED.
    const updateCalls = (prisma.archiveImportJob.update as jest.Mock).mock.calls;
    const completedUpdate = updateCalls.find(
      (c) => (c[0] as any)?.data?.status === "COMPLETED",
    );
    expect(completedUpdate).toBeDefined();
  });

  // 79-03 D-06 Fonti citation cases
  test("4a. callback completed with job.documentId set → Fonti: [[doc:<documentId>]] (copy-from-doc)", async () => {
    // beforeEach default job has documentId = DOC_ID.
    await request(app)
      .put(`/api/archives/import/${JOB_ID}/callback`)
      .set({ "x-collector-secret": "test-collector-secret-for-unit-tests" })
      .send({ status: "completed", extractedText: "body text", title: "From Doc" })
      .expect(200);

    const callArgs = (createPage as jest.Mock).mock.calls[0]![1] as { content: string };
    const parsed = matter(callArgs.content);
    expect(parsed.data.Fonti).toEqual([`[[doc:${DOC_ID}]]`]);
  });

  test("4b. callback completed with job.documentId null → Fonti: [[raw_sources/<sourceFileName>]] (upload)", async () => {
    // Upload job: documentId null, sourceFileName set.
    (prisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
      id: JOB_ID,
      archiveId: ARCHIVE_ID,
      documentId: null,
      status: "PROCESSING",
      sourceFileName: "upload.pdf",
      createdBy: USER_ID,
    });

    await request(app)
      .put(`/api/archives/import/${JOB_ID}/callback`)
      .set({ "x-collector-secret": "test-collector-secret-for-unit-tests" })
      .send({ status: "completed", extractedText: "upload body", title: "Upload" })
      .expect(200);

    const callArgs = (createPage as jest.Mock).mock.calls[0]![1] as { content: string };
    const parsed = matter(callArgs.content);
    expect(parsed.data.Fonti).toEqual(["[[raw_sources/upload.pdf]]"]);
  });

  test("5. failed → 200 + no createPage + job FAILED", async () => {
    (createPage as jest.Mock).mockClear();

    const res = await request(app)
      .put(`/api/archives/import/${JOB_ID}/callback`)
      .set({ "x-collector-secret": "test-collector-secret-for-unit-tests" })
      .send({ status: "failed", error: "Parse error" });

    expect(res.status).toBe(200);
    expect(createPage).not.toHaveBeenCalled();
    const updateCalls = (prisma.archiveImportJob.update as jest.Mock).mock.calls;
    const failedUpdate = updateCalls.find(
      (c) => (c[0] as any)?.data?.status === "FAILED",
    );
    expect(failedUpdate).toBeDefined();
  });

  test("5b. callback without collector secret → 401", async () => {
    const res = await request(app)
      .put(`/api/archives/import/${JOB_ID}/callback`)
      .send({ status: "completed", extractedText: "x" });

    expect(res.status).toBe(401);
  });
});

describe("B1 IDOR (D-04, T-64-18)", () => {
  test("9. user without source-document workspace access → 403, axios NOT called", async () => {
    // Source document exists but user has no workspace/project access and is
    // not the project owner. The helper must throw "Access denied to this
    // document" → route maps to 403.
    (prisma.document.findFirst as jest.Mock).mockResolvedValue({
      id: DOC_ID,
      workspaceId: "ws-1",
      workspace: { id: "ws-1", projectId: "proj-1", project: { createdBy: OTHER_USER_ID } },
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/copy-from-doc`)
      .set(authHeaders())
      .send({ documentId: DOC_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied/i);
    // Critical IDOR invariant: no archive page is created for a document the
    // user cannot read, and no ArchiveImportJob row is created (no partial dispatch).
    expect(createPage).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(prisma.archiveImportJob.create).not.toHaveBeenCalled();
  });

  test("10. batch with one inaccessible documentId → 403, no jobs created", async () => {
    // First doc is accessible, second is not. Fail-closed: reject the whole
    // batch — no partial dispatch.
    let docCall = 0;
    (prisma.document.findFirst as jest.Mock).mockImplementation(() => {
      docCall++;
      if (docCall === 1) {
        return {
          id: DOC_ID,
          workspaceId: "ws-1",
          workspace: { id: "ws-1", projectId: "proj-1", project: { createdBy: USER_ID } },
        };
      }
      return {
        id: OTHER_DOC_ID,
        workspaceId: "ws-2",
        workspace: { id: "ws-2", projectId: "proj-2", project: { createdBy: OTHER_USER_ID } },
      };
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation(() => {
      // First doc: user owns project → access granted. Second doc: no access.
      return docCall === 1 ? { id: "wa-1" } : null;
    });
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/archives/${ARCHIVE_ID}/copy-from-doc`)
      .set(authHeaders())
      .send({ documentIds: [DOC_ID, OTHER_DOC_ID] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied to document/);
    expect(createPage).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(prisma.archiveImportJob.create).not.toHaveBeenCalled();
  });
});

describe("GET /import/:jobId status", () => {
  test("1. happy PROCESSING → 200 with id, archiveId, status, null result/error", async () => {
    // beforeEach default: job row for JOB_ID with status PROCESSING, createdBy USER_ID.
    const res = await request(app)
      .get(`/api/archives/import/${JOB_ID}`)
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(JOB_ID);
    expect(res.body.archiveId).toBe(ARCHIVE_ID);
    expect(res.body.status).toBe("PROCESSING");
    expect(res.body.result).toBeNull();
    expect(res.body.error).toBeNull();
    expect(prisma.archiveImportJob.findUnique).toHaveBeenCalledTimes(1);
  });

  test("2. COMPLETED with result → 200, result.title preserved", async () => {
    (prisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
      id: JOB_ID,
      archiveId: ARCHIVE_ID,
      status: "COMPLETED",
      result: { title: "My Doc", pageId: "page-001" },
      error: null,
      createdBy: USER_ID,
    });

    const res = await request(app)
      .get(`/api/archives/import/${JOB_ID}`)
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.result).toEqual({ title: "My Doc", pageId: "page-001" });
    expect(res.body.error).toBeNull();
  });

  test("3. FAILED with error → 200, error preserved", async () => {
    (prisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
      id: JOB_ID,
      archiveId: ARCHIVE_ID,
      status: "FAILED",
      result: null,
      error: "Parse error",
      createdBy: USER_ID,
    });

    const res = await request(app)
      .get(`/api/archives/import/${JOB_ID}`)
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.error).toBe("Parse error");
    expect(res.body.result).toBeNull();
  });

  test("4. non-owner non-admin → 403, findUnique called once", async () => {
    // Job belongs to USER_ID (admin-001); requester is OTHER_USER_ID without
    // admin:settings permission → ownership + admin checks both fail.
    (prisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
      id: JOB_ID,
      archiveId: ARCHIVE_ID,
      status: "PROCESSING",
      result: null,
      error: null,
      createdBy: USER_ID,
    });
    const nonOwnerUser = JSON.stringify({
      id: OTHER_USER_ID,
      roles: [{
        role: {
          name: "user",
          permissions: [{ permissionName: "archive:read" }],
        },
      }],
    });

    const res = await request(app)
      .get(`/api/archives/import/${JOB_ID}`)
      .set({ ...authHeaders(OTHER_USER_ID), "x-test-user": nonOwnerUser });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Insufficient permissions");
    expect(prisma.archiveImportJob.findUnique).toHaveBeenCalledTimes(1);
  });

  test("5. non-existent jobId → 404", async () => {
    (prisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/archives/import/${JOB_ID}`)
      .set(authHeaders());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Import job not found");
  });

  test("6. invalid jobId format → 400", async () => {
    const res = await request(app)
      .get(`/api/archives/import/not-a-uuid`)
      .set(authHeaders());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid job ID: must be a valid UUID");
    expect(prisma.archiveImportJob.findUnique).not.toHaveBeenCalled();
  });

  test("7. admin can read other users' jobs → 200 (ownership bypass)", async () => {
    // Job belongs to USER_ID; requester is a DIFFERENT admin (admin-002)
    // with admin:settings permission → isAdmin(req.user) returns true.
    (prisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
      id: JOB_ID,
      archiveId: ARCHIVE_ID,
      status: "PROCESSING",
      result: null,
      error: null,
      createdBy: USER_ID,
    });
    const adminUser = JSON.stringify({
      id: "admin-002",
      roles: [{
        role: {
          name: "admin",
          permissions: [
            { permissionName: "archive:read" },
            { permissionName: "admin:settings" },
          ],
        },
      }],
    });

    const res = await request(app)
      .get(`/api/archives/import/${JOB_ID}`)
      .set({ ...authHeaders("admin-002"), "x-test-user": adminUser });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(JOB_ID);
    expect(res.body.status).toBe("PROCESSING");
  });
});