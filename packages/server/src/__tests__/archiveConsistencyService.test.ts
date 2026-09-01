// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Consistency Service tests — wiki vector drift detection.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../services/wikiEmbeddingService", () => ({
  indexWikiPage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// G-131-17: getSetting returns no DB value → the service falls back to
// getEnv().VECTOR_DB_PROVIDER (unset in tests) → hard default "lancedb".
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: undefined }),
}));

// Phase 165 (Pattern 3): mock the jobQueue seam — getBoss/createQueue/schedule.
// The mock boundary is jobQueue, NOT pg-boss directly. The __mocks__/pg-boss.ts
// manual mock handles transitive ESM loads (Pitfall 6). Under @swc/jest the
// factory cannot reference outer variables, so it creates its own jest.fn()
// handles; tests retrieve them via the mocked imports below.
jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn(),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "../utils/prisma";
import { indexWikiPage } from "../services/wikiEmbeddingService";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { logger } from "../utils/logger";
import {
  runWikiConsistencyCheck,
  reindexDriftedPages,
  initWikiConsistencyScheduler,
} from "../services/archiveConsistencyService";

const mockGetBoss = getBoss as jest.Mock;
const mockCreateQueue = createQueue as jest.Mock;
const mockSchedule = schedule as jest.Mock;
const mockedLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const PAGE_ID = "660e8400-e29b-41d4-a716-446655440200";
const PAGE_SLUG = "acme-corporation";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runWikiConsistencyCheck", () => {
  it("should return no drift when vectorContentHash matches current hash", async () => {
    const bodyText = "ACME Corporation is a leading enterprise software company.";
    const contentHash = require("crypto")
      .createHash("sha256")
      .update(bodyText)
      .digest("hex");

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        id: PAGE_ID,
        slug: PAGE_SLUG,
        bodyText,
        contentHash,
        vectorContentHash: contentHash,
        vectorProvider: "lancedb",
        lastIndexedAt: new Date(),
      },
    ]);

    const results = await runWikiConsistencyCheck(ARCHIVE_ID);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      pageId: PAGE_ID,
      slug: PAGE_SLUG,
      drifted: false,
      currentHash: contentHash,
      indexedHash: contentHash,
    });
  });

  it("should detect drift when vectorContentHash differs", async () => {
    const bodyText = "ACME Corporation is a leading enterprise software company.";
    const currentHash = require("crypto")
      .createHash("sha256")
      .update(bodyText)
      .digest("hex");
    const oldHash = "oldhash1234567890abcdef1234567890abcdef12";

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        id: PAGE_ID,
        slug: PAGE_SLUG,
        bodyText,
        contentHash: currentHash,
        vectorContentHash: oldHash,
        lastIndexedAt: new Date(),
      },
    ]);

    const results = await runWikiConsistencyCheck(ARCHIVE_ID);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      pageId: PAGE_ID,
      slug: PAGE_SLUG,
      drifted: true,
      currentHash,
      indexedHash: oldHash,
    });
  });

  it("should detect drift when vectorContentHash is null", async () => {
    const bodyText = "Some page content.";

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        id: PAGE_ID,
        slug: PAGE_SLUG,
        bodyText,
        contentHash: "somehash",
        vectorContentHash: null,
        lastIndexedAt: null,
      },
    ]);

    const results = await runWikiConsistencyCheck(ARCHIVE_ID);

    expect(results).toHaveLength(1);
    expect(results[0]!.drifted).toBe(true);
    expect(results[0]!.indexedHash).toBeNull();
  });

  describe("G-131-17: vectorProvider drift guard (provider switches count as drift)", () => {
    const CURRENT_PROVIDER = "lancedb";

    it("should detect drift when vectorProvider differs from the current provider (hash matches)", async () => {
      const bodyText = "ACME Corporation is a leading enterprise software company.";
      const contentHash = require("crypto")
        .createHash("sha256")
        .update(bodyText)
        .digest("hex");

      // The stranded-vector scenario: hash matches (written by the OLD
      // provider) but the provider differs — pre-fix this returned drifted: false.
      (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
        {
          id: PAGE_ID,
          slug: PAGE_SLUG,
          bodyText,
          contentHash,
          vectorContentHash: contentHash,
          vectorProvider: "qdrant",
          lastIndexedAt: new Date(),
        },
      ]);

      const results = await runWikiConsistencyCheck(ARCHIVE_ID);

      expect(results).toHaveLength(1);
      expect(results[0]!.drifted).toBe(true);
      expect(results[0]!.provider).toBe("qdrant");
    });

    it("should detect drift when vectorProvider is null (never indexed in the current provider)", async () => {
      const bodyText = "ACME Corporation is a leading enterprise software company.";
      const contentHash = require("crypto")
        .createHash("sha256")
        .update(bodyText)
        .digest("hex");

      // The exact stranded case: hash was written by the old provider but the
      // provider column is null (pre-column rows) — must count as drift.
      (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
        {
          id: PAGE_ID,
          slug: PAGE_SLUG,
          bodyText,
          contentHash,
          vectorContentHash: contentHash,
          vectorProvider: null,
          lastIndexedAt: new Date(),
        },
      ]);

      const results = await runWikiConsistencyCheck(ARCHIVE_ID);

      expect(results).toHaveLength(1);
      expect(results[0]!.drifted).toBe(true);
      expect(results[0]!.provider).toBeNull();
    });

    it("should NOT detect drift when hash AND provider match the current provider", async () => {
      const bodyText = "ACME Corporation is a leading enterprise software company.";
      const contentHash = require("crypto")
        .createHash("sha256")
        .update(bodyText)
        .digest("hex");

      (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
        {
          id: PAGE_ID,
          slug: PAGE_SLUG,
          bodyText,
          contentHash,
          vectorContentHash: contentHash,
          vectorProvider: CURRENT_PROVIDER,
          lastIndexedAt: new Date(),
        },
      ]);

      const results = await runWikiConsistencyCheck(ARCHIVE_ID);

      expect(results).toHaveLength(1);
      expect(results[0]!.drifted).toBe(false);
      expect(results[0]!.provider).toBe(CURRENT_PROVIDER);
    });

    it("should still detect drift when hash differs but provider matches (existing behavior preserved)", async () => {
      const bodyText = "ACME Corporation is a leading enterprise software company.";
      const currentHash = require("crypto")
        .createHash("sha256")
        .update(bodyText)
        .digest("hex");
      const oldHash = "oldhash1234567890abcdef1234567890abcdef12";

      (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
        {
          id: PAGE_ID,
          slug: PAGE_SLUG,
          bodyText,
          contentHash: currentHash,
          vectorContentHash: oldHash,
          vectorProvider: CURRENT_PROVIDER,
          lastIndexedAt: new Date(),
        },
      ]);

      const results = await runWikiConsistencyCheck(ARCHIVE_ID);

      expect(results).toHaveLength(1);
      expect(results[0]!.drifted).toBe(true);
    });
  });
});

