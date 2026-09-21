// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * dlpEvalRoutes.test.ts — the eval admin endpoint route battery (Phase 192
 * plan 10 Task 2 — Gap 2 closure; the artifact plan-05 declared but never
 * shipped). Supertest against createApp() on the dlpPatterns.routes.test.ts
 * scaffold (createMockPrisma on ../utils/prisma, getEnv stub, licenseService
 * stub, adminMode-toggle authMiddleware mock, generateTestToken imported
 * AFTER the auth mock).
 *
 * Contract pinned here (plan-05 Task 2 acceptance criteria + T-192-29/30/32):
 *  - middleware chain: 401 unauthenticated + 403 non-admin on BOTH
 *    POST /dlp/eval/run and GET /dlp/eval/result (auth → tenant → requireAdmin)
 *  - GET result shape through the dlpEvalResultSchema discriminated union:
 *    full-result arm 200, null row → 200 no-run arm, parseable-but-
 *    schema-invalid row → 200 no-run arm (fail-closed), malformed-JSON row
 *    → 200 no-run arm (the hardened try/catch parse — never a 500)
 *  - POST run: 200 body validates through dlpEvalRunResponseSchema
 *    (durationSeconds present); persistence pinned through the REAL
 *    persistEvalResult (jest.requireActual — only runEval is mocked) against
 *    the mocked prisma systemConfig.upsert delegate (key DLP_EVAL_LAST_RUN)
 *  - single-flight (T-192-29): a second concurrent POST while a run is in
 *    flight → 409 { error } with a stable message; the flag releases in
 *    finally so a post-completion POST succeeds (never wedged closed)
 *  - no-PII discipline: the served payloads carry only counts/rates/class
 *    rows — no fixture text values asserted or served anywhere
 *
 * Postgres-free: prisma is fully mocked via createMockPrisma; runEval is the
 * only mocked service export (persistEvalResult's dynamic import of
 * ../utils/prisma resolves through the same jest.mock).
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
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  ensureSetupWizardMode: jest.fn(),
  getSetting: jest.fn(async (_k: string) => ({ value: "false" })),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

// system.ts destructures assertEvalGatePassed/countEligibleDocuments/
// enqueueDlpBackfillBatch at module load — omitting this mock crashes suite
// boot (dlpBackfillService imports the real prisma + jobQueue chain).
jest.mock("../services/dlpBackfillService", () => ({
  __esModule: true,
  assertEvalGatePassed: jest.fn(async () => true),
  countEligibleDocuments: jest.fn(async () => 0),
  enqueueDlpBackfillBatch: jest.fn(async () => ({ enqueued: 0, skipped: 0, totalEligible: 0, errors: [] })),
}));

// dlpEvalService: the REAL module is loaded via jest.requireActual so the
// route's dynamic import() resolves to actuals with ONLY runEval replaced.
// persistEvalResult (the module's only prisma touch) stays real and runs
// against the mocked prisma — this is the persistence-arm pin.
const mockRunEval = jest.fn();
jest.mock("../services/dlpEvalService", () => {
  const actual = jest.requireActual("../services/dlpEvalService") as Record<string, unknown>;
  return { __esModule: true, ...actual, runEval: (...a: unknown[]) => mockRunEval(...(a as [])) };
});

let adminMode = true;

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: { headers: Record<string, unknown>; userId?: string; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !String(authHeader).startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (adminMode) {
      req.userId = "admin-001";
      req.user = {
        id: "admin-001",
        roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }] } }],
      };
    } else {
      req.userId = "user-001";
      req.user = {
        id: "user-001",
        roles: [{ role: { name: "user", permissions: [{ permissionName: "chat:read" }] } }],
      };
    }
    next();
  },
  apiKeyMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { dlpEvalResultSchema, dlpEvalRunResponseSchema, type DlpEvalResult } from "@simmetric-chat/shared";
import { DLP_EVAL_LAST_RUN_KEY } from "../services/dlpEvalService";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

function userAuth() {
  return { Authorization: `Bearer ${generateTestToken("user-001")}` };
}

// generateTestToken import AFTER the auth mock — same import order as
// dlpPatterns.routes.test.ts
import { generateTestToken } from "./helpers/mockAuth";

