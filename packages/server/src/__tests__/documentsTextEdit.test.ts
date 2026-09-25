// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * Phase 204 (DEBT-SW-05, FEAT-01) — PUT /api/documents/:documentId/text.
 *
 * The body-only edit route contract, one describe per arm:
 *   - 202 happy arm: provider.put BEFORE the re-dispatch; row update carries
 *     the re-index reset (status "pending" so forwardToCollector's guarded
 *     processing claim succeeds) + the DLP marker-clear arm on scanned rows
 *     (deleteEntityMap refresh); binary-type rows swap to a .txt source
 *     (pdf→txt precedent, documents.ts:1283-1288) BEFORE dispatch; the
 *     re-dispatch rides the FULL forwardToCollector chain (multipart POST to
 *     the collector asserted via the fetch seam — the exact contract the
 *     collector's IngestUploadBodySchema depends on).
 *   - 400 invalid body (z.string().min(1)) — archivePages.ts:205 shape.
 *   - 404 unknown / soft-deleted document.
 *   - 403 access triple-check (admin does NOT bypass — T-78-01 posture).
 *   - 409 status !== "completed".
 *
 * Mock scaffold mirrors documentUpload.test.ts + forwardToCollectorCleanup
 * (prisma/env/license/systemConfig mocks, shared provider mock helper).
 * The fire-and-forget dispatch is proven with a global fetch spy (the
 * collectorIngestTimeout.test.ts precedent) + bounded polling waits.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    withSoftDelete: (where: any) => where,
  };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn((key: string) => {
    if (key === "EMBEDDING_MODEL") return { value: "Xenova/all-MiniLM-L6-v2" };
    if (key === "OCR_DEFAULT_MODEL") return { value: "glm-ocr:latest" };
    return { value: "" };
  }),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

// Phase 184 (SAAS-03): provider mock surface — shared helper, same handles the
// upload suite uses. The edit route's stored-file rewrite rides provider.put.
jest.mock("../services/storageProvider", () =>
  require("./helpers/mockStorageProvider").mockStorageProviderModule,
);

import request from "supertest";
import { createApp } from "../index";
import {
  generateTestToken,
  regularUser,
  regularUserWithWorkspaceAccess,
  regularUserWithoutWorkspaceAccess,
  adminUser,
  adminWithoutWorkspaceAccess,
} from "./helpers/mockAuth";
import prisma from "../utils/prisma";
import {
  mockProviderPut,
  mockProviderGet,
  mockGetStorageProvider,
} from "./helpers/mockStorageProvider";

const app = createApp();

const DOC_ID = "doc-edit-001";
const WS_ID = "ws-1";
const PROJECT_ID = "proj-1";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Bounded poll for the fire-and-forget dispatch chain (fetch spy arm). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: predicate not satisfied before timeout");
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A completed md document, never DLP-scanned, provider-key carrying. */
function textDocFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    workspaceId: WS_ID,
    organizationId: ORG_ID,
    name: "report.md",
    type: "md",
    status: "completed",
    storageKey: `${ORG_ID}/uploads/33333333-3333-4333-8333-333333333333-report.md`,
    filePath: "/tmp/multer-gone.md",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    dlpScannedAt: null as Date | null,
    dlpScanState: null as string | null,
    // api-design sweep: the If-Match validator (optimistic concurrency).
    updatedAt: new Date("2026-09-24T10:00:00Z"),
    workspace: {
      id: WS_ID,
      name: "Test Workspace",
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      dlpDocumentScanEnabled: false,
      project: { id: PROJECT_ID, createdBy: "other-user" },
    },
    chunks: [],
    ...overrides,
  };
}

const fetchSpy = jest.spyOn(globalThis, "fetch");

