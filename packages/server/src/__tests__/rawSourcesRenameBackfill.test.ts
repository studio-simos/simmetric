// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * rawSourcesRenameBackfill tests — WIKI-02 D-02.
 *
 * Covers 4 behavior cases:
 *  1. First call on archive with raw/ and no raw_sources/ → renamed: 1
 *  2. Second call on same archive (raw_sources/ now exists) → skipped, renamed: 0 (idempotent)
 *  3. Archive with neither raw/ nor raw_sources/ → skipped, no error
 *  4. Per-archive fs.rename failure is caught, never throws (non-blocking)
 *
 * The service resolves ARCHIVES_BASE from process.cwd()/storage/archives at
 * import time. We create real on-disk archive dirs under that base using
 * unique slug prefixes and clean them up in afterEach.
 */
import "./helpers/setupEnv";
import fs from "fs/promises";
import path from "path";

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

import prisma from "../utils/prisma";
import { renameRawToRawSources } from "../services/rawSourcesRenameBackfill";

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage", "archives");
const TEST_PREFIX = "backfill-test-";

describe("rawSourcesRenameBackfill", () => {
  const createdSlugs: string[] = [];

  afterEach(async () => {
    for (const slug of createdSlugs) {
      await fs
        .rm(path.join(ARCHIVES_BASE, slug), { recursive: true, force: true })
        .catch(() => {});
    }
    createdSlugs.length = 0;
    jest.clearAllMocks();
  });

  async function makeArchiveDir(slug: string): Promise<string> {
    const dir = path.join(ARCHIVES_BASE, slug);
    await fs.mkdir(dir, { recursive: true });
    createdSlugs.push(slug);
    return dir;
  }

  it("renames legacy raw/ to raw_sources/ when raw_sources/ does not exist", async () => {
    const slug = `${TEST_PREFIX}a-${Date.now()}`;
    const archiveDir = await makeArchiveDir(slug);
    await fs.mkdir(path.join(archiveDir, "raw"), { recursive: true });
    await fs.writeFile(path.join(archiveDir, "raw", "note.md"), "hello");

    (prisma.archive.findMany as jest.Mock).mockResolvedValue([{ slug }]);

    const result = await renameRawToRawSources();

    expect(result.renamed).toBe(1);
    expect(result.skipped).toBe(0);
    await expect(fs.access(path.join(archiveDir, "raw"))).rejects.toThrow();
    const content = await fs.readFile(
      path.join(archiveDir, "raw_sources", "note.md"),
      "utf-8",
    );
    expect(content).toBe("hello");
  });

  it("is idempotent — second call skips when raw_sources/ already exists", async () => {
    const slug = `${TEST_PREFIX}b-${Date.now()}`;
    const archiveDir = await makeArchiveDir(slug);
    await fs.mkdir(path.join(archiveDir, "raw_sources"), { recursive: true });

    (prisma.archive.findMany as jest.Mock).mockResolvedValue([{ slug }]);

    const result = await renameRawToRawSources();

    expect(result.renamed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips when neither raw/ nor raw_sources/ exists (nothing to migrate)", async () => {
    const slug = `${TEST_PREFIX}c-${Date.now()}`;
    const archiveDir = await makeArchiveDir(slug);

    (prisma.archive.findMany as jest.Mock).mockResolvedValue([{ slug }]);

    const result = await renameRawToRawSources();

    expect(result.renamed).toBe(0);
    expect(result.skipped).toBe(1);
    await expect(fs.access(path.join(archiveDir, "raw_sources"))).rejects.toThrow();
  });

  it("never throws on per-archive fs.rename failure (non-blocking)", async () => {
    const slug = `${TEST_PREFIX}d-${Date.now()}`;
    const archiveDir = await makeArchiveDir(slug);
    await fs.mkdir(path.join(archiveDir, "raw"), { recursive: true });

    (prisma.archive.findMany as jest.Mock).mockResolvedValue([{ slug }]);

    // Sabotage fs.rename so it rejects — simulates EBUSY/EACCES. The service
    // must catch the error, log a warning, and continue (D-02 non-blocking).
    const renameSpy = jest
      .spyOn(fs, "rename")
      .mockRejectedValue(new Error("EBUSY: resource busy"));
    try {
      const result = await renameRawToRawSources();

      expect(result.renamed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(renameSpy).toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
    }
  });
});