beforeEach(() => {
  jest.clearAllMocks();
  adminMode = true;
});

/** A schema-valid full-result fixture (counts/rates only — no PII values). */
function fullResultFixture(overrides: Record<string, unknown> = {}) {
  return {
    noRun: false,
    passed: true,
    fpRate: 0,
    totalChecks: 5,
    perClass: [
      { entityClass: "PERSON", detected: 1, expected: 1, falsePositives: 0 },
      { entityClass: "ADDRESS", detected: 1, expected: 1, falsePositives: 0 },
      { entityClass: "FINANCIAL", detected: 1, expected: 1, falsePositives: 0 },
      { entityClass: "GOV_ID", detected: 2, expected: 2, falsePositives: 0 },
      { entityClass: "CONTACT", detected: 1, expected: 1, falsePositives: 0 },
    ],
    lastRun: "2026-09-19T10:00:00.000Z",
    nerMode: "stub",
    ...overrides,
  };
}

// ── GET /api/system/dlp/eval/result ──────────────────────────────────────────

describe("GET /api/system/dlp/eval/result", () => {
  it("401 without a Bearer token", async () => {
    await request(app).get("/api/system/dlp/eval/result").expect(401);
  });

  it("403 for a user without admin:settings", async () => {
    adminMode = false;
    await request(app)
      .get("/api/system/dlp/eval/result")
      .set(userAuth())
      .expect(403);
  });

  it("200 with the full-result arm for a persisted valid row (validated through the shared union)", async () => {
    const fixture = fullResultFixture();
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: DLP_EVAL_LAST_RUN_KEY,
      value: JSON.stringify(fixture),
    });

    const res = await request(app)
      .get("/api/system/dlp/eval/result")
      .set(adminAuth())
      .expect(200);

    const parsed = dlpEvalResultSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    const data = parsed.data as { noRun: false; passed: boolean; fpRate: number; totalChecks: number; perClass: unknown[]; lastRun: string; nerMode: string };
    expect(data.passed).toBe(true);
    expect(data.fpRate).toBe(0);
    expect(data.totalChecks).toBe(5);
    expect(data.perClass).toHaveLength(5);
    expect(data.lastRun).toBe("2026-09-19T10:00:00.000Z");
    expect(data.nerMode).toBe("stub");
  });

  it("200 no-run arm when the row is null (never-run — NOT an error, NOT a fabricated pass)", async () => {
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get("/api/system/dlp/eval/result")
      .set(adminAuth())
      .expect(200);

    const parsed = dlpEvalResultSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body).toEqual({ passed: false, noRun: true });
  });

  it("200 no-run arm for a parseable row that fails the schema union (fail-closed, never 500)", async () => {
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: DLP_EVAL_LAST_RUN_KEY,
      // Parses fine, but fabricates a pass without the required full-result
      // fields — the union rejects it → the no-run arm.
      value: JSON.stringify({ passed: true, noRun: false }),
    });

    const res = await request(app)
      .get("/api/system/dlp/eval/result")
      .set(adminAuth())
      .expect(200);

    expect(res.body).toEqual({ passed: false, noRun: true });
  });

  it("200 no-run arm for a MALFORMED-JSON row value (hardened try/catch parse — never 500)", async () => {
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: DLP_EVAL_LAST_RUN_KEY,
      value: "not-json{",
    });

    const res = await request(app)
      .get("/api/system/dlp/eval/result")
      .set(adminAuth())
      .expect(200);

    expect(res.body).toEqual({ passed: false, noRun: true });
  });

  it("serves counts/rates only — no entity VALUES ever cross the route (T-192-30 no-PII discipline)", async () => {
    const fixture = fullResultFixture();
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: DLP_EVAL_LAST_RUN_KEY,
      value: JSON.stringify(fixture),
    });

    const res = await request(app)
      .get("/api/system/dlp/eval/result")
      .set(adminAuth())
      .expect(200);

    const serialized = JSON.stringify(res.body);
    // The eval result vocabulary is counts/rates/class rows/timestamps only.
    for (const forbidden of ["matchedText", "original", "plaintext", "chunkText", "representative"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ── POST /api/system/dlp/eval/run ────────────────────────────────────────────

describe("POST /api/system/dlp/eval/run", () => {
  it("401 without a Bearer token", async () => {
    await request(app).post("/api/system/dlp/eval/run").expect(401);
  });

  it("403 for a user without admin:settings", async () => {
    adminMode = false;
    await request(app)
      .post("/api/system/dlp/eval/run")
      .set(userAuth())
      .expect(403);
  });

  it("200 with a dlpEvalRunResponseSchema-valid body (durationSeconds present)", async () => {
    mockRunEval.mockResolvedValue(fullResultFixture());

    const res = await request(app)
      .post("/api/system/dlp/eval/run")
      .set(adminAuth())
      .expect(200);

    const parsed = dlpEvalRunResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    const data = parsed.data as { noRun: false; passed: boolean; durationSeconds: number };
    expect(data.passed).toBe(true);
    expect(typeof data.durationSeconds).toBe("number");
    expect(data.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("persists through the REAL persistEvalResult: systemConfig.upsert called with DLP_EVAL_LAST_RUN + the schema-validated row JSON", async () => {
    const fixture = fullResultFixture();
    mockRunEval.mockResolvedValue(fixture);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post("/api/system/dlp/eval/run")
      .set(adminAuth())
      .expect(200);

    expect(prisma.systemConfig.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = (prisma.systemConfig.upsert as jest.Mock).mock.calls[0][0] as {
      where: { key: string };
      update: { value: string };
      create: { key: string; value: string };
    };
    expect(upsertArg.where.key).toBe(DLP_EVAL_LAST_RUN_KEY);
    expect(upsertArg.create.key).toBe(DLP_EVAL_LAST_RUN_KEY);
    // The persisted value round-trips through the shared union.
    const persisted = JSON.parse(upsertArg.create.value) as DlpEvalResult;
    const reparsed = dlpEvalResultSchema.safeParse(persisted);
    expect(reparsed.success).toBe(true);
    expect(persisted).toEqual(fixture);
    // The SERVED body carries the run-response contract (result + duration).
    expect((res.body as { durationSeconds: number }).durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("single-flight: a second concurrent POST → 409 with the stable message; the flag releases after completion", async () => {
    // Controllable pending runEval: the first request stays in flight until
    // we resolve it, so the second request lands while dlpEvalRunInFlight.
    let releaseRun!: (value: unknown) => void;
    const gated = new Promise((resolve) => {
      releaseRun = resolve;
    });
    mockRunEval.mockImplementation(() => gated);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});

    // Supertest fires lazily on .then — attaching it KICKS the first request.
    const firstPromise = request(app).post("/api/system/dlp/eval/run").set(adminAuth());
    const firstSettled = firstPromise.then(
      (r) => r,
      (e) => {
        throw e;
      },
    );
    // Wait until the first handler actually entered the in-flight gate.
    for (let i = 0; i < 100 && mockRunEval.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mockRunEval).toHaveBeenCalledTimes(1);

    const second = await request(app).post("/api/system/dlp/eval/run").set(adminAuth());
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("DLP eval run already in progress");

    // Release the first run with a schema-valid result; it completes 200.
    releaseRun(fullResultFixture());
    const firstRes = await firstSettled;
    expect(firstRes.status).toBe(200);

    // The flag released in finally — a subsequent POST succeeds (never wedged).
    mockRunEval.mockResolvedValue(fullResultFixture());
    const third = await request(app).post("/api/system/dlp/eval/run").set(adminAuth());
    expect(third.status).toBe(200);
  }, 15_000);

  it("run-shape validation mismatch → 500 { error } with the no-leak discipline", async () => {
    // runEval resolves something persistEvalResult accepts (schema-valid) but
    // the run-response contract check must still hold the no-leak shape.
    // Force the mismatch by breaking ONLY after persistence: an invalid
    // durationSeconds is not injectable (route-computed), so instead drive the
    // dlpEvalResultSchema 500-guard with a persistable-invalid result —
    // persistEvalResult throws → outer catch → 500 { error }.
    mockRunEval.mockResolvedValue({ bogus: true });

    const res = await request(app)
      .post("/api/system/dlp/eval/run")
      .set(adminAuth())
      .expect(500);

    expect(typeof res.body.error).toBe("string");
    // No internals leak: the message names nothing beyond the refusal.
    expect(res.body.error).not.toContain("bogus");
  });
});