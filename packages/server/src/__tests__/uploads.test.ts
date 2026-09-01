// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 69 — Plan 69-03 Task 1 + Task 3.
 *
 * Integration tests for the three UploadDraft routes mounted on an isolated
 * Express app (only the uploads router, NOT the full index.ts). Covers:
 *   DST-02  — stage creates draft, no Document row
 *   DST-04  — assign fan-out uses Promise.allSettled via dispatchUploadDraft
 *   DST-04  — per-leg failure isolation (RAG rejects, KB fulfils)
 *   SC-3    — pending workspace-scoped IDOR (uploadedBy + workspaceId filter)
 *   D-69-08 — IDOR cross-user blocked (403)
 *   D-69-06 — image + rag rejected; KB MIME restricted
 *   INT-02  — KB leg reuses archiveImport (Buffer signature, Pitfall 2)
 *   C2      — expiresAt NaN-safe fallback (Pitfall 7)
 *   SC-5    — collector routes byte-identical, ingest.schema.ts unchanged
 *
 * Mocks (no real DB / no real collector HTTP):
 *   - prisma singleton (custom factory — includes uploadDraft + workspace + workspaceAccess + projectAccess + document + archiveImportJob)
 *   - authMiddleware / requirePermission as pass-throughs (set req.userId = "user-a")
 *   - getSetting (NaN-safe retention test)
 *   - dispatchUploadDraft + enrichDraftWithLegStatus (KB/RAG legs isolated via partial mock; dispatchKbLeg stays real for INT-02)
 *   - dispatchUploadToArchive (INT-02 mock target)
 *   - forwardToCollector (DST-04 RAG leg isolation)
 *
 * The `../config/env` mock matches the B1 fix: no STORAGE_PATH key (uploads.ts
 * uses the literal "storage/uploads/drafts" relative path).
 */
import "./helpers/setupEnv";

// --- Prisma mock (custom factory — adds uploadDraft) -----------------------
// NOTE: mock object lives INSIDE the factory to avoid TDZ under @swc/jest
// (SWC hoists ESM imports above `const`; factory runs at import-time before
// the outer const would initialize). Exposed via require() after jest.mock.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    uploadDraft: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    workspace: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    workspaceAccess: {
      findFirst: jest.fn(),
    },
    projectAccess: {
      findFirst: jest.fn(),
    },
    document: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    archive: {
      findUnique: jest.fn(),
    },
    archiveImportJob: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    ocrJob: {
      create: jest.fn(),
      // 260814-wxr: finalizeAutoApproveOnComplete does
      // prisma.ocrJob.findUnique (sourceFileName title fallback) — without it
      // the hook's non-fatal try/catch silently swallows a TypeError and the
      // AIJ is never updated.
      findUnique: jest.fn(),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));
const mockPrisma = require("../utils/prisma").default;

// --- env mock (B1 fix: NO STORAGE_PATH key) --------------------------------
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    OCR_MODEL: "glm-ocr:latest",
    LLM_MODEL: "gemma4:latest",
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

// --- auth / rbac pass-throughs --------------------------------------------
// Phase 70: the authMiddleware mock reads from a mutable global holder so
// SC-1a/2a/2b tests can inject admin / non-admin users WITHOUT
// jest.resetModules() (which would re-instantiate the getSetting mock and
// lose the per-test mockImplementation set in beforeEach).
const DEFAULT_AUTH_USER = { id: "user-a", role: "user", permissions: [] } as any;
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.userId = (global as any).__AUTH_USER_ID__ ?? "user-a";
    req.user = (global as any).__AUTH_USER__ ?? DEFAULT_AUTH_USER;
    next();
  },
}));
jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireProjectAccess: (_req: any, _res: any, next: any) => next(),
  requireWorkspaceAccess: (_req: any, _res: any, next: any) => next(),
}));

// --- systemConfigService.getSetting (NaN-safe retention test) -------------
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(() => ({ key: "upload_draft_retention_days", value: "30" })),
  seedConfigDefaults: jest.fn(),
}));

// --- archiveImportService (INT-02 mock target) -----------------------------
jest.mock("../services/archiveImportService", () => ({
  dispatchUploadToArchive: jest.fn(() => Promise.resolve({ jobId: "job-1" })),
}));

// --- ocrJobService (createOcrJob mock for 71-02 OCR branch) -----------------
jest.mock("../services/ocrJobService", () => ({
  createOcrJob: jest.fn(() => Promise.resolve({ id: "ocr-job-1" })),
  parseOcrJobResult: jest.fn((r: unknown) => (r && typeof r === "object" ? r : {})),
}));

// --- documents route (DST-04 RAG leg isolation) ---------------------------
jest.mock("../routes/documents", () => ({
  forwardToCollector: jest.fn(() => Promise.resolve()),
  __esModule: true,
  default: { use: () => {} },
}));

// --- uploadDraftService partial mock --------------------------------------
// Keep dispatchKbLeg + dispatchRagLeg real (INT-02 test calls dispatchKbLeg
// directly and asserts the Buffer signature through the mocked
// dispatchUploadToArchive). Mock dispatchUploadDraft + enrichDraftWithLegStatus
// so the route tests don't hit the real fan-out / enrichment.
jest.mock("../services/uploadDraftService", () => {
  const actual = jest.requireActual("../services/uploadDraftService");
  return {
    ...actual,
    dispatchUploadDraft: jest.fn(),
    enrichDraftWithLegStatus: jest.fn((draft: any) =>
      Promise.resolve({ ...draft, ragStatus: null, kbStatus: null }),
    ),
  };
});

import request from "supertest";
import express from "express";
import fs from "fs";
import path from "path";
import uploadRoutes from "../routes/uploads";
import { dispatchUploadDraft, dispatchKbLeg, dispatchRagLeg, enrichDraftWithLegStatus } from "../services/uploadDraftService";
import { dispatchUploadToArchive } from "../services/archiveImportService";
import { getSetting } from "../services/systemConfigService";
import { logger } from "../utils/logger";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/uploads", uploadRoutes);

// Use a real workspaceId UUID (createUploadDraftSchema validates UUID).
const WS_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVE_ID = "22222222-2222-4222-8222-222222222222";

// 260814-wxr: the POST /:id/assign route now pre-checks draft.filePath on
// disk via fs.existsSync when kb=true. The staged draft fixtures point at
// fake paths (storage/uploads/drafts/test.md etc.) that never exist, so the
// happy-path assign tests simulate a PRESENT file by default; the stale-
// draft guard suite (260814-wxr Task2) overrides per-test with `false`.
// Restore-by-reference per test (NOT mockRestore, which would leak the mock
// into the next test because we re-apply in beforeEach).
const REAL_FS_EXISTS_SYNC = fs.existsSync;

/** Standard workspace fixture: project createdBy "user-a" so the access check passes for user-a.
 * Phase 70: includes allowMemberUploads=true so the D-02 toggle OR gate passes
 * for the default non-admin user under the default ALLOW_NON_ADMIN_UPLOAD=true mock. */
const accessibleWorkspace = (workspaceId: string) => ({
  id: workspaceId,
  projectId: "proj-1",
  name: "Test Workspace",
  allowMemberUploads: true,
  project: { id: "proj-1", createdBy: "user-a" },
});

/** Draft fixture builder. */
const draftFixture = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "draft-1",
  uploadedBy: "user-a",
  workspaceId: WS_ID,
  filePath: "storage/uploads/drafts/draft-1",
  originalName: "test.md",
  fileSize: 5,
  mimeType: "text/markdown",
  expiresAt: new Date(Date.now() + 30 * 86400000),
  ragEnabled: false,
  kbEnabled: false,
  ragJobId: null,
  kbJobId: null,
  assignedArchiveId: null,
  parseStatus: "uploaded",
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  // 260814-wxr: default "file present on disk" for the route-level guard.
  fs.existsSync = REAL_FS_EXISTS_SYNC;
  jest.spyOn(fs, "existsSync").mockReturnValue(true);
  // Phase 70: reset the auth holder to the default non-admin user before each test
  (global as any).__AUTH_USER_ID__ = undefined;
  (global as any).__AUTH_USER__ = undefined;
  // Default getSetting returns 30 days + ALLOW_NON_ADMIN_UPLOAD=true so the
  // existing stage tests (which use accessibleWorkspace with allowMemberUploads=true)
  // pass the D-02 gate without flipping toggles per-test.
  (getSetting as jest.Mock).mockImplementation((key: string) => {
    if (key === "ALLOW_NON_ADMIN_UPLOAD") return { key, value: "true" };
    if (key === "upload_draft_retention_days") return { key, value: "30" };
    if (key === "EMBEDDING_MODEL") return { key, value: "Xenova/all-MiniLM-L6-v2" };
    if (key === "OCR_DEFAULT_MODEL") return { key, value: "glm-ocr:latest" };
    return { key, value: "" };
  });
  // Default workspace access: user-a owns the project → access granted
  (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessibleWorkspace(WS_ID));
  (mockPrisma.workspace.findUnique as jest.Mock).mockResolvedValue({ id: WS_ID, name: "Test Workspace" });
  (mockPrisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (mockPrisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  // Phase 70 D-06: default archive owned by user-a so existing assign tests
  // that send kb=true + archiveId pass the new archive-ownership gate.
  (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
    id: ARCHIVE_ID,
    createdBy: "user-a",
    deletedAt: null,
  });
  // 71-02: default AIJ create returns a row with id "aij-default" so the
  // refactored dispatchKbLeg (AIJ-first) works in tests that call the real
  // dispatchKbLeg via jest.requireActual (CR-01 regression + INT-02 reuse).
  (mockPrisma.archiveImportJob.create as jest.Mock).mockResolvedValue({
    id: "aij-default",
    archiveId: ARCHIVE_ID,
    status: "PROCESSING",
    sourceFileName: "test.md",
    createdBy: "user-a",
    result: undefined,
  });
  (mockPrisma.archiveImportJob.update as jest.Mock).mockResolvedValue({});
  (mockPrisma.ocrJob.create as jest.Mock).mockResolvedValue({ id: "ocr-job-default" });
  (mockPrisma.uploadDraft.create as jest.Mock).mockImplementation((args: any) =>
    Promise.resolve({
      id: "draft-1",
      parseStatus: "uploaded",
      expiresAt: args?.data?.expiresAt ?? new Date(),
      originalName: args?.data?.originalName,
      fileSize: args?.data?.fileSize,
      mimeType: args?.data?.mimeType,
      ...args?.data,
    }),
  );
});

// =========================================================================
// POST /api/uploads
// =========================================================================
describe("POST /api/uploads", () => {
  it("POST /api/uploads stages draft without creating a Document row", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .field("workspaceId", WS_ID)
      .field("originalName", "test.md")
      .attach("file", Buffer.from("hello"), { filename: "test.md", contentType: "text/markdown" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body.parseStatus).toBe("uploaded");
    expect(res.body.expiresAt).toBeDefined();
    expect(res.body.originalName).toBe("test.md");
    // D-06 / T-69-e: filePath MUST NOT leak into the response body
    expect(res.body).not.toHaveProperty("filePath");

    // DST-02: uploadDraft.create called with filePath set (multer wrote the file)
    expect(mockPrisma.uploadDraft.create).toHaveBeenCalledTimes(1);
    const createArgs = (mockPrisma.uploadDraft.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.filePath).toBeDefined();
    expect(createArgs.data.filePath).toContain("storage/uploads/drafts");
    expect(createArgs.data.uploadedBy).toBe("user-a");
    expect(createArgs.data.workspaceId).toBe(WS_ID);

    // DST-02: NO Document row was created (stage only writes an UploadDraft)
    expect(mockPrisma.document.create).not.toHaveBeenCalled();
  });

  it("expiresAt NaN fallback: upload_draft_retention_days=abc defaults to 30 days", async () => {
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "upload_draft_retention_days") return { key, value: "abc" };
      if (key === "EMBEDDING_MODEL") return { key, value: "Xenova/all-MiniLM-L6-v2" };
      if (key === "OCR_DEFAULT_MODEL") return { key, value: "glm-ocr:latest" };
      return { key, value: "" };
    });

    const res = await request(app)
      .post("/api/uploads")
      .field("workspaceId", WS_ID)
      .field("originalName", "test.md")
      .attach("file", Buffer.from("hello"), { filename: "test.md", contentType: "text/markdown" });

    expect(res.status).toBe(201);

    const createArgs = (mockPrisma.uploadDraft.create as jest.Mock).mock.calls[0][0];
    const expiresAt = new Date(createArgs.data.expiresAt).getTime();
    const now = Date.now();
    const thirtyDays = 30 * 86400000;
    // ±60s tolerance — Date.now() captured after the call
    expect(Math.abs(expiresAt - (now + thirtyDays))).toBeLessThan(60000);
  });

  it("quick 260808-vzm: stages the sanitized originalName (spaces -> dashes)", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .field("workspaceId", WS_ID)
      .field("originalName", "My Report.txt")
      .attach("file", Buffer.from("hello"), { filename: "My Report.txt", contentType: "text/plain" });

    expect(res.status).toBe(201);
    // The create mock returns originalName from args.data, so the response
    // reflects exactly what was stored.
    expect(res.body.originalName).toBe("My-Report.txt");
    const createArgs = (mockPrisma.uploadDraft.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.originalName).toBe("My-Report.txt");
  });
});