beforeEach(() => {
  jest.clearAllMocks();
  fetchSpy.mockReset();

  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === regularUser.id) return Promise.resolve(regularUser);
    if (id === regularUserWithWorkspaceAccess.id) return Promise.resolve(regularUserWithWorkspaceAccess);
    if (id === regularUserWithoutWorkspaceAccess.id) return Promise.resolve(regularUserWithoutWorkspaceAccess);
    if (id === adminUser.id) return Promise.resolve(adminUser);
    if (id === adminWithoutWorkspaceAccess.id) return Promise.resolve(adminWithoutWorkspaceAccess);
    return Promise.resolve(null);
  });

  (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
    if (args?.where?.userId === regularUserWithWorkspaceAccess.id && args?.where?.workspaceId === WS_ID) {
      // WR-02: the edit route grades the access row — the mock returns an
      // editor-granted row (the role filter accepts owner/editor rows).
      return Promise.resolve({ userId: regularUserWithWorkspaceAccess.id, workspaceId: WS_ID, role: "editor" });
    }
    return Promise.resolve(null);
  });
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  // Tenant context (185 D-09): live default-org membership for every user.
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
  (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ dlpDocumentScanEnabled: false });
  (prisma.dlpEntity.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
  (prisma.document.update as jest.Mock).mockResolvedValue({});
  // The dispatch chain's guarded processing claim (T-P3H-04 arm a) — default
  // to a successful claim so the fire-and-forget re-dispatch proceeds.
  (prisma.document.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  (prisma.document.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
  (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
  (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

  mockProviderPut.mockReset().mockResolvedValue({ key: "k", size: 10 });
  mockProviderGet.mockReset().mockResolvedValue(Buffer.from("edited body"));
  mockGetStorageProvider.mockReset().mockResolvedValue({
    put: mockProviderPut,
    get: mockProviderGet,
    getReadStream: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(true),
  });
});

describe("PUT /api/documents/:documentId/text — 400 validation arm (archivePages shape)", () => {
  it("returns 400 { error: Invalid request body, details } for an empty body string", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Invalid request body");
    expect(res.body.error.code).toBe("invalid_body");
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.error.details).toBeDefined();
    // Gate short-circuits BEFORE any stored-file mutation.
    expect(mockProviderPut).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing/null body field", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Invalid request body");
    expect(res.body.error.details).toEqual(expect.objectContaining({ body: expect.anything() }));
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .send({ body: "x" });

    expect(res.status).toBe(401);
  });

  it("returns 403 for a user without document:write permission", async () => {
    // regularUserWithoutWorkspaceAccess carries document:write? No — the
    // noPermUser does not. Use a permission-less fixture through the same
    // middleware chain: regular user WITHOUT write permission hits the
    // requirePermission gate BEFORE the document lookup.
    (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.id === "noperm-001") {
        return Promise.resolve({
          id: "noperm-001",
          username: "noperm",
          email: "noperm@test.com",
          passwordHash: "hashed",
          roles: [],
        });
      }
      return Promise.resolve(null);
    });
    const token = generateTestToken("noperm-001");
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "x" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Insufficient permissions");
  });
});

describe("PUT /api/documents/:documentId/text — 404 arm", () => {
  it("returns 404 { error: Document not found } for an unknown documentId", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "new text" });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Document not found");
    expect(res.body.error.code).toBe("document_not_found");
    expect(mockProviderPut).not.toHaveBeenCalled();
  });
});

describe("PUT /api/documents/:documentId/text — 403 IDOR arm (access triple-check)", () => {
  it("returns 403 Access denied when the user has no owner/workspace/project access", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUserWithoutWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "new text" });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Access denied to this document");
    expect(mockProviderPut).not.toHaveBeenCalled();
  });

  it("returns 403 for an ADMIN without workspace access (T-78-01: admin does NOT bypass)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(adminWithoutWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "new text" });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Access denied to this document");
  });

  it("returns 202 for a project owner (createdBy === userId) even without access rows", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({
        workspace: {
          id: WS_ID,
          name: "Test Workspace",
          projectId: PROJECT_ID,
          organizationId: ORG_ID,
          dlpDocumentScanEnabled: false,
          project: { id: PROJECT_ID, createdBy: regularUser.id },
        },
      }),
    );
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "owner edit" });

    expect(res.status).toBe(202);
    await waitFor(() => fetchSpy.mock.calls.length > 0);
  });
});

