// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { detectOrphanPages, detectBrokenWikilinks } from "../services/synthesisOrphanService";

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    archivePage: {
      findMany: jest.fn(),
    },
  },
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import prisma from "../utils/prisma";

// Helper to create mock archive page data
function makePage(overrides: Partial<{
  id: string;
  archiveId: string;
  slug: string;
  title: string;
  category: string;
  bodyText: string;
  wikilinks: string[];
}> = {}): any {
  return {
    id: overrides.id || "page-1",
    archiveId: overrides.archiveId || "archive-1",
    slug: overrides.slug || "test-page",
    title: overrides.title || "Test Page",
    category: overrides.category || "entities",
    bodyText: overrides.bodyText || "This is test content.",
    wikilinks: overrides.wikilinks || [],
  };
}

describe("synthesisOrphanService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // detectOrphanPages
  // =========================================================================

  it("returns pages with empty wikilinks array and no incoming references", async () => {
    const pages = [
      makePage({ slug: "orphan-a", wikilinks: [], bodyText: "Orphan content." }),
      makePage({ slug: "linked-b", wikilinks: ["other-page"], bodyText: "Linked content." }),
    ];

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await detectOrphanPages("archive-1");

    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe("orphan-a");
  });

  it("excludes pages that have incoming references via standard Markdown links", async () => {
    const pages = [
      makePage({ slug: "orphan-a", wikilinks: [], bodyText: "Orphan content." }),
      makePage({
        slug: "referrer-b",
        wikilinks: [],
        bodyText: "See [orphan page](orphan-a.md) for details.",
      }),
    ];

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await detectOrphanPages("archive-1");

    // orphan-a is NOT orphaned because referrer-b links to it via [text](orphan-a.md)
    expect(result.find((r) => r.slug === "orphan-a")).toBeUndefined();
  });

  it("excludes _index.md and log.md system pages", async () => {
    const pages = [
      makePage({ slug: "_index", wikilinks: [], bodyText: "Index page." }),
      makePage({ slug: "log", wikilinks: [], bodyText: "Log page." }),
      makePage({ slug: "real-orphan", wikilinks: [], bodyText: "Real orphan." }),
    ];

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await detectOrphanPages("archive-1");

    // _index and log should be excluded, only real-orphan should remain
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe("real-orphan");
  });

  it("returns empty array when all pages are cross-linked", async () => {
    const pages = [
      makePage({ slug: "page-a", wikilinks: ["page-b"], bodyText: "Content A." }),
      makePage({ slug: "page-b", wikilinks: ["page-a"], bodyText: "Content B." }),
      makePage({ slug: "page-c", wikilinks: ["page-a"], bodyText: "Content C." }),
    ];

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await detectOrphanPages("archive-1");

    expect(result).toEqual([]);
  });

  // =========================================================================
  // detectBrokenWikilinks
  // =========================================================================

  it("finds wikilinks pointing to non-existent page slugs", async () => {
    const pages = [
      makePage({ slug: "page-a", wikilinks: ["page-b", "non-existent-x"], bodyText: "Content A." }),
      makePage({ slug: "page-b", wikilinks: [], bodyText: "Content B." }),
    ];

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await detectBrokenWikilinks("archive-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourcePageSlug: "page-a",
      brokenTarget: "non-existent-x",
    });
  });

  it("returns empty array when all wikilinks resolve to existing pages", async () => {
    const pages = [
      makePage({ slug: "page-a", wikilinks: ["page-b", "page-c"], bodyText: "Content A." }),
      makePage({ slug: "page-b", wikilinks: ["page-a"], bodyText: "Content B." }),
      makePage({ slug: "page-c", wikilinks: [], bodyText: "Content C." }),
    ];

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await detectBrokenWikilinks("archive-1");

    expect(result).toEqual([]);
  });
});
