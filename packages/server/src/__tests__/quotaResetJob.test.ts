// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 207 (Plan 02 Task 1 / VALIDATION W0) — quotaResetJob battery:
 * 30-day due computation, idempotent sweep (one anchor per due user, no-op
 * on already-reset), anchor-date-less/unlimited skips, per-row error
 * isolation, D-02 degrade (boss null → no scheduler).
 */

jest.mock("../utils/prisma", () => {
  const makePrisma = () => ({
    $transaction: jest.fn(),
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    quotaReset: { findFirst: jest.fn(), create: jest.fn() },
    workspaceTokenUsage: { aggregate: jest.fn() },
  });
  return { __esModule: true, default: makePrisma() };
});

jest.mock("../services/jobQueue", () => ({
  getBoss: jest.fn(),
  createQueue: jest.fn(async () => undefined),
  schedule: jest.fn(async () => undefined),
}));

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(async (key: string) => ({ key, value: "0", readOnly: false })),
}));

jest.mock("../utils/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import prisma from "../utils/prisma";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { initQuotaResetScheduler, runQuotaResetSweep } from "../services/quotaResetJob";
import type { PgBoss } from "pg-boss";

const mockedPrisma = jest.mocked(prisma);
const mockedGetBoss = jest.mocked(getBoss);

// The sweep resolves each user's quota via quotaService → prisma.user.findUnique
// and inserts anchors via resetTokenQuota → $transaction(quotaReset.findFirst/create).
function mockQuotaActive(limit: number | null, unlimited = false) {
  mockedPrisma.user.findUnique.mockResolvedValue({
    tokenQuotaLimit: limit,
    tokenQuotaUnlimited: unlimited,
  } as never);
  mockedPrisma.quotaReset.findFirst.mockResolvedValue(null as never);
  mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({
    _sum: { totalTokens: 0 },
  } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runQuotaResetSweep (D-11)", () => {
  it("inserts exactly one anchor for a due user (start + 30d <= now)", async () => {
    const start = new Date("2026-08-01T00:00:00Z");
    const now = new Date("2026-09-25T00:00:00Z"); // start + 55d → due at start+30d (k=1)
    mockedPrisma.user.findMany.mockResolvedValue([
      { id: "u1", resetAnchorDate: start },
    ] as never);
    mockQuotaActive(100000);
    const tx = {
      quotaReset: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => await (fn as (t: unknown) => Promise<unknown>)(tx));

    const r = await runQuotaResetSweep(now);
    expect(r.reset).toBe(1);
    expect(tx.quotaReset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u1", kind: "tokens", triggeredBy: "cron" }),
    });
  });

  it("is idempotent across consecutive sweeps — second sweep inserts nothing (D-11)", async () => {
    const start = new Date("2026-08-01T00:00:00Z");
    const now = new Date("2026-09-25T00:00:00Z");
    mockedPrisma.user.findMany.mockResolvedValue([{ id: "u1", resetAnchorDate: start }] as never);
    mockQuotaActive(100000);

    // Sweep 1: no prior anchor → insert.
    const tx1 = { quotaReset: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() } };
    mockedPrisma.$transaction.mockImplementationOnce(async (fn: unknown) => await (fn as (t: unknown) => Promise<unknown>)(tx1));
    const r1 = await runQuotaResetSweep(now);
    expect(r1.reset).toBe(1);

    // Sweep 2 (same now): latest anchor (written by sweep 1 at `now`) is at/after the due
    // instant → no-op.
    const tx2 = {
      quotaReset: {
        findFirst: jest.fn().mockResolvedValue({ at: new Date("2026-09-25T00:00:01Z") }),
        create: jest.fn(),
      },
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (fn: unknown) => await (fn as (t: unknown) => Promise<unknown>)(tx2));
    const r2 = await runQuotaResetSweep(new Date("2026-09-25T00:00:02Z"));
    expect(r2.reset).toBe(0);
    expect(tx2.quotaReset.create).not.toHaveBeenCalled();
  });

  it("skips users without resetAnchorDate (manual-only, D-09/D-11)", async () => {
    mockedPrisma.user.findMany.mockResolvedValue([] as never); // where clause excludes them
    const r = await runQuotaResetSweep(new Date("2026-09-25T00:00:00Z"));
    expect(r.reset).toBe(0);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("skips unlimited users and users with no active quota (nothing to reset)", async () => {
    const start = new Date("2026-08-01T00:00:00Z");
    mockedPrisma.user.findMany.mockResolvedValue([
      { id: "u-unlimited", resetAnchorDate: start },
      { id: "u-noquota", resetAnchorDate: start },
    ] as never);
    // unlimited → resolveTokenQuota short-circuits without preset lookup
    mockedPrisma.user.findUnique.mockResolvedValueOnce({
      tokenQuotaLimit: null,
      tokenQuotaUnlimited: true,
    } as never);
    // no override + preset unset → unset → unlimited
    mockedPrisma.user.findUnique.mockResolvedValueOnce({
      tokenQuotaLimit: null,
      tokenQuotaUnlimited: false,
    } as never);

    const r = await runQuotaResetSweep(new Date("2026-09-25T00:00:00Z"));
    expect(r.reset).toBe(0);
    expect(r.skipped).toBe(2);
  });

  it("isolates per-row errors — one failing user does not abort the sweep", async () => {
    const start = new Date("2026-08-01T00:00:00Z");
    mockedPrisma.user.findMany.mockResolvedValue([
      { id: "u-bad", resetAnchorDate: start },
      { id: "u-good", resetAnchorDate: start },
    ] as never);
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: 1000,
      tokenQuotaUnlimited: false,
    } as never);
    // u-bad: $transaction throws; u-good: inserts fine
    mockedPrisma.$transaction
      .mockRejectedValueOnce(new Error("db down"))
      .mockImplementationOnce(async (fn: unknown) =>
        await (fn as (t: unknown) => Promise<unknown>)({
          quotaReset: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
        }),
      );
    const r = await runQuotaResetSweep(new Date("2026-09-25T00:00:00Z"));
    expect(r.reset).toBe(1);
    expect(r.errors).toBe(1);
  });
});

describe("initQuotaResetScheduler (D-02 degrade + cron contract)", () => {
  it("degrades gracefully when pg-boss is unavailable — no queue, no work (D-02)", async () => {
    mockedGetBoss.mockReturnValue(null as unknown as PgBoss);
    await initQuotaResetScheduler();
    expect(createQueue).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("registers queue before schedule and wires the hourly cron (D-11)", async () => {
    const work = jest.fn(async () => undefined);
    mockedGetBoss.mockReturnValue({ work } as unknown as PgBoss);
    await initQuotaResetScheduler();
    expect(createQueue).toHaveBeenCalledWith("quota_reset_sweep");
    expect(schedule).toHaveBeenCalledWith("quota_reset_sweep", "0 * * * *");
    expect(work).toHaveBeenCalledWith("quota_reset_sweep", expect.any(Function));
  });
});