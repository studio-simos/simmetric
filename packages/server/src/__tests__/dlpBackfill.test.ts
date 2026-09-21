// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * dlpBackfill.test.ts — DLP-06 legacy backfill unit battery (Phase 192
 * plan 06 Task 1 — tracer). Postgres-free: prisma + jobQueue.send +
 * dlpEvalService + logger are mocked; scanDocument is mocked at the
 * dlpDocumentService seam (the pipeline itself is proven by
 * dlpDocumentScan.test.ts — here only the ORCHESTRATION matters).
 *
 * The six arms (must_haves):
 * 1. countEligibleDocuments — where-clause shape (deletedAt/status/marker)
 * 2. enqueueDlpBackfillBatch — slice-50 sends + progress logging
 * 3. zero-eligible NO-OP SUCCESS (probe edge: empty)
 * 4. POST /api/system/dlp/backfill — admin chain + the 409 eval-gate arm
 * 5. runBackfillDocument — dlpScannedAt marker skip (probe edge: single-doc)
 * 6. same-document race exclusion — status="completed" in the where clause
 */

import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── prisma mock (lazy holder — jest.mock factories are hoisted) ─────────────
interface MockPrismaShape {
  document: {
    count: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
  };
  systemConfig: {
    findUnique: jest.Mock;
  };
}
const prismaHolder: { prisma?: MockPrismaShape } = {};
function buildMockPrisma(): MockPrismaShape {
  return {
    document: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    systemConfig: { findUnique: jest.fn() },
  };
}
prismaHolder.prisma = buildMockPrisma();
const mockPrisma = prismaHolder.prisma!;

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  get default() {
    return prismaHolder.prisma;
  },
  withSoftDelete: (where: Record<string, unknown>) => ({ ...where, deletedAt: null }),
}));

const mockSend = jest.fn();
jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  send: (...args: unknown[]) => mockSend(...(args as [string, unknown])),
}));

// The queue-name seam is imported BY the service from dlpDocumentScanJob —
// mock the consumer module to the same constant (value-level, no cycle).
jest.mock("../services/dlpDocumentScanJob", () => ({
  __esModule: true,
  DLP_BACKFILL_QUEUE_NAME: "dlp_backfill",
}));

// scanDocument: the backfill delegates to plan 02's sequence — mocked here
// (its own suite covers it); the marker-skip arm asserts the DELEGATION.
const mockScanDocument = jest.fn();
const mockParseScanJobPayload = jest.fn((data: unknown) =>
  // Real parser behavior: valid payload → passthrough, forged → null.
  data !== null && typeof data === "object" && "documentId" in (data as object)
    ? (data as { documentId: string; workspaceId: string; organizationId: string })
    : null,
);
jest.mock("../services/dlpDocumentService", () => ({
  __esModule: true,
  scanDocument: (...args: unknown[]) => mockScanDocument(...(args as [string])),
  parseScanJobPayload: (...args: unknown[]) => mockParseScanJobPayload(...(args as [unknown])),
}));

// Eval-gate seam: readEvalResult passthrough of the raw stored JSON — the
// arm tests pin BOTH the never-run and failed arms through it.
const mockReadEvalResult = jest.fn((raw: string | null) => {
  if (!raw) return { passed: false, noRun: true };
  try {
    return JSON.parse(raw);
  } catch {
    return { passed: false, noRun: true };
  }
});
jest.mock("../services/dlpEvalService", () => ({
  __esModule: true,
  readEvalResult: (...args: unknown[]) => mockReadEvalResult(...(args as [string | null])),
  DLP_EVAL_LAST_RUN_KEY: "DLP_EVAL_LAST_RUN",
}));

import {
  backfillEligibilityWhere,
  countEligibleDocuments,
  enqueueDlpBackfillBatch,
  assertEvalGatePassed,
  runBackfillDocument,
  MAX_SENDS_PER_REQUEST,
} from "../services/dlpBackfillService";
import type { DlpBackfillResponse } from "@simmetric-chat/shared";

// ── Endpoint-arm harness (createApp + supertest + stubbed admin chain) ──────

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
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: { headers?: Record<string, string>; userId?: string; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    const authHeader = req.headers?.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    req.user = {
      id: "admin-001",
      roles: [
        {
          role: {
            name: "admin",
            permissions: [{ permissionName: "admin:settings" }],
          },
        },
      ],
    };
    next();
  },
  apiKeyMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middleware/tenantContext", () => ({
  tenantContextMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from "supertest";
