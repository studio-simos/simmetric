// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Quick 260829-jv7 — Task 1 (D-01): the collector ingest-status callback
 * (`PUT /api/documents/:id/status`) must NEVER unlink a staged draft file
 * under storage/uploads/drafts/.
 *
 * Incident reproduction: draft d6ef3403 had its staged file erased by a
 * sibling terminal callback ~60s after both legs read it — every retry
 * then ENOENTs because all Documents of a draft share the SAME drafts
 * filePath. Suppression is keyed on the reaper-A5 prefix rule
 * (path.resolve + prefix + trailing path.sep):
 *   - storage/uploads/drafts/<file>   → suppressed (both terminal statuses)
 *   - storage/uploads/tmp-abc123.pdf  → unlinked (direct-upload multer tmp
 *     cleanup contract T-69-07 preserved)
 *   - storage/uploads/drafts-evil/x.pdf → unlinked (trailing-sep semantics —
 *     a sibling prefix directory is NOT a drafts path)
 *
 * Mock scaffold mirrors documentUpload.test.ts (prisma/env/settings mocks);
 * the documents router is mounted directly on a minimal express app
 * (uploads.test.ts style) instead of booting createApp (heavy).
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
  getSetting: jest.fn(() => ({ value: "" })),
}));
jest.mock("../services/ftsService", () => ({
  initPostgreSQLFTS: jest.fn(),
  MULTI_CONFIG_TSVECTOR: "to_tsvector('english', t)",
}));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

import request from "supertest";
import express from "express";
import fs from "fs";
import documentsRouter from "../routes/documents";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

const app = express();
app.use(express.json());
app.use("/api/documents", documentsRouter);

const COLLECTOR_SECRET = "test-collector-secret-for-unit-tests";

/** Document row fixture as prisma.document.update would resolve it. */
const docFixture = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "doc-1",
  workspaceId: "ws-1",
  name: "preventivo.pdf",
  type: "pdf",
  filePath: "storage/uploads/drafts/d6ef3403_preventivo.pdf",
  cacheKey: "cache-1",
  chunkCount: 3,
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  status: "processing",
  fileSize: 1234,
  deletedAt: null,
  ...overrides,
});

// fs spy discipline (uploads.test.ts style): keep real references, re-apply
// in beforeEach, never rely on mockRestore leaking across tests.
const REAL_FS_EXISTS_SYNC = fs.existsSync;
const REAL_FS_UNLINK_SYNC = fs.unlinkSync;

describe("PUT /api/documents/:id/status — draft-file callback guard (260829-jv7)", () => {
  let unlinkSpy: jest.SpyInstance;
  let loggerInfoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync = REAL_FS_EXISTS_SYNC;
    fs.unlinkSync = REAL_FS_UNLINK_SYNC;
    // Default per-test setup: the file EXISTS on disk (the suppression must
    // hold even then) and unlinkSync is observed but must not fire for
    // draft-owned paths.
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    loggerInfoSpy = jest.spyOn(logger, "info").mockImplementation(() => logger as never);
  });

  it("260829-jv7 incident pin: status=completed with a storage/uploads/drafts/ filePath → unlinkSync MUST NOT be called", async () => {
    (prisma.document.update as jest.Mock).mockResolvedValue(docFixture());

    const res = await request(app)
      .put("/api/documents/doc-1/status")
      .set({ "x-collector-secret": COLLECTOR_SECRET })
      .send({ status: "completed", chunkCount: 3 });

    expect(res.status).toBe(200);
    // D-01: the staged draft file is draft-owned — NEVER deleted by the
    // callback, even though the file exists on disk.
    expect(unlinkSpy).not.toHaveBeenCalled();
    // Suppression is observable at info level.
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        documentId: "doc-1",
        filePath: "storage/uploads/drafts/d6ef3403_preventivo.pdf",
      }),
    );
  });

  it("status=failed with a drafts filePath → unlinkSync never called (both terminal statuses suppressed)", async () => {
    (prisma.document.update as jest.Mock).mockResolvedValue(
      docFixture({ filePath: "storage/uploads/drafts/anything.pdf" }),
    );

    const res = await request(app)
      .put("/api/documents/doc-1/status")
      .set({ "x-collector-secret": COLLECTOR_SECRET })
      .send({ status: "failed", statusMessage: "boom" });

    expect(res.status).toBe(200);
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("direct-upload multer tmp path (storage/uploads/tmp-abc123.pdf) → unlinkSync IS called (T-69-07 contract preserved)", async () => {
    (prisma.document.update as jest.Mock).mockResolvedValue(
      docFixture({ filePath: "storage/uploads/tmp-abc123.pdf" }),
    );

    const res = await request(app)
      .put("/api/documents/doc-1/status")
      .set({ "x-collector-secret": COLLECTOR_SECRET })
      .send({ status: "completed" });

    expect(res.status).toBe(200);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    // Unlink semantics identical for non-suppressed paths: the RAW filePath
    // as stored (matches the pre-existing handler behavior).
    expect(unlinkSpy).toHaveBeenCalledWith("storage/uploads/tmp-abc123.pdf");
  });

  it("drafts-evil sibling prefix (storage/uploads/drafts-evil/x.pdf) → unlinkSync IS called (trailing-sep semantics)", async () => {
    (prisma.document.update as jest.Mock).mockResolvedValue(
      docFixture({ filePath: "storage/uploads/drafts-evil/x.pdf" }),
    );

    const res = await request(app)
      .put("/api/documents/doc-1/status")
      .set({ "x-collector-secret": COLLECTOR_SECRET })
      .send({ status: "failed" });

    expect(res.status).toBe(200);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledWith("storage/uploads/drafts-evil/x.pdf");
  });

  it("body missing/invalid per IngestStatusCallbackSchema → 400 with details (contract unchanged)", async () => {
    const res = await request(app)
      .put("/api/documents/doc-1/status")
      .set({ "x-collector-secret": COLLECTOR_SECRET })
      .send({ status: "processing" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid ingest status callback");
    expect(res.body.details).toBeDefined();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("wrong x-collector-secret → 401 (contract unchanged)", async () => {
    const res = await request(app)
      .put("/api/documents/doc-1/status")
      .set({ "x-collector-secret": "wrong-secret" })
      .send({ status: "completed" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("missing staged file (existsSync false) + drafts path → unlinkSync still not called (no crash)", async () => {
    (prisma.document.update as jest.Mock).mockResolvedValue(docFixture());
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    const res = await request(app)
      .put("/api/documents/doc-1/status")
      .set({ "x-collector-secret": COLLECTOR_SECRET })
      .send({ status: "completed" });

    expect(res.status).toBe(200);
    expect(unlinkSpy).not.toHaveBeenCalled();
  });
});