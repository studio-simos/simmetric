/**
 * Unit tests for `deriveChunkIndex` in reindex-chunkids.ts.
 *
 * These tests exercise ONLY the pure derivation function — prisma, axios, and
 * env are mocked at module level so importing the script does not invoke
 * main() (the script guards main() behind `require.main === module`).
 *
 * Covers UAT-60-11 root cause: chunkIndex must be derived from embeddingId
 * (primary, `${documentId}-${N}`) or metadata JSON (fallback), never from a
 * top-level DB column (which does not exist on document_chunks).
 */

jest.mock("../../src/utils/prisma", () => ({
  prisma: {
    document: { findMany: jest.fn().mockResolvedValue([]) },
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  },
  withSoftDelete: jest.fn((w) => w),
}));

jest.mock("../../src/config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-secret",
  })),
}));

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ data: { chunkCount: 0 } }) },
}));

import { deriveChunkIndex } from "../reindex-chunkids";

describe("deriveChunkIndex", () => {
  it("returns the numeric suffix when embeddingId is `${documentId}-${N}`", () => {
    expect(deriveChunkIndex("doc-abc-3", "doc-abc", "{}")).toBe(3);
    expect(deriveChunkIndex("doc-abc-0", "doc-abc", "{}")).toBe(0);
    expect(deriveChunkIndex("doc-abc-42", "doc-abc", "")).toBe(42);
  });

  it("falls back to metadata.chunkIndex when embeddingId is not aligned", () => {
    expect(deriveChunkIndex("random-uuid-no-suffix", "doc-abc", '{"chunkIndex": 7}')).toBe(7);
    expect(deriveChunkIndex("", "doc-abc", '{"chunkIndex": 11}')).toBe(11);
  });

  it("returns undefined when embeddingId is not aligned AND metadata has no chunkIndex", () => {
    expect(deriveChunkIndex("random-uuid", "doc-abc", "{}")).toBeUndefined();
    expect(deriveChunkIndex("random-uuid", "doc-abc", "")).toBeUndefined();
    expect(deriveChunkIndex("random-uuid", "doc-abc", '{"paragraph": 2}')).toBeUndefined();
  });

  it("returns undefined when embeddingId suffix is non-numeric (e.g. random UUID)", () => {
    expect(
      deriveChunkIndex("doc-abc-a1b2c3d4-e5f6-7890-abcd-ef1234567890", "doc-abc", "{}"),
    ).toBeUndefined();
    expect(deriveChunkIndex("doc-abc-foo", "doc-abc", "{}")).toBeUndefined();
  });

  it("returns undefined when metadata JSON is malformed", () => {
    expect(deriveChunkIndex("random-uuid", "doc-abc", "not-json")).toBeUndefined();
    expect(deriveChunkIndex("random-uuid", "doc-abc", "{bad")).toBeUndefined();
  });

  it("returns undefined when metadata.chunkIndex is not a number", () => {
    expect(deriveChunkIndex("random-uuid", "doc-abc", '{"chunkIndex": "3"}')).toBeUndefined();
    expect(deriveChunkIndex("random-uuid", "doc-abc", '{"chunkIndex": null}')).toBeUndefined();
  });
});