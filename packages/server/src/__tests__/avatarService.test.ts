// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck
import { AVATAR_SIZES, AVATAR_MAX_SIZE, avatarUpload, resizeAvatar, deleteOldAvatars, removeAvatarFiles } from "../services/avatarService";

jest.mock("sharp", () => {
  const chain = {
    resize: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
    toFile: jest.fn().mockResolvedValue(undefined),
  };
  return jest.fn(() => chain);
});

jest.mock("fs", () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

// Phase 184 (D-03): avatar bytes ride the StorageProvider — the shared mock
// surface keeps the hoisted factory and the per-test handles in sync.
jest.mock("../services/storageProvider", () =>
  require("./helpers/mockStorageProvider").mockStorageProviderModule,
);

// resolveUserOrgId looks up the user's live OrganizationMember row (User is
// identity-pure per Phase 182 D-01) — mock the prisma singleton.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    organizationMember: { findFirst: jest.fn() },
  },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import sharp from "sharp";
import fs from "fs";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import { DEFAULT_ORG_ID } from "@simmetric-chat/shared";
import { mockProviderPut, mockProviderDelete, mockGetStorageProvider } from "./helpers/mockStorageProvider";

const mockSharp = sharp as unknown as jest.Mock;
const mockFs = fs as unknown as {
  mkdirSync: jest.Mock;
  existsSync: jest.Mock;
  unlinkSync: jest.Mock;
};
const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
const mockMembershipFindFirst = prisma.organizationMember.findFirst as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no live membership row → default-org fallback (air-gap root).
  mockMembershipFindFirst.mockResolvedValue(null);
});

describe("avatarService constants", () => {
  test("AVATAR_SIZES is [32, 64, 128]", () => {
    expect(AVATAR_SIZES).toEqual([32, 64, 128]);
  });

  test("AVATAR_MAX_SIZE is 512KB", () => {
    expect(AVATAR_MAX_SIZE).toBe(512 * 1024);
  });
});

describe("avatarUpload.fileFilter", () => {
  function callFilter(mimetype: string): { ok: boolean; error?: string } {
    let err: Error | null = null;
    let accepted: boolean | null = null;
    avatarUpload.fileFilter(
      {} as Express.Request,
      { mimetype } as Express.Multer.File,
      (e, a) => {
        err = e;
        accepted = a;
      },
    );
    if (err) return { ok: false, error: err.message };
    return { ok: accepted === true };
  }

  test("accepts image/jpeg, image/png, image/webp, image/gif", () => {
    expect(callFilter("image/jpeg").ok).toBe(true);
    expect(callFilter("image/png").ok).toBe(true);
    expect(callFilter("image/webp").ok).toBe(true);
    expect(callFilter("image/gif").ok).toBe(true);
  });

  test("rejects non-image mimetypes", () => {
    const res = callFilter("text/plain");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unsupported file type/);
  });
});

