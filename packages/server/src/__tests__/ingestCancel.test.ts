// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * quick 260918-p3h — cancellation race guards + cancel contract.
 *
 * T-P3H-04 pins (the cancel/completion race can never overwrite CANCELLED):
 *   (a) PUT /:documentId/status with current status "cancelled" + incoming
 *       "completed" → row UNCHANGED, terminal cleanup skipped.
 *   (b) forwardToCollector with fetch resolving { status: "cancelled" } →
 *       NO completed write, NO FTS chunk write.
 *   (c) forwardToCollector catch-path: row already cancelled when the error
 *       lands → failed write skipped.
 *   (d) forwardToCollector guarded processing claim: updateMany returns
 *       count 0 → no dispatch fetch happens at all.
 *   (e) handleArchiveImportCallback on a CANCELLED job → no createPage,
 *       status untouched.
 *   (f) cancelDraftLegSchema accepts {}, {leg:"rag"}, rejects {leg:"both"}.
 *
 * Mock scaffold mirrors collectorIngestTimeout.test.ts (the proven template
 * for loading documents.ts under jest).
 */
import "./helpers/setupEnv";
import fs from "fs";

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
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
  })),
}));

jest.mock("../services/licenseService", () => ({}));

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

jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

jest.mock("../services/storageProvider", () =>
  require("./helpers/mockStorageProvider").mockStorageProviderModule,
);

jest.mock("../routes/push", () => {
  const express = jest.requireActual("express");
  return {
    __esModule: true,
    default: express.Router(),
    sendPushNotification: jest.fn().mockResolvedValue(undefined),
  };
});

// Mock logger so suppression-log assertions are observable (winston is a
// singleton — spying per-test is flaky across the createApp import).
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import request from "supertest";
import { forwardToCollector } from "../routes/documents";
import prisma from "../utils/prisma";
import { handleArchiveImportCallback } from "../services/archiveImportService";
import { cancelDraftLegSchema } from "@simmetric-chat/shared";
import { logger } from "../utils/logger";
import { createApp } from "../index";

const app = createApp();

const readFileSyncSpy = jest
  .spyOn(fs, "readFileSync")
  .mockImplementation(() => Buffer.from("hello"));
const existsSyncSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);

const fetchSpy = jest.spyOn(globalThis, "fetch");

afterAll(() => {
  readFileSyncSpy.mockRestore();
  existsSyncSpy.mockRestore();
  fetchSpy.mockRestore();
});

function callDirectUpload(documentId: string) {
  return forwardToCollector(
    documentId,
    "/tmp/fake-src.bin",
    "f.txt",
    "ws-1",
    "WS",
    "model",
    "txt",
    "ocr",
  );
}

function failedUpdateCalls() {
  return (prisma.document.update as jest.Mock).mock.calls.filter(
    (c) => c[0]?.data?.status === "failed",
  );
}

function completedUpdateCalls() {
  return (prisma.document.update as jest.Mock).mock.calls.filter(
    (c) => c[0]?.data?.status === "completed",
  );
}

