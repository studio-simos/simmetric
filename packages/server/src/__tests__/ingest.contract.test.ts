// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Contract tests for the collector↔server ingest contract.
 *
 * These are unit-style schema safeParse tests (RESEARCH.md Open Question 2
 * recommendation: unit-style, NO spin-up of the collector). They validate:
 *  - Valid round-trip payload is accepted by IngestResponseSchema
 *  - Bug B regression guard: `text` instead of `chunkText` is rejected
 *  - Missing documentId is rejected
 *  - Status enum is strict (processed/completed/failed)
 *  - IngestStatusCallbackSchema accepts valid callback + rejects malformed
 *  - ocrSkipped (D-04) field is accepted
 *
 * The schemas live in @simmetric-chat/shared and are consumed on both sides of the
 * HTTP boundary (producer-side in collector ingest.ts, consumer-side in server
 * documents.ts PUT /:id/status).
 */

import {
  IngestResponseSchema,
  IngestStatusCallbackSchema,
} from "@simmetric-chat/shared";

const validUUID = "550e8400-e29b-41d4-a716-446655440000";

// ─── IngestResponseSchema ─────────────────────────────────────────

describe("IngestResponseSchema", () => {
  it("Test 1: accepts valid round-trip payload", () => {
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

  it("Test 2 (Bug B regression guard): rejects `text` instead of `chunkText` — fieldErrors contains `chunks`", () => {
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

  it("Test 3: rejects payload without documentId", () => {
    const result = IngestResponseSchema.safeParse({ status: "processed" });
    expect(result.success).toBe(false);
  });

  it("Test 4: rejects status `processing` — enum only processed/completed/failed", () => {
    const result = IngestResponseSchema.safeParse({
      documentId: validUUID,
      status: "processing",
    });
    expect(result.success).toBe(false);
  });

  it("Test 7: accepts ocrSkipped optional field (D-04)", () => {
    const result = IngestResponseSchema.safeParse({
      documentId: validUUID,
      status: "processed",
      ocrSkipped: "OCR skipped: no vision model",
    });
    expect(result.success).toBe(true);
  });
});

// ─── IngestStatusCallbackSchema ───────────────────────────────────

describe("IngestStatusCallbackSchema", () => {
  it("Test 5: accepts valid callback with statusMessage alias", () => {
    const result = IngestStatusCallbackSchema.safeParse({
      status: "completed",
      chunkCount: 5,
      statusMessage: "ok",
    });
    expect(result.success).toBe(true);
  });

  it("Test 6: rejects status `processing` — enum only completed/failed", () => {
    const result = IngestStatusCallbackSchema.safeParse({ status: "processing" });
    expect(result.success).toBe(false);
  });

  it("accepts failed status with error + ocrSkipped fields", () => {
    const result = IngestStatusCallbackSchema.safeParse({
      status: "failed",
      error: "embed failed",
      ocrSkipped: "OCR skipped: no vision model",
    });
    expect(result.success).toBe(true);
  });
});