// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * wikiWriteService non-write behavioral test (D-03, WIKI-02).
 *
 * Asserts the AI write path (applyWikiEdit -> createPage/updatePage) NEVER
 * issues an fs.writeFile call whose path contains "raw_sources/". The
 * validateWritablePath guard (added in Task 1) is load-bearing: if it were
 * removed, the malicious-category case would reach fs.writeFile with a
 * raw_sources path and the assertion would fail.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/archiveIndexService", () => ({
  generateIndexFile: jest.fn().mockResolvedValue(undefined),
}));

import fs from "fs/promises";
import path from "path";
import { createPage } from "../services/archivePageService";
import { validateWritablePath } from "../utils/archivePath";
import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440102";
const PAGE_ID = "770e8400-e29b-41d4-a716-446655440103";
const now = new Date("2025-06-01T00:00:00.000Z");

const mockArchive = {
  id: ARCHIVE_ID,
  slug: "test-archive-ws",
  name: "Test Archive",
  description: "",
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

const mockPage = {
  id: PAGE_ID,
  archiveId: ARCHIVE_ID,
  slug: "foo-page",
  title: "Foo Page",
  bodyText: "Foo page body",
  bodyHtml: "",
  frontmatter: null,
  category: "entities",
  searchVector: null,
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

let writeFileSpy: jest.SpyInstance;
let mkdirSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.archive.findFirst as jest.Mock).mockResolvedValue(mockArchive);
  (prisma.archivePage.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.archivePage.create as jest.Mock).mockResolvedValue(mockPage);
  (logEvent as jest.Mock).mockResolvedValue(undefined);
  mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
  writeFileSpy = jest
    .spyOn(fs, "writeFile")
    .mockResolvedValue(undefined as never);
});

afterEach(() => {
  mkdirSpy.mockRestore();
  writeFileSpy.mockRestore();
});

describe("non-write: AI write path never touches raw_sources/", () => {
  it("createPage (AI write sink) writes to a wiki/ path on a legitimate request", async () => {
    await createPage(
      ARCHIVE_ID,
      {
        title: "Foo Page",
        content: "# Foo\n\nBody text",
        category: "entities",
      },
      "admin-001",
    );

    expect(writeFileSpy).toHaveBeenCalled();
    for (const call of writeFileSpy.mock.calls) {
      const target = String(call[0]);
      expect(target).toContain("wiki");
      expect(target).not.toContain("raw_sources");
    }
  });

  it("createPage with a traversal category (../raw_sources) is blocked by the guard — no fs.writeFile call reaches raw_sources", async () => {
    await expect(
      createPage(
        ARCHIVE_ID,
        {
          title: "Malicious",
          content: "# Malicious\n\nBody",
          category: "../raw_sources" as any,
        },
        "admin-001",
      ),
    ).rejects.toThrow(/outside wiki|traversal/i);

    // The guard threw before fs.writeFile — no write call was issued at all.
    expect(writeFileSpy).not.toHaveBeenCalled();
    // Sanity: no fs.writeFile call path contains raw_sources.
    for (const call of writeFileSpy.mock.calls) {
      const target = String(call[0]);
      expect(target).not.toContain("raw_sources");
    }
  });

  it("validateWritablePath directly rejects a raw_sources/ target (guard is load-bearing)", () => {
    expect(() =>
      validateWritablePath("/tmp/arch", "raw_sources/foo.md"),
    ).toThrow(/outside wiki/i);
  });
});