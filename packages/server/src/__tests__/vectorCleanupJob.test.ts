// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Vector Cleanup Job unit tests (D-08).
 *
 * Tests runVectorCleanupCycle: marks vectorCleanupAt on 2xx from collector,
 * increments vectorCleanupAttempts on failure, tombstones a doc once attempts
 * reach the cap (IN-02), and skips when no pending documents. Mocks prisma,
 * config/env, and global.fetch — no real PostgreSQL or collector required.
 *
 * Harness follows documentUpload.test.ts (setupEnv, mock prisma, mock env,
 * mock licenseService, mock builtinSkills).
 *
 * Phase 161 (DR-02): the scheduler/lock lifecycle describe block also mocks
 * `withDistributedLock` and `logger` so the lock path is deterministic without
 * Redis and skip/idempotency logs can be asserted. Under `@swc/jest` the
 * `jest.mock` factory cannot reference outer variables (no babel-plugin-jest-
 * hoist), so the factory creates its own `jest.fn()` and the test grabs the
 * handle from the mocked module import (see RESEARCH.md §"Mocking pattern").
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
  getSetting: jest.fn(() => ({ value: "Xenova/all-MiniLM-L6-v2" })),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

// Phase 165 (Pattern 3): mock the jobQueue seam — getBoss/createQueue/schedule.
// The mock boundary is jobQueue, NOT pg-boss directly. The __mocks__/pg-boss.ts
// manual mock handles transitive ESM loads (Pitfall 6). Under @swc/jest the
// factory cannot reference outer variables, so it creates its own jest.fn()
// handles; tests retrieve them via the mocked imports below.
jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn(),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
}));

// Mock logger so scheduler tests can assert on info/warn call args and the
// existing runVectorCleanupCycle tests stay quiet.
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { runVectorCleanupCycle, initVectorCleanupScheduler } from "../services/vectorCleanupJob";

const mockGetBoss = getBoss as jest.Mock;
const mockCreateQueue = createQueue as jest.Mock;
const mockSchedule = schedule as jest.Mock;

const mockedLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  (global.fetch as jest.Mock) = jest.fn();
  (prisma.document.update as jest.Mock).mockResolvedValue({});
});

