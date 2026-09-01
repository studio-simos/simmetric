// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Wiki Embedding Service integration tests.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret",
    VECTOR_DB_PROVIDER: "lancedb",
  })),
}));

// G-131-17: getSetting returns no DB value → env fallback VECTOR_DB_PROVIDER
// ("lancedb") is exercised.
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: undefined }),
}));

jest.mock("axios");

import axios from "axios";
import prisma from "../utils/prisma";
import {
  indexWikiPage,
  indexAllWikiPages,
  deleteWikiVectors,
} from "../services/wikiEmbeddingService";

const mockedAxios = axios as jest.Mocked<typeof axios>;

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const PAGE_ID = "660e8400-e29b-41d4-a716-446655440200";
const PAGE_SLUG = "acme-corporation";
const PAGE_TITLE = "ACME Corporation";
const BODY_TEXT = "ACME Corporation is a leading enterprise software company.";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("indexWikiPage", () => {
  it("should hash content, call collector, and update ArchivePage metadata", async () => {
    mockedAxios.post.mockResolvedValue({ data: { status: "completed", chunkCount: 3 } });
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({
      id: PAGE_ID,
      vectorContentHash: "abc123",
      lastIndexedAt: new Date(),
    });

    await indexWikiPage(ARCHIVE_ID, PAGE_ID, PAGE_SLUG, PAGE_TITLE, BODY_TEXT);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "http://localhost:3210/api/ingest/wiki-pages",
      expect.objectContaining({
        archiveId: ARCHIVE_ID,
        pageId: PAGE_ID,
        slug: PAGE_SLUG,
        title: PAGE_TITLE,
        bodyText: BODY_TEXT,
        contentHash: expect.any(String),
      }),
      { timeout: 60000, headers: { "X-Collector-Secret": expect.any(String) } }
    );

    expect(prisma.archivePage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAGE_ID },
        data: expect.objectContaining({
          vectorContentHash: expect.any(String),
          vectorProvider: "lancedb",
          lastIndexedAt: expect.any(Date),
        }),
      })
    );

    // quick 260811-lxh: the tsvector FTS column is maintained on the
    // vector-index path too. Phase 151 (RAG-01): BOTH columns are populated
    // in the same statement.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const execCall = (prisma.$executeRaw as jest.Mock).mock.calls[0];
    const sql = (execCall[0] as string[]).join("?");
    expect(sql).toContain("to_tsvector('english'");
    expect(sql).toContain('"searchVectorMulti"');
    expect(execCall[1]).toBe(BODY_TEXT);
    // Last interpolated value is the pageId (WHERE clause).
    expect(execCall[execCall.length - 1]).toBe(PAGE_ID);
  });

  it("should throw if collector request fails", async () => {
    mockedAxios.post.mockRejectedValue(new Error("Collector unreachable"));

    await expect(
      indexWikiPage(ARCHIVE_ID, PAGE_ID, PAGE_SLUG, PAGE_TITLE, BODY_TEXT)
    ).rejects.toThrow("Collector unreachable");
  });
});

describe("indexAllWikiPages", () => {
  it("should iterate all pages and index each", async () => {
    const pages = [
      { id: PAGE_ID, slug: PAGE_SLUG, title: PAGE_TITLE, bodyText: BODY_TEXT },
      { id: "770e8400-e29b-41d4-a716-446655440300", slug: "page-two", title: "Page Two", bodyText: "Body two." },
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);
    mockedAxios.post.mockResolvedValue({ data: { status: "completed", chunkCount: 1 } });
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({ id: PAGE_ID });

    await indexAllWikiPages(ARCHIVE_ID);

    expect(prisma.archivePage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { archiveId: ARCHIVE_ID, deletedAt: null },
        select: expect.any(Object),
      })
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it("should continue on individual page failures", async () => {
    const pages = [
      { id: PAGE_ID, slug: PAGE_SLUG, title: PAGE_TITLE, bodyText: BODY_TEXT },
      { id: "770e8400-e29b-41d4-a716-446655440300", slug: "page-two", title: "Page Two", bodyText: "Body two." },
    ];
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue(pages);
    mockedAxios.post
      .mockRejectedValueOnce(new Error("Collector error"))
      .mockResolvedValueOnce({ data: { status: "completed" } });
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({ id: PAGE_ID });

    // Should not throw — errors are logged and swallowed per page
    await expect(indexAllWikiPages(ARCHIVE_ID)).resolves.toBeUndefined();
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});

describe("deleteWikiVectors", () => {
  it("should call collector delete and clear metadata", async () => {
    mockedAxios.delete.mockResolvedValue({ data: { status: "deleted" } });
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({ id: PAGE_ID });

    await deleteWikiVectors(PAGE_ID);

    expect(mockedAxios.delete).toHaveBeenCalledWith(
      `http://localhost:3210/api/ingest/wiki-pages/${PAGE_ID}`,
      { timeout: 10000, headers: { "X-Collector-Secret": expect.any(String) } }
    );
    expect(prisma.archivePage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAGE_ID },
        data: { vectorContentHash: null, vectorProvider: null, lastIndexedAt: null },
      })
    );
  });

  it("should still clear metadata even if collector delete fails", async () => {
    mockedAxios.delete.mockRejectedValue(new Error("Collector unreachable"));
    (prisma.archivePage.update as jest.Mock).mockResolvedValue({ id: PAGE_ID });

    await deleteWikiVectors(PAGE_ID);

    expect(mockedAxios.delete).toHaveBeenCalled();
    expect(prisma.archivePage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAGE_ID },
        data: { vectorContentHash: null, vectorProvider: null, lastIndexedAt: null },
      })
    );
  });
});
