// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 191 (KNOW-01 D-03 / KNOW-02 D-05) — archiveAttachmentService unit
 * tests. Mocks ONLY ../utils/prisma — proves the org-scoped silent filter
 * (IDOR: T-191-01), the dedupe/fan-out guard (T-191-03), and the
 * change-detection mirror contract. No live DB required.
 */
// @ts-nocheck
import { resolveAttachedArchives, syncChatAttachment } from "../services/archiveAttachmentService";

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    archive: {
      findMany: jest.fn(),
    },
    chat: {
      update: jest.fn(),
    },
  },
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const prisma = require("../utils/prisma").default;
const mockFindMany = prisma.archive.findMany as jest.Mock;
const mockChatUpdate = prisma.chat.update as jest.Mock;

const ORG = "org-11111111-1111-1111-1111-111111111111";
const A1 = "a1a1a1a1-1111-1111-1111-111111111111";
const A2 = "a2a2a2a2-2222-2222-2222-222222222222";
const A3 = "a3a3a3a3-3333-3333-3333-333333333333";

describe("resolveAttachedArchives (D-03 org-scoped silent filter)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
  });

  it("short-circuits empty input to [] with NO findMany call", async () => {
    const result = await resolveAttachedArchives([], ORG);
    expect(result).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("passes deduped IDs org-scoped and deletedAt-filtered to findMany", async () => {
    mockFindMany.mockResolvedValue([{ id: A1 }]);
    const result = await resolveAttachedArchives([A1], ORG);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { id: { in: [A1] }, organizationId: ORG, deletedAt: null },
      select: { id: true },
    });
    expect(result).toEqual([A1]);
  });

  it("dedupes duplicate requested IDs before the query (fan-out guard — T-191-03)", async () => {
    mockFindMany.mockResolvedValue([{ id: A1 }]);
    const result = await resolveAttachedArchives([A1, A1, A1], ORG);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: [A1] } }) }),
    );
    expect(result).toEqual([A1]);
  });

  it("silently drops unknown IDs (no error, no 4xx oracle)", async () => {
    mockFindMany.mockResolvedValue([{ id: A1 }]);
    const result = await resolveAttachedArchives([A1, "unknown-id"], ORG);
    expect(result).toEqual([A1]);
  });

  it("silently drops cross-org IDs (they are simply not returned by the org-scoped query)", async () => {
    // Only A1 belongs to the caller's org — A2/A3 are foreign rows that the
    // org-scoped WHERE clause excludes.
    mockFindMany.mockResolvedValue([{ id: A1 }]);
    const result = await resolveAttachedArchives([A1, A2, A3], ORG);
    expect(result).toEqual([A1]);
  });

  it("silently drops soft-deleted archives (deletedAt: null filter)", async () => {
    mockFindMany.mockResolvedValue([]);
    const result = await resolveAttachedArchives([A1], ORG);
    expect(result).toEqual([]);
  });

  it("preserves caller order in the resolved subset", async () => {
    mockFindMany.mockResolvedValue([{ id: A2 }, { id: A1 }]);
    const result = await resolveAttachedArchives([A2, A1], ORG);
    expect(result).toEqual([A2, A1]);
  });

  it("returns [] when organizationId is missing (fail-closed)", async () => {
    const result = await resolveAttachedArchives([A1], undefined);
    expect(result).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe("syncChatAttachment (D-05 per-chat mirror)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatUpdate.mockResolvedValue({});
  });

  it("updates the Chat row when the selection changed", async () => {
    await syncChatAttachment("chat-1", [], [A1, A2]);
    expect(mockChatUpdate).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      data: { attachedArchiveIds: [A1, A2] },
    });
  });

  it("does NOT update when the selection is unchanged (sorted-copy comparison)", async () => {
    await syncChatAttachment("chat-1", [A1, A2], [A2, A1]);
    expect(mockChatUpdate).not.toHaveBeenCalled();
  });

  it("treats null/undefined current as [] (first attach on a legacy row)", async () => {
    await syncChatAttachment("chat-1", null, []);
    expect(mockChatUpdate).not.toHaveBeenCalled();
    await syncChatAttachment("chat-1", undefined, [A1]);
    expect(mockChatUpdate).toHaveBeenCalledTimes(1);
  });

  it("writes the validated subset, never the raw client array", async () => {
    await syncChatAttachment("chat-1", [], [A1]);
    expect(mockChatUpdate).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      data: { attachedArchiveIds: [A1] },
    });
  });

  it("never throws — a mirror failure logs a warning and returns (union proceeds)", async () => {
    mockChatUpdate.mockRejectedValue(new Error("db down"));
    await expect(syncChatAttachment("chat-1", [], [A1])).resolves.toBeUndefined();
    expect(mockChatUpdate).toHaveBeenCalledTimes(1);
  });

  it("never throws when the comparison itself sees malformed current state", async () => {
    await expect(syncChatAttachment("chat-1", [], [])).resolves.toBeUndefined();
    expect(mockChatUpdate).not.toHaveBeenCalled();
  });
});