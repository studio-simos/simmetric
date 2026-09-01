// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { runFidelitySample } from "../services/synthesisFidelityService";

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    archivePage: { findMany: jest.fn() },
    archive: { findFirst: jest.fn() },
  },
}));

jest.mock("../services/eventLogService", () => ({
  __esModule: true,
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("fs/promises", () => {
  const readFile = jest.fn();
  return { __esModule: true, default: { readFile }, readFile };
});

jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";
import fs from "fs/promises";
import { logger } from "../utils/logger";

const mockPrisma = prisma as unknown as {
  archivePage: { findMany: jest.Mock };
  archive: { findFirst: jest.Mock };
};
const mockLogEvent = logEvent as jest.Mock;
const mockReadFile = (fs as unknown as { readFile: jest.Mock }).readFile;
const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  // Default: archive.findFirst returns an archive with a slug
  mockPrisma.archive.findFirst.mockResolvedValue({ slug: "archive-slug" });
});

describe("synthesisFidelityService.runFidelitySample", () => {
  test("no pages at all -> logs 'no synthesized pages found', returns early", async () => {
    mockPrisma.archivePage.findMany.mockResolvedValue([]);
    await runFidelitySample();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[synthesis] Fidelity sampling: no synthesized pages found",
    );
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  test("pages returned but none have synthesis_generation frontmatter -> filtered out", async () => {
    mockPrisma.archivePage.findMany.mockResolvedValue([
      {
        id: "p1",
        archiveId: "a1",
        slug: "page-1",
        title: "Page 1",
        bodyText: "Some content.",
        frontmatter: { other: "value" },
      },
    ]);
    await runFidelitySample();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[synthesis] Fidelity sampling: no synthesized pages found",
    );
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  test("pages with synthesis_generation >= 1, source files readable -> logEvent called", async () => {
    mockPrisma.archivePage.findMany.mockResolvedValue([
      {
        id: "p1",
        archiveId: "a1",
        slug: "page-1",
        title: "Page 1",
        bodyText: "This is a claim. This is another claim. This is a third claim here.",
        frontmatter: {
          synthesis_generation: 1,
          sources: [{ fileName: "source.txt", ingestDate: "2024-01-01" }],
        },
      },
    ]);
    // source content contains the claims
    mockReadFile.mockResolvedValue("This is a claim. This is another claim. This is a third claim here.");

    await runFidelitySample();

    expect(mockLogEvent).toHaveBeenCalled();
    // logEvent(entityType, entityId, action, userId, metadata)
    const call = mockLogEvent.mock.calls[0]!;
    expect(call[0]).toBe("synthesis_run");
    expect(call[1]).toBe("p1");
    expect(call[2]).toBe("synthesis.fidelity_check");
  });

  test("source files not readable -> NO_SOURCE_AVAILABLE log with fidelityScore 0", async () => {
    mockPrisma.archivePage.findMany.mockResolvedValue([
      {
        id: "p1",
        archiveId: "a1",
        slug: "page-1",
        title: "Page 1",
        bodyText: "claim",
        frontmatter: {
          synthesis_generation: 1,
          sources: [{ fileName: "missing.txt", ingestDate: "2024-01-01" }],
        },
      },
    ]);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await runFidelitySample();

    expect(mockLogEvent).toHaveBeenCalled();
    const metadata = mockLogEvent.mock.calls[0]![4];
    expect(metadata.status).toBe("NO_SOURCE_AVAILABLE");
    expect(metadata.fidelityScore).toBe(0);
  });

  test("error in the flow -> logger.error called, no throw", async () => {
    mockPrisma.archivePage.findMany.mockRejectedValue(new Error("db down"));
    await expect(runFidelitySample()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "[synthesis] Fidelity sampling failed",
      expect.any(Object),
    );
  });

  test("archive not found for a page -> skip that page (warn), continue", async () => {
    mockPrisma.archivePage.findMany.mockResolvedValue([
      {
        id: "p1",
        archiveId: "a1",
        slug: "page-1",
        title: "Page 1",
        bodyText: "claim text here.",
        frontmatter: {
          synthesis_generation: 1,
          sources: [{ fileName: "src.txt", ingestDate: "2024-01-01" }],
        },
      },
    ]);
    mockPrisma.archive.findFirst.mockResolvedValue(null);

    await runFidelitySample();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[synthesis] Fidelity check: archive not found for page",
      expect.any(Object),
    );
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});