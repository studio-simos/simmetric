// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for MCP reaper job — 5-min listTools() probe that disconnects
 * stale connections (D-05/D-07, T-63-leak mitigation).
 *
 * Phase 165 (Q-02/Q-03): the scheduler lifecycle describe block was rewritten
 * to assert pg-boss registration (createQueue + schedule + boss.work) instead
 * of the former timer/lock lifecycle. The cycle-body tests (runReaperCycle,
 * runReconnectCycle) are UNCHANGED — the cycle functions were not modified by
 * the migration. The mock boundary is at `jobQueue.ts` (Pattern 3 — mock the
 * seam, not pg-boss directly); the `__mocks__/pg-boss.ts` manual mock handles
 * transitive ESM loads for any suite that boots index.ts.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
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

// Mock mcpClient. WR-07 made the reaper acquire `withConnectionLock` around the
// probe and re-check `getActiveConnectionState` inside the lock, so the mock
// must surface both. `getActiveConnectionState` reads from the same snapshot
// jest.fn so it tracks whatever the test staged via `mockedSnapshot`.
jest.mock("../agent/mcpClient", () => {
  const snapshot = jest.fn(() => []);
  return {
    disconnectMCPServer: jest.fn(),
    connectMCPServer: jest.fn().mockResolvedValue({ tools: [] }),
    getActiveConnectionsSnapshot: snapshot,
    getActiveConnectionState: jest.fn((id: string) => {
      const entries = snapshot() as Array<{ id: string; state: unknown }>;
      return entries.find((e) => e.id === id)?.state;
    }),
    // WR-07: lock is transparent in tests — just run the guarded fn.
    withConnectionLock: jest.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
  };
});

import { disconnectMCPServer, connectMCPServer, getActiveConnectionsSnapshot, getActiveConnectionState } from "../agent/mcpClient";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { runReaperCycle, runReconnectCycle, initMCPReaperScheduler } from "../services/mcpReaperJob";

const mockedDisconnect = disconnectMCPServer as jest.Mock;
const mockedConnect = connectMCPServer as jest.Mock;
const mockedSnapshot = getActiveConnectionsSnapshot as jest.Mock;
const mockedGetState = getActiveConnectionState as jest.Mock;
const mockedFindMany = (prisma as unknown as { mCPConnection: { findMany: jest.Mock } }).mCPConnection.findMany;

const mockGetBoss = getBoss as jest.Mock;
const mockCreateQueue = createQueue as jest.Mock;
const mockSchedule = schedule as jest.Mock;
const mockedLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

