// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP Health-Check Job unit tests (stubs)
 *
 * Covers pingMCPServer, retry-with-backoff (D-03), and runHealthCheckCycle
 * staleness transitions (healthy → stale → down). Full implementation
 * to be completed in a future phase or inline.
 */
import "./helpers/setupEnv";

jest.mock("uuid", () => ({
  v4: jest.fn(() => "550e8400-e29b-41d4-a716-446655440000"),
  validate: jest.fn(() => true),
}));

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
  initLicense: jest.fn(() => ({
    tier: "community",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  getLicenseInfo: jest.fn(() => ({
    tier: "community",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({
  seedTemplates: jest.fn(),
}));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
}));
jest.mock("../services/ftsService", () => ({
  initPostgreSQLFTS: jest.fn(),
}));
jest.mock("../agent/mcpServer", () => ({
  mountMCPServer: jest.fn(),
}));

jest.mock("../agent/mcpClient", () => ({
  connectMCPServer: jest.fn(),
  disconnectMCPServer: jest.fn(),
  getConnectionStatuses: jest.fn(),
  testMCPServerConnection: jest.fn(),
  clearConnectionError: jest.fn(),
}));

jest.mock("../agent/skills", () => ({
  registerSkill: jest.fn(),
  unregisterSkillsForConnection: jest.fn(),
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
// existing pingMCPServer / runHealthCheckCycle tests stay quiet.
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockConnect = jest.fn();
const mockClose = jest.fn();
jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
  })),
}));
jest.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({})),
}));

import { pingMCPServer, runHealthCheckCycle, initMCPHealthCheckScheduler } from "../services/mcpHealthCheckJob";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";

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
  mCPConnection: { findMany: jest.Mock };
  mcpCatalogEntry: { findUnique: jest.Mock; update: jest.Mock };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockReset();
  mockClose.mockReset();
  mockConnect.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockPrisma.mCPConnection.findMany.mockReset();
  mockPrisma.mcpCatalogEntry.findUnique.mockReset();
  mockPrisma.mcpCatalogEntry.update.mockReset();
});