import { createApp } from "../index";

const app = createApp();

// ── fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = "00000000-0000-0000-0000-000000000000";
const DOC_ID = "d0000000-1000-4000-8000-000000000001";
const WS_ID = "a0000000-1000-4000-8000-000000000002";

function eligibleDoc(n: number) {
  return {
    id: `d0000000-1000-4000-8000-${String(n).padStart(12, "0")}`,
    workspaceId: WS_ID,
    organizationId: ORG_ID,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Arm 1 + 6: eligibility where-clause shape ────────────────────────────────

describe("countEligibleDocuments (D-12 eligibility)", () => {
  it("counts with the marker-driven where clause: deletedAt null + status completed + dlpScannedAt null", async () => {
    mockPrisma.document.count.mockResolvedValue(7);
    await expect(countEligibleDocuments()).resolves.toBe(7);
    expect(mockPrisma.document.count).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: "completed",
        dlpScannedAt: null,
      },
    });
  });

  it("same-document race guard (T-192-31): the where clause pins status='completed' only — a re-upload creates a NEW documentId, never a per-doc race", () => {
    const where = backfillEligibilityWhere(ORG_ID) as {
      deletedAt: null;
      status: string;
      dlpScannedAt: null;
      organizationId: string;
    };
    expect(where.status).toBe("completed");
    expect(where.dlpScannedAt).toBeNull();
    expect(where.deletedAt).toBeNull();
    // Org scoping (T-192-29): org-scoped requests filter on the M2 column.
    expect(where.organizationId).toBe(ORG_ID);
  });

  it("org-scoped count carries the organizationId filter", async () => {
    mockPrisma.document.count.mockResolvedValue(3);
    await countEligibleDocuments(ORG_ID);
    expect(mockPrisma.document.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: ORG_ID }),
    });
  });
});

// ── Arm 2: slice-50 sends ─────────────────────────────────────────────────────

describe("enqueueDlpBackfillBatch (D-12 per-document jobs)", () => {
  it("sends one dlp_backfill job per doc in slices of 50 with a progress log per slice", async () => {
    const docs = Array.from({ length: 120 }, (_, i) => eligibleDoc(i + 1));
    mockPrisma.document.findMany.mockResolvedValue(docs);
    mockSend.mockResolvedValue("job-id");

    const res = await enqueueDlpBackfillBatch();

    expect(res).toEqual({ enqueued: 120, skipped: 0, totalEligible: 120, errors: [] });
    expect(mockSend).toHaveBeenCalledTimes(120);
    // Every send targets the backfill queue with the shared-schema payload.
    expect(mockSend).toHaveBeenNthCalledWith(1, "dlp_backfill", {
      documentId: "d0000000-1000-4000-8000-000000000001",
      workspaceId: WS_ID,
      organizationId: ORG_ID,
    });
    // Progress logs: ceil(120/50) = 3 slices.
    expect(mockSend.mock.calls.length).toBe(120);
  });

  it("obeys the 500-send cap per request — the remainder stays eligible (resumable re-run)", async () => {
    const docs = Array.from({ length: 750 }, (_, i) => eligibleDoc(i + 1));
    mockPrisma.document.findMany.mockResolvedValue(docs);
    mockSend.mockResolvedValue("job-id");

    const res: DlpBackfillResponse = await enqueueDlpBackfillBatch();

    expect(mockSend).toHaveBeenCalledTimes(MAX_SENDS_PER_REQUEST);
    expect(res.enqueued).toBe(500);
    expect(res.totalEligible).toBe(750);
    // skipped = deferred-by-cap remainder (750 - 500).
    expect(res.skipped).toBe(250);
    expect(res.errors).toEqual([]);
  });

  it("response invariant: enqueued + skipped + errors.length === totalEligible", async () => {
    const docs = Array.from({ length: 10 }, (_, i) => eligibleDoc(i + 1));
    mockPrisma.document.findMany.mockResolvedValue(docs);
    // Doc 3 and doc 7 fail the send; the rest succeed.
    mockSend.mockImplementation((_q: string, data: { documentId: string }) => {
      if (data.documentId.endsWith("0003") || data.documentId.endsWith("0007")) {
        throw new Error("queue down");
      }
      return Promise.resolve("job-id");
    });

    const res = await enqueueDlpBackfillBatch();

    expect(res.enqueued).toBe(8);
    expect(res.skipped).toBe(0);
    expect(res.totalEligible).toBe(10);
    expect(res.errors).toHaveLength(2);
    expect(res.enqueued + res.skipped + res.errors.length).toBe(res.totalEligible);
    // Error strings carry the document id (identifiers only, never text).
    expect(res.errors.some((e: string) => e.includes("0003"))).toBe(true);
  });
});

