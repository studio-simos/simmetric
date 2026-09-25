// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 185 (SAAS-04c, D-09 / Pitfall 8): "jobs are ALS-free" unit probe.
 *
 * Every background job/scheduler MUST resolve org FROM THE ROW PROCESSED,
 * never from the ambient AsyncLocalStorage tenant context — jobs run outside
 * Express and outside any runInTenant window, so an ambient read there would
 * silently attach stale (or absent) tenant scoping to platform-level sweeps.
 *
 * The probe imports each swept job module (deps mocked per the @swc/jest-safe
 * inline-factory pattern — factories cannot reference outer variables) and
 * runs its exported cycle/init handle with mocked prisma. A spy on
 * getTenantContext asserts the spy call count is 0 for every job code path.
 *
 * NOTE: tenantContext.test.ts is Plan 02's artifact (same wave, zero file
 * overlap) — that suite owns ALS semantics; this suite owns the job
 * disposition gate.
 */
import "./helpers/setupEnv";

// Spy seam: utils/tenantContext is mocked with jest.fn() wrappers around the
// REAL implementations, so the scoped-prisma composition (if any job touched
// it) keeps working while every getTenantContext() read is counted.
jest.mock("../utils/tenantContext", () => {
  const actual = jest.requireActual("../utils/tenantContext");
  return {
    ...actual,
    getTenantContext: jest.fn((...args: unknown[]) =>
      (actual.getTenantContext as (...a: unknown[]) => unknown)(...args),
    ),
  };
});

// --- prisma mock (inline factory, @swc/jest-safe) --------------------------
// Only the delegates the six job modules' cycle/init paths touch.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    ocrJob: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    archive: { findUnique: jest.fn().mockResolvedValue(null) },
    mCPConnection: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      delete: jest.fn(),
    },
    mcpCatalogEntry: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    synthesisRun: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    systemConfig: {
      // getDbValue read path (getSetting → upsertSystemConfigRow family).
      findFirst: jest.fn().mockResolvedValue(null),
    },
    chatMessage: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    memory: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// systemConfigService: keep the module real but neutralize getSetting (the
// chatMessageReaper per-tick config read) and the write helpers' side effects.
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ key: "chat_message_retention_days", value: "" }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// jobQueue seam (Pattern 3 — mock the seam, not pg-boss directly).
jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn().mockReturnValue(null), // D-02: init* early-return path
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
}));

// mcpReaper's in-process snapshot (empty — no connections to probe).
jest.mock("../agent/mcpClient", () => ({
  disconnectMCPServer: jest.fn(),
  connectMCPServer: jest.fn().mockResolvedValue({ tools: [] }),
  getActiveConnectionsSnapshot: jest.fn(() => []),
  getActiveConnectionState: jest.fn(() => undefined),
  withConnectionLock: jest.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
}));

// mcpHealthCheck's SDK seam — no real SSE transport must be constructed.
jest.mock("@modelcontextprotocol/client", () => ({
  Client: jest.fn().mockImplementation(() => ({ connect: jest.fn(), close: jest.fn() })),
  SSEClientTransport: jest.fn().mockImplementation(() => ({})),
}));

import { getTenantContext } from "../utils/tenantContext";
import {
  resetStaleJobs,
  getActiveJobCount,
  getNextPendingJob,
  cleanupOrphanedRawFiles,
} from "../services/ocrJobService";
import { runHealthCheckCycle, initMCPHealthCheckScheduler } from "../services/mcpHealthCheckJob";
import { runReaperCycle as runMcpReaperCycle, runReconnectCycle, initMCPReaperScheduler } from "../services/mcpReaperJob";
import { runSynthesisReaperCycle, initSynthesisReaperScheduler } from "../services/synthesisReaperJob";
import { runVectorCleanupCycle, initVectorCleanupScheduler } from "../services/vectorCleanupJob";
import { runReaperCycle as runChatMessageReaperCycle, initChatMessageReaperScheduler } from "../services/chatMessageReaperJob";

const mockGetTenantContext = getTenantContext as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("jobs are ALS-free (D-09 org-from-row, Pitfall 8)", () => {
  it("getTenantContext spy is armed (mock integrity canary)", () => {
    expect(jest.isMockFunction(getTenantContext)).toBe(true);
  });

  it("ocrJobService cycle helpers never read ambient tenant context", async () => {
    await resetStaleJobs();
    await getActiveJobCount();
    await getNextPendingJob();
    await cleanupOrphanedRawFiles();
    expect(mockGetTenantContext).not.toHaveBeenCalled();
  });

  it("mcpHealthCheckJob cycle + init never read ambient tenant context", async () => {
    await runHealthCheckCycle();
    await initMCPHealthCheckScheduler(); // getBoss() === null → early return
    expect(mockGetTenantContext).not.toHaveBeenCalled();
  });

  it("mcpReaperJob reaper + reconnect cycles never read ambient tenant context", async () => {
    await runMcpReaperCycle();
    await runReconnectCycle();
    await initMCPReaperScheduler(); // getBoss() === null → early return
    expect(mockGetTenantContext).not.toHaveBeenCalled();
  });

  it("synthesisReaperJob cycle never reads ambient tenant context", async () => {
    await runSynthesisReaperCycle();
    await initSynthesisReaperScheduler(); // getBoss() === null → early return
    expect(mockGetTenantContext).not.toHaveBeenCalled();
  });

  it("vectorCleanupJob cycle never reads ambient tenant context", async () => {
    await runVectorCleanupCycle();
    await initVectorCleanupScheduler(); // getBoss() === null → early return
    expect(mockGetTenantContext).not.toHaveBeenCalled();
  });

  it("chatMessageReaperJob retention purge (documented cross-org A4 exception) never reads ambient tenant context", async () => {
    const summary = await runChatMessageReaperCycle();
    expect(summary).toEqual({ softDeleted: 0, hardPurged: 0 });
    await initChatMessageReaperScheduler(); // getBoss() === null → early return
    expect(mockGetTenantContext).not.toHaveBeenCalled();
  });
});
