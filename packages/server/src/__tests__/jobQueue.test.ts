// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for the pg-boss job-queue singleton service (Phase 164, SCALE-04).
// Covers Q-01 (singleton init + idempotency), Q-04 (stop 4500ms + null no-op +
// reset), Q-05 (PG-unavailable degradation — caught, null, error logged, no
// throw).
//
// Mock strategy (mirrors redisService.test.ts — @swc/jest factory-creates-own-
// jest.fn() pattern, RESEARCH Pattern 3 + Pitfall 2):
//   - pg-boss is mocked with a shared mutable constructor returning a shared
//     mock instance. The factory references module-level vars (NOT block-scoped)
//     — same as redisService.test.ts referencing rsMockRedisConstructor.
//   - getEnv is mocked with a shared mutable object so resetModules preserves it.
//   - logger is mocked to prevent file/console output.

// @ts-nocheck — allowed in __tests__/ per server AGENTS.md.

const jqMockEnv = { DATABASE_URL: "postgresql://test:test@localhost:5432/test" };

const mockBossInstance = {
  start: jest.fn(),
  stop: jest.fn(),
  on: jest.fn(),
  schedule: jest.fn(),
  createQueue: jest.fn(),
};

const mockPgBossConstructor = jest.fn(() => mockBossInstance);

jest.mock("pg-boss", () => ({
  __esModule: true,
  PgBoss: mockPgBossConstructor,
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => jqMockEnv),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// NOTE: tests that assert on logger calls must re-require `../utils/logger`
// INSIDE the test AFTER `freshJobQueue()` (which calls jest.resetModules()).
// resetModules clears the registry and re-runs the mock factory, producing a
// NEW logger object — the one jobQueue.ts actually received. A top-level
// require here would point at a stale instance and the assertion would fail.

function freshJobQueue() {
  jest.resetModules();
  mockPgBossConstructor.mockClear();
  mockBossInstance.start.mockClear();
  mockBossInstance.stop.mockClear();
  mockBossInstance.on.mockClear();
  return require("../services/jobQueue");
}

describe("jobQueue — singleton lifecycle, stop, degradation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockPgBossConstructor.mockClear();
    mockBossInstance.start.mockClear();
    mockBossInstance.stop.mockClear();
    mockBossInstance.on.mockClear();
    mockBossInstance.start.mockResolvedValue(undefined);
    mockBossInstance.stop.mockResolvedValue(undefined);
  });

  it("getBoss() returns null before startJobQueue() is called (lazy init)", () => {
    const { getBoss } = freshJobQueue();
    expect(getBoss()).toBeNull();
  });

  it("startJobQueue() constructs PgBoss with DATABASE_URL and starts", async () => {
    const { startJobQueue, getBoss } = freshJobQueue();
    await startJobQueue();
    expect(mockPgBossConstructor).toHaveBeenCalledWith(jqMockEnv.DATABASE_URL);
    expect(mockBossInstance.start).toHaveBeenCalledTimes(1);
    expect(getBoss()).toBe(mockBossInstance);
    // D-05 / RESEARCH Pattern 1: the error event handler is registered at
    // construction time (before start()) so operational errors are captured.
    expect(mockBossInstance.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("startJobQueue() is idempotent — second call does not re-construct (initAttempted guard)", async () => {
    const { startJobQueue } = freshJobQueue();
    await startJobQueue();
    await startJobQueue();
    expect(mockPgBossConstructor).toHaveBeenCalledTimes(1);
    expect(mockBossInstance.start).toHaveBeenCalledTimes(1);
  });

  it("stopJobQueue() calls boss.stop({ graceful: true, timeout: 4500 }) (D-04 exact args)", async () => {
    const { startJobQueue, stopJobQueue } = freshJobQueue();
    await startJobQueue();
    await stopJobQueue();
    expect(mockBossInstance.stop).toHaveBeenCalledWith({
      graceful: true,
      timeout: 4500,
    });
  });

  it("stopJobQueue() is a no-op when never started (null guard, Pitfall 6)", async () => {
    const { stopJobQueue } = freshJobQueue();
    await expect(stopJobQueue()).resolves.toBeUndefined();
    expect(mockBossInstance.stop).not.toHaveBeenCalled();
  });

  it("stopJobQueue() resets bossInstance to null after stopping (second stop is a no-op)", async () => {
    const { startJobQueue, stopJobQueue, getBoss } = freshJobQueue();
    await startJobQueue();
    await stopJobQueue();
    expect(getBoss()).toBeNull();
    // A second stop must not re-invoke boss.stop (bossInstance is already null).
    mockBossInstance.stop.mockClear();
    await stopJobQueue();
    expect(mockBossInstance.stop).not.toHaveBeenCalled();
  });

  it("PG-unavailable: start() rejects → caught, getBoss() returns null, startJobQueue does not throw (D-05)", async () => {
    mockBossInstance.start.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const jq = freshJobQueue();
    // Re-require logger after resetModules so we assert on the SAME instance
    // jobQueue.ts received (resetModules re-runs the mock factory → new object).
    const { logger: jqLogger } = require("../utils/logger");
    await expect(jq.startJobQueue()).resolves.toBeUndefined();
    expect(jq.getBoss()).toBeNull();
    // D-05: the degradation path logs at error level (the queue is unavailable,
    // not merely a transient warning).
    expect(jqLogger.error).toHaveBeenCalled();
  });
});