describe("reindexDriftedPages", () => {
  it("should reindex only drifted pages", async () => {
    const bodyText = "Updated content.";
    const currentHash = require("crypto")
      .createHash("sha256")
      .update(bodyText)
      .digest("hex");
    const oldHash = "oldhash1234567890abcdef1234567890abcdef12";

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        id: PAGE_ID,
        slug: PAGE_SLUG,
        bodyText,
        contentHash: currentHash,
        vectorContentHash: oldHash,
        lastIndexedAt: new Date(),
      },
      {
        id: "770e8400-e29b-41d4-a716-446655440300",
        slug: "page-two",
        bodyText: "Same content.",
        contentHash: "samehash",
        vectorContentHash: "samehash",
        lastIndexedAt: new Date(),
      },
    ]);

    (prisma.archivePage.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args.where.id === PAGE_ID) {
        return Promise.resolve({
          id: PAGE_ID,
          slug: PAGE_SLUG,
          title: "ACME Corporation",
          bodyText,
        });
      }
      return Promise.resolve(null);
    });

    const reindexed = await reindexDriftedPages(ARCHIVE_ID);

    expect(reindexed).toBe(1);
    expect(indexWikiPage).toHaveBeenCalledTimes(1);
    expect(indexWikiPage).toHaveBeenCalledWith(
      ARCHIVE_ID,
      PAGE_ID,
      PAGE_SLUG,
      "ACME Corporation",
      bodyText
    );
  });

  it("should handle errors gracefully and continue", async () => {
    const bodyText = "Updated content.";
    const currentHash = require("crypto")
      .createHash("sha256")
      .update(bodyText)
      .digest("hex");
    const oldHash = "oldhash1234567890abcdef1234567890abcdef12";

    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        id: PAGE_ID,
        slug: PAGE_SLUG,
        bodyText,
        contentHash: currentHash,
        vectorContentHash: oldHash,
        lastIndexedAt: new Date(),
      },
    ]);

    (prisma.archivePage.findUnique as jest.Mock).mockResolvedValue({
      id: PAGE_ID,
      slug: PAGE_SLUG,
      title: "ACME Corporation",
      bodyText,
    });

    (indexWikiPage as jest.Mock).mockRejectedValue(new Error("Collector down"));

    const reindexed = await reindexDriftedPages(ARCHIVE_ID);

    expect(reindexed).toBe(0);
  });
});

