// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

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

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { getMaintenanceSuggestions, type MergeSuggestion } from "../services/archiveMaintenanceService";
import prisma from "../utils/prisma";

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("archiveMaintenanceService", () => {
  describe("getMaintenanceSuggestions", () => {
    it("should return { suggestions, mergeSuggestions } with backward-compat suggestions array", async () => {
      (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);

      const result = await getMaintenanceSuggestions("test-workspace-id", ARCHIVE_ID);

      expect(result).toHaveProperty("suggestions");
      expect(result).toHaveProperty("mergeSuggestions");
      expect(Array.isArray(result.suggestions)).toBe(true);
      expect(Array.isArray(result.mergeSuggestions)).toBe(true);
    });

    it("should return empty arrays when archive has no pages", async () => {
      (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);

      const { suggestions, mergeSuggestions } = await getMaintenanceSuggestions(
        "test-workspace-id",
        ARCHIVE_ID,
      );
      expect(suggestions).toEqual([]);
      expect(mergeSuggestions).toEqual([]);
    });

    it("mergeSuggestions: title-normalized match detects duplicate pages", async () => {
      // Two pages whose normalized titles are identical ("cafe-corp").
      // First findMany (stale) returns [] so the stale loop is a no-op; the
      // second findMany (redlink+merge scan) returns the fixture pair.
      (prisma.archivePage.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // stale scan
        .mockResolvedValueOnce([
          {
            slug: "acme-cafe",
            title: "Café Corp",
            wikilinks: [],
            bodyText: "Some body text about coffee.",
          },
          {
            slug: "acme-cafe-2",
            title: "Cafe Corp",
            wikilinks: [],
            bodyText: "Different body text entirely.",
          },
        ]);
      (prisma.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);

      const { mergeSuggestions } = await getMaintenanceSuggestions("ws", ARCHIVE_ID);

      expect(mergeSuggestions).toHaveLength(1);
      const suggestion = mergeSuggestions[0] as MergeSuggestion;
      expect(suggestion.reason).toBe("title-normalized");
      expect(suggestion.pageA).toBe("acme-cafe");
      expect(suggestion.pageB).toBe("acme-cafe-2");
      expect(suggestion.similarity).toBeGreaterThan(0);
    });

    it("mergeSuggestions: content-overlap detects pages with shared wikilinks/body tokens", async () => {
      // Titles differ enough to NOT trigger title-normalized, but they share
      // wikilinks and body tokens above the Jaccard thresholds.
      const sharedLinks = ["shared-target", "another-shared", "third-shared"];
      (prisma.archivePage.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // stale scan
        .mockResolvedValueOnce([
          {
            slug: "page-alpha",
            title: "Alpha Subject",
            wikilinks: sharedLinks,
            bodyText: "enterprise software platform architecture strategy roadmap",
          },
          {
            slug: "page-beta",
            title: "Beta Subject",
            wikilinks: sharedLinks,
            bodyText: "enterprise software platform architecture strategy roadmap",
          },
        ]);
      (prisma.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);

      const { mergeSuggestions } = await getMaintenanceSuggestions("ws", ARCHIVE_ID);

      expect(mergeSuggestions).toHaveLength(1);
      const suggestion = mergeSuggestions[0] as MergeSuggestion;
      expect(suggestion.reason).toBe("content-overlap");
      expect(suggestion.pageA).toBe("page-alpha");
      expect(suggestion.pageB).toBe("page-beta");
      expect(suggestion.similarity).toBeGreaterThanOrEqual(0.4);
    });

    it("mergeSuggestions: pages with no duplicates produce no mergeSuggestions", async () => {
      (prisma.archivePage.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // stale scan
        .mockResolvedValueOnce([
          {
            slug: "unique-page-a",
            title: "Completely Unique Topic Alpha",
            wikilinks: ["unique-link-a"],
            bodyText: "alpha phenomenon discovery research manuscript",
          },
          {
            slug: "unique-page-b",
            title: "Totally Different Subject Beta",
            wikilinks: ["unique-link-b"],
            bodyText: "beta manufacturing logistics inventory procurement",
          },
        ]);
      (prisma.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);

      const { mergeSuggestions } = await getMaintenanceSuggestions("ws", ARCHIVE_ID);
      expect(mergeSuggestions).toEqual([]);
    });
  });
});