// =========================================================================
// Phase 70 — SC-1a toggle OR on POST /api/uploads (stage route)
// D-02: assertNonAdminUploadAllowed = global || workspace.allowMemberUploads
// D-03: fail-closed parse (value === "true")
// =========================================================================
describe("POST /api/uploads — SC-1a toggle OR (Phase 70 D-02/D-03)", () => {
  /** Non-admin user fixture (no admin:settings permission). */
  const nonAdminUser = {
    id: "user-a",
    roles: [{ role: { permissions: [{ permissionName: "document:write" }] } }],
  } as any;

  /** Admin user fixture (has admin:settings). */
  const adminUser = {
    id: "admin-1",
    roles: [{ role: { permissions: [{ permissionName: "admin:settings" }] } }],
  } as any;

  /** Workspace fixture with explicit allowMemberUploads + project owner. */
  const wsFixture = (allowMemberUploads: boolean, projectOwner: string) => ({
    id: WS_ID,
    projectId: "proj-1",
    name: "Test Workspace",
    allowMemberUploads,
    project: { id: "proj-1", createdBy: projectOwner },
  });

  beforeEach(() => {
    // default: non-admin user
    (global as any).__AUTH_USER_ID__ = "user-a";
    (global as any).__AUTH_USER__ = nonAdminUser;
    (mockPrisma.uploadDraft.create as jest.Mock).mockResolvedValue({
      id: "draft-1",
      parseStatus: "uploaded",
      expiresAt: new Date(),
      originalName: "test.md",
      fileSize: 5,
      mimeType: "text/markdown",
    });
  });

  it("non-admin with both toggles false → 403 (stage route gate)", async () => {
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { key, value: "false" };
      if (key === "upload_draft_retention_days") return { key, value: "30" };
      return { key, value: "" };
    });
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(wsFixture(false, "user-a"));

    const res = await request(app)
      .post("/api/uploads")
      .field("workspaceId", WS_ID)
      .field("originalName", "test.md")
      .attach("file", Buffer.from("hello"), { filename: "test.md", contentType: "text/markdown" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/restricted to admins/i);
    // WR-01: the stage route must NOT create a draft on 403
    expect(mockPrisma.uploadDraft.create).not.toHaveBeenCalled();
  });

  it("non-admin with allowMemberUploads=true (global=false) → 201 (OR-inclusive)", async () => {
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { key, value: "false" };
      if (key === "upload_draft_retention_days") return { key, value: "30" };
      return { key, value: "" };
    });
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(wsFixture(true, "user-a"));

    const res = await request(app)
      .post("/api/uploads")
      .field("workspaceId", WS_ID)
      .field("originalName", "test.md")
      .attach("file", Buffer.from("hello"), { filename: "test.md", contentType: "text/markdown" });

    expect(res.status).toBe(201);
  });

  it("non-admin with ALLOW_NON_ADMIN_UPLOAD=true (allowMemberUploads=false) → 201 (OR-inclusive)", async () => {
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { key, value: "true" };
      if (key === "upload_draft_retention_days") return { key, value: "30" };
      return { key, value: "" };
    });
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(wsFixture(false, "user-a"));

    const res = await request(app)
      .post("/api/uploads")
      .field("workspaceId", WS_ID)
      .field("originalName", "test.md")
      .attach("file", Buffer.from("hello"), { filename: "test.md", contentType: "text/markdown" });

    expect(res.status).toBe(201);
  });

  it("admin bypasses the toggle even with both toggles false → 201", async () => {
    (global as any).__AUTH_USER_ID__ = "admin-1";
    (global as any).__AUTH_USER__ = adminUser;
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { key, value: "false" };
      if (key === "upload_draft_retention_days") return { key, value: "30" };
      return { key, value: "" };
    });
    // admin owns the project → workspace access granted
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(wsFixture(false, "admin-1"));

    const res = await request(app)
      .post("/api/uploads")
      .field("workspaceId", WS_ID)
      .field("originalName", "test.md")
      .attach("file", Buffer.from("hello"), { filename: "test.md", contentType: "text/markdown" });

    expect(res.status).toBe(201);
  });
});

// =========================================================================
// POST /api/uploads/:id/assign
// =========================================================================
describe("POST /api/uploads/:id/assign", () => {
  it("POST /api/uploads assign fan-out uses Promise.allSettled via dispatchUploadDraft", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown" }),
    );
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: { status: "fulfilled", value: { ragJobId: "doc-1" } },
      kbResult: { status: "fulfilled", value: { kbJobId: "job-1" } },
      parseStatus: "assigned",
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: true, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(res.body.parseStatus).toBe("assigned");
    // DST-04: dispatchUploadDraft was called once with (draft, { rag: true, kb: true, archiveId })
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
    const [draftArg, targetsArg] = (dispatchUploadDraft as jest.Mock).mock.calls[0];
    expect(draftArg.id).toBe("draft-1");
    expect(targetsArg).toEqual({ rag: true, kb: true, archiveId: ARCHIVE_ID });
  });

  it("per-leg failure isolation: RAG leg fails, KB leg succeeds", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown" }),
    );
    // Promise.allSettled proof: ragResult.rejected, kbResult.fulfilled — aggregate still resolves
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: { status: "rejected", reason: new Error("collector down") },
      kbResult: { status: "fulfilled", value: { kbJobId: "job-1" } },
      parseStatus: "assigned",
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: true, kb: true, archiveId: ARCHIVE_ID });

    // NOT 500 — allSettled isolates per-leg failure
    expect(res.status).toBe(200);
    expect(res.body.ragResult).toBe("rejected");
    expect(res.body.kbResult).toBe("fulfilled");
  });

  it("IDOR cross-user blocked: user A cannot assign user B's draft without workspace access", async () => {
    // Draft owned by user-b in user-b's workspace
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ uploadedBy: "user-b", workspaceId: "ws-b" }),
    );
    // Workspace exists but user-a has no access (project owned by user-b, no explicit grants)
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: "ws-b",
      projectId: "p-b",
      name: "User B Workspace",
      project: { id: "p-b", createdBy: "user-b" },
    });
    (mockPrisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(403);
    // The route reuses assertWorkspaceAccess which writes the generic
    // "Access denied to this workspace" message; the IDOR IS blocked —
    // dispatchUploadDraft must NOT have run.
    expect(res.body.error).toMatch(/Access denied/);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  it("image rag rejected with 400", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "image/png" }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Images can only be assigned to Knowledge Base, not RAG");
    expect(res.body.details).toEqual({ mimeType: "image/png", rag: true });
    // Rejection BEFORE dispatch
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  it("kb mime restricted: kb=true with text/plain now ACCEPTED (quick 260829-xxx txt/csv→KB gap closed) — still-unknown MIME stays 400", async () => {
    // text/plain moved into ALLOWED_ARCHIVE_MIME (quick 260829-xxx): the
    // collector's parse-only /api/ingest/archive-page already parses .txt
    // (parseFile "txt" branch) and its multer fileFilter allows .txt/.csv,
    // so the assign route now dispatches the KB leg for it.
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/plain" }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);

    // Defense-in-depth still holds for a MIME outside every KB set — the
    // legacy xls MIME (application/vnd.ms-excel) is stage-allowed (12-enum)
    // but NOT in ALLOWED_ARCHIVE_MIME ∪ KB_OCR_MIME.
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "application/vnd.ms-excel" }),
    );
    const res2 = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/Knowledge Base accepts only/);
    expect(res2.body.details).toEqual({ mimeType: "application/vnd.ms-excel", kb: true });
  });
});

// =========================================================================
// Phase 70 — SC-2a IDOR cross-user admin non-bypass (D-07)
// Admin does NOT bypass workspace access on the assign route. The local
// assertWorkspaceAccess helper (uploads.ts:110) is non-bypass, mirroring
// documents.ts:381 — diverging from rbac.ts:requireWorkspaceAccess:117.
// =========================================================================
describe("POST /api/uploads/:id/assign — SC-2a admin non-bypass IDOR (D-07)", () => {
  const adminUser = {
    id: "admin-1",
    roles: [{ role: { permissions: [{ permissionName: "admin:settings" }, { permissionName: "archive:write" }, { permissionName: "document:write" }] } }],
  } as any;

  beforeEach(() => {
    (global as any).__AUTH_USER_ID__ = "admin-1";
    (global as any).__AUTH_USER__ = adminUser;
  });

  it("admin without workspace access, draft.uploadedBy !== admin → 403 (non-bypass)", async () => {
    // Draft owned by user-b in user-b's workspace
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ uploadedBy: "user-b", workspaceId: "ws-b" }),
    );
    // Workspace exists but admin-1 has no access (project owned by user-b, no grants)
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: "ws-b",
      projectId: "p-b",
      name: "User B WS",
      allowMemberUploads: true,
      project: { id: "p-b", createdBy: "user-b" },
    });
    (mockPrisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied/);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Phase 70 — SC-2b archive ownership on assign (D-06, global Archive)
// assertArchiveAccess: archive.createdBy === userId OR isAdmin (D-06a admin bypass)
// 404 when missing/soft-deleted, 403 when not owned (non-admin).
// =========================================================================
describe("POST /api/uploads/:id/assign — SC-2b archive ownership (D-06)", () => {
  const nonAdminUser = {
    id: "user-a",
    roles: [{ role: { permissions: [{ permissionName: "document:write" }, { permissionName: "archive:write" }] } }],
  } as any;

  beforeEach(() => {
    (global as any).__AUTH_USER_ID__ = "user-a";
    (global as any).__AUTH_USER__ = nonAdminUser;
  });

  it("kb=true, archiveId not owned by caller (non-admin) → 403", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-b", // owned by another user
      deletedAt: null,
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied to this archive/i);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  it("kb=true, archiveId missing → 404", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Archive not found/i);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  it("kb=true, archive soft-deleted → 404 (fail-closed)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-a",
      deletedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Archive not found/i);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  it("kb=true, archive owned by caller (createdBy === userId) → passes through to dispatch", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-a", // owner
      deletedAt: null,
    });
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: null,
      kbResult: { status: "fulfilled", value: { kbJobId: "job-1" } },
      parseStatus: "assigned",
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });

  it("kb=true, admin with non-owned archive → passes (D-06a admin bypass)", async () => {
    (global as any).__AUTH_USER_ID__ = "admin-1";
    (global as any).__AUTH_USER__ = {
      id: "admin-1",
      roles: [{ role: { permissions: [{ permissionName: "admin:settings" }, { permissionName: "archive:write" }, { permissionName: "document:write" }] } }],
    } as any;

    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "admin-1" }),
    );
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-b", // not owned by admin
      deletedAt: null,
    });
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: null,
      kbResult: { status: "fulfilled", value: { kbJobId: "job-1" } },
      parseStatus: "assigned",
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// GET /api/uploads/pending
// =========================================================================
describe("GET /api/uploads/pending", () => {
  it("pending workspace-scoped IDOR: user A cannot see user B's drafts", async () => {
    let capturedWhere: any = null;
    (mockPrisma.uploadDraft.findMany as jest.Mock).mockImplementation((args: any) => {
      capturedWhere = args.where;
      return [];
    });

    const res = await request(app).get("/api/uploads/pending?workspaceId=" + WS_ID);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(capturedWhere).not.toBeNull();
    // SC-3 / D-69-08: IDOR scope enforced at the query level
    expect(capturedWhere.uploadedBy).toBe("user-a");
    expect(capturedWhere.workspaceId).toBe(WS_ID);
    expect(capturedWhere.deletedAt).toBeNull();
    // Phase 71-06 CR-01/CR-02: the where clause no longer filters by
    // ragEnabled/kbEnabled/parseStatus — the pending endpoint returns the
    // full lifecycle (unassigned + in-flight + done) and the client-side
    // chip predicates split by parseStatus. The three keys must be absent
    // so assigned/done drafts are not silently hidden from the panel.
    expect(capturedWhere).not.toHaveProperty("ragEnabled");
    expect(capturedWhere).not.toHaveProperty("kbEnabled");
    expect(capturedWhere).not.toHaveProperty("parseStatus");
  });
});