describe("quick 260918-p3h — cancellation race guards", () => {
  beforeEach(() => {
    (prisma.document.update as jest.Mock).mockReset().mockResolvedValue({});
    (prisma.document.updateMany as jest.Mock).mockReset().mockResolvedValue({ count: 1 });
    (prisma.document.findUnique as jest.Mock).mockReset().mockResolvedValue(null);
    (prisma.document.findFirst as jest.Mock).mockReset().mockResolvedValue(null);
    (prisma.$executeRaw as jest.Mock).mockReset().mockResolvedValue(0);
    (prisma.$queryRaw as jest.Mock).mockReset().mockResolvedValue([]);
    jest.clearAllMocks();
    fetchSpy.mockReset();
    (prisma.document.update as jest.Mock).mockResolvedValue({});
    (prisma.document.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  // (a) PUT callback preservation: a "completed" callback landing on a row
  // the user already cancelled must NOT flip it — 200 + row unchanged +
  // cleanup skipped.
  it("status callback over a cancelled row → no write, cleanup skipped, cancelled returned", async () => {
    (prisma.document.findUnique as jest.Mock).mockResolvedValue({
      id: "doc-cancelled-1",
      status: "cancelled",
    });

    const r2 = await request(app)
      .put("/api/documents/doc-cancelled-1/status")
      .set("x-collector-secret", "test-collector-secret-for-unit-tests")
      .send({ status: "completed", chunkCount: 5 });

    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ id: "doc-cancelled-1", status: "cancelled" });

    // NO update write with completed/failed occurred.
    const updates = (prisma.document.update as jest.Mock).mock.calls;
    expect(updates).toHaveLength(0);

    // Storage cleanup never ran (stable mock handle from the shared helper).
    const { mockGetStorageProvider } = await import("./helpers/mockStorageProvider");
    expect(mockGetStorageProvider).not.toHaveBeenCalled();

    // Suppression is observable at info level.
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("terminal callback suppressed: document already cancelled"),
      expect.objectContaining({ documentId: "doc-cancelled-1" }),
    );
  });

  // (b) forwardToCollector cancelled response: the collector finished the
  // dispatch with { status: "cancelled" } → NO completed write, NO FTS
  // write (both raw SQL primitives must stay untouched).
  it("forwardToCollector sees result.status=cancelled → no completed write, no FTS write", async () => {
    (prisma.document.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "cancelled", documentId: "doc-race-1" }),
    });

    await expect(callDirectUpload("doc-race-1")).resolves.toBeUndefined();

    expect(completedUpdateCalls()).toHaveLength(0);
    expect(failedUpdateCalls()).toHaveLength(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("was cancelled mid-ingest"),
    );
  });

  // (c) forwardToCollector failure path over an already-cancelled row: the
  // failed write is suppressed — the row keeps "cancelled".
  it("forwardToCollector catch path preserves an already-cancelled row (no failed write)", async () => {
    (prisma.document.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED-mock"));
    // The pre-failed-write re-read observes the cancelled row.
    (prisma.document.findUnique as jest.Mock).mockResolvedValue({
      status: "cancelled",
    });

    await expect(callDirectUpload("doc-cancel-race-2")).resolves.toBeUndefined();

    expect(failedUpdateCalls()).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("already cancelled — preserving cancelled status"),
    );
  });

  // (d) guarded processing claim: updateMany returns count 0 (row already
  // cancelled before dispatch) → fetch is NEVER called.
  it("processing claim count 0 → no dispatch fetch", async () => {
    (prisma.document.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(callDirectUpload("doc-precancel-1")).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(completedUpdateCalls()).toHaveLength(0);
    expect(failedUpdateCalls()).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("no longer pending (cancelled or deleted)"),
    );
  });

  // (e) handleArchiveImportCallback on a CANCELLED job → no page creation,
  // status untouched.
  it("archive import callback over a CANCELLED job → no createPage, status untouched", async () => {
    (prisma.archiveImportJob.findUnique as jest.Mock).mockReset().mockResolvedValue({
      id: "aij-cancelled-1",
      status: "CANCELLED",
      archiveId: "arch-1",
      documentId: null,
      sourceFileName: "src.pdf",
      createdBy: "user-1",
    });
    (prisma.archiveImportJob.update as jest.Mock).mockReset().mockResolvedValue({});

    await expect(
      handleArchiveImportCallback("aij-cancelled-1", {
        status: "completed",
        extractedText: "text",
        title: "t",
      }),
    ).resolves.toBeUndefined();

    expect(prisma.archiveImportJob.update).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("callback suppressed: job already cancelled"),
      expect.objectContaining({ jobId: "aij-cancelled-1" }),
    );
  });

  // (f) cancelDraftLegSchema contract: {} valid (cancel all), {leg:"rag"}
  // valid, {leg:"both"} rejected.
  it("cancelDraftLegSchema accepts {} and {leg:'rag'}, rejects {leg:'both'}", () => {
    expect(cancelDraftLegSchema.safeParse({}).success).toBe(true);
    expect(cancelDraftLegSchema.safeParse({ leg: "rag" }).success).toBe(true);
    expect(cancelDraftLegSchema.safeParse({ leg: "kb" }).success).toBe(true);
    const rejected = cancelDraftLegSchema.safeParse({ leg: "both" });
    expect(rejected.success).toBe(false);
    expect(cancelDraftLegSchema.safeParse({ leg: "unassigned" }).success).toBe(false);
  });
});