describe("PUT /api/documents/:documentId/text — 409 arm", () => {
  it("returns 409 Document is not completed when status is processing", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({ status: "processing" }),
    );
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "new text" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("Document is not completed");
    expect(res.body.error.code).toBe("document_not_completed");
    expect(mockProviderPut).not.toHaveBeenCalled();
  });
});

describe("PUT /api/documents/:documentId/text — 202 text-type overwrite arm (md/txt/csv)", () => {
  it("returns 202 { documentId, status: reindexing }; provider.put rides the SAME storageKey; row type/key unchanged", async () => {
    const doc = textDocFixture({ dlpScannedAt: null });
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(doc);
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ documentId: DOC_ID, status: "reindexing" });

    await waitFor(() => mockProviderPut.mock.calls.length > 0);
    // Same-key overwrite (LocalFS overwrite-idempotent put)
    expect(mockProviderPut).toHaveBeenCalledTimes(1);
    expect(mockProviderPut.mock.calls[0][1]).toBe(doc.storageKey);
    // Resolution rides the row's org (row's-org rule)
    expect(mockGetStorageProvider).toHaveBeenCalledWith(ORG_ID);

    // The re-index reset update carries ONLY derived-state resets — never
    // type/storageKey/filePath on a text-type row.
    const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
    const editUpdate = updateCalls.find(
      (c: any[]) => c[0]?.where?.id === DOC_ID && c[0]?.data?.status === "pending",
    );
    expect(editUpdate).toBeDefined();
    expect(editUpdate[0].data).toEqual({
      status: "pending",
      statusMessage: null,
    });
    // No DLP fields on an unscanned row
    expect(editUpdate[0].data).not.toHaveProperty("dlpScannedAt");
    expect(editUpdate[0].data).not.toHaveProperty("type");
    expect(editUpdate[0].data).not.toHaveProperty("storageKey");
  });

  it("unscanned row: dlpEntity.deleteMany (deleteEntityMap) is NOT called", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture({ dlpScannedAt: null }));
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    await waitFor(() => fetchSpy.mock.calls.length > 0);
    expect(prisma.dlpEntity.deleteMany).not.toHaveBeenCalled();
  });

  it("re-dispatch rides the FULL forwardToCollector chain: multipart POST with docType txt + row-carried storageKey", async () => {
    const doc = textDocFixture();
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(doc);
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    await waitFor(() => fetchSpy.mock.calls.length > 0);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/ingest");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Collector-Secret"]).toBe("test-collector-secret-for-unit-tests");
    // The edited text re-enters the ingest chain read THROUGH the provider
    // (row-carried key — the put's bytes, not a direct fs read).
    expect(mockProviderGet).toHaveBeenCalledWith(doc.storageKey);
  });

  it("row update lands BEFORE the dispatch chain's processing claim (no stale-status dispatch race)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    await waitFor(() => (prisma.document.updateMany as jest.Mock).mock.calls.length > 0);
    const updateOrder = (prisma.document.update as jest.Mock).mock.invocationCallOrder[0] ?? 0;
    const claimOrder = (prisma.document.updateMany as jest.Mock).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(updateOrder).toBeLessThan(claimOrder);
  });

  it("dispatch failure after the 202: the request already answered — no 500, failure surfaces via logger/failed-status only", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    (prisma.document.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED-mock"));
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    expect(res.status).toBe(202);
    await waitFor(
      () =>
        (prisma.document.update as jest.Mock).mock.calls.some(
          (c: any[]) => c[0]?.data?.status === "failed",
        ),
      2000,
    );
    // deleteSourceOnFailure:false — the edited stored source SURVIVES the
    // failure (Pitfall-3 recovery: admin reembed re-reads the stored file).
    expect(mockProviderPut).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/documents/:documentId/text — DLP re-scan arm (P2)", () => {
  it("dlpScannedAt-set row: the update clears dlpScannedAt + dlpScanState and deleteEntityMap refreshes the entity rows", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({
        dlpScannedAt: new Date("2026-09-01T00:00:00Z"),
        dlpScanState: "clean",
      }),
    );
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
    const editUpdate = updateCalls.find(
      (c: any) => c[0]?.where?.id === DOC_ID && c[0]?.data?.status === "pending",
    );
    expect(editUpdate).toBeDefined();
    expect(editUpdate[0].data).toEqual(
      expect.objectContaining({
        status: "pending",
        statusMessage: null,
        dlpScannedAt: null,
        dlpScanState: null,
      }),
    );
    expect(editUpdate[0].data).not.toHaveProperty("type");
    expect(editUpdate[0].data).not.toHaveProperty("storageKey");
    // Entity-map refresh (deleteEntityMap export wired into the re-scan arm)
    expect(prisma.dlpEntity.deleteMany).toHaveBeenCalledWith({ where: { documentId: DOC_ID } });
  });
});