describe("mcpHealthCheckJob", () => {
  describe("pingMCPServer", () => {
    it("returns { ok: true } when MCP server is reachable", async () => {
      mockConnect.mockResolvedValue(undefined);
      const result = await pingMCPServer("http://localhost:3001/sse");
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("returns { ok: false, error } when MCP server times out", async () => {
      mockConnect.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 50)),
      );
      const result = await pingMCPServer("http://localhost:3001/sse", undefined, 30);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("timeout");
    });

    it("returns { ok: false, error } when URL is invalid", async () => {
      const result = await pingMCPServer("not-a-valid-url");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("runHealthCheckCycle", () => {
    beforeEach(() => {
      mockConnect.mockResolvedValue(undefined);
      mockClose.mockResolvedValue(undefined);
    });

    it("skips connections with null catalogEntryId", async () => {
      mockPrisma.mCPConnection.findMany.mockResolvedValue([
        { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: null },
      ]);
      mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValue(null);
      const result = await runHealthCheckCycle();
      expect(result).toEqual({ healthy: 0, stale: 0, down: 0 });
      expect(mockPrisma.mcpCatalogEntry.update).not.toHaveBeenCalled();
    });

    it("skips disabled connections", async () => {
      mockPrisma.mCPConnection.findMany.mockResolvedValue([]);
      const result = await runHealthCheckCycle();
      expect(result).toEqual({ healthy: 0, stale: 0, down: 0 });
    });

    it(
      "retries up to 3 times with delays (1s, 2s, 4s) when ping fails per D-03",
      async () => {
        mockConnect.mockRejectedValue(new Error("connection refused"));
        mockPrisma.mCPConnection.findMany.mockResolvedValue([
          { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: "entry1" },
        ]);
        mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValue({
          id: "entry1", consecutiveFailures: 0, healthStatus: "healthy",
        });
        jest.useFakeTimers();
        const spy = jest.spyOn(global, "setTimeout");
        const cyclePromise = runHealthCheckCycle();
        await jest.advanceTimersByTimeAsync(3000);
        await cyclePromise;
        expect(mockConnect).toHaveBeenCalledTimes(3);
        spy.mockRestore();
        jest.useRealTimers();
      },
    );

    it("counts cycle as success if any retry attempt succeeds", async () => {
      mockConnect
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(undefined);
      mockPrisma.mCPConnection.findMany.mockResolvedValue([
        { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: "entry1" },
      ]);
      mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValue({
        id: "entry1", consecutiveFailures: 2, healthStatus: "stale",
      });
      jest.useFakeTimers();
      const cyclePromise = runHealthCheckCycle();
      await jest.advanceTimersByTimeAsync(1000);
      await cyclePromise;
      expect(mockPrisma.mcpCatalogEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ healthStatus: "healthy", consecutiveFailures: 0 }) }),
      );
      jest.useRealTimers();
    });

    it(
      "counts cycle as failure only when all 3 retries are exhausted",
      async () => {
        mockConnect.mockRejectedValue(new Error("fail"));
        mockPrisma.mCPConnection.findMany.mockResolvedValue([
          { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: "entry1" },
        ]);
        mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValue({
          id: "entry1", consecutiveFailures: 0, healthStatus: "healthy",
        });
        jest.useFakeTimers();
        const cyclePromise = runHealthCheckCycle();
        await jest.advanceTimersByTimeAsync(3000);
        await cyclePromise;
        expect(mockConnect).toHaveBeenCalledTimes(3);
        expect(mockPrisma.mcpCatalogEntry.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ healthStatus: "stale", consecutiveFailures: 1 }) }),
        );
        jest.useRealTimers();
      },
    );

    it(
      "transitions healthy -> stale on first retry-exhausted failure cycle",
      async () => {
        mockConnect.mockRejectedValue(new Error("fail"));
        mockPrisma.mCPConnection.findMany.mockResolvedValue([
          { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: "entry1" },
        ]);
        mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValue({
          id: "entry1", consecutiveFailures: 0, healthStatus: "healthy",
        });
        jest.useFakeTimers();
        const cyclePromise = runHealthCheckCycle();
        await jest.advanceTimersByTimeAsync(3000);
        await cyclePromise;
        expect(mockPrisma.mcpCatalogEntry.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ healthStatus: "stale", consecutiveFailures: 1 }) }),
        );
        jest.useRealTimers();
      },
    );

    it(
      "transitions stale -> down on third retry-exhausted failure cycle",
      async () => {
        mockConnect.mockRejectedValue(new Error("fail"));
        mockPrisma.mCPConnection.findMany.mockResolvedValue([
          { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: "entry1" },
        ]);
        mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValue({
          id: "entry1", consecutiveFailures: 2, healthStatus: "stale",
        });
        jest.useFakeTimers();
        const cyclePromise = runHealthCheckCycle();
        await jest.advanceTimersByTimeAsync(3000);
        await cyclePromise;
        expect(mockPrisma.mcpCatalogEntry.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ healthStatus: "down" }) }),
        );
        jest.useRealTimers();
      },
    );

    it(
      "resets to healthy on retry-exhausted success cycle (clears counter)",
      async () => {
        mockConnect.mockResolvedValue(undefined);
        mockPrisma.mCPConnection.findMany.mockResolvedValue([
          { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: "entry1" },
        ]);
        mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValue({
          id: "entry1", consecutiveFailures: 5, healthStatus: "down",
        });
        const result = await runHealthCheckCycle();
        expect(mockPrisma.mcpCatalogEntry.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ healthStatus: "healthy", consecutiveFailures: 0, lastHealthError: null }) }),
        );
        expect(result.healthy).toBe(1);
      },
    );

    it("returns summary counts { healthy, stale, down }", async () => {
      mockConnect.mockResolvedValue(undefined);
      mockPrisma.mCPConnection.findMany.mockResolvedValue([
        { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: "entry1" },
        { id: "c2", name: "conn2", url: "http://localhost:3002/sse", headers: null, catalogEntryId: "entry2" },
      ]);
      mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValueOnce({
        id: "entry1", consecutiveFailures: 0, healthStatus: "healthy",
      }).mockResolvedValueOnce({
        id: "entry2", consecutiveFailures: 0, healthStatus: "healthy",
      });
      const result = await runHealthCheckCycle();
      expect(result).toEqual({ healthy: 2, stale: 0, down: 0 });
    });
  });
});