// =========================================================================
// dispatchKbLeg (INT-02 reuse) — service-level test
// =========================================================================
describe("dispatchKbLeg (INT-02 reuse)", () => {
  it("KB leg reuses archiveImport by calling dispatchUploadToArchive with fileBuffer + preExistingJobId", async () => {
    const draft = draftFixture({
      mimeType: "text/markdown",
      originalName: "kb-doc.md",
      filePath: "storage/uploads/drafts/kb-doc.md",
    });

    // Mock fs.readFileSync to return a Buffer (Pitfall 2 proof: KB leg reads
    // the draft file into memory before dispatch — NOT a filePath).
    const readSpy = jest.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("fake-content"));
    (mockPrisma.archiveImportJob.create as jest.Mock).mockResolvedValue({
      id: "aij-int02",
      archiveId: ARCHIVE_ID,
      status: "PROCESSING",
      sourceFileName: "kb-doc.md",
      createdBy: "user-a",
    });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});

    try {
      const result = await dispatchKbLeg(draft as any, ARCHIVE_ID);

      // 71-02 Pitfall 4: kbJobId = aij.id (NOT dispatchUploadToArchive return)
      expect(result).toEqual({ kbJobId: "aij-int02" });
      // INT-02 / Pitfall 2: dispatchUploadToArchive called with a Buffer + preExistingJobId
      expect(dispatchUploadToArchive).toHaveBeenCalledTimes(1);
      const callArgs = (dispatchUploadToArchive as jest.Mock).mock.calls[0][0];
      expect(callArgs.archiveId).toBe(ARCHIVE_ID);
      expect(callArgs.userId).toBe("user-a");
      expect(callArgs.fileBuffer).toEqual(expect.any(Buffer));
      expect(callArgs.fileName).toBe("kb-doc.md");
      expect(callArgs.mimeType).toBe("text/markdown");
      expect(callArgs.preExistingJobId).toBe("aij-int02");
      // Sanity: no filePath key on the dispatch payload
      expect(callArgs).not.toHaveProperty("filePath");
    } finally {
      readSpy.mockRestore();
    }
  });
});

// =========================================================================
// dispatchUploadDraft + enrichDraftWithLegStatus — regression tests for the
// two code-review BLOCKERs (CR-01 positional allSettled read, CR-02 unassigned
// draft promoted to "done"). The route-level tests above mock both functions,
// which masked the bugs (WR-02); these tests reach the REAL implementations
// via jest.requireActual while the dependency mocks (prisma, forwardToCollector,
// dispatchUploadToArchive, fs) stay in place.
// =========================================================================
describe("dispatchUploadDraft (CR-01 positional-read regression)", () => {
  it("rag=false, kb=true: kbResult is the fulfilled settle, ragResult is null (NOT results[0])", async () => {
    const realService = jest.requireActual("../services/uploadDraftService");
    // dispatchKbLeg reads the draft file into a Buffer before dispatch.
    const readSpy = jest.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("kb-content"));
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});

    try {
      const draft = draftFixture({ mimeType: "text/markdown" });
      const result = await realService.dispatchUploadDraft(draft as any, {
        rag: false,
        kb: true,
        archiveId: ARCHIVE_ID,
      });

      // CR-01: before the fix, results[0] was the KB settle (the only task)
      // and was wrongly reported as ragResult; results[1] (undefined → null)
      // was reported as kbResult. The key-mapped read must assign the KB
      // settle to kbResult and leave ragResult null.
      expect(result.ragResult).toBeNull();
      expect(result.kbResult).not.toBeNull();
      expect(result.kbResult!.status).toBe("fulfilled");
      expect(result.parseStatus).toBe("assigned");
    } finally {
      readSpy.mockRestore();
    }
  });

  it("rag=true, kb=false: ragResult is the fulfilled settle, kbResult is null", async () => {
    const realService = jest.requireActual("../services/uploadDraftService");
    (mockPrisma.workspace.findUnique as jest.Mock).mockResolvedValue({ id: WS_ID, name: "WS" });
    (mockPrisma.document.create as jest.Mock).mockResolvedValue({ id: "doc-1" });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});

    const draft = draftFixture({ mimeType: "text/markdown" });
    const result = await realService.dispatchUploadDraft(draft as any, { rag: true, kb: false });

    expect(result.ragResult).not.toBeNull();
    expect(result.ragResult!.status).toBe("fulfilled");
    expect(result.kbResult).toBeNull();
    expect(result.parseStatus).toBe("assigned");
  });
});

// =========================================================================
// 260829-fty — dispatchRagLeg MUST hand forwardToCollector the opt-out flag
// { deleteSourceOnFailure: false } as its 9th argument: the staged draft file
// is draft-owned and must survive a collector-leg failure (only the 24h
// reaper + DELETE route may delete draft files). dispatchRagLeg stays REAL
// (imported above via the partial mock that keeps it requireActual) while
// forwardToCollector is the jest.fn mock from ../routes/documents.
// =========================================================================
describe("dispatchRagLeg → forwardToCollector keep-file contract (260829-fty)", () => {
  it("dispatchRagLeg calls forwardToCollector with 9 args, last = { deleteSourceOnFailure: false }", async () => {
    const { forwardToCollector: mockedForward } = require("../routes/documents");
    (mockPrisma.workspace.findUnique as jest.Mock).mockResolvedValue({ id: WS_ID, name: "WS" });
    (mockPrisma.document.create as jest.Mock).mockResolvedValue({ id: "doc-new" });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});

    const draft = draftFixture({ mimeType: "text/markdown" });
    await dispatchRagLeg(draft as any);

    expect(mockedForward).toHaveBeenCalledTimes(1);
    expect(mockedForward).toHaveBeenCalledWith(
      "doc-new",        // documentId (fresh Document row)
      "storage/uploads/drafts/draft-1", // draft.filePath (must survive failure)
      "test.md",        // originalName
      WS_ID,            // workspaceId
      "WS",             // workspaceName
      "Xenova/all-MiniLM-L6-v2", // embeddingModel (beforeEach getSetting default)
      "md",             // docType (deriveDocType("test.md"))
      "glm-ocr:latest", // ocrModel (beforeEach getSetting default)
      { deleteSourceOnFailure: false }, // 260829-fty keep-file opt-out
    );
  });
});

describe("enrichDraftWithLegStatus (CR-02 unassigned-done regression)", () => {
  it("unassigned draft (parseStatus=uploaded, both legs disabled) is NOT promoted to done", async () => {
    const realService = jest.requireActual("../services/uploadDraftService");

    const unassigned = draftFixture({
      parseStatus: "uploaded",
      ragEnabled: false,
      kbEnabled: false,
      ragJobId: null,
      kbJobId: null,
    });

    const result = await realService.enrichDraftWithLegStatus(unassigned as any);

    // CR-02: before the fix, !ragEnabled && !kbEnabled made ragDone && kbDone
    // trivially true, so the draft was promoted to "done" on the first poll
    // and vanished from the parseStatus:"uploaded" pending filter on the next.
    expect(result.parseStatus).toBe("uploaded");
    expect(result.ragStatus).toBeNull();
    expect(result.kbStatus).toBeNull();
    // No DB mutation on an unassigned draft (also addresses WR-04).
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
  });

  it("assigned draft with both legs terminal IS promoted to done", async () => {
    const realService = jest.requireActual("../services/uploadDraftService");

    const assigned = draftFixture({
      parseStatus: "assigned",
      ragEnabled: true,
      kbEnabled: false,
      ragJobId: "doc-1",
      kbJobId: null,
    });
    (mockPrisma.document.findUnique as jest.Mock).mockResolvedValue({
      id: "doc-1",
      status: "completed",
    });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});

    const result = await realService.enrichDraftWithLegStatus(assigned as any);

    expect(result.parseStatus).toBe("done");
    expect(result.ragStatus).toBe("completed");
    expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: { parseStatus: "done" },
    });
  });

  it("assigned draft with RAG still pending stays assigned (no premature done)", async () => {
    const realService = jest.requireActual("../services/uploadDraftService");

    const assigned = draftFixture({
      parseStatus: "assigned",
      ragEnabled: true,
      kbEnabled: true,
      ragJobId: "doc-1",
      kbJobId: "job-1",
    });
    (mockPrisma.document.findUnique as jest.Mock).mockResolvedValue({
      id: "doc-1",
      status: "processing",
    });
    (mockPrisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
      id: "job-1",
      status: "COMPLETED",
    });

    const result = await realService.enrichDraftWithLegStatus(assigned as any);

    expect(result.parseStatus).toBe("assigned");
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
  });
});