describe("PUT /api/documents/:documentId/text — binary-type pdf→txt swap arm", () => {
  it("pdf row: provider.put with a NEW .txt key + row updated { storageKey, filePath, type: txt } BEFORE dispatch", async () => {
    const doc = textDocFixture({
      type: "pdf",
      name: "scan.pdf",
      storageKey: `${ORG_ID}/uploads/44444444-4444-4444-8444-444444444444-scan.pdf`,
    });
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(doc);
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    expect(res.status).toBe(202);
    await waitFor(() => mockProviderPut.mock.calls.length > 0);

    // NEW <org>/uploads/<uuid>-<safeName>.txt key (T-204-07: server-side composition only)
    expect(mockProviderPut).toHaveBeenCalledTimes(1);
    const newKey = mockProviderPut.mock.calls[0][1] as string;
    expect(newKey).toMatch(new RegExp(`^${ORG_ID}/uploads/[0-9a-f-]{36}-scan\\.txt$`));
    expect(newKey).not.toBe(doc.storageKey);

    // Row swap persisted BEFORE dispatch (the status callback never updates type)
    const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
    const swapUpdate = updateCalls.find((c: any) => c[0]?.data?.type === "txt");
    expect(swapUpdate).toBeDefined();
    expect(swapUpdate[0].where.id).toBe(DOC_ID);
    expect(swapUpdate[0].data).toEqual(
      expect.objectContaining({
        type: "txt",
        storageKey: newKey,
        filePath: `storage/uploads/${newKey}`,
        status: "pending",
        statusMessage: null,
      }),
    );

    await waitFor(() => fetchSpy.mock.calls.length > 0);
    // The dispatch reads the NEW key through the provider (post-swap source)
    expect(mockProviderGet).toHaveBeenCalledWith(newKey);
  });

  it("scanned pdf row: the swap update ALSO carries the DLP marker-clear in the same update", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({
        type: "docx",
        name: "notes.docx",
        dlpScannedAt: new Date("2026-09-01T00:00:00Z"),
        dlpScanState: "scanned",
      }),
    );
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    await waitFor(() => mockProviderPut.mock.calls.length > 0);
    const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
    const swapUpdate = updateCalls.find((c: any) => c[0]?.data?.type === "txt");
    expect(swapUpdate).toBeDefined();
    expect(swapUpdate[0].data).toEqual(
      expect.objectContaining({
        dlpScannedAt: null,
        dlpScanState: null,
        status: "pending",
      }),
    );
    expect(prisma.dlpEntity.deleteMany).toHaveBeenCalledWith({ where: { documentId: DOC_ID } });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 204-REVIEW fixes — WR-02 (viewer-role grant cannot rewrite text),
// WR-03 (in-flight DLP scan → fail-closed 409), CR-01 server arm
// (placeholder-bearing edit on a scanned row → 400), WR-01 (entity-map
// deletion AFTER the put + row update; a failed put keeps the map).
// ═══════════════════════════════════════════════════════════════════

describe("PUT /api/documents/:documentId/text — WR-02 role-graded access arm", () => {
  /** Mock that honors the route's owner/editor role filter the way the real
   *  DB would: a row whose role is outside the `where.role.in` filter is not
   *  returned. */
  function mockWorkspaceAccessRow(role: string) {
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.userId !== regularUserWithWorkspaceAccess.id || args?.where?.workspaceId !== WS_ID) {
        return Promise.resolve(null);
      }
      const accepted: string[] = args?.where?.role?.in ?? [];
      if (accepted.length > 0 && !accepted.includes(role)) return Promise.resolve(null);
      return Promise.resolve({ userId: regularUserWithWorkspaceAccess.id, workspaceId: WS_ID, role });
    });
  }

  it("returns 403 when the workspaceAccess row carries the default viewer role (no editor/owner grant)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    mockWorkspaceAccessRow("viewer");
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "attacker-supplied text" });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Access denied to this document");
    expect(mockProviderPut).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it("the workspaceAccess query is role-filtered to owner/editor (source-level grading pin)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    await waitFor(() => mockProviderPut.mock.calls.length > 0);
    const findFirstArg = (prisma.workspaceAccess.findFirst as jest.Mock).mock.calls[0][0] as {
      where?: { role?: unknown };
    };
    expect(findFirstArg.where?.role).toEqual({ in: ["owner", "editor"] });
  });

  it("returns 202 for an owner-granted row (owner passes the same filter)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    mockWorkspaceAccessRow("owner");
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "owner edit" });

    expect(res.status).toBe(202);
    await waitFor(() => mockProviderPut.mock.calls.length > 0);
  });
});

