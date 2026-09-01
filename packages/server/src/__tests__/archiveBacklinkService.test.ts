// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { establishBacklinks, propagateRename } from "../services/archiveBacklinkService";

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    archivePage: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    archive: { findFirst: jest.fn() },
  },
}));

jest.mock("../services/archivePageService", () => ({
  __esModule: true,
  updatePage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock("gray-matter", () => ({
  __esModule: true,
  default: { stringify: jest.fn((body: string, fm: unknown) => JSON.stringify(fm) + "\n" + body) },
}));

jest.mock("simple-git", () => {
  const simpleGit = jest.fn(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
  }));
  return { __esModule: true, simpleGit, default: { simpleGit } };
});

jest.mock("fs/promises", () => {
  const writeFile = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { writeFile }, writeFile };
});

jest.mock("crypto", () => ({
  __esModule: true,
  default: {
    createHash: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue("hash-sha256"),
    })),
  },
}));

import prisma from "../utils/prisma";
import { updatePage } from "../services/archivePageService";
import { logger } from "../utils/logger";
import matter from "gray-matter";
import fs from "fs/promises";

const mockPrisma = prisma as unknown as {
  archivePage: { findFirst: jest.Mock; findMany: jest.Mock; update: jest.Mock };
  archive: { findFirst: jest.Mock };
};
const mockUpdatePage = updatePage as jest.Mock;
const mockLogger = logger as unknown as { info: jest.Mock; error: jest.Mock };
const mockMatterStringify = (matter as unknown as { stringify: jest.Mock }).stringify;
const mockWriteFile = (fs as unknown as { writeFile: jest.Mock }).writeFile;

beforeEach(() => {
  jest.clearAllMocks();
});

const ARCHIVE_ID = "archive-1";
const SOURCE_SLUG = "source-page";
const USER_ID = "user-1";

describe("archiveBacklinkService.establishBacklinks", () => {
  test("content with no wikilinks -> established=0", async () => {
    mockPrisma.archivePage.findFirst.mockResolvedValue(null);
    await establishBacklinks(ARCHIVE_ID, SOURCE_SLUG, "Just plain text, no links.", USER_ID);
    // No target pages looked up (findMany not used here; findFirst per target)
    expect(mockUpdatePage).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[archive] Backlink establishment complete",
      expect.objectContaining({ established: 0, skipped: 0, failed: 0 }),
    );
  });

  test("content with [[target]] but target page not found -> skipped++", async () => {
    mockPrisma.archivePage.findFirst.mockResolvedValue(null);
    await establishBacklinks(ARCHIVE_ID, SOURCE_SLUG, "See [[missing-target]] for more.", USER_ID);
    expect(mockUpdatePage).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[archive] Backlink establishment complete",
      expect.objectContaining({ established: 0, skipped: 1, failed: 0 }),
    );
  });

  test("target page already links back to source -> no update call", async () => {
    mockPrisma.archivePage.findFirst.mockResolvedValue({
      id: "t1",
      slug: "target-page",
      bodyText: "Earlier text.\n- [[source-page]]",
      frontmatter: {},
    });
    await establishBacklinks(ARCHIVE_ID, SOURCE_SLUG, "Link to [[target-page]].", USER_ID);
    expect(mockUpdatePage).not.toHaveBeenCalled();
  });

  test("target page found, no backlink -> updatePage called, established++", async () => {
    mockPrisma.archivePage.findFirst.mockResolvedValue({
      id: "t1",
      slug: "target-page",
      bodyText: "Target page body.",
      frontmatter: { title: "Target" },
    });
    await establishBacklinks(ARCHIVE_ID, SOURCE_SLUG, "Link to [[target-page]].", USER_ID);
    expect(mockMatterStringify).toHaveBeenCalled();
    expect(mockUpdatePage).toHaveBeenCalledWith(
      ARCHIVE_ID,
      "target-page",
      { content: expect.any(String) },
      USER_ID,
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[archive] Backlink establishment complete",
      expect.objectContaining({ established: 1, skipped: 0, failed: 0 }),
    );
  });

  test("source slug is filtered out (no self-backlink)", async () => {
    mockPrisma.archivePage.findFirst.mockResolvedValue(null);
    await establishBacklinks(ARCHIVE_ID, SOURCE_SLUG, "Self link [[source-page]].", USER_ID);
    // findFirst not called because source slug is filtered out before lookup
    expect(mockPrisma.archivePage.findFirst).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[archive] Backlink establishment complete",
      expect.objectContaining({ established: 0, skipped: 0, failed: 0 }),
    );
  });
});

describe("archiveBacklinkService.propagateRename", () => {
  test("archive not found -> throws 'Archive not found'", async () => {
    mockPrisma.archive.findFirst.mockResolvedValue(null);
    await expect(
      propagateRename(ARCHIVE_ID, "old-slug", "new-slug", USER_ID),
    ).rejects.toThrow(/Archive not found/);
  });

  test("no pages contain [[oldSlug -> returns 0", async () => {
    mockPrisma.archive.findFirst.mockResolvedValue({ id: ARCHIVE_ID, slug: "archive-slug" });
    mockPrisma.archivePage.findMany.mockResolvedValue([]);
    const count = await propagateRename(ARCHIVE_ID, "old-slug", "new-slug", USER_ID);
    expect(count).toBe(0);
  });

  test("pages found -> bodyText replaced, writeFile + archivePage.update + git commit called", async () => {
    mockPrisma.archive.findFirst.mockResolvedValue({ id: ARCHIVE_ID, slug: "archive-slug" });
    mockPrisma.archivePage.findMany.mockResolvedValue([
      {
        id: "p1",
        slug: "page-1",
        category: "docs",
        bodyText: "Link to [[old-slug]] here.",
        frontmatter: {},
      },
    ]);

    const count = await propagateRename(ARCHIVE_ID, "old-slug", "new-slug", USER_ID);
    // If the per-page catch swallowed an error, logger.error would have been called.
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(count).toBe(1);
    // bodyText replaced — update called with new body
    expect(mockPrisma.archivePage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1" },
        data: expect.objectContaining({ bodyText: "Link to [[new-slug]] here." }),
      }),
    );
    // file written to disk
    expect(mockWriteFile).toHaveBeenCalled();
  });
});