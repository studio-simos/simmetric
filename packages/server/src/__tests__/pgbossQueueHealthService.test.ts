// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for the pg-boss queue-table self-heal guard
// (debug session pgboss-queue-pkey-duplicate).
//
// Covers:
//   - healthy table → no-op (single duplicate-check query, no repair writes)
//   - duplicate rows → repair transaction (replica role + DELETE + role restore),
//     create_queue re-creation per duplicated name, REINDEX, returns true
//   - duplicate-check failure (e.g. pgboss schema missing) → silent no-op, false
//   - repair failure → error logged, false, boot continues (degradation contract)
//
// Mock strategy: prisma and logger are module-mocked; $queryRawUnsafe /
// $executeRawUnsafe are shared jest.fn()s controlled per-test.

// @ts-nocheck — allowed in __tests__/ per server AGENTS.md.

const mockQueryRawUnsafe = jest.fn();
const mockExecuteRawUnsafe = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: mockQueryRawUnsafe,
    $executeRawUnsafe: mockExecuteRawUnsafe,
    $transaction: mockTransaction,
  },
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function freshService() {
  jest.resetModules();
  return require("../services/pgbossQueueHealthService");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTransaction.mockImplementation((ops) => Promise.all(ops));
  mockExecuteRawUnsafe.mockResolvedValue(undefined);
});

describe("healPgbossQueueDuplicates — healthy table", () => {
  it("returns false and performs NO repair writes when no duplicates exist", async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    const { healPgbossQueueDuplicates } = freshService();

    await expect(healPgbossQueueDuplicates()).resolves.toBe(false);

    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(1);
    // The check must be the pgboss.queue aggregate (GROUP BY name HAVING count > 1)
    expect(String(mockQueryRawUnsafe.mock.calls[0][0])).toMatch(
      /pgboss\.queue[\s\S]*HAVING count\(\*\) > 1/,
    );
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("healPgbossQueueDuplicates — repair path", () => {
  it("dedups, re-creates queues via create_queue, and REINDEXes the pkey", async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { name: "consistency_archive", dup_count: 3 },
      { name: "cleanup_vector", dup_count: 2 },
    ]);
    const { healPgbossQueueDuplicates } = freshService();
    const { logger } = require("../utils/logger");

    await expect(healPgbossQueueDuplicates()).resolves.toBe(true);

    // 1. Repair transaction: replica role → DELETE → role restored
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRawUnsafe.mock.calls[0][0]).toMatch(/session_replication_role = replica/);
    const deleteCall = mockExecuteRawUnsafe.mock.calls[1];
    expect(deleteCall[0]).toMatch(/DELETE FROM pgboss\.queue WHERE name = ANY/);
    expect(deleteCall[1]).toEqual(["consistency_archive", "cleanup_vector"]);
    expect(mockExecuteRawUnsafe.mock.calls[2][0]).toMatch(/session_replication_role = DEFAULT/);

    // 2. create_queue re-creation per duplicated name (standard policy — the
    //    exact function pg-boss's Manager.createQueue() calls)
    const createCalls = mockExecuteRawUnsafe.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.includes("create_queue"));
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]).toMatch(/pgboss\.create_queue/);
    // names are bound as parameters, not interpolated
    expect(mockExecuteRawUnsafe.mock.calls[3][1]).toBe("consistency_archive");
    expect(mockExecuteRawUnsafe.mock.calls[4][1]).toBe("cleanup_vector");

    // 3. REINDEX of the unique index — AFTER dedup (fails on existing dupes)
    const reindexCalls = mockExecuteRawUnsafe.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.includes("REINDEX"));
    expect(reindexCalls).toEqual(["REINDEX INDEX pgboss.queue_pkey"]);

    // Audit trail at info on success
    expect(logger.info).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("healPgbossQueueDuplicates — degradation", () => {
  it("returns false silently when the duplicate check fails (pgboss schema absent, D-05 first boot)", async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error("relation \"pgboss.queue\" does not exist"));
    const { healPgbossQueueDuplicates } = freshService();
    const { logger } = require("../utils/logger");

    await expect(healPgbossQueueDuplicates()).resolves.toBe(false);
    expect(mockTransaction).not.toHaveBeenCalled();
    // debug-level (not warn/error) — an absent schema on first boot is expected
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns false and logs error when the repair transaction fails (boot continues)", async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ name: "x", dup_count: 2 }]);
    mockTransaction.mockRejectedValueOnce(new Error("permission denied"));
    const { healPgbossQueueDuplicates } = freshService();
    const { logger } = require("../utils/logger");

    await expect(healPgbossQueueDuplicates()).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});