describe("PUT /api/documents/:documentId/text — WR-03 in-flight-scan 409 arm", () => {
  it("returns 409 { error: Document is being DLP-scanned } when dlpScanState is scanning (fail-closed)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({ dlpScanState: "scanning" }),
    );
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "new text" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("Document is being DLP-scanned");
    expect(res.body.error.code).toBe("document_scanning");
    expect(mockProviderPut).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(prisma.dlpEntity.deleteMany).not.toHaveBeenCalled();
  });

  it("a finished scan (dlpScanState clean/scanned/failed) does NOT block the edit", async () => {
    for (const state of ["clean", "scanned", "failed"]) {
      jest.clearAllMocks();
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(regularUserWithWorkspaceAccess);
      (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({ role: "editor" });
      (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
      (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ dlpDocumentScanEnabled: false });
      (prisma.dlpEntity.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.document.update as jest.Mock).mockResolvedValue({});
      (prisma.document.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.document.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
      mockProviderPut.mockReset().mockResolvedValue({ key: "k", size: 10 });
      mockProviderGet.mockReset().mockResolvedValue(Buffer.from("edited body"));
      mockGetStorageProvider.mockReset().mockResolvedValue({
        put: mockProviderPut,
        get: mockProviderGet,
        getReadStream: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        exists: jest.fn().mockResolvedValue(true),
      });
      fetchSpy.mockReset();

      (prisma.document.findFirst as jest.Mock).mockResolvedValue(
        textDocFixture({ dlpScanState: state }),
      );
      const token = generateTestToken(regularUserWithWorkspaceAccess.id);
      const res = await request(app)
        .put(`/api/documents/${DOC_ID}/text`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body: "new text" });
      expect(res.status).toBe(202);
    }
  });
});