describe("resizeAvatar (D-03 resize→put)", () => {
  test("calls sharp chain for each size, puts ×3 through the provider, returns primary path", async () => {
    const chain = mockSharp() as { resize: jest.Mock; webp: jest.Mock; toFile: jest.Mock };
    mockSharp.mockClear();
    chain.resize.mockClear();
    chain.toFile.mockClear();
    mockProviderPut.mockClear();

    const primaryPath = await resizeAvatar("/tmp/input.webp", "user-42", "org-abc");

    // sharp called once per size
    expect(mockSharp).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    // mkdirSync called once per size (3 sizes)
    expect(mockFs.mkdirSync).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    // toFile called once per size (via chain)
    expect(chain.toFile).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    // put called ×3 with row's-org keys {orgId}/avatars/{size}/{filename}.webp
    expect(mockProviderPut).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    const putKeys = mockProviderPut.mock.calls.map((c) => c[1]);
    const timestamp = putKeys[0].match(/user-42-(\d+)\.webp/)?.[1];
    expect(putKeys).toEqual([
      `org-abc/avatars/32/user-42-${timestamp}.webp`,
      `org-abc/avatars/64/user-42-${timestamp}.webp`,
      `org-abc/avatars/128/user-42-${timestamp}.webp`,
    ]);
    // provider resolved ONCE per upload with the passed org
    expect(mockGetStorageProvider).toHaveBeenCalledTimes(1);
    expect(mockGetStorageProvider).toHaveBeenCalledWith("org-abc");
    // temp input unlinked AFTER the puts (ingress cleanup post-put)
    expect(mockFs.unlinkSync).toHaveBeenCalledWith("/tmp/input.webp");
    const firstPutOrder = mockProviderPut.mock.invocationCallOrder[0];
    const unlinkOrder = mockFs.unlinkSync.mock.invocationCallOrder[0];
    expect(unlinkOrder).toBeGreaterThan(firstPutOrder);
    // primary path uses the 128 size (URL shape unchanged — A2)
    expect(primaryPath).toMatch(/^\/avatars\/128\/user-42-\d+\.webp$/);
  });

  test("each put happens AFTER that size's toFile (resize rides the local tmp first)", async () => {
    const chain = mockSharp() as { resize: jest.Mock; webp: jest.Mock; toFile: jest.Mock };
    mockProviderPut.mockClear();
    chain.toFile.mockClear();

    await resizeAvatar("/tmp/input.webp", "user-42", "org-abc");

    // The first put's invocation must follow the first toFile's — the webp
    // exists on local tmp before the provider copy starts.
    const firstToFileOrder = chain.toFile.mock.invocationCallOrder[0];
    const firstPutOrder = mockProviderPut.mock.invocationCallOrder[0];
    expect(firstPutOrder).toBeGreaterThan(firstToFileOrder);
  });

  test("org resolution: passed organizationId wins; membership lookup next; default-org fallback last", async () => {
    mockMembershipFindFirst.mockResolvedValue({ organizationId: "org-from-row" });

    // 1. Explicit org wins — no lookup
    await resizeAvatar("/tmp/a.webp", "user-1", "org-explicit");
    expect(mockGetStorageProvider).toHaveBeenLastCalledWith("org-explicit");
    expect(mockMembershipFindFirst).not.toHaveBeenCalled();

    // 2. No org passed → live membership row's org (row's-org rule)
    await resizeAvatar("/tmp/b.webp", "user-1");
    expect(mockMembershipFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", deletedAt: null } }),
    );
    expect(mockGetStorageProvider).toHaveBeenLastCalledWith("org-from-row");

    // 3. Lookup misses → default-org fallback (air-gap tenancy root)
    mockMembershipFindFirst.mockResolvedValue(null);
    await resizeAvatar("/tmp/c.webp", "user-1");
    expect(mockGetStorageProvider).toHaveBeenLastCalledWith(DEFAULT_ORG_ID);

    // 4. Lookup throws → default-org fallback (never crashes the upload)
    mockMembershipFindFirst.mockRejectedValue(new Error("db down"));
    await resizeAvatar("/tmp/d.webp", "user-1");
    expect(mockGetStorageProvider).toHaveBeenLastCalledWith(DEFAULT_ORG_ID);
  });

  test("failure probe: sharp throws mid-resize → reject BEFORE all puts, tmp kept, no cleanup (order invariant)", async () => {
    const chain = mockSharp() as { resize: jest.Mock; webp: jest.Mock; toFile: jest.Mock };
    mockProviderPut.mockClear();
    mockFs.unlinkSync.mockClear();
    // toFile succeeds for the first size, throws for the second
    chain.toFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("sharp boom"));

    await expect(resizeAvatar("/tmp/input.webp", "user-42", "org-abc")).rejects.toThrow("sharp boom");

    // Only the completed first size was put (intermediate state stays servable);
    // the row update at the route level can never be reached (resize rejects first).
    expect(mockProviderPut).toHaveBeenCalledTimes(1);
    expect(mockProviderPut.mock.calls[0][1]).toMatch(/^org-abc\/avatars\/32\//);
    // tmp NOT unlinked on failure — the input stays for a retried upload
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  test("failure probe: provider.put throws → reject propagates (row stays un-updated upstream)", async () => {
    mockProviderPut.mockClear();
    mockFs.unlinkSync.mockClear();
    mockProviderPut.mockRejectedValueOnce(new Error("s3 down"));

    await expect(resizeAvatar("/tmp/input.webp", "user-42", "org-abc")).rejects.toThrow("s3 down");

    // First put failed → loop aborted before any later size; tmp cleanup skipped
    expect(mockProviderPut).toHaveBeenCalledTimes(1);
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("removeAvatarFiles", () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockFs.unlinkSync.mockClear();
    mockFs.existsSync.mockClear();
    mockProviderDelete.mockClear();
  });

  test("path traversal guard: rejects paths not starting with /avatars/ (T-19-06 intact)", async () => {
    await removeAvatarFiles("/etc/passwd");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to remove avatar"),
    );
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    expect(mockProviderDelete).not.toHaveBeenCalled();
  });

  test("D-03 provider arm: deletes new-layout keys {orgId}/avatars/{size}/{filename} for the user's org", async () => {
    mockMembershipFindFirst.mockResolvedValue({ organizationId: "org-row" });
    mockFs.existsSync.mockReturnValue(false);

    await removeAvatarFiles("/avatars/128/uuid-1-1700000000.webp");

    expect(mockMembershipFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "uuid-1", deletedAt: null } }),
    );
    expect(mockProviderDelete).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    expect(mockProviderDelete.mock.calls.map((c) => c[0])).toEqual([
      "org-row/avatars/32/uuid-1-1700000000.webp",
      "org-row/avatars/64/uuid-1-1700000000.webp",
      "org-row/avatars/128/uuid-1-1700000000.webp",
    ]);
  });

  test("D-03 fs fallback arm: legacy physical files still unlinked after the provider arm", async () => {
    mockFs.existsSync.mockReturnValue(true);

    await removeAvatarFiles("/avatars/128/user-1-1.webp");

    // fs arm ran for all sizes (legacy pre-phase bytes)
    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    // provider arm ran first (userId prefix "user-1" → default org fallback)
    const firstDeleteOrder = mockProviderDelete.mock.invocationCallOrder[0];
    const firstUnlinkOrder = mockFs.unlinkSync.mock.invocationCallOrder[0];
    expect(firstDeleteOrder).toBeLessThan(firstUnlinkOrder);
    expect(mockLogger.info).toHaveBeenCalled();
  });

  test("missing files (existsSync false) are not unlinked", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await removeAvatarFiles("/avatars/128/user-1-1.webp");
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  test("provider resolution failure never breaks the fs arm (best-effort cleanup)", async () => {
    mockGetStorageProvider.mockRejectedValueOnce(new Error("config incomplete"));
    mockFs.existsSync.mockReturnValue(true);

    await expect(removeAvatarFiles("/avatars/128/user-1-1.webp")).resolves.toBeUndefined();

    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(AVATAR_SIZES.length);
  });
});

describe("deleteOldAvatars", () => {
  beforeEach(() => {
    mockProviderDelete.mockClear();
    mockFs.unlinkSync.mockClear();
    mockFs.existsSync.mockClear();
  });

  test("best-effort: does not throw on missing files, no unlink", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await expect(deleteOldAvatars("/avatars/128/user-1-1.webp")).resolves.toBeUndefined();
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  test("deletes existing files for all sizes (fs arm) plus the provider keys (D-03)", async () => {
    mockFs.existsSync.mockReturnValue(true);
    await deleteOldAvatars("/avatars/128/user-1-1.webp");
    // fs arm: legacy physical files removed
    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    // provider arm: new-layout keys removed for the resolved org
    expect(mockProviderDelete).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    expect(mockProviderDelete.mock.calls[0][0]).toMatch(/^00000000-0000-0000-0000-000000000000\/avatars\/32\/user-1-1\.webp$/);
  });

  test("provider delete failures are best-effort (fs arm still runs, never throws)", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockProviderDelete.mockRejectedValue(new Error("network"));

    await expect(deleteOldAvatars("/avatars/128/user-1-1.webp")).resolves.toBeUndefined();
    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(AVATAR_SIZES.length);
  });
});