// ─── Phase 165 (Q-02): pg-boss registration ─────────────────────────────────
//
// Verifies the pg-boss migration: getBoss null-check (D-02 graceful
// degradation), createQueue + schedule + boss.work registration, and the
// work handler contract (Job[] array per Pitfall 2, error catch per Pitfall 3).
// Mocks the jobQueue seam (Pattern 3), NOT pg-boss directly.
describe("initWikiConsistencyScheduler pg-boss registration (Phase 165, Q-02)", () => {
  const bossWork = jest.fn().mockResolvedValue("worker-id-1");

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateQueue.mockResolvedValue(undefined);
    mockSchedule.mockResolvedValue(undefined);
    bossWork.mockClear();
    bossWork.mockResolvedValue("worker-id-1");
    mockGetBoss.mockReturnValue({ work: bossWork });
  });

  it("registers queue + cron schedule + work handler", async () => {
    await initWikiConsistencyScheduler();

    // D-04: queue name matches the Phase 161 lock resource key.
    expect(mockCreateQueue).toHaveBeenCalledWith("consistency_archive");
    // D-05: hourly cron expression.
    expect(mockSchedule).toHaveBeenCalledWith("consistency_archive", "0 * * * *");
    // boss.work registered with the queue name and a handler function.
    expect(bossWork).toHaveBeenCalledTimes(1);
    expect(bossWork.mock.calls[0][0]).toBe("consistency_archive");
    expect(typeof bossWork.mock.calls[0][1]).toBe("function");
    // createQueue precedes schedule (Pitfall 1 — foreign-key constraint).
    expect(mockCreateQueue.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSchedule.mock.invocationCallOrder[0]!,
    );
  });

  it("D-02: getBoss() === null → logs warn + returns early (no createQueue/schedule/work)", async () => {
    mockGetBoss.mockReturnValue(null);

    await initWikiConsistencyScheduler();

    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(bossWork).not.toHaveBeenCalled();
    const warnCalls = mockedLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("pg-boss unavailable"))).toBe(true);
  });

  it("work handler runs the wiki-consistency cycle on each job (Pitfall 2 — Job[] array)", async () => {
    await initWikiConsistencyScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Stage no autoIndex archives so the cycle is a no-op but findMany is
    // called — proves the cycle actually ran inside the work handler.
    (prisma.archive.findMany as jest.Mock).mockResolvedValue([]);

    // pg-boss passes a Job[] array (Pitfall 2). The handler iterates with
    // for...of and runs the cycle once per job.
    const job = {
      id: "j1",
      data: {},
      name: "consistency_archive",
      expireInSeconds: 300,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };
    await expect(handler([job])).resolves.toBeUndefined();

    // The cycle ran → archive.findMany called with the autoIndex filter.
    expect(prisma.archive.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ autoIndex: true }) }),
    );
  });

  it("Pitfall 3: work handler catches cycle errors and resolves (no re-throw → no retry storm)", async () => {
    await initWikiConsistencyScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Force the cycle to throw by making archive.findMany blow up.
    (prisma.archive.findMany as jest.Mock).mockImplementation(() => {
      throw new Error("cycle boom");
    });

    // Handler must NOT re-throw — it logs and resolves (pg-boss sees success).
    await expect(handler([{ id: "j1", data: {}, name: "consistency_archive" }])).resolves.toBeUndefined();
    expect(mockedLogger.error).toHaveBeenCalled();
  });
});
