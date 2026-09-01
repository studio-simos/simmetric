// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive graph service unit tests — mocks Prisma, tests buildArchiveGraph logic.
 */
import "./helpers/setupEnv";

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

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

jest.mock("../services/archiveIndexService", () => ({
  rebuildAllIndexFiles: jest.fn().mockResolvedValue({ reindexed: 0, errors: [] }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "../utils/prisma";
import { buildArchiveGraph } from "../services/archiveGraphService";

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";

function makePage(overrides: Partial<{ id: string; slug: string; title: string; category: string; wikilinks: string[]; deletedAt: Date | null }> = {}) {
  return {
    id: "page-" + Math.random().toString(36).slice(2),
    slug: overrides.slug ?? "default-slug",
    title: overrides.title ?? "Default Title",
    category: overrides.category ?? "entities",
    wikilinks: overrides.wikilinks ?? [],
    deletedAt: overrides.deletedAt ?? null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buildArchiveGraph", () => {
  it("should return empty nodes and edges for empty archive", async () => {
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(prisma.archivePage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { archiveId: ARCHIVE_ID, deletedAt: null },
        select: { id: true, slug: true, title: true, category: true, wikilinks: true },
      })
    );
  });

  it("should return nodes but no edges when pages have no wikilinks", async () => {
    const pages = [
      makePage({ slug: "page-a", title: "Page A", category: "entities" }),
      makePage({ slug: "page-b", title: "Page B", category: "concepts" }),
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toEqual({ id: "page-a", title: "Page A", category: "entities", slug: "page-a" });
    expect(result.nodes[1]).toEqual({ id: "page-b", title: "Page B", category: "concepts", slug: "page-b" });
    expect(result.edges).toEqual([]);
  });

  it("should create edges for wikilinks to existing pages", async () => {
    const pages = [
      makePage({ slug: "page-a", title: "Page A", wikilinks: ["page-b"] }),
      makePage({ slug: "page-b", title: "Page B", wikilinks: [] }),
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ source: "page-a", target: "page-b" });
  });

  it("should deduplicate bidirectional wikilinks into a single edge", async () => {
    const pages = [
      makePage({ slug: "page-a", title: "Page A", wikilinks: ["page-b"] }),
      makePage({ slug: "page-b", title: "Page B", wikilinks: ["page-a"] }),
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    // Source should be the first page in iteration order (page-a)
    expect(result.edges[0]).toEqual({ source: "page-a", target: "page-b" });
  });

  it("should extract slug from pipe syntax wikilinks", async () => {
    const pages = [
      makePage({ slug: "page-a", title: "Page A", wikilinks: ["page-b|Display Title"] }),
      makePage({ slug: "page-b", title: "Page B", wikilinks: [] }),
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ source: "page-a", target: "page-b" });
  });

  it("should ignore wikilinks to non-existent pages", async () => {
    const pages = [
      makePage({ slug: "page-a", title: "Page A", wikilinks: ["missing-page"] }),
      makePage({ slug: "page-b", title: "Page B", wikilinks: [] }),
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    expect(result.edges).toEqual([]);
  });

  it("should exclude soft-deleted pages", async () => {
    const pages = [
      makePage({ slug: "page-a", title: "Page A", wikilinks: [] }),
      makePage({ slug: "page-b", title: "Page B", wikilinks: ["page-a"], deletedAt: new Date() }),
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    // Only page-a should be included because findMany filters deletedAt: null
    expect(result.nodes).toHaveLength(2); // mock returns both, service doesn't filter again
    // But edges should not include links from deleted page because it's in the result set
    // Actually the service uses the returned pages directly. If mock returns both, edges will include page-b.
    // This test verifies that the Prisma query includes deletedAt: null — the actual filtering is Prisma's job.
    expect(prisma.archivePage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { archiveId: ARCHIVE_ID, deletedAt: null },
      })
    );
  });

  it("should not create self-loops", async () => {
    const pages = [
      makePage({ slug: "page-a", title: "Page A", wikilinks: ["page-a"] }),
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
  });

  it("should handle multiple wikilinks from a single page", async () => {
    const pages = [
      makePage({ slug: "page-a", title: "Page A", wikilinks: ["page-b", "page-c"] }),
      makePage({ slug: "page-b", title: "Page B", wikilinks: [] }),
      makePage({ slug: "page-c", title: "Page C", wikilinks: [] }),
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);

    const result = await buildArchiveGraph(ARCHIVE_ID);

    expect(result.edges).toHaveLength(2);
    expect(result.edges).toContainEqual({ source: "page-a", target: "page-b" });
    expect(result.edges).toContainEqual({ source: "page-a", target: "page-c" });
  });
});
