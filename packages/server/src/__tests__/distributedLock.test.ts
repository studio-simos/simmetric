// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for the distributed lock service (TEC-03d, D-04) — redlock-based
// reimplementation of the Phase 104-03 hand-rolled SET NX EX + Lua lock.
// Phase 180 dead-code sweep: the backup-mutex half (acquireRedisLock /
// releaseRedisLock / acquireBackupMutex / releaseBackupMutex + heartbeat)
// was removed with its production consumers (moved to the enterprise
// plugin in Phase 146). What remains under test: getRedlock (via
// withDistributedLock) and withDistributedLock itself (local-run fallback,
// redlock.using wrap, ResourceLockedError/ExecutionError skip contract).
//
// Mock strategy:
// - redisService is mocked directly to control getRedis() return value.
// - redlock is mocked (constructor + ResourceLockedError + ExecutionError).

// ─── Mocks ───────────────────────────────────────────────────────────────────

const dlMockRedis = {
  on: jest.fn(),
  get: jest.fn(),
  set: jest.fn().mockResolvedValue("OK"),
  setex: jest.fn().mockResolvedValue("OK"),
  del: jest.fn().mockResolvedValue(1),
  eval: jest.fn().mockResolvedValue(1),
  ping: jest.fn().mockResolvedValue("PONG"),
  disconnect: jest.fn(),
};

const dlMockGetRedis = jest.fn();

jest.mock("../services/redisService", () => ({
  getRedis: dlMockGetRedis,
}));

// ─── Redlock mock ─────────────────────────────────────────────────────────────
// Constructor mock + ResourceLockedError class + fake Lock with extend/release.
// The mock instance's acquire/using are jest.fn()s the tests configure.

class MockResourceLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLockedError";
  }
}

class MockExecutionError extends Error {
  attempts: unknown[];
  constructor(message: string, attempts: unknown[] = []) {
    super(message);
    this.name = "ExecutionError";
    this.attempts = attempts;
  }
}

const mockRedlockUsing = jest.fn();
const mockRedlockOn = jest.fn();
const mockRedlockInstance = {
  using: mockRedlockUsing,
  on: mockRedlockOn,
};
const mockRedlockConstructor = jest.fn(() => mockRedlockInstance);

jest.mock("redlock", () => ({
  __esModule: true,
  default: mockRedlockConstructor,
  ResourceLockedError: MockResourceLockedError,
  ExecutionError: MockExecutionError,
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ─── Helper: fresh module require ─────────────────────────────────────────────

function freshDistributedLock() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../services/distributedLock");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("distributedLock — getRedlock (via withDistributedLock)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    dlMockGetRedis.mockReturnValue(dlMockRedis);
  });

  it("returns null when getRedis() is null → withDistributedLock runs locally", async () => {
    dlMockGetRedis.mockReturnValue(null);
    const { withDistributedLock } = freshDistributedLock();
    const result = await withDistributedLock("reaper:test", 30_000, jest.fn().mockResolvedValue("v"));
    expect(result).toBe("v");
    expect(mockRedlockConstructor).not.toHaveBeenCalled();
  });

  it("constructs a singleton Redlock with retryCount 0 and an error listener when Redis is available", () => {
    const { withDistributedLock } = freshDistributedLock();
    mockRedlockUsing.mockImplementation(
      async (_r: string[], _d: number, _s: unknown, routine: (s: unknown) => Promise<unknown>) =>
        routine({ aborted: false }),
    );
    void withDistributedLock("reaper:probe", 30_000, jest.fn());
    expect(mockRedlockConstructor).toHaveBeenCalledWith([dlMockRedis], {
      driftFactor: 0.01,
      retryCount: 0,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });
    expect(mockRedlockOn).toHaveBeenCalledWith("error", expect.any(Function));
  });
});

describe("distributedLock — withDistributedLock", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    dlMockGetRedis.mockReturnValue(dlMockRedis);
    mockRedlockUsing.mockImplementation(
      async (_resources: string[], _duration: number, _settings: unknown, routine: (signal: unknown) => Promise<unknown>) =>
        routine({ aborted: false }),
    );
  });

  it("runs the routine locally when Redis is absent (returns its value)", async () => {
    dlMockGetRedis.mockReturnValue(null);
    const { withDistributedLock } = freshDistributedLock();
    const routine = jest.fn().mockResolvedValue("local-result");

    const result = await withDistributedLock("reaper:test", 30_000, routine);
    expect(result).toBe("local-result");
    expect(routine).toHaveBeenCalledTimes(1);
    expect(mockRedlockUsing).not.toHaveBeenCalled();
  });

  it("wraps the routine in redlock.using with retryCount 0 when Redis is available", async () => {
    const { withDistributedLock } = freshDistributedLock();
    const routine = jest.fn().mockResolvedValue("locked-result");

    const result = await withDistributedLock("reaper:test", 30_000, routine);
    expect(result).toBe("locked-result");
    expect(mockRedlockUsing).toHaveBeenCalledWith(
      ["reaper:test"],
      30_000,
      { retryCount: 0 },
      expect.any(Function),
    );
  });

  it("returns null ONLY on ResourceLockedError (busy)", async () => {
    mockRedlockUsing.mockRejectedValue(new MockResourceLockedError("busy"));
    const { withDistributedLock } = freshDistributedLock();

    const result = await withDistributedLock("reaper:test", 30_000, jest.fn());
    expect(result).toBeNull();
  });

  it("returns null when redlock 5.0.0-beta.2 wraps contention in ExecutionError (Phase 124-01 A3 regression)", async () => {
    // Redlock 5.0.0-beta.2 surfaces a contended acquire (retryCount 0) as an
    // ExecutionError whose attempts[].stats.votesAgainst carries the
    // ResourceLockedError. The smoke-multi-instance A3 uncovered this gap:
    // the old `instanceof ResourceLockedError` catch let it escape.
    const busyStats = {
      membershipSize: 1,
      quorumSize: 1,
      votesFor: new Set(),
      votesAgainst: new Map([[dlMockRedis, new MockResourceLockedError("The operation was applied to: 0 of the 1 requested resources.")]]),
    };
    mockRedlockUsing.mockRejectedValue(new MockExecutionError("The operation was unable to achieve a quorum during its retry window.", [busyStats]));
    const { withDistributedLock } = freshDistributedLock();

    const result = await withDistributedLock("reaper:test", 30_000, jest.fn());
    expect(result).toBeNull();
  });

  it("rethrows non-busy errors", async () => {
    mockRedlockUsing.mockRejectedValue(new Error("redis down"));
    const { withDistributedLock } = freshDistributedLock();

    await expect(
      withDistributedLock("reaper:test", 30_000, jest.fn()),
    ).rejects.toThrow("redis down");
  });
});