// =========================================================================
// 71-02 Task1 — dispatchKbLeg OCR branch (Pitfall 4: AIJ-first, kbJobId=aij.id)
// PDF + 4 image MIME dispatch via createOcrJob with draft.filePath; non-OCR
// MIME reuses dispatchUploadToArchive with preExistingJobId=aij.id (no dup AIJ).
// =========================================================================
describe("71-02 Task1 dispatchKbLeg OCR branch", () => {
  const { createOcrJob } = require("../services/ocrJobService");

  beforeEach(() => {
    // Default AIJ create returns a row with id "aij-1"
    (mockPrisma.archiveImportJob.create as jest.Mock).mockResolvedValue({
      id: "aij-1",
      archiveId: ARCHIVE_ID,
      status: "PROCESSING",
      sourceFileName: "doc.pdf",
      createdBy: "user-a",
      result: { ocrJobId: null },
    });
    (mockPrisma.archiveImportJob.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    (createOcrJob as jest.Mock).mockResolvedValue({ id: "ocr-job-1" });
  });

  it("Test 1 (Pitfall 4): PDF draft creates AIJ FIRST (PROCESSING), calls createOcrJob with filePath, kbJobId=aij.id (NOT ocrJob.id)", async () => {
    const draft = draftFixture({
      mimeType: "application/pdf",
      originalName: "doc.pdf",
      filePath: "storage/uploads/drafts/doc.pdf",
    });

    // 260814-wxr: dispatchKbLeg now FAILS FAST when the persistent copy fails.
    // Simulate a present file so the copy succeeds and the OCR dispatch goes
    // through. The OcrJob must receive the PERSISTENT path (never the fragile
    // draft.filePath).
    const readSpy = jest.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("fake-pdf"));
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});

    try {
      const result = await dispatchKbLeg(draft as any, ARCHIVE_ID);

      // AIJ created FIRST with status PROCESSING + result.ocrJobId=null
      expect(mockPrisma.archiveImportJob.create).toHaveBeenCalledTimes(1);
      const createArgs = (mockPrisma.archiveImportJob.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.archiveId).toBe(ARCHIVE_ID);
      expect(createArgs.data.status).toBe("PROCESSING");
      expect(createArgs.data.sourceFileName).toBe("doc.pdf");
      expect(createArgs.data.createdBy).toBe("user-a");
      expect(createArgs.data.result).toEqual({ ocrJobId: null });

      // createOcrJob called with 9th arg = persistent OCR source copy (D-13).
      // 260814-wxr: NOT draft.filePath — the persistent copy is the only
      // source path that can reach createOcrJob.
      expect(createOcrJob).toHaveBeenCalledTimes(1);
      expect(createOcrJob).toHaveBeenCalledWith(
        ARCHIVE_ID,
        "OCR",
        "user-a",
        "doc.pdf",
        undefined,
        undefined,
        undefined,
        undefined,
        path.resolve(process.cwd(), "storage", "ocr-sources", "draft-1_doc.pdf"),
      );

      // AIJ updated with ocrJobId after createOcrJob returns
      expect(mockPrisma.archiveImportJob.update).toHaveBeenCalledWith({
        where: { id: "aij-1" },
        data: { result: { ocrJobId: "ocr-job-1" } },
      });

      // kbJobId = aij.id (NOT ocrJob.id) — Pitfall 4
      expect(result).toEqual({ kbJobId: "aij-1" });
      expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith({
        where: { id: "draft-1" },
        data: expect.objectContaining({
          kbJobId: "aij-1",
          kbEnabled: true,
          assignedArchiveId: ARCHIVE_ID,
        }),
      });

      // Non-OCR path NOT taken: dispatchUploadToArchive NOT called
      expect(dispatchUploadToArchive).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("Test 2 (Pitfall 4): image draft (PNG) creates AIJ FIRST, calls createOcrJob with filePath, kbJobId=aij.id", async () => {
    const draft = draftFixture({
      mimeType: "image/png",
      originalName: "scan.png",
      filePath: "storage/uploads/drafts/scan.png",
    });

    const readSpy = jest.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("fake-png"));
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});

    try {
      const result = await dispatchKbLeg(draft as any, ARCHIVE_ID);

      expect(mockPrisma.archiveImportJob.create).toHaveBeenCalledTimes(1);
      expect(createOcrJob).toHaveBeenCalledWith(
        ARCHIVE_ID,
        "OCR",
        "user-a",
        "scan.png",
        undefined,
        undefined,
        undefined,
        undefined,
        path.resolve(process.cwd(), "storage", "ocr-sources", "draft-1_scan.png"),
      );
      expect(result).toEqual({ kbJobId: "aij-1" });
      expect(dispatchUploadToArchive).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("Test 3 (non-OCR regression): .md draft reuses dispatchUploadToArchive with preExistingJobId=aij.id (no duplicate AIJ)", async () => {
    const draft = draftFixture({
      mimeType: "text/markdown",
      originalName: "notes.md",
      filePath: "storage/uploads/drafts/notes.md",
    });
    const readSpy = jest.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("md-content"));

    try {
      const result = await dispatchKbLeg(draft as any, ARCHIVE_ID);

      // AIJ created first (single source of truth)
      expect(mockPrisma.archiveImportJob.create).toHaveBeenCalledTimes(1);
      // Non-OCR: result is undefined (no ocrJobId placeholder)
      const createArgs = (mockPrisma.archiveImportJob.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.result).toBeUndefined();

      // dispatchUploadToArchive called with preExistingJobId=aij.id (skip internal create)
      expect(dispatchUploadToArchive).toHaveBeenCalledTimes(1);
      const dispatchArgs = (dispatchUploadToArchive as jest.Mock).mock.calls[0][0];
      expect(dispatchArgs.preExistingJobId).toBe("aij-1");
      expect(dispatchArgs.archiveId).toBe(ARCHIVE_ID);
      expect(dispatchArgs.fileBuffer).toEqual(expect.any(Buffer));
      expect(dispatchArgs.fileName).toBe("notes.md");
      expect(dispatchArgs.mimeType).toBe("text/markdown");

      // createOcrJob NOT called for non-OCR MIME
      expect(createOcrJob).not.toHaveBeenCalled();

      // kbJobId = aij.id (pre-created row reused — no duplicate AIJ)
      expect(result).toEqual({ kbJobId: "aij-1" });
    } finally {
      readSpy.mockRestore();
    }
  });
});

// =========================================================================
// 260814-wxr Task1 — dispatchKbLeg fail-fast on missing source file.
// Before the fix, both branches let a dead draft.filePath through: the OCR
// branch logged "Failed to copy draft to persistent OCR source, using
// original path" and enqueued a doomed OcrJob; the non-OCR branch bubbled
// a raw ENOENT. Now BOTH branches flip the pre-created AIJ to FAILED and
// throw an Error containing "Draft source file not found".
// =========================================================================
describe("dispatchKbLeg missing source file (260814-wxr)", () => {
  const { createOcrJob } = require("../services/ocrJobService");

  beforeEach(() => {
    (mockPrisma.archiveImportJob.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({
        id: "aij-missing",
        archiveId: ARCHIVE_ID,
        status: "PROCESSING",
        sourceFileName: args?.data?.sourceFileName ?? "gone.pdf",
        createdBy: "user-a",
        result: args?.data?.result,
      }),
    );
    (mockPrisma.archiveImportJob.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    (createOcrJob as jest.Mock).mockResolvedValue({ id: "ocr-job-1" });
  });

  it("OCR branch (PDF draft): throws 'Draft source file not found', AIJ FAILED, createOcrJob NOT called", async () => {
    // fs.readFileSync throws ENOENT — the draft file was already unlinked
    // by DELETE /api/uploads/:id or the 24h reaper.
    const fsErr = Object.assign(new Error("ENOENT: no such file or directory, open 'storage/uploads/drafts/gone.pdf'"), { code: "ENOENT" });
    const readSpy = jest.spyOn(fs, "readFileSync").mockImplementation(() => { throw fsErr; });
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});

    try {
      const draft = draftFixture({
        mimeType: "application/pdf",
        originalName: "gone.pdf",
        filePath: "storage/uploads/drafts/gone.pdf",
      });

      await expect(dispatchKbLeg(draft as any, ARCHIVE_ID)).rejects.toThrow(
        /Draft source file not found for draft draft-1/,
      );

      // The pre-created AIJ was flipped to FAILED with a matching message.
      expect(mockPrisma.archiveImportJob.update).toHaveBeenCalledWith({
        where: { id: "aij-missing" },
        data: {
          status: "FAILED",
          error: expect.stringContaining("Draft source file not found"),
        },
      });

      // createOcrJob must NEVER be called when the persistent copy failed —
      // before the fix it was called with the dead draft.filePath.
      expect(createOcrJob).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(dispatchUploadToArchive).not.toHaveBeenCalled();

      // All four fs call sites are properly mocked (read, write above; the
      // DRAFTS_DIR/OCR_SOURCES_DIR mkdirs happen at import + dispatch time).
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("non-OCR branch (.md draft): throws 'Draft source file not found', AIJ FAILED, dispatchUploadToArchive NOT called", async () => {
    const fsErr = Object.assign(new Error("ENOENT: no such file or directory, open 'storage/uploads/drafts/gone.md'"), { code: "ENOENT" });
    const readSpy = jest.spyOn(fs, "readFileSync").mockImplementation(() => { throw fsErr; });

    try {
      const draft = draftFixture({
        mimeType: "text/markdown",
        originalName: "gone.md",
        filePath: "storage/uploads/drafts/gone.md",
      });

      await expect(dispatchKbLeg(draft as any, ARCHIVE_ID)).rejects.toThrow(
        /Draft source file not found for draft draft-1 \(path: storage\/uploads\/drafts\/gone\.md\)/,
      );

      expect(mockPrisma.archiveImportJob.update).toHaveBeenCalledWith({
        where: { id: "aij-missing" },
        data: {
          status: "FAILED",
          error: expect.stringContaining("Draft source file not found"),
        },
      });

      expect(dispatchUploadToArchive).not.toHaveBeenCalled();
      expect(createOcrJob).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });
});

// =========================================================================
// 71-02 Task2 — Assign route KB MIME amend (D-13/D-14) + D-17 URL stage
// PDF + 4 image MIME → KB via ocr.ts dispatch (200, not 400); URL sourceType
// body branch creates a URL draft (mimeType="text/url" sentinel) + dispatches
// KB via urlIngestion. IDOR + archive access + image→RAG gate preserved.
// =========================================================================
describe("71-02 Task2 assign route + URL stage", () => {
  beforeEach(() => {
    // Default: dispatchUploadDraft resolves successfully
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: null,
      kbResult: { status: "fulfilled", value: { kbJobId: "aij-1" } },
      parseStatus: "assigned",
    });
  });

  // Test 1 (D-13): PDF → KB returns 200 (not 400)
  it("Test 1 (D-13): POST /api/uploads/:id/assign with {kb:true} on a PDF draft returns 200", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "application/pdf", uploadedBy: "user-a" }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });

  // Test 2 (D-14): images → KB return 200
  it("Test 2 (D-14): POST /api/uploads/:id/assign with {kb:true} on image drafts returns 200", async () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/tiff"]) {
      (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
        draftFixture({ mimeType: mime, uploadedBy: "user-a" }),
      );
      (dispatchUploadDraft as jest.Mock).mockClear();
      (dispatchUploadDraft as jest.Mock).mockResolvedValue({
        ragResult: null,
        kbResult: { status: "fulfilled", value: { kbJobId: "aij-1" } },
        parseStatus: "assigned",
      });

      const res = await request(app)
        .post("/api/uploads/draft-1/assign")
        .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

      expect(res.status).toBe(200);
      expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
    }
  });

  // Test 3 (flipped, quick 260829-xxx): .txt → KB now returns 200 —
  // text/plain was added to ALLOWED_ARCHIVE_MIME (the collector parse-only
  // endpoint already handles it). The old "txt→KB gap v0.13" pin is closed
  // ahead of v0.13.
  it("Test 3 (flipped): {kb:true} on a .txt draft now returns 200 (txt→KB gap closed quick 260829-xxx)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/plain", uploadedBy: "user-a" }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });

  // Test 4 (preserved): image + rag → 400 (D-69-06 rule 1)
  it("Test 4 (preserved): {rag:true} on an image draft still returns 400 (images→RAG gap v0.13)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "image/png", uploadedBy: "user-a" }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Images can only be assigned to Knowledge Base, not RAG");
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test 5 (D-17): URL stage body branch
  it("Test 5 (D-17): POST /api/uploads with {sourceType:'url', url, archiveId} creates a URL draft + dispatches KB", async () => {
    // URL draft created by the stage route
    (mockPrisma.uploadDraft.create as jest.Mock).mockResolvedValue({
      id: "draft-url-1",
      parseStatus: "assigned",
      expiresAt: new Date(),
      originalName: "https://example.com/article",
      fileSize: 0,
      mimeType: "text/url",
    });

    const res = await request(app)
      .post("/api/uploads")
      .send({
        sourceType: "url",
        workspaceId: WS_ID,
        url: "https://example.com/article",
        archiveId: ARCHIVE_ID,
        ocrMode: "text",
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body.mimeType).toBe("text/url");
    // D-06: filePath MUST NOT leak
    expect(res.body).not.toHaveProperty("filePath");
    // uploadDraft.create called with URL sentinel fields
    const createArgs = (mockPrisma.uploadDraft.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.mimeType).toBe("text/url");
    expect(createArgs.data.filePath).toBe("https://example.com/article");
    expect(createArgs.data.originalName).toBe("https://example.com/article");
    expect(createArgs.data.fileSize).toBe(0);
    expect(createArgs.data.kbEnabled).toBe(true);
    expect(createArgs.data.ragEnabled).toBe(false);
    expect(createArgs.data.assignedArchiveId).toBe(ARCHIVE_ID);
    expect(createArgs.data.parseStatus).toBe("assigned");
  });

  // Test 6 (D-17 validation): invalid URL → 400
  it("Test 6 (D-17 validation): POST /api/uploads with {sourceType:'url', url:'not-a-url'} returns 400 with Zod details", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .send({
        sourceType: "url",
        workspaceId: WS_ID,
        url: "not-a-url",
        archiveId: ARCHIVE_ID,
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("details");
    // No draft created on validation failure
    expect(mockPrisma.uploadDraft.create).not.toHaveBeenCalled();
  });

  // Test 7 (IDOR preserved): user A cannot assign user B's draft
  it("Test 7 (IDOR preserved): user A cannot assign user B's draft without workspace access", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ uploadedBy: "user-b", workspaceId: "ws-b", mimeType: "application/pdf" }),
    );
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: "ws-b",
      projectId: "p-b",
      name: "User B WS",
      allowMemberUploads: true,
      project: { id: "p-b", createdBy: "user-b" },
    });
    (mockPrisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied/);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test 8 (archive access preserved): non-owner cannot assign with kb=true
  it("Test 8 (archive access preserved): user without archive access cannot assign with kb=true", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "application/pdf", uploadedBy: "user-a" }),
    );
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-b", // owned by another user
      deletedAt: null,
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied to this archive/i);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });
});

