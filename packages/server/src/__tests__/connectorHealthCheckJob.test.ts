// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * Phase 200 (ECCO-06, Plan 03 Task 2) — connectorHealthCheckJob unit tests.
 *
 * Covers (D-09, mcpHealthCheck.test.ts:81-144 jobQueue-SEAM-mock pattern):
 *  - initConnectorHealthCheckScheduler: createQueue("healthcheck_connectors")
 *    + schedule("healthcheck_connectors", daily cron) pins; the null-boss
 *    early return (getBoss → null → scheduler resolves without creating a
 *    queue, D-02 no-fallback-timer); the Job[] handler contract; the no-
 *    re-throw discipline (a throwing sweep resolves, never rejects).
 *  - runConnectorHealthSweep: fake adapters via the REAL registry seam
 *    (clearAdapters + registerAdapter) — pass arm flips healthy + clears
 *    lastError, error arm flips error + persists lastError, and the
 *    NO-AUTO-DISABLE invariant: the update data NEVER carries isEnabled
 *    (198 D-20 / D-09). Tokenless rows skipped silently; unimplemented
 *    platforms fail-closed skipped; disabled/deleted rows excluded by the
 *    findMany where clause.
 */
import "./helpers/setupEnv";

jest.mock("uuid", () => ({
  v4: jest.fn(() => "550e8400-e29b-41d4-a716-446655440000"),
  validate: jest.fn(() => true),
}));

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  (mock.prisma as any).chatConnector = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  };
  return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
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
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

// Phase 165 (Pattern 3): mock the jobQueue SEAM — getBoss/createQueue/schedule.
// The mock boundary is jobQueue, NOT pg-boss directly. Under @swc/jest the
// factory cannot reference outer variables, so it creates its own jest.fn()
// handles; tests retrieve them via the mocked imports below.
jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn(),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runConnectorHealthSweep, initConnectorHealthCheckScheduler } from "../services/connectorHealthCheckJob";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { clearAdapters, registerAdapter, getAdapter } from "../services/connectors/registry";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import { encrypt } from "../services/encryptionService";

const mockGetBoss = getBoss as jest.Mock;
const mockCreateQueue = createQueue as jest.Mock;
const mockSchedule = schedule as jest.Mock;

const mockedLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

const mockPrisma = prisma as unknown as {
  chatConnector: { findMany: jest.Mock; update: jest.Mock };
};

/** A minimal ChatConnector row for the sweep. */
function connectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "550e8400-e29b-41d4-a716-446655440021",
    platform: "slack",
    isEnabled: true,
    deletedAt: null,
    botTokenEncrypted: encrypt("xoxb-token-under-test"),
    ...overrides,
  };
}

/** A fake adapter exposing ONLY validateBotToken (the single-arg contract). */
function fakeAdapter(validateBotToken: jest.Mock) {
  return {
    parseIncomingWebhook: jest.fn(() => null),
    pollUpdates: jest.fn(),
    sendMessage: jest.fn(),
    sendTypingIndicator: jest.fn(),
    validateBotToken,
    getBotInfo: jest.fn(),
    setWebhook: jest.fn(),
    removeWebhook: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBoss.mockReset();
  mockCreateQueue.mockReset().mockResolvedValue(undefined);
  mockSchedule.mockReset().mockResolvedValue(undefined);
  mockPrisma.chatConnector.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.chatConnector.update.mockReset().mockResolvedValue({});
  clearAdapters();
});

afterEach(() => {
  clearAdapters();
});

