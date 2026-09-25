// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 207 (Plan 01 Tasks 1+3 / VALIDATION W0) — quotaService battery:
 * resolution chain arms (D-08), window SUM (D-01), breach contract (D-04),
 * exemption + uniform application (D-07/D-10), anchor-window reset (D-02,
 * P1: history immutable).
 */

jest.mock("../utils/prisma", () => {
  const makePrisma = () => ({
    $transaction: jest.fn(),
    user: { findUnique: jest.fn() },
    quotaReset: { findFirst: jest.fn(), create: jest.fn() },
    workspaceTokenUsage: { aggregate: jest.fn() },
  });
  return { __esModule: true, default: makePrisma() };
});

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(async (key: string) => {
    // Default: preset unset ("0" sentinel → chain falls to unlimited).
    return { key, value: "0", readOnly: false };
  }),
}));

jest.mock("../utils/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import prisma from "../utils/prisma";
import { getSetting } from "../services/systemConfigService";
import {
  QuotaError,
  checkTokenQuota,
  resolveTokenQuota,
  resetTokenQuota,
  getTokenWindowUsage,
  windowStart,
} from "../services/quotaService";

const mockedPrisma = jest.mocked(prisma);
const mockedGetSetting = jest.mocked(getSetting);

const USER_SELECT = { select: { tokenQuotaLimit: true, tokenQuotaUnlimited: true } };

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetSetting.mockResolvedValue({ key: "QUOTA_TOKEN_DEFAULT", value: "0", readOnly: false });
});

describe("resolveTokenQuota (D-08 chain)", () => {
  it("override wins over preset (D-08 arm 2 > 3)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: 12345,
      tokenQuotaUnlimited: false,
    } as never);
    mockedGetSetting.mockResolvedValue({ key: "QUOTA_TOKEN_DEFAULT", value: "999", readOnly: false });
    const r = await resolveTokenQuota("u1");
    expect(r).toEqual({ limit: 12345, source: "override" });
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, ...USER_SELECT });
  });

  it("preset applies when override null; sentinel 0/empty = unset → unlimited (D-08 arm 3)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: null,
      tokenQuotaUnlimited: false,
    } as never);
    mockedGetSetting.mockResolvedValue({ key: "QUOTA_TOKEN_DEFAULT", value: "500000", readOnly: false });
    const r = await resolveTokenQuota("u1");
    expect(r).toEqual({ limit: 500000, source: "preset" });

    mockedGetSetting.mockResolvedValue({ key: "QUOTA_TOKEN_DEFAULT", value: "0", readOnly: false });
    expect(await resolveTokenQuota("u1")).toEqual({ limit: null, source: "unset" });
    mockedGetSetting.mockResolvedValue({ key: "QUOTA_TOKEN_DEFAULT", value: "", readOnly: false });
    expect(await resolveTokenQuota("u1")).toEqual({ limit: null, source: "unset" });
  });

  it("tokenQuotaUnlimited exempts from a live preset (D-07)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: null,
      tokenQuotaUnlimited: true,
    } as never);
    mockedGetSetting.mockResolvedValue({ key: "QUOTA_TOKEN_DEFAULT", value: "500000", readOnly: false });
    const r = await resolveTokenQuota("u1");
    expect(r).toEqual({ limit: null, source: "unlimited" });
    expect(mockedGetSetting).not.toHaveBeenCalled();
  });

  it("preset lookup failure fails OPEN to unlimited (logged)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: null,
      tokenQuotaUnlimited: false,
    } as never);
    mockedGetSetting.mockRejectedValue(new Error("config store down"));
    const r = await resolveTokenQuota("u1");
    expect(r).toEqual({ limit: null, source: "unset" });
  });

  it("missing user row resolves unset (fail-closed identity upstream)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null as never);
    expect(await resolveTokenQuota("ghost")).toEqual({ limit: null, source: "unset" });
  });
});

