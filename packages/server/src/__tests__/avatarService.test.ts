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

jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import sharp from "sharp";
import fs from "fs";
import { logger } from "../utils/logger";

const mockSharp = sharp as unknown as jest.Mock;
const mockFs = fs as unknown as {
  mkdirSync: jest.Mock;
  existsSync: jest.Mock;
  unlinkSync: jest.Mock;
};
const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
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

describe("resizeAvatar", () => {
  test("calls sharp chain for each size and returns primary path", async () => {
    const chain = mockSharp() as { resize: jest.Mock; webp: jest.Mock; toFile: jest.Mock };
    mockSharp.mockClear();
    chain.resize.mockClear();
    chain.toFile.mockClear();

    const primaryPath = await resizeAvatar("/tmp/input.webp", "user-42");

    // sharp called once per size
    expect(mockSharp).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    // mkdirSync called once per size (3 sizes)
    expect(mockFs.mkdirSync).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    // toFile called once per size (via chain)
    expect(chain.toFile).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    // temp input unlinked
    expect(mockFs.unlinkSync).toHaveBeenCalledWith("/tmp/input.webp");
    // primary path uses the 128 size
    expect(primaryPath).toMatch(/^\/avatars\/128\/user-42-\d+\.webp$/);
  });
});

describe("removeAvatarFiles", () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockFs.unlinkSync.mockClear();
    mockFs.existsSync.mockClear();
  });

  test("path traversal guard: rejects paths not starting with /avatars/", async () => {
    await removeAvatarFiles("/etc/passwd");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to remove avatar"),
    );
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  test("valid path: unlinks each existing size file", async () => {
    mockFs.existsSync.mockReturnValue(true);
    await removeAvatarFiles("/avatars/128/user-1-1.webp");
    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(AVATAR_SIZES.length);
    expect(mockLogger.info).toHaveBeenCalled();
  });

  test("missing files (existsSync false) are not unlinked", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await removeAvatarFiles("/avatars/128/user-1-1.webp");
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("deleteOldAvatars", () => {
  test("best-effort: does not throw on missing files, no unlink", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await expect(deleteOldAvatars("/avatars/128/user-1-1.webp")).resolves.toBeUndefined();
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  test("deletes existing files for all sizes", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.unlinkSync.mockClear();
    await deleteOldAvatars("/avatars/128/user-1-1.webp");
    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(AVATAR_SIZES.length);
  });
});