// =========================================================================
// SC-5 contract assertion (INT-01 byte-identical)
// =========================================================================
describe("SC-5 contract assertion (INT-01 byte-identical)", () => {
  // Expected pre-Phase-69 collector routes directory listing. Verified via
  // `ls packages/collector/src/routes/` at plan-check time: only `ingest.ts`.
  // If a future phase adds a collector route, adjust this snapshot.
  const EXPECTED_PRE_PHASE_69_FILES = ["ingest.ts"];

  it("no new file under packages/collector/src/routes/ (collector stays destination-agnostic)", () => {
    const dir = path.resolve(__dirname, "../../../collector/src/routes");
    const actualFiles = fs.readdirSync(dir).sort();
    expect(actualFiles).toEqual(EXPECTED_PRE_PHASE_69_FILES);
  });

  it("ingest.schema.ts is unchanged (IngestUploadBodySchema and IngestStatusCallbackSchema still exported with same shape)", async () => {
    // Dynamic import to keep this test self-contained.
    const shared = await import("@simmetric-chat/shared");
    expect(shared.IngestUploadBodySchema).toBeDefined();
    expect(shared.IngestStatusCallbackSchema).toBeDefined();
    // Zod parse identity is exercised by ingest.contract.test.ts (INT-01
    // regression baseline). This assertion proves the schemas are still
    // importable with the same names — the in-band complement to the
    // out-of-band `git diff` check.
    expect(typeof shared.IngestUploadBodySchema.safeParse).toBe("function");
    expect(typeof shared.IngestStatusCallbackSchema.safeParse).toBe("function");
  });
});

// 71-02 Task 3: D-07 assign idempotency regression coverage.
// The D-07 idempotency logic is Fase 69 existing (the assign route's
// `parseStatus === "done"` → 409 check). These tests verify the existing
// behavior is preserved under 71-02 changes (KB MIME amend + URL stage).
// `dispatchUploadDraft` is mocked at module level — assertions target the
// mock, not the real fan-out. `dispatchKbLeg` stays real (jest.requireActual)
// but is NOT called in the test environment because dispatchUploadDraft is
// mocked. Tests assert on `dispatchUploadDraft` to verify the route's
// idempotency gate.
describe("71-02 Task3 assign idempotency D-07", () => {
  beforeEach(() => {
    // Standard accessible workspace + archive owned by user-a.
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessibleWorkspace(WS_ID));
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-a",
      deletedAt: null,
    });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.archiveImportJob.create as jest.Mock).mockResolvedValue({
      id: "aij-idem",
      archiveId: ARCHIVE_ID,
      status: "PROCESSING",
      sourceFileName: "test.pdf",
      createdBy: "user-a",
      result: undefined,
    });
    (mockPrisma.ocrJob.create as jest.Mock).mockResolvedValue({ id: "ocr-idem" });
    (mockPrisma.archiveImportJob.update as jest.Mock).mockResolvedValue({});
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: null,
      kbResult: { status: "fulfilled", value: { kbJobId: "aij-idem" } },
      parseStatus: "assigned",
    });
  });

  // Test 1 (D-07 skip done): assign on a draft with parseStatus="done" →
  // 409 "Draft already finalized", no re-dispatch.
  it("Test 1 (D-07 skip done): assign on a draft with parseStatus=done → 409, dispatchUploadDraft NOT called", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        parseStatus: "done",
        kbEnabled: true,
        ragEnabled: true,
        kbJobId: "aij-done",
        ragJobId: "doc-done",
        assignedArchiveId: ARCHIVE_ID,
      }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: true, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Draft already finalized");
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test 2 (D-07 retry failed): assign on a draft with parseStatus="assigned"
  // and kbStatus=FAILED → route proceeds (retry). dispatchUploadDraft called.
  // The Fase 69 route does NOT block on FAILED status — the "retry" path is
  // the normal flow (parseStatus is still "assigned", not "done").
  it("Test 2 (D-07 retry failed): assign on a draft with kbStatus=FAILED → re-dispatch, dispatchUploadDraft called once", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        parseStatus: "assigned",
        kbEnabled: true,
        ragEnabled: false,
        kbJobId: "aij-failed",
        assignedArchiveId: ARCHIVE_ID,
        mimeType: "application/pdf",
      }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });

  // Test 3 (D-07 regression — in-flight gap documented): assign on a draft
  // with parseStatus="assigned" and kbStatus=PROCESSING. The Fase 69 route
  // does NOT implement an in-flight no-op check (only `parseStatus === "done"`
  // → 409). The route proceeds and calls dispatchUploadDraft, which means
  // double-dispatch is POSSIBLE on an in-flight draft. This test documents
  // the existing behavior — the D-07 "no-op in-flight" guard is a known gap
  // deferred to a future phase (Fase 69 logic is locked for 71-02).
  it("Test 3 (D-07 regression — in-flight gap): assign on a draft with kbStatus=PROCESSING → route proceeds (no in-flight no-op guard), dispatchUploadDraft called", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        parseStatus: "assigned",
        kbEnabled: true,
        ragEnabled: false,
        kbJobId: "aij-processing",
        assignedArchiveId: ARCHIVE_ID,
        mimeType: "application/pdf",
      }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/assign")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    // Existing Fase 69 behavior: route proceeds (no in-flight check).
    // parseStatus is "assigned" (not "done"), so the 409 gate does NOT fire.
    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// 71-06 Task C — pending endpoint lifecycle regression (CR-01/CR-02 closure)
// Verifies the broadened where clause + enriched response shape expose the
// full pending lifecycle (unassigned + in-flight + done) to the
// PendingDocsPanel. The route-level enrichDraftWithLegStatus is mocked at
// module scope; per-test we override the mock to return the desired
// per-leg status + (for test c) the promoted parseStatus="done".
// =========================================================================
describe("71-06 Task — pending endpoint lifecycle (CR-01/CR-02 closure)", () => {
  beforeEach(() => {
    // Default accessible workspace + archive owned by user-a.
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessibleWorkspace(WS_ID));
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-a",
      deletedAt: null,
    });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.document.findUnique as jest.Mock).mockResolvedValue(null);
  });

  // Test (a): assigned draft with both legs in-flight is visible with the
  // full response shape (ragEnabled/kbEnabled/assignedArchiveId + per-leg
  // status). Before CR-01/CR-02 this draft was filtered out by the
  // `ragEnabled: false, kbEnabled: false, parseStatus: "uploaded"` clause.
  it("Test (a): assigned draft with both legs in-flight appears with full response shape", async () => {
    const draft = draftFixture({
      id: "draft-assigned",
      parseStatus: "assigned",
      ragEnabled: true,
      kbEnabled: true,
      assignedArchiveId: ARCHIVE_ID,
      ragJobId: "rag-1",
      kbJobId: "kb-1",
      mimeType: "application/pdf",
      originalName: "doc.pdf",
    });

    let capturedWhere: any = null;
    (mockPrisma.uploadDraft.findMany as jest.Mock).mockImplementation((args: any) => {
      capturedWhere = args.where;
      return [draft];
    });
    // Override enrich to return in-flight per-leg status, parseStatus stays "assigned".
    (enrichDraftWithLegStatus as jest.Mock).mockResolvedValue({
      ...draft,
      ragStatus: "processing",
      kbStatus: "PROCESSING",
      parseStatus: "assigned",
    });

    const res = await request(app).get("/api/uploads/pending?workspaceId=" + WS_ID);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    // CR-01/CR-02: the where clause must NOT filter by ragEnabled/kbEnabled/parseStatus
    expect(capturedWhere).not.toHaveProperty("ragEnabled");
    expect(capturedWhere).not.toHaveProperty("kbEnabled");
    expect(capturedWhere).not.toHaveProperty("parseStatus");
    expect(capturedWhere.uploadedBy).toBe("user-a");
    expect(capturedWhere.workspaceId).toBe(WS_ID);
    expect(capturedWhere.deletedAt).toBeNull();
    // Response shape: 8 original fields + 3 new flags
    expect(res.body[0].id).toBe("draft-assigned");
    expect(res.body[0].parseStatus).toBe("assigned");
    expect(res.body[0].ragEnabled).toBe(true);
    expect(res.body[0].kbEnabled).toBe(true);
    expect(res.body[0].assignedArchiveId).toBe(ARCHIVE_ID);
    expect(res.body[0].ragStatus).toBe("processing");
    expect(res.body[0].kbStatus).toBe("PROCESSING");
    expect(res.body[0].mimeType).toBe("application/pdf");
    expect(res.body[0].originalName).toBe("doc.pdf");
    // D-06: filePath never exposed
    expect(res.body[0]).not.toHaveProperty("filePath");
  });

  // Test (b): URL draft (mimeType="text/url", kbEnabled=true, ragEnabled=false)
  // is visible in the pending panel. Before CR-02 the parseStatus filter
  // excluded it because URL drafts are staged with parseStatus="assigned"
  // (the KB leg is dispatched immediately at stage time).
  it("Test (b): URL draft (text/url sentinel) appears in pending response (D-17 closure)", async () => {
    const draft = draftFixture({
      id: "draft-url",
      parseStatus: "assigned",
      mimeType: "text/url",
      kbEnabled: true,
      ragEnabled: false,
      assignedArchiveId: ARCHIVE_ID,
      kbJobId: "kb-url-1",
      ragJobId: null,
      originalName: "https://example.com/doc",
    });

    (mockPrisma.uploadDraft.findMany as jest.Mock).mockResolvedValue([draft]);
    (enrichDraftWithLegStatus as jest.Mock).mockResolvedValue({
      ...draft,
      ragStatus: null,
      kbStatus: "PENDING",
      parseStatus: "assigned",
    });

    const res = await request(app).get("/api/uploads/pending?workspaceId=" + WS_ID);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].mimeType).toBe("text/url");
    expect(res.body[0].kbEnabled).toBe(true);
    expect(res.body[0].ragEnabled).toBe(false);
    expect(res.body[0].parseStatus).toBe("assigned");
    expect(res.body[0].kbStatus).toBe("PENDING");
    expect(res.body[0].assignedArchiveId).toBe(ARCHIVE_ID);
    expect(res.body[0].originalName).toBe("https://example.com/doc");
  });

  // Test (c): KB done (COMPLETED) draft is promoted to parseStatus="done"
  // by enrichDraftWithLegStatus and returned with the full response shape.
  // Uses the REAL enrichDraftWithLegStatus (via jest.requireActual) to
  // exercise the lazy parseStatus flip + the DB update call.
  it("Test (c): KB COMPLETED draft is promoted to parseStatus=done (INT-04 + D-04)", async () => {
    const realService = jest.requireActual("../services/uploadDraftService");
    const draft = draftFixture({
      id: "draft-kb-done",
      parseStatus: "assigned",
      ragEnabled: false,
      kbEnabled: true,
      kbJobId: "kb-done-1",
      ragJobId: null,
      assignedArchiveId: ARCHIVE_ID,
      mimeType: "application/pdf",
      originalName: "done.pdf",
    });

    (mockPrisma.uploadDraft.findMany as jest.Mock).mockResolvedValue([draft]);
    (mockPrisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
      id: "kb-done-1",
      status: "COMPLETED",
    });
    (mockPrisma.document.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    // Use the REAL enrich so the "assigned" → "done" promotion fires.
    (enrichDraftWithLegStatus as jest.Mock).mockImplementation(realService.enrichDraftWithLegStatus);

    const res = await request(app).get("/api/uploads/pending?workspaceId=" + WS_ID);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].kbStatus).toBe("COMPLETED");
    expect(res.body[0].parseStatus).toBe("done");
    expect(res.body[0].kbEnabled).toBe(true);
    expect(res.body[0].ragEnabled).toBe(false);
    expect(res.body[0].assignedArchiveId).toBe(ARCHIVE_ID);
    // The lazy "done" flip wrote to the DB.
    expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-kb-done" },
      data: { parseStatus: "done" },
    });
  });
});

