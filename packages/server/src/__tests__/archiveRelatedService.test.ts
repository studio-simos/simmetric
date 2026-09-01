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

import { computeRelatedCounts } from "../services/archiveRelatedService";
import prisma from "../utils/prisma";

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440199";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("archiveRelatedService.computeRelatedCounts", () => {
  it("returns empty map for an archive with no pages", async () => {
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);
    const counts = await computeRelatedCounts(ARCHIVE_ID);
    expect(counts).toEqual({});
  });

  it("returns empty map for an archive with a single page (nothing to relate to)", async () => {
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      { slug: "only-page", bodyText: "some text about a topic" },
    ]);
    const counts = await computeRelatedCounts(ARCHIVE_ID);
    expect(counts).toEqual({ "only-page": 0 });
  });

  it("counts same-topic page pairs as related and leaves off-topic pages at 0", async () => {
    // 5 pages, two same-topic pairs + one fully off-topic page. The adaptive
    // DF filter (>40% of pages) drops nothing relevant here because every
    // discriminating token lives in at most 2 of 5 pages. With only 5 pages
    // the DF filter is aggressive (>2 pages), so we keep rely-tokens rare.
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        slug: "usereducer-basics",
        bodyText:
          "reducer dispatch action state transition pure function pattern hook",
      },
      {
        slug: "usereducer-advanced",
        bodyText:
          "reducer dispatch action state transition pure function pattern variant",
      },
      {
        slug: "jsx-intro",
        bodyText: "markup syntax extension element tree render declaration",
      },
      {
        slug: "jsx-deep-dive",
        bodyText: "markup syntax extension element render virtualdom tree",
      },
      {
        slug: "weather-forecast",
        bodyText: "weather climate forecast rain precipitation temperature atmosphere",
      },
    ]);

    const counts = await computeRelatedCounts(ARCHIVE_ID);

    // Same-topic pairs are mutually related.
    expect(counts["usereducer-basics"]).toBe(1);
    expect(counts["usereducer-advanced"]).toBe(1);
    expect(counts["jsx-intro"]).toBe(1);
    expect(counts["jsx-deep-dive"]).toBe(1);
    // The off-topic page has no related neighbor.
    expect(counts["weather-forecast"]).toBe(0);
  });

  it("does not relate pages whose only shared tokens are archive-ubiquitous", async () => {
    // Two pages that share ONLY the word "component" (appearing in BOTH
    // pages = 100% of pages → dropped by the adaptive DF filter). With the
    // ubiquitous token removed, their discriminating sets are disjoint →
    // not related.
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        slug: "page-alpha",
        bodyText: "component component component component",
      },
      {
        slug: "page-beta",
        bodyText: "component component component component",
      },
    ]);

    const counts = await computeRelatedCounts(ARCHIVE_ID);

    // "component" is in 100% of pages → filtered out → no discriminating
    // overlap → not related.
    expect(counts["page-alpha"]).toBe(0);
    expect(counts["page-beta"]).toBe(0);
  });
});