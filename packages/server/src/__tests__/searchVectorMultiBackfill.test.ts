// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for searchVectorMultiBackfill (Phase 151, RAG-01).
 *
 * Covers:
 *  - idempotency: loop terminates when a batch returns 0 rows
 *  - batching: each UPDATE is bounded by LIMIT 500
 *  - the WHERE guard: `"searchVectorMulti" IS NULL`
 *  - soft-delete alignment: archive_pages loop filters `"deletedAt" IS NULL`
 *  - the multi-config expression is the shared MULTI_CONFIG_TSVECTOR fragment
 *  - result accumulation: { chunks, pages } counts
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import prisma from "../utils/prisma";
import { backfillSearchVectorMulti } from "../services/searchVectorMultiBackfill";
import { MULTI_CONFIG_TSVECTOR } from "../services/ftsService";

describe("backfillSearchVectorMulti", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("terminates when a batch returns 0 rows and accumulates counts", async () => {
    // chunks: 500, 500, 0 → 1000; pages: 500, 0 → 500
    (prisma.$executeRaw as jest.Mock)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(0);

    const result = await backfillSearchVectorMulti();

    expect(result).toEqual({ chunks: 1000, pages: 500 });
    // 3 chunk batches + 2 page batches
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(5);
  });

  it("is a no-op when nothing needs backfilling", async () => {
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(0);

    const result = await backfillSearchVectorMulti();

    expect(result).toEqual({ chunks: 0, pages: 0 });
    // one probe per table, then stop
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("guards every UPDATE with the IS NULL predicate and LIMIT 500", async () => {
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(0);

    await backfillSearchVectorMulti();

    const calls = (prisma.$executeRaw as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);

    for (const call of calls) {
      // Prisma 7 tagged template: (strings[], ...values)
      const sqlSegments = call[0] as string[];
      const sql = sqlSegments.join("?");
      expect(sql).toContain('"searchVectorMulti" IS NULL');
      expect(sql).toContain("LIMIT ?");
      // The batch size is the last interpolated value (500).
      const values = call.slice(1);
      expect(values).toContain(500);
    }
  });

  it("filters tombstoned pages in the archive_pages loop (soft-delete alignment)", async () => {
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(0);

    await backfillSearchVectorMulti();

    const calls = (prisma.$executeRaw as jest.Mock).mock.calls;
    // call[0] = chunks loop, call[1] = pages loop
    const pagesSql = (calls[1][0] as string[]).join("?");
    expect(pagesSql).toContain('"deletedAt" IS NULL');
    expect(pagesSql).toContain('UPDATE "archive_pages"');
  });

  it("uses the shared MULTI_CONFIG_TSVECTOR fragment in both loops", async () => {
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(0);

    await backfillSearchVectorMulti();

    const calls = (prisma.$executeRaw as jest.Mock).mock.calls;
    for (const call of calls) {
      // The fragment is embedded via Prisma.raw — it arrives as an
      // interpolation value (an object with `strings`/`values`), not as
      // SQL text in the template strings.
      const values = call.slice(1);
      const fragment = values.find(
        (v: unknown) =>
          typeof v === "object" &&
          v !== null &&
          Array.isArray((v as { strings?: unknown }).strings),
      ) as { strings: string[] } | undefined;
      expect(fragment).toBeDefined();
      const fragmentSql = fragment!.strings.join("?");
      expect(fragmentSql).toContain("to_tsvector('english', t)");
      expect(fragmentSql).toContain("to_tsvector('italian', t)");
      expect(fragmentSql).toContain("to_tsvector('simple', t)");
    }
    // Sanity: the fragment itself is the 7-config concat.
    expect(MULTI_CONFIG_TSVECTOR).toContain("to_tsvector('russian', t)");
  });
});