describe("checkTokenQuota (D-03/D-04 gate)", () => {
  it("passes silently when unlimited", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: null,
      tokenQuotaUnlimited: true,
    } as never);
    await expect(checkTokenQuota("u1")).resolves.toBeUndefined();
    expect(mockedPrisma.workspaceTokenUsage.aggregate).not.toHaveBeenCalled();
  });

  it("throws the 409 family with quota: tokens on breach (D-04)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: 1000,
      tokenQuotaUnlimited: false,
    } as never);
    mockedPrisma.quotaReset.findFirst.mockResolvedValue(null as never);
    mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({
      _sum: { totalTokens: 1500 },
    } as never);
    const err = await checkTokenQuota("u1").catch((e) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.status).toBe(409);
    expect(err.payload).toMatchObject({
      error: "Token quota reached",
      quota: "tokens",
      limit: 1000,
      used: 1500,
    });
    expect(err.payload.windowStart).toEqual(expect.any(String));
  });

  it("allows usage strictly below the limit (overage window semantics)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: 1000,
      tokenQuotaUnlimited: false,
    } as never);
    mockedPrisma.quotaReset.findFirst.mockResolvedValue(null as never);
    mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({
      _sum: { totalTokens: 999 },
    } as never);
    await expect(checkTokenQuota("u1")).resolves.toBeUndefined();
  });

  it("window usage reads from the latest anchor (D-01/D-02)", async () => {
    const anchorAt = new Date("2026-09-01T00:00:00Z");
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: 1000,
      tokenQuotaUnlimited: false,
    } as never);
    mockedPrisma.quotaReset.findFirst.mockResolvedValue({
      userId: "u1",
      kind: "tokens",
      at: anchorAt,
      triggeredBy: "cron",
      id: "a1",
      createdAt: anchorAt,
    } as never);
    mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({
      _sum: { totalTokens: 10 },
    } as never);
    await checkTokenQuota("u1");
    expect(mockedPrisma.quotaReset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", kind: "tokens" } }),
    );
    expect(mockedPrisma.workspaceTokenUsage.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", createdAt: { gt: anchorAt } },
      }),
    );
    const ws = await windowStart("u1", "tokens");
    expect(ws).toEqual(anchorAt);
  });
});

describe("resetTokenQuota (D-02 anchor, P1 immutability)", () => {
  it("manual reset inserts an anchor inside a transaction — usage rows untouched", async () => {
    const tx = { quotaReset: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) } };
    mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => await (fn as (t: unknown) => Promise<unknown>)(tx));
    const r = await resetTokenQuota("u1", "tokens", "manual");
    expect(r.inserted).toBe(true);
    expect(tx.quotaReset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u1", kind: "tokens", triggeredBy: "manual" }),
    });
    // P1: no workspaceTokenUsage delete/updateMany call ever occurs.
    expect((mockedPrisma as unknown as { workspaceTokenUsage: Record<string, jest.Mock> }).workspaceTokenUsage.deleteMany).toBeUndefined();
  });

  it("cron reset is a no-op when a concurrent tick anchored at/after the due instant (D-11)", async () => {
    const due = new Date("2026-09-25T12:00:00Z");
    const tx = {
      quotaReset: {
        findFirst: jest.fn().mockResolvedValue({ at: new Date("2026-09-25T12:00:01Z") }),
        create: jest.fn(),
      },
    };
    mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => await (fn as (t: unknown) => Promise<unknown>)(tx));
    const r = await resetTokenQuota("u1", "tokens", "cron", { notBefore: due });
    expect(r.inserted).toBe(false);
    expect(tx.quotaReset.create).not.toHaveBeenCalled();
  });

  it("cron reset inserts when no anchor is at/after the due instant", async () => {
    const due = new Date("2026-09-25T12:00:00Z");
    const tx = {
      quotaReset: {
        findFirst: jest.fn().mockResolvedValue({ at: new Date("2026-09-25T11:00:00Z") }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => await (fn as (t: unknown) => Promise<unknown>)(tx));
    const r = await resetTokenQuota("u1", "tokens", "cron", { notBefore: due });
    expect(r.inserted).toBe(true);
    expect(tx.quotaReset.create).toHaveBeenCalled();
  });
});

describe("getTokenWindowUsage (D-01 ledger SUM)", () => {
  it("sums totalTokens from the epoch when no anchor exists", async () => {
    mockedPrisma.quotaReset.findFirst.mockResolvedValue(null as never);
    mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({
      _sum: { totalTokens: 777 },
    } as never);
    const usage = await getTokenWindowUsage("u1");
    expect(usage).toBe(777);
    expect(mockedPrisma.workspaceTokenUsage.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", createdAt: { gt: new Date(0) } },
      }),
    );
  });
  it("returns 0 when the SUM is null (no usage rows)", async () => {
    mockedPrisma.quotaReset.findFirst.mockResolvedValue(null as never);
    mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({
      _sum: { totalTokens: null },
    } as never);
    expect(await getTokenWindowUsage("u1")).toBe(0);
  });
});