describe("connectorHealthCheckJob — scheduler registration (D-09)", () => {
  it("createQueue + schedule are called with the underscore queue name and the daily cron (order pinned)", async () => {
    mockGetBoss.mockReturnValue({ work: jest.fn().mockResolvedValue(undefined) });
    await initConnectorHealthCheckScheduler();

    expect(mockCreateQueue).toHaveBeenCalledTimes(1);
    expect(mockCreateQueue).toHaveBeenCalledWith("healthcheck_connectors");
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledWith("healthcheck_connectors", "0 4 * * *");
    // Pitfall 1: createQueue MUST precede schedule (FK).
    const createOrder = mockCreateQueue.mock.invocationCallOrder[0];
    const scheduleOrder = mockSchedule.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(scheduleOrder);
  });

  it("returns early with a warn when pg-boss is unavailable (D-02 — NO fallback timer, no queue created)", async () => {
    mockGetBoss.mockReturnValue(null);
    await expect(initConnectorHealthCheckScheduler()).resolves.toBeUndefined();

    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("pg-boss unavailable"),
    );
    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it("registers the Job[] handler via boss.work and the handler runs the sweep per job (Pitfall 2)", async () => {
    mockPrisma.chatConnector.findMany.mockResolvedValue([]);
    const workHandler = jest.fn(async (jobs: unknown[]) => {
      for (const _job of jobs) {
        await runConnectorHealthSweep();
      }
    });
    mockGetBoss.mockReturnValue({ work: workHandler.mockResolvedValue(undefined) });

    await initConnectorHealthCheckScheduler();
    expect(workHandler).toHaveBeenCalledWith("healthcheck_connectors", expect.any(Function));
  });

  it("does NOT re-throw from the work handler when the sweep throws (Pitfall 3 — no retry storm)", async () => {
    mockPrisma.chatConnector.findMany.mockRejectedValue(new Error("db down"));
    let registeredHandler: ((jobs: unknown[]) => Promise<void>) | undefined;
    mockGetBoss.mockReturnValue({
      work: jest.fn(async (_queue: string, handler: (jobs: unknown[]) => Promise<void>) => {
        registeredHandler = handler;
      }),
    });

    await initConnectorHealthCheckScheduler();
    expect(registeredHandler).toBeDefined();
    // The handler RESOLVES (swallows) — never rejects:
    await expect(registeredHandler!([{}])).resolves.toBeUndefined();
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Health-check cycle failed"),
      expect.objectContaining({ error: "db down" }),
    );
  });

  it("declares no setInterval fallback anywhere in the job source (D-02 source pin)", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const src = readFileSync(resolve(__dirname, "../services/connectorHealthCheckJob.ts"), "utf-8");
    // No fallback timer:
    expect(src).not.toContain("setInterval");
    // No fail-loud exit (a prose mention is fine; a CALL is not):
    expect(src).not.toMatch(/(?<!\/)process\.exit\s*\(/);
    expect(src).toContain('"healthcheck_connectors"');
    // Queue-name charset guard: the literal queue name contains no colon.
  });
});

