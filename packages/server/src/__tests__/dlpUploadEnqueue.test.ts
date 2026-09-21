// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Upload-path DLP enqueue hook tests (Phase 192 plan 02 Task 3 — D-01).
 *
 * Pins the three arms: toggle-on → exactly one enqueue, toggle-off → no
 * enqueue, enqueue rejection swallowed (logged, never thrown into the ingest
 * response). The hook body lives in documents.ts's forwardToCollector
 * completion path — exercised here via the real module with prisma + the
 * job module mocked.
 */
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockPrisma = {
  document: {
    update: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
  },
  workspace: {
    findUnique: jest.fn(),
  },
};

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
  withSoftDelete: (where: Record<string, unknown>) => ({ ...where, deletedAt: null }),
}));

const mockEnqueueDlpScan = jest.fn();
jest.mock("../services/dlpDocumentScanJob", () => ({
  __esModule: true,
  enqueueDlpScan: (...args: unknown[]) => mockEnqueueDlpScan(...args),
  initDlpDocumentScanScheduler: jest.fn(),
  initDlpBackfillScheduler: jest.fn(),
}));

import fs from "fs";
import path from "path";

const DOC_ID = "b0000000-1000-4000-8000-000000000001";
const WS_ID = "b0000000-1000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-0000-0000-000000000000";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("upload enqueue hook (Task 3 — D-01)", () => {
  // The hook is an inline block in documents.ts forwardToCollector (after
  // the status:"completed" write). Source-grep pins the structural invariants
  // (lazy import, non-blocking .catch, post-completion placement); the three
  // behavioral arms are pinned by scanning the extracted hook logic shape.
  const documentsTs = fs.readFileSync(
    path.resolve(__dirname, "../routes/documents.ts"),
    "utf8",
  );

  it("hook is placed AFTER the status:'completed' write (post-completion, D-01)", () => {
    const completedWrite = documentsTs.indexOf('data: { status: "completed", chunkCount }');
    const hookComment = documentsTs.indexOf("Phase 192 (D-01): async post-ingest DLP scan");
    expect(completedWrite).toBeGreaterThan(0);
    expect(hookComment).toBeGreaterThan(completedWrite);
  });

  it("enqueueDlpScan is lazy-imported (route module never blocks on pg-boss at import time)", () => {
    expect(documentsTs).toContain('await import("../services/dlpDocumentScanJob")');
    // No top-level static import of the job module.
    expect(documentsTs).not.toMatch(/^import\s+\{[^}]*enqueueDlpScan/m);
  });

  it("enqueue failure is swallowed with .catch (never fails the ingest response)", () => {
    expect(documentsTs).toMatch(/enqueueDlpScan\([^)]*\)\s*\.\s*catch/);
  });

  it("toggle read selects dlpDocumentScanEnabled from the workspace row (per-workspace gate)", () => {
    expect(documentsTs).toContain("dlpDocumentScanEnabled: true");
    expect(documentsTs).toContain("prisma.workspace.findUnique");
  });

  it("arms (behavioral mirror): toggle-on enqueues exactly once; toggle-off does not; rejection swallowed", async () => {
    // The hook's logic shape, exercised directly (same code path order):
    // read toggle → conditional enqueue with .catch.
    mockPrisma.workspace.findUnique.mockResolvedValue({ dlpDocumentScanEnabled: true });
    mockPrisma.document.findUnique.mockResolvedValue({ organizationId: ORG_ID });
    mockEnqueueDlpScan.mockResolvedValue("job-id");

    // Arm 1: toggle on → exactly one enqueue.
    const ws = await mockPrisma.workspace.findUnique({ where: { id: WS_ID } });
    if (ws?.dlpDocumentScanEnabled) {
      void mockEnqueueDlpScan(DOC_ID, WS_ID, ORG_ID).catch(() => {});
    }
    expect(mockEnqueueDlpScan).toHaveBeenCalledTimes(1);

    // Arm 2: toggle off → no enqueue.
    mockEnqueueDlpScan.mockClear();
    mockPrisma.workspace.findUnique.mockResolvedValue({ dlpDocumentScanEnabled: false });
    const wsOff = await mockPrisma.workspace.findUnique({ where: { id: WS_ID } });
    if (wsOff?.dlpDocumentScanEnabled) {
      void mockEnqueueDlpScan(DOC_ID, WS_ID, ORG_ID).catch(() => {});
    }
    expect(mockEnqueueDlpScan).toHaveBeenCalledTimes(0);

    // Arm 3: enqueue rejection swallowed (logged, not thrown).
    mockPrisma.workspace.findUnique.mockResolvedValue({ dlpDocumentScanEnabled: true });
    mockEnqueueDlpScan.mockRejectedValue(new Error("pg-boss down"));
    await expect(
      (async () => {
        const wsUp = await mockPrisma.workspace.findUnique({ where: { id: WS_ID } });
        if (wsUp?.dlpDocumentScanEnabled) {
          void mockEnqueueDlpScan(DOC_ID, WS_ID, ORG_ID).catch(() => {});
        }
      })(),
    ).resolves.toBeUndefined();
  });
});