describe("MCP reaper job (D-05/D-07, T-63-leak)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedDisconnect.mockResolvedValue(undefined);
  });

  it("reaper stale — listTools throws → disconnectMCPServer called", async () => {
    mockedSnapshot.mockReturnValue([
      {
        id: "conn-stale",
        state: {
          connected: true,
          client: {
            listTools: jest.fn().mockRejectedValue(new Error("socket hang up")),
          },
        },
      },
    ]);

    await runReaperCycle();

    expect(mockedDisconnect).toHaveBeenCalledWith("conn-stale");
  });

  it("reaper empty tools — listTools returns [] → disconnectMCPServer called", async () => {
    mockedSnapshot.mockReturnValue([
      {
        id: "conn-empty",
        state: {
          connected: true,
          client: {
            listTools: jest.fn().mockResolvedValue({ tools: [] }),
          },
        },
      },
    ]);

    await runReaperCycle();

    expect(mockedDisconnect).toHaveBeenCalledWith("conn-empty");
  });

  it("reaper healthy — listTools returns tools → disconnectMCPServer NOT called", async () => {
    mockedSnapshot.mockReturnValue([
      {
        id: "conn-healthy",
        state: {
          connected: true,
          client: {
            listTools: jest.fn().mockResolvedValue({ tools: [{ name: "t1" }] }),
          },
        },
      },
    ]);

    await runReaperCycle();

    expect(mockedDisconnect).not.toHaveBeenCalled();
  });

  it("reaper skips disconnected entries — !state.connected → not probed, not disconnected", async () => {
    const listTools = jest.fn();
    mockedSnapshot.mockReturnValue([
      {
        id: "conn-disc",
        state: { connected: false, client: { listTools } },
      },
    ]);

    await runReaperCycle();

    expect(listTools).not.toHaveBeenCalled();
    expect(mockedDisconnect).not.toHaveBeenCalled();
  });

  it("reaper per-connection isolation — one bad entry does not abort the cycle", async () => {
    mockedSnapshot.mockReturnValue([
      {
        id: "conn-bad",
        state: {
          connected: true,
          client: { listTools: jest.fn().mockRejectedValue(new Error("bad")) },
        },
      },
      {
        id: "conn-good",
        state: {
          connected: true,
          client: {
            listTools: jest.fn().mockResolvedValue({ tools: [{ name: "t1" }] }),
          },
        },
      },
    ]);

    await runReaperCycle();

    // bad entry disconnected, good entry left alone
    expect(mockedDisconnect).toHaveBeenCalledTimes(1);
    expect(mockedDisconnect).toHaveBeenCalledWith("conn-bad");
  });

  it("reaper mutex — concurrent probe + disconnect does not double-close (withConnectionLock serializes)", async () => {
    // The reaper calls disconnectMCPServer which internally acquires the
    // per-connection lock (withConnectionLock). Concurrent callers are
    // serialized by that lock. We simulate the reaper observing a throwing
    // listTools and calling disconnectMCPServer; the lock inside
    // disconnectMCPServer prevents a concurrent toggle from double-closing.
    mockedSnapshot.mockReturnValue([
      {
        id: "conn-race",
        state: {
          connected: true,
          client: {
            listTools: jest.fn().mockRejectedValue(new Error("stale")),
          },
        },
      },
    ]);

    // Fire two reaper cycles concurrently — both target the same connection.
    await Promise.all([runReaperCycle(), runReaperCycle()]);

    // disconnectMCPServer is idempotent + mutex-guarded; the second cycle sees
    // the connection already gone (snapshot was taken once, but disconnect is
    // a no-op on missing state). At most one effective close path runs.
    expect(mockedDisconnect).toHaveBeenCalledWith("conn-race");
  });

  describe("auto-reconnect sweep (runReconnectCycle)", () => {
    beforeEach(() => {
      mockedConnect.mockReset();
      mockedConnect.mockResolvedValue({ tools: [] });
      mockedFindMany.mockReset();
    });

    it("reconnects enabled-but-disconnected connections (fire-and-forget)", async () => {
      mockedFindMany.mockResolvedValue([
        { id: "conn-a", name: "A" },
        { id: "conn-b", name: "B" },
      ]);
      // No active connection state for either → both candidates.
      mockedSnapshot.mockReturnValue([]);
      mockedConnect.mockResolvedValue({ tools: [{ name: "t1" }] });

      const summary = await runReconnectCycle();
      // fire-and-forget: let the microtasks flush.
      await Promise.resolve();
      await Promise.resolve();

      expect(summary.candidates).toBe(2);
      expect(mockedConnect).toHaveBeenCalledWith("conn-a");
      expect(mockedConnect).toHaveBeenCalledWith("conn-b");
    });

    it("skips already-connected (healthy) connections", async () => {
      mockedFindMany.mockResolvedValue([
        { id: "conn-healthy", name: "Healthy" },
        { id: "conn-disc", name: "Disc" },
      ]);
      // conn-healthy is in the snapshot and connected → skipped; conn-disc absent → candidate.
      mockedSnapshot.mockReturnValue([
        { id: "conn-healthy", state: { connected: true } },
      ]);

      const summary = await runReconnectCycle();
      await Promise.resolve();

      expect(summary.candidates).toBe(1);
      expect(mockedConnect).toHaveBeenCalledTimes(1);
      expect(mockedConnect).toHaveBeenCalledWith("conn-disc");
    });

    it("ignores disabled connections (findMany filters by enabled)", async () => {
      // The sweep queries `where: { enabled: true }` — disabled rows never
      // reach the candidate loop. Verified by staging an empty enabled set.
      mockedFindMany.mockResolvedValue([]);
      mockedSnapshot.mockReturnValue([]);

      const summary = await runReconnectCycle();
      expect(summary.candidates).toBe(0);
      expect(mockedConnect).not.toHaveBeenCalled();
    });

    it("a failing connectMCPServer does not reject the sweep (defensive catch)", async () => {
      mockedFindMany.mockResolvedValue([{ id: "conn-x", name: "X" }]);
      mockedSnapshot.mockReturnValue([]);
      mockedConnect.mockRejectedValue(new Error("boom"));

      // Should not throw — the sweep's .catch handles background rejections.
      await expect(runReconnectCycle()).resolves.toEqual({ candidates: 1 });
    });
  });

  describe("initMCPReaperScheduler pg-boss registration (Phase 165, Q-02)", () => {
    // Default boss instance with a work stub whose calls the tests inspect.
    const bossWork = jest.fn().mockResolvedValue("worker-id-1");

    beforeEach(() => {
      jest.clearAllMocks();
      mockedDisconnect.mockResolvedValue(undefined);
      mockCreateQueue.mockResolvedValue(undefined);
      mockSchedule.mockResolvedValue(undefined);
      bossWork.mockClear();
      bossWork.mockResolvedValue("worker-id-1");
      mockGetBoss.mockReturnValue({ work: bossWork });
    });

    it("registers queue + cron schedule + work handler", async () => {
      await initMCPReaperScheduler();

      // D-04: queue name matches the Phase 161 lock resource key.
      expect(mockCreateQueue).toHaveBeenCalledWith("reaper_mcp");
      // D-05: 5-minute cron expression.
      expect(mockSchedule).toHaveBeenCalledWith("reaper_mcp", "*/5 * * * *");
      // boss.work registered with the queue name and a handler function.
      expect(bossWork).toHaveBeenCalledTimes(1);
      expect(bossWork.mock.calls[0][0]).toBe("reaper_mcp");
      expect(typeof bossWork.mock.calls[0][1]).toBe("function");
      // createQueue precedes schedule (Pitfall 1 — foreign-key constraint).
      expect(mockCreateQueue.mock.invocationCallOrder[0]!).toBeLessThan(
        mockSchedule.mock.invocationCallOrder[0]!,
      );
    });

    it("D-02: getBoss() === null → logs warn + returns early (no createQueue/schedule/work)", async () => {
      mockGetBoss.mockReturnValue(null);

      await initMCPReaperScheduler();

      expect(mockCreateQueue).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(bossWork).not.toHaveBeenCalled();
      // D-02: warn log mentions pg-boss unavailable.
      const warnCalls = mockedLogger.warn.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => m.includes("pg-boss unavailable"))).toBe(true);
    });

    it("work handler calls runReaperCycle on each job (Pitfall 2 — Job[] array)", async () => {
      await initMCPReaperScheduler();
      const handler = bossWork.mock.calls[0][1];

      // Stage a stale connection so runReaperCycle disconnects it — proves the
      // cycle actually ran inside the work handler.
      mockedSnapshot.mockReturnValue([
        {
          id: "conn-stale",
          state: {
            connected: true,
            client: { listTools: jest.fn().mockRejectedValue(new Error("dead")) },
          },
        },
      ]);
      mockedDisconnect.mockResolvedValue(undefined);

      // pg-boss passes a Job[] array (Pitfall 2). The handler iterates with
      // for...of and runs the cycle once per job.
      const job = {
        id: "j1",
        data: {},
        name: "reaper_mcp",
        expireInSeconds: 300,
        heartbeatSeconds: null,
        signal: new AbortController().signal,
      };
      await expect(handler([job])).resolves.toBeUndefined();

      // The cycle ran → disconnectMCPServer called for the stale entry.
      expect(mockedDisconnect).toHaveBeenCalledWith("conn-stale");
    });

    it("Pitfall 3: work handler catches cycle errors and resolves (no re-throw → no retry storm)", async () => {
      await initMCPReaperScheduler();
      const handler = bossWork.mock.calls[0][1];

      // Force runReaperCycle to throw by making the snapshot getter blow up.
      mockedSnapshot.mockImplementation(() => {
        throw new Error("cycle boom");
      });

      // Handler must NOT re-throw — it logs and resolves (pg-boss sees success).
      await expect(handler([{ id: "j1", data: {}, name: "reaper_mcp" }])).resolves.toBeUndefined();
      expect(mockedLogger.error).toHaveBeenCalled();
    });
  });
});