// =========================================================================
// 260814-wxr Task2 — POST /:id/assign pre-checks draft.filePath on disk
// when kb=true. A stale draft (file removed by DELETE /:id or the 24h
// reaper) is rejected with 400 BEFORE dispatch — previously it sailed
// through and the KB leg failed ~30s later ("Draft source file not
// found"), silent at the UI click.
// =========================================================================
describe("POST /api/uploads/:id/assign — stale draft source file guard (260814-wxr)", () => {
  beforeEach(() => {
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: null,
      kbResult: { status: "fulfilled", value: { kbJobId: "aij-1" } },
      parseStatus: "assigned",
    });
  });

  it("kb=true with source file missing on disk → 400 'Draft source file no longer exists on disk' + NO dispatch", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    jest.spyOn(fs, "existsSync").mockReturnValue(false);

      const res = await request(app)
        .post("/api/uploads/draft-1/assign")
        .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        "Draft source file no longer exists on disk — re-upload the file to assign it",
      );
      expect(res.body.details).toEqual({ draftId: "draft-1" });
      // D-06 / T-76-04: the raw filePath is NEVER echoed back
      expect(JSON.stringify(res.body)).not.toContain("storage/uploads/drafts");
      // Rejection BEFORE dispatch AND before the archive-access DB check
      expect(dispatchUploadDraft).not.toHaveBeenCalled();
      expect(mockPrisma.archive.findUnique).not.toHaveBeenCalled();
  });

  it("kb=false rag=true with source file missing on disk → guard inert, dispatch proceeds", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    jest.spyOn(fs, "existsSync").mockReturnValue(false);

      const res = await request(app)
        .post("/api/uploads/draft-1/assign")
        .send({ rag: true, kb: false });

      // The RAG leg is out of scope for this fix — no 400 from the guard.
      expect(res.status).toBe(200);
      expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
      expect(dispatchUploadDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: "draft-1" }),
        { rag: true, kb: false },
      );
  });

  it("kb=true on a URL draft (text/url sentinel, filePath=https://...) → guard skipped, dispatch proceeds", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        mimeType: "text/url",
        filePath: "https://example.com/article",
        originalName: "https://example.com/article",
        uploadedBy: "user-a",
      }),
    );
    // Even if fs.existsSync would resolve the URL string to garbage, the
    // guard must not consult it for URL drafts.
    jest.spyOn(fs, "existsSync").mockReturnValue(false);

      const res = await request(app)
        .post("/api/uploads/draft-1/assign")
        .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

      expect(res.status).toBe(200);
      expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });

  it("kb=true with the file present on disk → assign flow unchanged (200 + dispatch)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    jest.spyOn(fs, "existsSync").mockReturnValue(true);

      const res = await request(app)
        .post("/api/uploads/draft-1/assign")
        .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

      expect(res.status).toBe(200);
      expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
      // Archive-ownership check still runs (ordering: file check is cheap
      // and local, but does NOT replace the D-06 access gate).
      expect(mockPrisma.archive.findUnique).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// Phase 76 Plan 01 — DELETE /api/uploads/:id + PATCH /api/uploads/:id
// PEND-01 (single delete) + PEND-03 (rename). D-08 owner-only IDOR (404 hides
// existence), D-02 in-flight 409 gate, D-01 soft-delete+unlink with A5 prefix
// guard, D-07 rename 1-500 validation, T-76-04 filePath never leaked.
// =========================================================================
describe("DELETE /api/uploads/:id", () => {
  beforeEach(() => {
    // Default: accessible workspace + archive owned by user-a.
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessibleWorkspace(WS_ID));
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-a",
      deletedAt: null,
    });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    // Default enrichment: parseStatus stays "done" (NOT in-flight → deletable).
    (enrichDraftWithLegStatus as jest.Mock).mockResolvedValue({
      ...draftFixture(),
      parseStatus: "done",
      ragStatus: "completed",
      kbStatus: null,
    });
  });

  it("owner draft → 200 + deletedAt set + unlink called (A5 guard passes for drafts/ path)", async () => {
    const draft = draftFixture({
      filePath: "storage/uploads/drafts/draft-1.pdf",
      parseStatus: "done",
    });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      const res = await request(app).delete("/api/uploads/draft-1");

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Draft deleted");
      // D-06 / T-76-04: no filePath in response
      expect(res.body).not.toHaveProperty("filePath");
      // Soft-delete: update called with deletedAt
      expect(mockPrisma.uploadDraft.update).toHaveBeenCalledTimes(1);
      const updateArgs = (mockPrisma.uploadDraft.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.where.id).toBe("draft-1");
      expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);
      // A5 guard: resolved path starts with DRAFTS_BASE → unlink called
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
      const resolved = path.resolve("storage/uploads/drafts/draft-1.pdf");
      expect(unlinkSpy).toHaveBeenCalledWith(resolved);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("non-owner draft → 404 (IDOR hides existence) + row unchanged", async () => {
    const draft = draftFixture({ uploadedBy: "user-b", parseStatus: "done" });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      // req.userId = "user-a" (default mock), draft.uploadedBy = "user-b"
      const res = await request(app).delete("/api/uploads/draft-1");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Draft not found");
      // NO soft-delete, NO unlink
      expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("missing draft → 404", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app).delete("/api/uploads/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Draft not found");
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
  });

  it("already-deleted draft (deletedAt !== null) → 404", async () => {
    const draft = draftFixture({ deletedAt: new Date(), parseStatus: "done" });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);

    const res = await request(app).delete("/api/uploads/draft-1");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Draft not found");
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
  });

  it("in-flight draft (enriched parseStatus=assigned, ragEnabled=true) → 409 + NO update + NO unlink", async () => {
    // 260829-h0n: the fixture MUST set ragEnabled: true so "processing" is a
    // genuinely in-flight ENABLED leg under the new gate — a DISABLED leg
    // never blocks deletion (matching enrichDraftWithLegStatus's own
    // ragDone/kbDone derivation). With the old fixture's ragEnabled: false
    // the new derivation would correctly treat the draft as deletable.
    const draft = draftFixture({ parseStatus: "assigned", ragEnabled: true });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    // Enrichment returns parseStatus "assigned" (in-flight)
    (enrichDraftWithLegStatus as jest.Mock).mockResolvedValue({
      ...draft,
      parseStatus: "assigned",
      ragStatus: "processing",
      kbStatus: null,
    });
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      const res = await request(app).delete("/api/uploads/draft-1");

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/in-flight/);
      // NO soft-delete, NO unlink
      expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  // 260829-h0n — failure-aware DELETE gate. A draft whose every ENABLED leg
  // is terminal (completed OR failed) is deletable: nothing is processing,
  // so the old `parseStatus === "assigned"` check was a false positive.
  // Mirrors the live draft 270fd171 (ragStatus "failed", kbEnabled false).
  it("failed-RAG-terminal draft (assigned + ragStatus failed + kbEnabled false) → 200 + soft-delete + unlink", async () => {
    const draft = draftFixture({
      parseStatus: "assigned",
      ragEnabled: true,
      kbEnabled: false,
      ragJobId: "rag-1",
    });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    (enrichDraftWithLegStatus as jest.Mock).mockResolvedValue({
      ...draft,
      parseStatus: "assigned",
      ragStatus: "failed",
      kbStatus: null,
    });
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      const res = await request(app).delete("/api/uploads/draft-1");

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Draft deleted");
      // Soft-delete: update called once with a deletedAt Date
      expect(mockPrisma.uploadDraft.update).toHaveBeenCalledTimes(1);
      const updateArgs = (mockPrisma.uploadDraft.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.where.id).toBe("draft-1");
      expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);
      // A5 guard passes → unlink called with the resolved drafts path
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
      expect(unlinkSpy).toHaveBeenCalledWith(path.resolve("storage/uploads/drafts/draft-1"));
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("both-legs-failed draft (assigned + ragStatus failed + kbStatus FAILED, both enabled) → 200 (deletable)", async () => {
    const draft = draftFixture({
      parseStatus: "assigned",
      ragEnabled: true,
      kbEnabled: true,
      ragJobId: "rag-1",
      kbJobId: "kb-1",
    });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    (enrichDraftWithLegStatus as jest.Mock).mockResolvedValue({
      ...draft,
      parseStatus: "assigned",
      ragStatus: "failed",
      kbStatus: "FAILED",
    });
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      const res = await request(app).delete("/api/uploads/draft-1");

      // Delete is the user's explicit choice over retry — no state conflict.
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Draft deleted");
      expect(mockPrisma.uploadDraft.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "draft-1" } }),
      );
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("mixed legs (RAG failed terminal, kbEnabled true + kbStatus PROCESSING) → 409 + NO update + NO unlink", async () => {
    const draft = draftFixture({
      parseStatus: "assigned",
      ragEnabled: true,
      kbEnabled: true,
      ragJobId: "rag-1",
      kbJobId: "kb-1",
    });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    (enrichDraftWithLegStatus as jest.Mock).mockResolvedValue({
      ...draft,
      parseStatus: "assigned",
      ragStatus: "failed",
      kbStatus: "PROCESSING",
    });
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      const res = await request(app).delete("/api/uploads/draft-1");

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/in-flight/);
      // NO soft-delete, NO unlink
      expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("parseStatus 'uploaded' (never dispatched) draft → 200 (deletable, pinned)", async () => {
    const draft = draftFixture({ parseStatus: "uploaded" });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    // Default describe-level enrichment passthrough: ragStatus/kbStatus null.
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      const res = await request(app).delete("/api/uploads/draft-1");

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Draft deleted");
      expect(mockPrisma.uploadDraft.update).toHaveBeenCalledTimes(1);
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("URL draft (filePath=https://...) → 200 + soft-delete + unlink NOT called (A5 guard rejects)", async () => {
    const draft = draftFixture({
      filePath: "https://example.com/article",
      parseStatus: "done",
      mimeType: "text/url",
    });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      const res = await request(app).delete("/api/uploads/draft-1");

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Draft deleted");
      // Soft-delete happened
      expect(mockPrisma.uploadDraft.update).toHaveBeenCalledTimes(1);
      // A5 guard: path.resolve("https://...") does NOT start with DRAFTS_BASE
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("path-traversal filePath (../../etc/passwd) → 200 + soft-delete + unlink NOT called (A5 guard rejects)", async () => {
    const draft = draftFixture({
      filePath: "../../etc/passwd",
      parseStatus: "done",
    });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      const res = await request(app).delete("/api/uploads/draft-1");

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Draft deleted");
      // Soft-delete happened
      expect(mockPrisma.uploadDraft.update).toHaveBeenCalledTimes(1);
      // A5 guard: path.resolve("../../etc/passwd") does NOT start with DRAFTS_BASE
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});

describe("PATCH /api/uploads/:id", () => {
  beforeEach(() => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessibleWorkspace(WS_ID));
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-a",
      deletedAt: null,
    });
    (mockPrisma.uploadDraft.update as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({
        id: args.where.id,
        originalName: args.data.originalName,
      }),
    );
  });

  it("owner valid body → 200 + { id, originalName } + originalName updated in DB", async () => {
    const draft = draftFixture({ parseStatus: "done" });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);

    const res = await request(app)
      .patch("/api/uploads/draft-1")
      .send({ originalName: "New Name.pdf" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("draft-1");
    expect(res.body.originalName).toBe("New Name.pdf");
    // D-06 / T-76-04: no filePath in response
    expect(res.body).not.toHaveProperty("filePath");
    // DB updated with the new originalName
    expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: { originalName: "New Name.pdf" },
    });
  });

  it("non-owner → 404 (IDOR hides) + row unchanged", async () => {
    const draft = draftFixture({ uploadedBy: "user-b", parseStatus: "done" });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);

    const res = await request(app)
      .patch("/api/uploads/draft-1")
      .send({ originalName: "Hacked.pdf" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Draft not found");
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
  });

  it("empty body → 400 with details", async () => {
    const res = await request(app).patch("/api/uploads/draft-1").send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("details");
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
  });

  it("originalName > 500 char → 400 with details", async () => {
    const res = await request(app)
      .patch("/api/uploads/draft-1")
      .send({ originalName: "a".repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("details");
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
  });

  it("response body has no filePath key", async () => {
    const draft = draftFixture({ parseStatus: "done" });
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(draft);

    const res = await request(app)
      .patch("/api/uploads/draft-1")
      .send({ originalName: "Test.pdf" });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("filePath");
    // Minimal response: exactly id + originalName keys
    expect(Object.keys(res.body).sort()).toEqual(["id", "originalName"]);
  });
});
// =========================================================================
// quick 260829-jv7 Task 2 (D-02) — OCR-copy restore path in the
// /retry and /assign source-file guards. When the staged draft file is
// missing but the KB leg's persistent OCR copy exists at
// storage/ocr-sources/<draftId>_<originalName> (written by
// dispatchKbLeg at uploadDraftService.ts:206-208), the guard restores the
// file (copyFileSync back into storage/uploads/drafts/) and proceeds with
// dispatch instead of failing. When no copy exists, the existing 400
// fail-fast response is byte-identical (the stale-draft pins above stay
// green). Note: these tests exercise the REAL tryRestoreDraftFromOcrCopy
// (uploadDraftService is only partially mocked — dispatchUploadDraft and
// enrichDraftWithLegStatus are mocked, the restore helper stays real).
// =========================================================================
describe("POST /api/uploads/:id/retry + /:id/assign — OCR-copy restore path (260829-jv7)", () => {
  const DRAFT_PATH = path.resolve("storage/uploads/drafts/draft-1");
  const OCR_COPY_PATH = path.resolve("storage/ocr-sources/draft-1_test.md");

  const restoreFixture = () =>
    draftFixture({
      id: "draft-1",
      mimeType: "application/pdf",
      filePath: "storage/uploads/drafts/draft-1",
      originalName: "test.md",
      uploadedBy: "user-a",
      parseStatus: "assigned",
      ragEnabled: true,
      ragJobId: "doc-old",
    });

  /** existsSync impl distinguishing the two resolved paths (per plan):
   *  false for the drafts staged path, true for the ocr-sources copy. */
  const splitExistsSync = () =>
    jest.spyOn(fs, "existsSync").mockImplementation(((p: fs.PathLike) => {
      const s = typeof p === "string" ? p : String(p);
      if (s === DRAFT_PATH) return false;
      if (s === OCR_COPY_PATH) return true;
      return true;
    }) as typeof fs.existsSync);

  beforeEach(() => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessibleWorkspace(WS_ID));
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-a",
      deletedAt: null,
    });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.document.update as jest.Mock).mockResolvedValue({});
  });

  it("route /retry (rag): staged file missing but OCR copy present → copyFileSync restores + dispatch proceeds (NO 400)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(restoreFixture());
    const existsSpy = splitExistsSync();
    const copySpy = jest.spyOn(fs, "copyFileSync").mockImplementation(() => {});
    const loggerInfoSpy = jest.spyOn(logger, "info").mockImplementation(() => logger as never);

    try {
      const res = await request(app)
        .post("/api/uploads/draft-1/retry")
        .send({ rag: true, kb: false });

      expect(res.status).toBe(200);
      // Restore happened: server-generated copy → drafts target, byte-identical
      // naming to the dispatchKbLeg writer (uploadDraftService.ts:206-208).
      expect(copySpy).toHaveBeenCalledTimes(1);
      expect(copySpy).toHaveBeenCalledWith(OCR_COPY_PATH, DRAFT_PATH);
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ draftId: "draft-1" }),
      );
      // Flow proceeds after restore.
      expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
    } finally {
      existsSpy.mockRestore();
      copySpy.mockRestore();
      loggerInfoSpy.mockRestore();
    }
  });

  it("route /retry (rag): staged file missing and NO OCR copy anywhere → 400 byte-identical, dispatch NOT called", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(restoreFixture());
    // existsSync false everywhere → both staged path and OCR copy absent.
    const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);

    try {
      const res = await request(app)
        .post("/api/uploads/draft-1/retry")
        .send({ rag: true, kb: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        "Draft source file no longer exists on disk — re-upload the file to assign it",
      );
      expect(res.body.details).toEqual({ draftId: "draft-1" });
      expect(dispatchUploadDraft).not.toHaveBeenCalled();
      expect(mockPrisma.document.update).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
    }
  });

  it("route /assign (kb): staged file missing but OCR copy present → dispatch proceeds (mirror of /retry)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        id: "draft-1",
        mimeType: "application/pdf",
        filePath: "storage/uploads/drafts/draft-1",
        originalName: "test.md",
        uploadedBy: "user-a",
        parseStatus: "assigned",
        kbEnabled: true,
        kbJobId: "aij-old",
      }),
    );
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: null,
      kbResult: { status: "fulfilled", value: { kbJobId: "aij-new" } },
      parseStatus: "assigned",
    });
    const existsSpy = splitExistsSync();
    const copySpy = jest.spyOn(fs, "copyFileSync").mockImplementation(() => {});

    try {
      const res = await request(app)
        .post("/api/uploads/draft-1/assign")
        .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

      expect(res.status).toBe(200);
      expect(copySpy).toHaveBeenCalledTimes(1);
      expect(copySpy).toHaveBeenCalledWith(OCR_COPY_PATH, DRAFT_PATH);
      expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
    } finally {
      existsSpy.mockRestore();
      copySpy.mockRestore();
    }
  });
});

