// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 260829-fty — forwardToCollector source-file failure-cleanup contract.
 *
 * WR-02 (documents.ts catch block) unlinks the source filePath on collector
 * failure. That behavior was designed for the direct-upload multer tmp path
 * (documents.ts:370 — no options argument). But dispatchRagLeg (unified
 * upload) hands forwardToCollector a DRAFT-OWNED staged file under
 * storage/uploads/drafts/ — the failure handler was destroying the draft's
 * evidence, making every future retry impossible (the ENOENT forever loop).
 *
 * Contract under test:
 *   - Test A (back-compat): direct-upload call shape (8 args, no options) →
 *     failure unlinks the source filePath + Document status "failed" with an
 *     ENOENT statusMessage (existing WR-02 contract preserved).
 *   - Test B (opt-out): 9th argument { deleteSourceOnFailure: false } →
 *     failure does NOT unlink the source filePath (the draft file survives
 *     for retry/re-upload; only the 24h reaper + DELETE route may remove it).
 *
 * Mock scaffold mirrors ocrRouting.test.ts (loads documents.ts under jest
 * with prisma/env/licenseService/systemConfigService mocked).
 */
import "./helpers/setupEnv";
// NOTE: default import (NOT `import * as fs`) — documents.ts also imports the
// default (`import fs from "fs"`), and jest.spyOn must mutate the SAME
// module.exports object. The namespace copy has distinct require semantics
// under @swc/jest CJS output; spying on it does not affect documents.ts.
import fs from "fs";

// Mock prisma singleton — createMockPrisma covers document.update etc.
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

// Mock env to satisfy transitive config imports (COLLECTOR_URL/SECRET).
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

// Mock licenseService — transitive import of documents.ts
jest.mock("../services/licenseService", () => ({}));

// Mock systemConfigService — getSetting used by the OCR routing block
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn((key: string) => {
    if (key === "EMBEDDING_MODEL") return { key, value: "Xenova/all-MiniLM-L6-v2" };
    if (key === "OCR_DEFAULT_MODEL") return { key, value: "glm-ocr:latest" };
    return { key, value: "" };
  }),
  getAllSettings: jest.fn(),
  updateSettings: jest.fn(),
  seedConfigDefaults: jest.fn(),
}));

// Mock ragOcrService — cleanupOcrTextFile is called on the failure path
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

import { forwardToCollector } from "../routes/documents";
import prisma from "../utils/prisma";
import { cleanupOcrTextFile } from "../services/ragOcrService";

// Deterministic non-PDF failure: docType "txt" skips the entire OCR routing
// block, and readFileSync throws → the WR-02 catch runs with a stable
// "ENOENT" message (no fetch, no collector HTTP).
const readFileSyncSpy = jest.spyOn(fs, "readFileSync").mockImplementation(() => {
  throw new Error("ENOENT: no such file or directory, open '/tmp/fake-src.bin'");
});
const existsSyncSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);

afterAll(() => {
  readFileSyncSpy.mockRestore();
  existsSyncSpy.mockRestore();
});

describe("forwardToCollector failure cleanup (260829-fty)", () => {
  beforeEach(() => {
    (prisma.document.update as jest.Mock).mockReset().mockResolvedValue({});
    (cleanupOcrTextFile as jest.Mock).mockReset().mockResolvedValue(undefined);
    jest.clearAllMocks();
  });

  // Test A: direct-upload call shape (NO options) → source file unlinked on
  // failure (existing WR-02 back-compat), Document status "failed" + ENOENT.
  it("direct-upload call (8 args, no options) → failure unlinks source filePath + Document failed (WR-02 back-compat)", async () => {
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      await forwardToCollector(
        "doc-1",
        "/tmp/fake-src.bin",
        "f.txt",
        "ws-1",
        "WS",
        "model",
        "txt",
        "ocr",
      );

      expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/fake-src.bin");
      expect(prisma.document.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "doc-1" },
          data: expect.objectContaining({
            status: "failed",
            statusMessage: expect.stringContaining("ENOENT"),
          }),
        }),
      );
      // The OCR temp-text-file cleanup must NOT be invoked: for docType "txt"
      // no temp text file exists (uploadFilePath === filePath throughout).
      expect(cleanupOcrTextFile).not.toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  // Test B: opt-out (9th arg) → source file NOT unlinked on failure. The
  // draft's staged file survives so the user can retry or delete manually.
  it("deleteSourceOnFailure: false (9th arg) → failure does NOT unlink source filePath", async () => {
    const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    try {
      await forwardToCollector(
        "doc-1",
        "/tmp/fake-src.bin",
        "f.txt",
        "ws-1",
        "WS",
        "model",
        "txt",
        "ocr",
        { deleteSourceOnFailure: false },
      );

      expect(fs.unlinkSync).not.toHaveBeenCalledWith("/tmp/fake-src.bin");
      // The failure still records the Document failure side effect — only the
      // file cleanup is opted out.
      expect(prisma.document.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "doc-1" },
          data: expect.objectContaining({ status: "failed" }),
        }),
      );
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});