describe("runVectorCleanupCycle (D-08)", () => {
  it("marks vectorCleanupAt on 2xx", async () => {
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      { id: "doc-1", workspaceId: "ws-1", vectorCleanupAttempts: 0 },
    ]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const result = await runVectorCleanupCycle();

    expect(result).toEqual({ purged: 1, failed: 0 });
    // fetch called with DELETE method + X-Collector-Secret header
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/ingest/doc-1?workspaceId=ws-1"),
      expect.objectContaining({
        method: "DELETE",
        headers: { "X-Collector-Secret": "test-collector-secret-for-unit-tests" },
      }),
    );
    // document.update called with vectorCleanupAt (attempts not touched on success)
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: { vectorCleanupAt: expect.any(Date) },
    });
  });

  it("increments vectorCleanupAttempts (no tombstone) on 5xx", async () => {
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      { id: "doc-1", workspaceId: "ws-1", vectorCleanupAttempts: 0 },
    ]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

    const result = await runVectorCleanupCycle();

    expect(result).toEqual({ purged: 0, failed: 1 });
    // IN-02: document.update IS called to bump the attempt counter;
    // vectorCleanupAt stays null (pending) and no tombstone at attempt 1.
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: { vectorCleanupAttempts: 1 },
    });
  });

  it("tombstones a doc once attempts reach the cap (IN-02)", async () => {
    // 9 prior attempts — one more failure (attempt 10) must set the tombstone.
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      { id: "doc-1", workspaceId: "ws-1", vectorCleanupAttempts: 9 },
    ]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 502 });

    const result = await runVectorCleanupCycle();

    expect(result).toEqual({ purged: 0, failed: 1 });
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: {
        vectorCleanupAttempts: 10,
        vectorCleanupFailedAt: expect.any(Date),
      },
    });
  });

  it("tombstones on network error once attempts reach the cap (IN-02)", async () => {
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      { id: "doc-2", workspaceId: "ws-2", vectorCleanupAttempts: 9 },
    ]);
    (global.fetch as jest.Mock).mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await runVectorCleanupCycle();

    expect(result).toEqual({ purged: 0, failed: 1 });
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: "doc-2" },
      data: {
        vectorCleanupAttempts: 10,
        vectorCleanupFailedAt: expect.any(Date),
      },
    });
  });

  it("skips when no pending", async () => {
    (prisma.document.findMany as jest.Mock).mockResolvedValue([]);

    const result = await runVectorCleanupCycle();

    expect(result).toEqual({ purged: 0, failed: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});

// ─── Phase 165 (Q-02): pg-boss registration ─────────────────────────────────
//
// Verifies the pg-boss migration: getBoss null-check (D-02 graceful
// degradation), createQueue + schedule + boss.work registration, and the
// work handler contract (Job[] array per Pitfall 2, error catch per Pitfall 3).
// Mocks the jobQueue seam (Pattern 3), NOT pg-boss directly.
describe("initVectorCleanupScheduler pg-boss registration (Phase 165, Q-02)", () => {
  const bossWork = jest.fn().mockResolvedValue("worker-id-1");

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.document.update as jest.Mock).mockResolvedValue({});
    mockCreateQueue.mockResolvedValue(undefined);
    mockSchedule.mockResolvedValue(undefined);
    bossWork.mockClear();
    bossWork.mockResolvedValue("worker-id-1");
    mockGetBoss.mockReturnValue({ work: bossWork });
  });

  it("registers queue + cron schedule + work handler", async () => {
    await initVectorCleanupScheduler();

    // D-04: queue name matches the Phase 161 lock resource key.
    expect(mockCreateQueue).toHaveBeenCalledWith("cleanup_vector");
    // D-05: 5-minute cron expression.
    expect(mockSchedule).toHaveBeenCalledWith("cleanup_vector", "*/5 * * * *");
    // boss.work registered with the queue name and a handler function.
    expect(bossWork).toHaveBeenCalledTimes(1);
    expect(bossWork.mock.calls[0][0]).toBe("cleanup_vector");
    expect(typeof bossWork.mock.calls[0][1]).toBe("function");
    // createQueue precedes schedule (Pitfall 1 — foreign-key constraint).
    expect(mockCreateQueue.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSchedule.mock.invocationCallOrder[0]!,
    );
  });

  it("D-02: getBoss() === null → logs warn + returns early (no createQueue/schedule/work)", async () => {
    mockGetBoss.mockReturnValue(null);

    await initVectorCleanupScheduler();

    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(bossWork).not.toHaveBeenCalled();
    const warnCalls = mockedLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("pg-boss unavailable"))).toBe(true);
  });

  it("work handler calls runVectorCleanupCycle on each job (Pitfall 2 — Job[] array)", async () => {
    await initVectorCleanupScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Stage a pending doc so runVectorCleanupCycle exercises the collector
    // purge path — proves the cycle actually ran inside the work handler.
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      { id: "doc-1", workspaceId: "ws-1", vectorCleanupAttempts: 0 },
    ]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    // pg-boss passes a Job[] array (Pitfall 2). The handler iterates with
    // for...of and runs the cycle once per job.
    const job = {
      id: "j1",
      data: {},
      name: "cleanup_vector",
      expireInSeconds: 300,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };
    await expect(handler([job])).resolves.toBeUndefined();

    // The cycle ran → document.update called to mark vectorCleanupAt.
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: { vectorCleanupAt: expect.any(Date) },
    });
  });

  it("Pitfall 3: work handler catches cycle errors and resolves (no re-throw → no retry storm)", async () => {
    await initVectorCleanupScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Force runVectorCleanupCycle to throw by making findMany blow up.
    (prisma.document.findMany as jest.Mock).mockImplementation(() => {
      throw new Error("cycle boom");
    });

    // Handler must NOT re-throw — it logs and resolves (pg-boss sees success).
    await expect(handler([{ id: "j1", data: {}, name: "cleanup_vector" }])).resolves.toBeUndefined();
    expect(mockedLogger.error).toHaveBeenCalled();
  });
});