// =========================================================================
// quick 260829-jv7 Task 2 — tryRestoreDraftFromOcrCopy unit cases
// (service level, real helper). Covers: copy present → restore + true;
// copy absent → false no-write; text/url draft → false no fs; filePath
// outside drafts dir (/etc/target) → false no write (isDraftsPath
// defense-in-depth gate, D-02).
// =========================================================================
describe("tryRestoreDraftFromOcrCopy (260829-jv7)", () => {
  const realService = jest.requireActual("../services/uploadDraftService") as unknown as {
    tryRestoreDraftFromOcrCopy: (draft: { id: string; originalName: string; mimeType: string; filePath: string }) => boolean;
  };

  const baseDraft = {
    id: "draft-1",
    originalName: "preventivo.pdf",
    mimeType: "application/pdf",
    filePath: "storage/uploads/drafts/gone.pdf",
  };

  it("OCR copy present → copies back into the drafts path, returns true", () => {
    const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const copySpy = jest.spyOn(fs, "copyFileSync").mockImplementation(() => {});
    const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as never);

    try {
      const result = realService.tryRestoreDraftFromOcrCopy(baseDraft);

      expect(result).toBe(true);
      expect(copySpy).toHaveBeenCalledWith(
        path.resolve("storage/ocr-sources/draft-1_preventivo.pdf"),
        path.resolve("storage/uploads/drafts/gone.pdf"),
      );
      // Ensure parent dir exists before restore write.
      expect(mkdirSpy).toHaveBeenCalledWith(
        path.dirname(path.resolve("storage/uploads/drafts/gone.pdf")),
        { recursive: true },
      );
    } finally {
      existsSpy.mockRestore();
      copySpy.mockRestore();
      mkdirSpy.mockRestore();
    }
  });

  it("OCR copy ABSENT → returns false, no write attempted", () => {
    // existsSync true for other paths but false for the ocr-sources copy
    // (storage/ocr-sources empty).
    const existsSpy = jest.spyOn(fs, "existsSync").mockImplementation(((p: fs.PathLike) => {
      return !String(p).includes("storage/ocr-sources");
    }) as typeof fs.existsSync);
    const copySpy = jest.spyOn(fs, "copyFileSync").mockImplementation(() => {});

    try {
      const result = realService.tryRestoreDraftFromOcrCopy(baseDraft);

      expect(result).toBe(false);
      expect(copySpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      copySpy.mockRestore();
    }
  });

  it("text/url draft → returns false without touching the filesystem", () => {
    const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const copySpy = jest.spyOn(fs, "copyFileSync").mockImplementation(() => {});

    try {
      const result = realService.tryRestoreDraftFromOcrCopy({
        ...baseDraft,
        mimeType: "text/url",
        filePath: "https://example.com/article",
        originalName: "https://example.com/article",
      });

      expect(result).toBe(false);
      expect(copySpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      copySpy.mockRestore();
    }
  });

  it("filePath outside the drafts dir (/etc/target) → returns false, no write (isDraftsPath gate)", () => {
    const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const copySpy = jest.spyOn(fs, "copyFileSync").mockImplementation(() => {});

    try {
      const result = realService.tryRestoreDraftFromOcrCopy({
        ...baseDraft,
        filePath: "/etc/target",
      });

      expect(result).toBe(false);
      expect(copySpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      copySpy.mockRestore();
    }
  });

  it("fs operation throws mid-copy → returns false (never throws out of the helper)", () => {
    const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as never);
    const loggerWarnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger as never);

    try {
      const result = realService.tryRestoreDraftFromOcrCopy(baseDraft);

      expect(result).toBe(false);
      expect(loggerWarnSpy).toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      mkdirSpy.mockRestore();
      loggerWarnSpy.mockRestore();
    }
  });
});

