// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  IngestResponseSchema,
  IngestStatusCallbackSchema,
  IngestChunkSchema,
  WikiPagesIngestSchema,
  IngestQueryRequestSchema,
  ReembedRequestSchema,
  RagMetadataFilterSchema,
  ragFilterDocumentTypeSchema,
} from "../schemas/ingest.schema";
import type {
  IngestResponse,
  IngestStatusCallback,
  IngestChunk,
  HybridSearchFilters,
} from "../schemas/ingest.schema";

const validUUID = "550e8400-e29b-41d4-a716-446655440000";

// ─── IngestChunkSchema ────────────────────────────────────────────

describe("IngestChunkSchema", () => {
  it("accepts chunk with chunkIndex + chunkText", () => {
    const result = IngestChunkSchema.safeParse({ chunkIndex: 0, chunkText: "abc" });
    expect(result.success).toBe(true);
  });

  it("rejects `text` field in place of `chunkText` (Bug B regression guard)", () => {
    const result = IngestChunkSchema.safeParse({ chunkIndex: 0, text: "abc" });
    expect(result.success).toBe(false);
  });

  it("accepts optional paragraph/charStart/charEnd", () => {
    const result = IngestChunkSchema.safeParse({
      chunkIndex: 1,
      chunkText: "abc",
      paragraph: 2,
      charStart: 10,
      charEnd: 20,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative chunkIndex", () => {
    const result = IngestChunkSchema.safeParse({ chunkIndex: -1, chunkText: "abc" });
    expect(result.success).toBe(false);
  });
});

// ─── IngestResponseSchema ─────────────────────────────────────────

describe("IngestResponseSchema", () => {
  it("accepts valid round-trip payload (Test 1)", () => {
    const result = IngestResponseSchema.safeParse({
      documentId: validUUID,
      status: "processed",
      chunkCount: 3,
      chunks: [{ chunkIndex: 0, chunkText: "abc" }],
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      table: "ws_test",
    });
    expect(result.success).toBe(true);
  });

  it("rejects `text` instead of `chunkText` — fieldErrors contains `chunks` (Test 2 / Bug B guard)", () => {
    const result = IngestResponseSchema.safeParse({
      documentId: validUUID,
      status: "processed",
      chunks: [{ chunkIndex: 0, text: "abc" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors;
      expect(fieldErrors).toHaveProperty("chunks");
    }
  });

  it("rejects payload without documentId (Test 3)", () => {
    const result = IngestResponseSchema.safeParse({ status: "processed" });
    expect(result.success).toBe(false);
  });

  it("rejects status `processing` — enum only processed/completed/failed (Test 4)", () => {
    const result = IngestResponseSchema.safeParse({
      documentId: validUUID,
      status: "processing",
    });
    expect(result.success).toBe(false);
  });

  it("accepts ocrSkipped optional field (Test 7 / D-04)", () => {
    const result = IngestResponseSchema.safeParse({
      documentId: validUUID,
      status: "processed",
      ocrSkipped: "OCR skipped: no vision model",
    });
    expect(result.success).toBe(true);
  });

  it("accepts `completed` and `failed` status values", () => {
    expect(
      IngestResponseSchema.safeParse({ documentId: validUUID, status: "completed" }).success,
    ).toBe(true);
    expect(
      IngestResponseSchema.safeParse({ documentId: validUUID, status: "failed", error: "boom" }).success,
    ).toBe(true);
  });
});

// ─── IngestStatusCallbackSchema ───────────────────────────────────

describe("IngestStatusCallbackSchema", () => {
  it("accepts valid callback with statusMessage alias (Test 5)", () => {
    const result = IngestStatusCallbackSchema.safeParse({
      status: "completed",
      chunkCount: 5,
      statusMessage: "ok",
    });
    expect(result.success).toBe(true);
  });

  it("rejects status `processing` — enum only completed/failed (Test 6)", () => {
    const result = IngestStatusCallbackSchema.safeParse({ status: "processing" });
    expect(result.success).toBe(false);
  });

  it("accepts failed status with error + ocrSkipped", () => {
    const result = IngestStatusCallbackSchema.safeParse({
      status: "failed",
      error: "embed failed",
      ocrSkipped: "OCR skipped: no vision model",
    });
    expect(result.success).toBe(true);
  });
});

// ─── Type inference smoke tests ───────────────────────────────────

describe("Type exports", () => {
  it("type aliases are importable", () => {
    const _r: IngestResponse | undefined = undefined;
    const _c: IngestStatusCallback | undefined = undefined;
    const _k: IngestChunk | undefined = undefined;
    expect(_r).toBeUndefined();
    expect(_c).toBeUndefined();
    expect(_k).toBeUndefined();
  });
});

// ─── WikiPagesIngestSchema (260721-lrm) ───────────────────────────

describe("WikiPagesIngestSchema", () => {
  const validBase = {
    archiveId: validUUID,
    pageId: validUUID,
    slug: "home",
    title: "Home",
    bodyText: "body",
    contentHash: "abc123",
  };

  it("accepts payload without embeddingModel (backward-compat, D-01)", () => {
    const result = WikiPagesIngestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.embeddingModel).toBeUndefined();
    }
  });

  it("accepts payload with embeddingModel (D-01 archive wiring)", () => {
    const result = WikiPagesIngestSchema.safeParse({
      ...validBase,
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
    }
  });

  it("rejects path-traversal in embeddingModel (T-lrm-01)", () => {
    const result = WikiPagesIngestSchema.safeParse({
      ...validBase,
      embeddingModel: "../../etc/passwd",
    });
    expect(result.success).toBe(false);
  });

  it("rejects absolute path in embeddingModel (T-lrm-01)", () => {
    const result = WikiPagesIngestSchema.safeParse({
      ...validBase,
      embeddingModel: "/etc/passwd",
    });
    expect(result.success).toBe(false);
  });
});

// ─── RagMetadataFilterSchema / IngestQueryRequestSchema.filters (260830-ur9) ──

describe("ragFilterDocumentTypeSchema (6-value enum matching Prisma Document.type)", () => {
  it("accepts each of the 6 document type values", () => {
    for (const t of ["pdf", "md", "txt", "csv", "docx", "xlsx"]) {
      expect(ragFilterDocumentTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects values outside the 6-value enum (e.g. exe, pptx, youtube)", () => {
    expect(ragFilterDocumentTypeSchema.safeParse("exe").success).toBe(false);
    // documentTypeSchema (document.schema.ts) has pptx/youtube — do NOT reuse it.
    expect(ragFilterDocumentTypeSchema.safeParse("pptx").success).toBe(false);
    expect(ragFilterDocumentTypeSchema.safeParse("youtube").success).toBe(false);
  });
});

describe("RagMetadataFilterSchema", () => {
  it("accepts empty object as a no-op filter", () => {
    const result = RagMetadataFilterSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts documentTypes array of valid values", () => {
    const result = RagMetadataFilterSchema.safeParse({ documentTypes: ["pdf", "md"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documentTypes).toEqual(["pdf", "md"]);
    }
  });

  it("rejects invalid documentTypes values", () => {
    expect(RagMetadataFilterSchema.safeParse({ documentTypes: ["exe"] }).success).toBe(false);
  });

  it("rejects duplicate documentTypes entries", () => {
    const result = RagMetadataFilterSchema.safeParse({ documentTypes: ["pdf", "pdf"] });
    expect(result.success).toBe(false);
  });

  it("caps documentTypes at max 6 entries", () => {
    const result = RagMetadataFilterSchema.safeParse({
      documentTypes: ["pdf", "md", "pdf", "pdf", "pdf", "pdf", "pdf"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts date-only and full ISO datetime strings", () => {
    expect(RagMetadataFilterSchema.safeParse({ dateFrom: "2025-01-15" }).success).toBe(true);
    expect(RagMetadataFilterSchema.safeParse({ dateFrom: "2025-01-15T10:30:00.000Z" }).success).toBe(true);
    expect(RagMetadataFilterSchema.safeParse({ dateTo: "2025-12-31" }).success).toBe(true);
  });

  it("rejects non-ISO-parseable date strings", () => {
    expect(RagMetadataFilterSchema.safeParse({ dateFrom: "not-a-date" }).success).toBe(false);
    expect(RagMetadataFilterSchema.safeParse({ dateFrom: "15/01/2025" }).success).toBe(false);
  });

  it("rejects dateFrom after dateTo (object-level refine)", () => {
    const result = RagMetadataFilterSchema.safeParse({
      dateFrom: "2025-06-01",
      dateTo: "2025-01-15",
    });
    expect(result.success).toBe(false);
  });

  it("accepts dateFrom <= dateTo", () => {
    const result = RagMetadataFilterSchema.safeParse({
      dateFrom: "2025-01-15",
      dateTo: "2025-06-01",
    });
    expect(result.success).toBe(true);
  });

  it("type HybridSearchFilters is importable", () => {
    const _f: HybridSearchFilters | undefined = undefined;
    expect(_f).toBeUndefined();
  });
});

describe("IngestQueryRequestSchema.filters (260830-ur9)", () => {
  const base = { query: "hello", workspaceId: "ws-1" };

  it("filters absent -> parsed.data.filters is undefined (byte-identical to current)", () => {
    const result = IngestQueryRequestSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters).toBeUndefined();
    }
  });

  it("filters {} accepted as no-op", () => {
    const result = IngestQueryRequestSchema.safeParse({ ...base, filters: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters).toEqual({});
    }
  });

  it("accepts documentTypes filter on the query request", () => {
    const result = IngestQueryRequestSchema.safeParse({
      ...base,
      filters: { documentTypes: ["pdf", "md"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters?.documentTypes).toEqual(["pdf", "md"]);
    }
  });

  it("accepts dateFrom/dateTo filters on the query request", () => {
    const result = IngestQueryRequestSchema.safeParse({
      ...base,
      filters: { dateFrom: "2025-01-15", dateTo: "2025-06-01" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid filters (bad enum value, bad date, inverted range)", () => {
    expect(
      IngestQueryRequestSchema.safeParse({ ...base, filters: { documentTypes: ["exe"] } }).success,
    ).toBe(false);
    expect(
      IngestQueryRequestSchema.safeParse({ ...base, filters: { dateFrom: "not-a-date" } }).success,
    ).toBe(false);
    expect(
      IngestQueryRequestSchema.safeParse({
        ...base,
        filters: { dateFrom: "2025-06-01", dateTo: "2025-01-15" },
      }).success,
    ).toBe(false);
  });
});

describe("ReembedRequestSchema optional stamp passthrough (260830-ur9)", () => {
  const base = {
    documentId: validUUID,
    workspaceId: "ws-1",
    chunks: [{ chunkIndex: 0, chunkText: "abc" }],
  };

  it("absent documentType/documentCreatedAt = unchanged shape (backward-compat)", () => {
    const result = ReembedRequestSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documentType).toBeUndefined();
      expect(result.data.documentCreatedAt).toBeUndefined();
    }
  });

  it("optional documentType/documentCreatedAt accepted", () => {
    const result = ReembedRequestSchema.safeParse({
      ...base,
      documentType: "pdf",
      documentCreatedAt: "2025-01-15T10:30:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documentType).toBe("pdf");
      expect(result.data.documentCreatedAt).toBe("2025-01-15T10:30:00.000Z");
    }
  });
});