// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 207 (Plan 03 Tasks 1+2 / VALIDATION W0) — storage accounting +
 * storage gate battery: uploader-chain sums (D-13/D-14), tombstone/expiry
 * exclusion, no-double-count (draft → document handoff), org bucket,
 * resolution chain (D-08 storage arm), over-quota rejection at both ends
 * (D-15), parallel-upload race closed by the caller's in-tx usage of
 * computeStorageUsage.
 */

jest.mock("../utils/prisma", () => {
  const makePrisma = () => ({
    $transaction: jest.fn(),
    user: { findUnique: jest.fn() },
    quotaReset: { findFirst: jest.fn(), create: jest.fn() },
    uploadDraft: { aggregate: jest.fn(), findMany: jest.fn() },
    document: { aggregate: jest.fn() },
    workspaceTokenUsage: { aggregate: jest.fn() },
  });
  return { __esModule: true, default: makePrisma() };
});

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(async (key: string) => ({ key, value: "", readOnly: false })),
}));

jest.mock("../utils/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import prisma from "../utils/prisma";
import { getSetting } from "../services/systemConfigService";
import {
  QuotaError,
  checkStorageQuota,
  computeStorageUsage,
  getStorageUsage,
  resolveStorageQuota,
} from "../services/quotaService";

const mockedPrisma = jest.mocked(prisma);
const mockedGetSetting = jest.mocked(getSetting);

function mockUsageParts({ draftBytes = 0, documentBytes = 0 }: { draftBytes?: number; documentBytes?: number }) {
  mockedPrisma.uploadDraft.aggregate.mockResolvedValue({ _sum: { fileSize: draftBytes } } as never);
  mockedPrisma.uploadDraft.findMany.mockResolvedValue(
    documentBytes > 0 ? [{ ragJobId: "doc-1" }] : [],
  );
  mockedPrisma.document.aggregate.mockResolvedValue({ _sum: { fileSize: documentBytes } } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetSetting.mockResolvedValue({ key: "QUOTA_STORAGE_GB_DEFAULT", value: "", readOnly: false });
});

describe("computeStorageUsage (D-13/D-14 uploader chain)", () => {
  it("counts live unattributed-to-document drafts + documents via the originating draft", async () => {
    mockUsageParts({ draftBytes: 1000, documentBytes: 4000 });
    const u = await computeStorageUsage(prisma, "u1");
    expect(u).toEqual({ draftBytes: 1000, documentBytes: 4000, totalBytes: 5000 });
    // drafts in the draft-arm EXCLUDE ragJobId-set rows (no double counting)
    expect(mockedPrisma.uploadDraft.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uploadedBy: "u1", deletedAt: null, ragJobId: null }),
      }),
    );
    // documents attributed via drafts with ragJobId set, tombstones excluded
    expect(mockedPrisma.document.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["doc-1"] }, deletedAt: null },
      }),
    );
  });

  it("excludes expired drafts from the sum (D-13)", async () => {
    mockUsageParts({});
    await computeStorageUsage(prisma, "u1", new Date("2026-09-25T00:00:00Z"));
    expect(mockedPrisma.uploadDraft.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ expiresAt: { gt: new Date("2026-09-25T00:00:00Z") } }),
      }),
    );
  });

  it("returns zero breakdown when nothing is stored", async () => {
    mockUsageParts({});
    const u = await getStorageUsage("u1");
    expect(u.totalBytes).toBe(0);
  });
});

describe("resolveStorageQuota (D-08 storage arm)", () => {
  it("override GB wins over preset", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ storageQuotaGb: 2.5, storageQuotaUnlimited: false } as never);
    mockedGetSetting.mockResolvedValue({ key: "QUOTA_STORAGE_GB_DEFAULT", value: "10", readOnly: false });
    expect(await resolveStorageQuota("u1")).toEqual({ limit: 2.5, source: "override" });
  });

  it("preset applies when override null; sentinel 0/empty = unset → unlimited", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ storageQuotaGb: null, storageQuotaUnlimited: false } as never);
    mockedGetSetting.mockResolvedValue({ key: "QUOTA_STORAGE_GB_DEFAULT", value: "5", readOnly: false });
    expect(await resolveStorageQuota("u1")).toEqual({ limit: 5, source: "preset" });
    mockedGetSetting.mockResolvedValue({ key: "QUOTA_STORAGE_GB_DEFAULT", value: "", readOnly: false });
    expect(await resolveStorageQuota("u1")).toEqual({ limit: null, source: "unset" });
  });

  it("storageQuotaUnlimited exempts from a live preset (D-07)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ storageQuotaGb: null, storageQuotaUnlimited: true } as never);
    mockedGetSetting.mockResolvedValue({ key: "QUOTA_STORAGE_GB_DEFAULT", value: "5", readOnly: false });
    expect(await resolveStorageQuota("u1")).toEqual({ limit: null, source: "unlimited" });
    expect(mockedGetSetting).not.toHaveBeenCalled();
  });
});

describe("checkStorageQuota (D-15 gate core)", () => {
  it("accepts an upload that fits within the remaining bytes", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ storageQuotaGb: 1, storageQuotaUnlimited: false } as never);
    mockUsageParts({ draftBytes: 500_000_000 }); // 0.5 GB used of 1 GB
    const usage = await checkStorageQuota(prisma, "u1", 400_000_000);
    expect(usage.totalBytes).toBe(500_000_000);
  });

  it("throws the 409 storage family when the upload exceeds remaining bytes (D-04)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ storageQuotaGb: 1, storageQuotaUnlimited: false } as never);
    mockUsageParts({ draftBytes: 900_000_000 }); // 0.9 GB used
    const err = await checkStorageQuota(prisma, "u1", 200_000_000).catch((e) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.status).toBe(409);
    expect(err.payload).toMatchObject({
      error: "Storage limit reached",
      quota: "storage",
      limit: 1,
      used: 900_000_000,
    });
  });

  it("unlimited resolution never throws and returns usage for logging", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ storageQuotaGb: null, storageQuotaUnlimited: true } as never);
    mockUsageParts({ draftBytes: 123 });
    const usage = await checkStorageQuota(prisma, "u1", 999_999_999_999);
    expect(usage.totalBytes).toBe(123);
  });

  it("Decimal GB→byte math: 0.01 GB admits a 1 MB file, rejects an 11 MB file at the boundary", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ storageQuotaGb: 0.01, storageQuotaUnlimited: false } as never);
    mockUsageParts({ draftBytes: 0 });
    await expect(checkStorageQuota(prisma, "u1", 1_000_000)).resolves.toBeDefined();
    await expect(checkStorageQuota(prisma, "u1", 11_000_000)).rejects.toBeInstanceOf(QuotaError);
  });
});