// =========================================================================
// 260814-wxr Task3 — finalizeAutoApproveOnComplete: no empty ArchivePage on
// zero valid page results. Before the fix the hook flipped the AIJ to
// COMPLETED unconditionally, even when the OcrJob result had zero pages (or
// all pages "[FAILED:") — the wiki document was never extracted yet the
// pending list reported COMPLETED. No existing test file covered this hook,
// so the regression coverage lives here (it already has the prisma mock
// infra shared by the KB-leg tests).
// =========================================================================
describe("finalizeAutoApproveOnComplete — empty pageResults guard (260814-wxr)", () => {
  // Dynamic-import friendly mock: the hook does
  // `await import("../services/archivePageService")` internally, so a
  // requireActual-based spread keeps the real module while replacing the two
  // call sites we assert on.
  const createPageMock = jest.fn((..._args: unknown[]) => Promise.resolve({ id: "page-1" }));
  const rebuildIndexMock = jest.fn((..._args: unknown[]) => Promise.resolve());
  jest.mock("../services/archivePageService", () => ({
    ...jest.requireActual("../services/archivePageService"),
    createPage: (...args: unknown[]) => createPageMock(...args),
    rebuildIndex: (...args: unknown[]) => rebuildIndexMock(...args),
  }));

  // The hook's dependencies are heavy (ocrStages imports the whole OCR
  // pipeline: pdfjs, pdfRenderer, ollamaVisionClient, ...). ocrStages.ts is
  // NOT imported at this test file's module scope — imported INSIDE the test
  // bodies so only these three tests pay the import cost.
  const OCR_JOB_ID = "ocr-job-empty";

  beforeEach(() => {
    createPageMock.mockClear();
    rebuildIndexMock.mockClear();
    (mockPrisma.archiveImportJob.findFirst as jest.Mock).mockResolvedValue({
      id: "aij-hook",
      archiveId: ARCHIVE_ID,
      status: "PROCESSING",
      createdBy: "user-a",
      result: { ocrJobId: OCR_JOB_ID },
    });
    (mockPrisma.ocrJob.findUnique as jest.Mock).mockResolvedValue({
      id: OCR_JOB_ID,
      archiveId: ARCHIVE_ID,
      sourceFileName: "doc.pdf",
      createdBy: "user-a",
    });
    (mockPrisma.archiveImportJob.update as jest.Mock).mockResolvedValue({});
  });

  it("pageResults = [] (empty success) → NO createPage, AIJ FAILED with 'no valid pages' error", async () => {
    const { finalizeAutoApproveOnComplete } = require("../ocr/ocrStages");

    await finalizeAutoApproveOnComplete(OCR_JOB_ID, ARCHIVE_ID, "user-a", {
      pageResults: [],
    });

    expect(createPageMock).not.toHaveBeenCalled();
    expect(rebuildIndexMock).not.toHaveBeenCalled();
    expect(mockPrisma.archiveImportJob.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.archiveImportJob.update).toHaveBeenCalledWith({
      where: { id: "aij-hook" },
      data: {
        status: "FAILED",
        error: expect.stringContaining("no valid pages"),
      },
    });
  });

  it("every page markdown starts with '[FAILED:' → NO createPage, AIJ FAILED", async () => {
    const { finalizeAutoApproveOnComplete } = require("../ocr/ocrStages");

    await finalizeAutoApproveOnComplete(OCR_JOB_ID, ARCHIVE_ID, "user-a", {
      pageResults: [
        { pageNumber: 1, markdown: "[FAILED: page unrecognizable]" },
        { pageNumber: 2, markdown: "[FAILED: timeout]" },
      ],
    });

    expect(createPageMock).not.toHaveBeenCalled();
    expect(rebuildIndexMock).not.toHaveBeenCalled();
    expect(mockPrisma.archiveImportJob.update).toHaveBeenCalledWith({
      where: { id: "aij-hook" },
      data: {
        status: "FAILED",
        error: expect.stringContaining("no valid pages"),
      },
    });
  });

  it("mixed valid + failed pages → ArchivePage created from VALID pages only, AIJ COMPLETED (happy path regression)", async () => {
    const { finalizeAutoApproveOnComplete } = require("../ocr/ocrStages");

    await finalizeAutoApproveOnComplete(OCR_JOB_ID, ARCHIVE_ID, "user-a", {
      pageResults: [
        { pageNumber: 1, markdown: "Valid page one" },
        { pageNumber: 2, markdown: "[FAILED: page unrecognizable]" },
      ],
    });

    expect(createPageMock).toHaveBeenCalledTimes(1);
    const [archiveIdArg, pageArg, userIdArg] = createPageMock.mock.calls[0] as unknown[] as [
      string,
      { content: string },
      string,
    ];
    expect(archiveIdArg).toBe(ARCHIVE_ID);
    // Only the valid page is embedded — the "[FAILED:" marker must NOT leak
    // into the wiki page content.
    expect(pageArg.content).toContain("Valid page one");
    expect(pageArg.content).not.toContain("[FAILED:");
    expect(userIdArg).toBe("user-a");
    expect(rebuildIndexMock).toHaveBeenCalledWith(ARCHIVE_ID);
    expect(mockPrisma.archiveImportJob.update).toHaveBeenCalledWith({
      where: { id: "aij-hook" },
      data: { status: "COMPLETED" },
    });
  });
});

// =========================================================================
// quick 260826-fan Task1 — POST /api/uploads/:id/retry endpoint.
// Retry mirrors /assign's validations (MIME, archive-ownership, source-file,
// IDOR) but OMITS the parseStatus==="done" 409 gate (D-01). RAG retry
// soft-deletes the old Document (deletedAt) before re-dispatch (D-06); KB
// retry leaves the old AIJ as-is (no dedup). parseStatus is reset to
// "assigned" before dispatch so enrichDraftWithLegStatus can re-derive
// terminal "done". Reuses assignDraftSchema (D-05).
// =========================================================================
describe("POST /api/uploads/:id/retry", () => {
  beforeEach(() => {
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue(accessibleWorkspace(WS_ID));
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-a",
      deletedAt: null,
    });
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.document.update as jest.Mock).mockResolvedValue({});
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: { status: "fulfilled", value: { ragJobId: "doc-new" } },
      kbResult: null,
      parseStatus: "assigned",
    });
  });

  // Test (a): 200 happy path with {rag:true,kb:false} on a done draft with
  // an existing ragJobId — document.update soft-deletes the old Document,
  // parseStatus reset to "assigned", then dispatchUploadDraft called.
  it("rag=true on a done draft with ragJobId → 200, document.update soft-deletes old doc, parseStatus reset, dispatch called", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        parseStatus: "done",
        ragEnabled: true,
        kbEnabled: false,
        ragJobId: "doc-old",
        kbJobId: null,
        mimeType: "text/markdown",
      }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(200);
    expect(res.body.parseStatus).toBe("assigned");
    // D-06: old Document soft-deleted (deletedAt set) BEFORE dispatch
    expect(mockPrisma.document.update).toHaveBeenCalledWith({
      where: { id: "doc-old" },
      data: { deletedAt: expect.any(Date) },
    });
    // parseStatus reset to "assigned" BEFORE dispatch
    expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: { parseStatus: "assigned" },
    });
    // dispatch called once with the draft + {rag:true, kb:false}
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
    const [draftArg, targetsArg] = (dispatchUploadDraft as jest.Mock).mock.calls[0];
    expect(draftArg.id).toBe("draft-1");
    expect(targetsArg).toEqual({ rag: true, kb: false });
  });

  // Test (b): {rag:false, kb:true, archiveId} — NO document.update soft-delete
  it("kb=true with archiveId → 200, NO document.update soft-delete (KB retry creates new AIJ, D-06)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        parseStatus: "done",
        ragEnabled: false,
        kbEnabled: true,
        ragJobId: null,
        kbJobId: "aij-old",
        assignedArchiveId: ARCHIVE_ID,
        mimeType: "text/markdown",
      }),
    );
    (dispatchUploadDraft as jest.Mock).mockResolvedValue({
      ragResult: null,
      kbResult: { status: "fulfilled", value: { kbJobId: "aij-new" } },
      parseStatus: "assigned",
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(200);
    // D-06: KB retry does NOT soft-delete a Document
    expect(mockPrisma.document.update).not.toHaveBeenCalled();
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
    expect(dispatchUploadDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: "draft-1" }),
      { rag: false, kb: true, archiveId: ARCHIVE_ID },
    );
  });

  // Test (c): rag=true on unassigned draft (ragJobId null) → NO document.update
  it("rag=true on a draft with ragJobId=null → 200, NO document.update (no old doc to soft-delete)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        parseStatus: "uploaded",
        ragJobId: null,
        kbJobId: null,
        mimeType: "text/markdown",
      }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(200);
    expect(mockPrisma.document.update).not.toHaveBeenCalled();
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });

  // Test (d): missing draft → 404
  it("missing draft → 404 'Draft not found'", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Draft not found");
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test (e): kb=true without archiveId → 400
  it("kb=true without archiveId → 400 'archiveId is required when kb is true'", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown" }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: false, kb: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("archiveId is required when kb is true");
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test (f): image + rag → 400 (D-69-06 rule 1, mirrored from /assign)
  it("image + rag=true → 400 'Images can only be assigned to Knowledge Base, not RAG'", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "image/png" }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Images can only be assigned to Knowledge Base, not RAG");
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test (g): the CRITICAL difference from /assign — parseStatus "done" does
  // NOT return 409. Retry is allowed on every parseStatus (D-01).
  it("parseStatus='done' with both legs completed → 200 (NO 409 'Draft already finalized' gate, D-01)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        parseStatus: "done",
        ragEnabled: true,
        kbEnabled: false,
        ragJobId: "doc-done",
        kbJobId: null,
        mimeType: "text/markdown",
      }),
    );

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("error");
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });

  // Test (h): non-owner without workspace access → 403 (IDOR scope mirrored)
  it("non-owner without workspace access → 403 'Access denied to this workspace'", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ uploadedBy: "user-b", workspaceId: "ws-b", mimeType: "text/markdown" }),
    );
    (mockPrisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: "ws-b",
      projectId: "p-b",
      name: "User B WS",
      project: { id: "p-b", createdBy: "user-b" },
    });
    (mockPrisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied/);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test (i): archive not owned → 403 (D-06, mirrored)
  it("kb=true, archive not owned by caller (non-admin) → 403", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    (mockPrisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: "user-b",
      deletedAt: null,
    });

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied to this archive/i);
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test (j): kb=true + missing source file on disk → 400 (260814-wxr guard)
  it("kb=true with source file missing on disk → 400 (260814-wxr guard mirrored)", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    jest.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: false, kb: true, archiveId: ARCHIVE_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Draft source file no longer exists on disk — re-upload the file to assign it",
    );
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
  });

  // Test (260829-fty): rag=true + missing source file on disk → 400 fail-fast
  // BEFORE any dispatch or soft-delete. The 260814-wxr guard previously fired
  // only for kb=true; a RAG retry of a fileless draft returned 200
  // (Promise.allSettled per-leg isolation) and the collector leg failed with
  // ENOENT — a false success for the user. The guard now covers rag too.
  it("rag=true with source file missing on disk → 400 + NO dispatch + NO document.update soft-delete", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({ mimeType: "text/markdown", uploadedBy: "user-a" }),
    );
    jest.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Draft source file no longer exists on disk — re-upload the file to assign it",
    );
    expect(res.body.details).toEqual({ draftId: "draft-1" });
    // D-06 / T-76-04: the raw filePath is NEVER echoed back
    expect(JSON.stringify(res.body)).not.toContain("storage/uploads/drafts");
    // Guard fires BEFORE dispatch AND before the D-06 soft-delete block
    expect(dispatchUploadDraft).not.toHaveBeenCalled();
    expect(mockPrisma.document.update).not.toHaveBeenCalled();
  });

  // Test (260829-fty): URL drafts (text/url sentinel, filePath=URL string)
  // have no disk file — the guard must stay INERT for them (mirror /assign
  // URL-draft test above), even with existsSync mocked false.
  it("rag=true on a URL draft (text/url sentinel) with existsSync=false → 200, dispatch proceeds", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        mimeType: "text/url",
        filePath: "https://example.com/article",
        originalName: "https://example.com/article",
        uploadedBy: "user-a",
      }),
    );
    jest.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
    expect(dispatchUploadDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: "draft-1" }),
      { rag: true, kb: false },
    );
  });

  // Test (k): soft-delete-old-Document failure is non-blocking (warns + continues)
  it("rag=true with old Document already deleted (update rejects) → 200, warns but still dispatches", async () => {
    (mockPrisma.uploadDraft.findUnique as jest.Mock).mockResolvedValue(
      draftFixture({
        parseStatus: "done",
        ragEnabled: true,
        ragJobId: "doc-old-gone",
        mimeType: "text/markdown",
      }),
    );
    (mockPrisma.document.update as jest.Mock).mockRejectedValue(new Error("Record not found"));

    const res = await request(app)
      .post("/api/uploads/draft-1/retry")
      .send({ rag: true, kb: false });

    // Non-blocking: warn logged but dispatch still runs
    expect(res.status).toBe(200);
    expect(dispatchUploadDraft).toHaveBeenCalledTimes(1);
  });
});