// ─── Phase 165 (Q-02): pg-boss registration ─────────────────────────────────
//
// Verifies the pg-boss migration: getBoss null-check (D-02 graceful
// degradation), createQueue + schedule + boss.work registration, and the
// work handler contract (Job[] array per Pitfall 2, error catch per Pitfall 3).
// Mocks the jobQueue seam (Pattern 3), NOT pg-boss directly.
describe("initMCPHealthCheckScheduler pg-boss registration (Phase 165, Q-02)", () => {
  const bossWork = jest.fn().mockResolvedValue("worker-id-1");

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockCreateQueue.mockResolvedValue(undefined);
    mockSchedule.mockResolvedValue(undefined);
    bossWork.mockClear();
    bossWork.mockResolvedValue("worker-id-1");
    mockGetBoss.mockReturnValue({ work: bossWork });
  });

  it("registers queue + cron schedule + work handler", async () => {
    await initMCPHealthCheckScheduler();

    // D-04: queue name matches the Phase 161 lock resource key.
    expect(mockCreateQueue).toHaveBeenCalledWith("healthcheck_mcp");
    // D-05: 30-minute cron expression.
    expect(mockSchedule).toHaveBeenCalledWith("healthcheck_mcp", "*/30 * * * *");
    // boss.work registered with the queue name and a handler function.
    expect(bossWork).toHaveBeenCalledTimes(1);
    expect(bossWork.mock.calls[0][0]).toBe("healthcheck_mcp");
    expect(typeof bossWork.mock.calls[0][1]).toBe("function");
    // createQueue precedes schedule (Pitfall 1 — foreign-key constraint).
    expect(mockCreateQueue.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSchedule.mock.invocationCallOrder[0]!,
    );
  });

  it("D-02: getBoss() === null → logs warn + returns early (no createQueue/schedule/work)", async () => {
    mockGetBoss.mockReturnValue(null);

    await initMCPHealthCheckScheduler();

    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(bossWork).not.toHaveBeenCalled();
    const warnCalls = mockedLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("pg-boss unavailable"))).toBe(true);
  });

  it("work handler calls runHealthCheckCycle on each job (Pitfall 2 — Job[] array)", async () => {
    await initMCPHealthCheckScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Stage a healthy connection so runHealthCheckCycle exercises the update
    // path — proves the cycle actually ran inside the work handler.
    mockPrisma.mCPConnection.findMany.mockResolvedValue([
      { id: "c1", name: "conn1", url: "http://localhost:3001/sse", headers: null, catalogEntryId: "entry1" },
    ]);
    mockPrisma.mcpCatalogEntry.findUnique.mockResolvedValue({
      id: "entry1", consecutiveFailures: 5, healthStatus: "down",
    });

    // pg-boss passes a Job[] array (Pitfall 2). The handler iterates with
    // for...of and runs the cycle once per job.
    const job = {
      id: "j1",
      data: {},
      name: "healthcheck_mcp",
      expireInSeconds: 300,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };
    await expect(handler([job])).resolves.toBeUndefined();

    // The cycle ran → mcpCatalogEntry.update called to reset to healthy.
    expect(mockPrisma.mcpCatalogEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ healthStatus: "healthy", consecutiveFailures: 0 }) }),
    );
  });

  it("Pitfall 3: work handler catches cycle errors and resolves (no re-throw → no retry storm)", async () => {
    await initMCPHealthCheckScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Force runHealthCheckCycle to throw by making findMany blow up.
    mockPrisma.mCPConnection.findMany.mockImplementation(() => {
      throw new Error("cycle boom");
    });

    // Handler must NOT re-throw — it logs and resolves (pg-boss sees success).
    await expect(handler([{ id: "j1", data: {}, name: "healthcheck_mcp" }])).resolves.toBeUndefined();
    expect(mockedLogger.error).toHaveBeenCalled();
  });
});