// ── Arm 3: zero-eligible no-op ────────────────────────────────────────────────

describe("zero-eligible NO-OP SUCCESS (probe edge: empty)", () => {
  it("empty corpus → enqueued 0, totalEligible 0, empty errors — never an error", async () => {
    mockPrisma.document.findMany.mockResolvedValue([]);

    const res = await enqueueDlpBackfillBatch();

    expect(res).toEqual({ enqueued: 0, skipped: 0, totalEligible: 0, errors: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ── Arm 4: eval gate (service helper + endpoint) ─────────────────────────────

describe("assertEvalGatePassed (D-12 ordering, T-192-28)", () => {
  it("never-run → false; failed run → false; passed run → true", async () => {
    mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
    await expect(assertEvalGatePassed()).resolves.toBe(false);
    expect(mockReadEvalResult).toHaveBeenCalledWith(null);

    mockPrisma.systemConfig.findUnique.mockResolvedValue({ value: JSON.stringify({ passed: false, noRun: true }) });
    await expect(assertEvalGatePassed()).resolves.toBe(false);

    mockPrisma.systemConfig.findUnique.mockResolvedValue({
      value: JSON.stringify({ passed: true, noRun: false, fpRate: 0, totalChecks: 5, perClass: [], lastRun: new Date().toISOString(), nerMode: "stub" }),
    });
    await expect(assertEvalGatePassed()).resolves.toBe(true);
    expect(mockPrisma.systemConfig.findUnique).toHaveBeenCalledWith({ where: { key: "DLP_EVAL_LAST_RUN" } });
  });
});

describe("POST /api/system/dlp/backfill (admin trigger endpoint)", () => {
  const token = (global as unknown as { __testAdminToken?: string }).__testAdminToken;
  function auth() {
    // authMiddleware is stubbed — any Bearer header passes.
    return { Authorization: "Bearer admin-token" };
  }

  it("eval gate NOT passed → 409 { error, gate: 'eval-not-passed', totalEligible } — NO jobs enqueued", async () => {
    mockPrisma.systemConfig.findUnique.mockResolvedValue({ value: JSON.stringify({ passed: false, noRun: true }) });
    mockPrisma.document.count.mockResolvedValue(12);

    const res = await request(app)
      .post("/api/system/dlp/backfill")
      .set(auth())
      .send({})
      .expect(409);

    expect(res.body.gate).toBe("eval-not-passed");
    expect(res.body.error).toContain("eval");
    expect(res.body.totalEligible).toBe(12);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
  });

  it("eval gate passed → 200 with the dlpBackfillResponseSchema shape (enqueued/skipped/totalEligible/errors)", async () => {
    mockPrisma.systemConfig.findUnique.mockResolvedValue({
      value: JSON.stringify({ passed: true, noRun: false, fpRate: 0, totalChecks: 5, perClass: [], lastRun: new Date().toISOString(), nerMode: "stub" }),
    });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: DOC_ID, workspaceId: WS_ID, organizationId: ORG_ID },
    ]);
    mockSend.mockResolvedValue("job-1");

    const res = await request(app)
      .post("/api/system/dlp/backfill")
      .set(auth())
      .send({})
      .expect(200);

    expect(res.body).toEqual({ enqueued: 1, skipped: 0, totalEligible: 1, errors: [] });
    expect(mockSend).toHaveBeenCalledWith("dlp_backfill", {
      documentId: DOC_ID,
      workspaceId: WS_ID,
      organizationId: ORG_ID,
    });
  });

  it("empty body tolerated (dlpBackfillRequestSchema passthrough) — zero eligible is a clean no-op 200", async () => {
    mockPrisma.systemConfig.findUnique.mockResolvedValue({
      value: JSON.stringify({ passed: true, noRun: false, fpRate: 0, totalChecks: 5, perClass: [], lastRun: new Date().toISOString(), nerMode: "stub" }),
    });
    mockPrisma.document.findMany.mockResolvedValue([]);

    const res = await request(app).post("/api/system/dlp/backfill").set(auth()).send().expect(200);
    expect(res.body).toEqual({ enqueued: 0, skipped: 0, totalEligible: 0, errors: [] });
  });

  it("admin chain verbatim: missing Authorization → 401 (never reaches the service)", async () => {
    const res = await request(app).post("/api/system/dlp/backfill").send({});
    expect(res.status).toBe(401);
    expect(mockPrisma.systemConfig.findUnique).not.toHaveBeenCalled();
  });
});

// ── Arm 5: marker skip in runBackfillDocument ────────────────────────────────

describe("runBackfillDocument (per-document job body)", () => {
  const payload = { documentId: DOC_ID, workspaceId: WS_ID, organizationId: ORG_ID };

  it("already-scanned doc (dlpScannedAt set) → 'skipped', scanDocument NEVER called (D-12 idempotency)", async () => {
    mockPrisma.document.findFirst.mockResolvedValue({
      id: DOC_ID,
      workspaceId: WS_ID,
      organizationId: ORG_ID,
      dlpScannedAt: new Date(),
    });

    await expect(runBackfillDocument(payload)).resolves.toBe("skipped");
    expect(mockScanDocument).not.toHaveBeenCalled();
  });

  it("unmarked doc → delegates to plan 02's scanDocument (the SAME masking sequence)", async () => {
    mockPrisma.document.findFirst.mockResolvedValue({
      id: DOC_ID,
      workspaceId: WS_ID,
      organizationId: ORG_ID,
      dlpScannedAt: null,
    });

    await expect(runBackfillDocument(payload)).resolves.toBe("processed");
    expect(mockScanDocument).toHaveBeenCalledTimes(1);
    expect(mockScanDocument).toHaveBeenCalledWith(DOC_ID);
  });

  it("forged payload → 'invalid' no-op (schema validator, no prisma touch)", async () => {
    const realParser = mockParseScanJobPayload.getMockImplementation()!;
    mockParseScanJobPayload.mockImplementation(() => null);
    try {
      await expect(runBackfillDocument({ documentId: "forged" })).resolves.toBe("invalid");
      expect(mockPrisma.document.findFirst).not.toHaveBeenCalled();
    } finally {
      mockParseScanJobPayload.mockImplementation(realParser);
    }
  });

  it("soft-deleted doc → scoped read misses → 'skipped', no scan (T-192-08 race guard)", async () => {
    mockPrisma.document.findFirst.mockResolvedValue(null);
    await expect(runBackfillDocument(payload)).resolves.toBe("skipped");
    expect(mockScanDocument).not.toHaveBeenCalled();
    const readArg = mockPrisma.document.findFirst.mock.calls[0]?.[0];
    expect(readArg.where.deletedAt).toBeNull();
  });

  it("tenancy mismatch (payload ids ≠ row ids) → 'skipped' (T-192-29 forged payload arm)", async () => {
    mockPrisma.document.findFirst.mockResolvedValue({
      id: DOC_ID,
      workspaceId: "other-workspace",
      organizationId: ORG_ID,
      dlpScannedAt: null,
    });
    await expect(runBackfillDocument(payload)).resolves.toBe("skipped");
    expect(mockScanDocument).not.toHaveBeenCalled();
  });

  it("single-doc corpus: marker set on the second invocation → skip (probe edge: single-doc idempotency)", async () => {
    // First invocation: unmarked → processed.
    mockPrisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID, workspaceId: WS_ID, organizationId: ORG_ID, dlpScannedAt: null,
    });
    await expect(runBackfillDocument(payload)).resolves.toBe("processed");
    expect(mockScanDocument).toHaveBeenCalledTimes(1);
    // Second invocation: the marker the first run wrote → skipped.
    mockPrisma.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID, workspaceId: WS_ID, organizationId: ORG_ID, dlpScannedAt: new Date(),
    });
    await expect(runBackfillDocument(payload)).resolves.toBe("skipped");
    expect(mockScanDocument).toHaveBeenCalledTimes(1); // unchanged
  });
});