describe("connectorHealthCheckJob — runConnectorHealthSweep (D-09/198 D-20)", () => {
  it("flips healthy + clears lastError on the pass arm", async () => {
    clearAdapters();
    const validate = jest.fn().mockResolvedValue({ valid: true, botUsername: "bot" });
    registerAdapter("slack", fakeAdapter(validate));
    mockPrisma.chatConnector.findMany.mockResolvedValue([connectorRow()]);
    mockPrisma.chatConnector.update.mockResolvedValue({});

    const result = await runConnectorHealthSweep();
    expect(result).toEqual({ healthy: 1, error: 0, skipped: 0 });
    expect(validate).toHaveBeenCalledWith(expect.any(String));
    expect(mockPrisma.chatConnector.update).toHaveBeenCalledWith({
      where: { id: "550e8400-e29b-41d4-a716-446655440021" },
      data: { healthStatus: "healthy", lastError: null },
    });
  });

  it("flips error + persists lastError on the failure arm and NEVER writes isEnabled (no-auto-disable invariant, D-09)", async () => {
    clearAdapters();
    const validate = jest.fn().mockResolvedValue({ valid: false });
    registerAdapter("slack", fakeAdapter(validate));
    mockPrisma.chatConnector.findMany.mockResolvedValue([connectorRow()]);
    mockPrisma.chatConnector.update.mockResolvedValue({});

    const result = await runConnectorHealthSweep();
    expect(result).toEqual({ healthy: 0, error: 1, skipped: 0 });
    const updateArg = mockPrisma.chatConnector.update.mock.calls[0][0];
    expect(updateArg.data.healthStatus).toBe("error");
    expect(updateArg.data.lastError).toBe("token validation failed");
    // THE invariant: the update data NEVER carries isEnabled — the cron has
    // no auto-disable path (198 D-20 / D-09).
    expect("isEnabled" in updateArg.data).toBe(false);
    expect(Object.keys(updateArg.data).sort()).toEqual(["healthStatus", "lastError"]);
  });

  it("sweeps ALL FOUR platforms through the single-arg validateBotToken contract (INFO-2 — no per-platform branching)", async () => {
    clearAdapters();
    const probes: Record<string, jest.Mock> = {};
    for (const platform of ["telegram", "discord", "slack", "whatsapp"]) {
      probes[platform] = jest.fn().mockResolvedValue({ valid: true });
      registerAdapter(platform, fakeAdapter(probes[platform]!));
    }
    mockPrisma.chatConnector.findMany.mockResolvedValue(
      ["telegram", "discord", "slack", "whatsapp"].map((platform, i) =>
        connectorRow({ id: `550e8400-e29b-41d4-a716-4466554400${i + 1}`, platform }),
      ),
    );
    mockPrisma.chatConnector.update.mockResolvedValue({});

    const result = await runConnectorHealthSweep();
    expect(result.healthy).toBe(4);
    for (const platform of ["telegram", "discord", "slack", "whatsapp"]) {
      expect(probes[platform]).toHaveBeenCalledTimes(1);
      expect(probes[platform]).toHaveBeenCalledWith(expect.any(String));
    }
  });

  it("skips a tokenless row silently (no error spam, health untouched)", async () => {
    clearAdapters();
    const validate = jest.fn();
    registerAdapter("slack", fakeAdapter(validate));
    mockPrisma.chatConnector.findMany.mockResolvedValue([
      connectorRow({ botTokenEncrypted: null }),
    ]);

    const result = await runConnectorHealthSweep();
    expect(result).toEqual({ healthy: 0, error: 0, skipped: 1 });
    expect(validate).not.toHaveBeenCalled();
    expect(mockPrisma.chatConnector.update).not.toHaveBeenCalled();
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it("fail-closed skips a row whose platform has no adapter (D-03)", async () => {
    clearAdapters();
    mockPrisma.chatConnector.findMany.mockResolvedValue([
      connectorRow({ platform: "teams" }),
    ]);

    const result = await runConnectorHealthSweep();
    expect(result).toEqual({ healthy: 0, error: 0, skipped: 1 });
    expect(mockPrisma.chatConnector.update).not.toHaveBeenCalled();
  });

  it("queries ONLY enabled non-deleted connectors (the where clause carries the exclusion — D-09 sweep scope)", async () => {
    clearAdapters();
    mockPrisma.chatConnector.findMany.mockResolvedValue([]);

    await runConnectorHealthSweep();
    expect(mockPrisma.chatConnector.findMany).toHaveBeenCalledWith({
      where: { isEnabled: true, deletedAt: null },
    });
  });

  it("keeps sweeping after one row throws (per-row try/catch — one bad row never aborts the cycle)", async () => {
    clearAdapters();
    const good = jest.fn().mockResolvedValue({ valid: true });
    const bad = jest.fn().mockRejectedValue(new Error("probe exploded"));
    registerAdapter("slack", fakeAdapter(bad));
    registerAdapter("telegram", fakeAdapter(good));
    mockPrisma.chatConnector.findMany.mockResolvedValue([
      connectorRow({ id: "550e8400-e29b-41d4-a716-4466554400aa", platform: "slack" }),
      connectorRow({ id: "550e8400-e29b-41d4-a716-4466554400bb", platform: "telegram" }),
    ]);
    mockPrisma.chatConnector.update.mockResolvedValue({});

    const result = await runConnectorHealthSweep();
    expect(result.healthy).toBe(1);
    expect(result.skipped).toBe(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("never logs token material (T-198-03 — the row's decrypted token never reaches a log call)", async () => {
    clearAdapters();
    const validate = jest.fn().mockRejectedValue(new Error("network down"));
    registerAdapter("slack", fakeAdapter(validate));
    mockPrisma.chatConnector.findMany.mockResolvedValue([connectorRow()]);

    await runConnectorHealthSweep();
    const allLogArgs = JSON.stringify([
      ...mockedLogger.error.mock.calls,
      ...mockedLogger.warn.mock.calls,
      ...mockedLogger.info.mock.calls,
    ]);
    expect(allLogArgs).not.toContain("xoxb-token-under-test");
  });
});