describe("PUT /api/documents/:documentId/text — CR-01 placeholder-edit 400 arm", () => {
  it("returns 400 { error: Edited body still contains DLP placeholders } when a SCANNED row's edited body carries placeholder tokens", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({
        dlpScannedAt: new Date("2026-09-01T00:00:00Z"),
        dlpScanState: "scanned",
      }),
    );
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Il cliente [PERSON_1] abita in [ADDRESS_1]." });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Edited body still contains DLP placeholders");
    expect(res.body.error.code).toBe("dlp_placeholder_edit");
    // Nothing durable happened: no put, no row update, and critically NO
    // entity-map deletion (the one-way door stays shut).
    expect(mockProviderPut).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(prisma.dlpEntity.deleteMany).not.toHaveBeenCalled();
  });

  it("tolerant matching: whitespace/case variants of the placeholder shape also 400", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({
        dlpScannedAt: new Date("2026-09-01T00:00:00Z"),
        dlpScanState: "clean",
      }),
    );
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Il cliente [ person_1 ] abita qui." });

    expect(res.status).toBe(400);
    expect(prisma.dlpEntity.deleteMany).not.toHaveBeenCalled();
  });

  it("an UNscanned row is NOT subject to the placeholder 400 (placeholder-shaped text on a toggle-off doc edits fine)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture({ dlpScannedAt: null }));
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the word [PERSON_1] appears in this template" });

    expect(res.status).toBe(202);
    await waitFor(() => mockProviderPut.mock.calls.length > 0);
    expect(prisma.dlpEntity.deleteMany).not.toHaveBeenCalled();
  });
});

describe("PUT /api/documents/:documentId/text — WR-01 entity-map deletion ordering", () => {
  it("a FAILED provider.put on a scanned row leaves the entity map INTACT (deleteEntityMap runs after the put, never before)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({
        dlpScannedAt: new Date("2026-09-01T00:00:00Z"),
        dlpScanState: "scanned",
      }),
    );
    mockProviderPut.mockRejectedValueOnce(new Error("S3 503"));
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    expect(res.status).toBe(500);
    // The one-way-door map survives the failed edit — the row stays
    // completed + dlpScannedAt set, so the map is still the only
    // re-composition source.
    expect(prisma.dlpEntity.deleteMany).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it("a successful edit on a scanned row deletes the entity map AFTER the put + row update (ordering pin)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(
      textDocFixture({
        dlpScannedAt: new Date("2026-09-01T00:00:00Z"),
        dlpScanState: "scanned",
      }),
    );
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "the edited text" });

    await waitFor(() => prisma.dlpEntity.deleteMany.mock.calls.length > 0);
    const putOrder = mockProviderPut.mock.invocationCallOrder[0];
    const updateOrder = (prisma.document.update as jest.Mock).mock.invocationCallOrder[0];
    const mapDeleteOrder = (prisma.dlpEntity.deleteMany as jest.Mock).mock.invocationCallOrder[0];
    expect(putOrder).toBeLessThan(updateOrder);
    expect(updateOrder).toBeLessThan(mapDeleteOrder);
  });
});


describe("PUT /api/documents/:documentId/text — If-Match optimistic concurrency (api-design sweep)", () => {
  const TOKEN = () => `Bearer ${generateTestToken(regularUserWithWorkspaceAccess.id)}`;
  const CURRENT = "2026-09-24T10:00:00.000Z";

  it("stale If-Match → 409 stale_version with the current validator; no mutation, no dispatch", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .set("If-Match", '"2026-09-24T09:00:00.000Z"')
      .send({ body: "edited" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("stale_version");
    expect(res.body.error.message).toBe("Document was modified by another editor");
    expect(res.body.error.details.currentUpdatedAt).toBe(CURRENT);
    expect(res.body.error.requestId).toBeDefined();
    expect(mockProviderPut).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(prisma.document.updateMany).not.toHaveBeenCalled();
  });

  it("matching If-Match (quoted updatedAt) → edit proceeds (202)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .set("If-Match", `"${CURRENT}"`)
      .send({ body: "edited" });

    expect(res.status).toBe(202);
    await waitFor(() => fetchSpy.mock.calls.length > 0);
  });

  it("If-Match: * matches any current state → proceeds (202)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(textDocFixture());
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .put(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .set("If-Match", "*")
      .send({ body: "edited" });

    expect(res.status).toBe(202);
    await waitFor(() => fetchSpy.mock.calls.length > 0);
  });
});
