// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  ocrJobRequestSchema,
  urlIngestionRequestSchema,
  ocrJobApproveSchema,
  ocrJobRejectSchema,
  ocrPageResultSchema,
  ocrJobResultSchema,
} from "../schemas/ocr.schema";

const validUUID = "550e8400-e29b-41d4-a716-446655440000";

// ─── ocrJobRequestSchema ──────────────────────────────────────────

describe("ocrJobRequestSchema", () => {
  it("accepts valid OCR job request with archiveId only", () => {
    const result = ocrJobRequestSchema.safeParse({ archiveId: validUUID });
    expect(result.success).toBe(true);
  });

  it("accepts with optional model field", () => {
    const result = ocrJobRequestSchema.safeParse({
      archiveId: validUUID,
      model: "glm-ocr:latest",
    });
    expect(result.success).toBe(true);
  });

  it("accepts with optional sourceQualityScore", () => {
    const result = ocrJobRequestSchema.safeParse({
      archiveId: validUUID,
      sourceQualityScore: 3,
    });
    expect(result.success).toBe(true);
  });

  it("accepts with both optional fields", () => {
    const result = ocrJobRequestSchema.safeParse({
      archiveId: validUUID,
      model: "glm-ocr:latest",
      sourceQualityScore: 5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing archiveId", () => {
    const result = ocrJobRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID archiveId", () => {
    const result = ocrJobRequestSchema.safeParse({ archiveId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects model over 200 characters", () => {
    const result = ocrJobRequestSchema.safeParse({
      archiveId: validUUID,
      model: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("rejects sourceQualityScore < 1", () => {
    const result = ocrJobRequestSchema.safeParse({
      archiveId: validUUID,
      sourceQualityScore: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects sourceQualityScore > 5", () => {
    const result = ocrJobRequestSchema.safeParse({
      archiveId: validUUID,
      sourceQualityScore: 6,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer sourceQualityScore", () => {
    const result = ocrJobRequestSchema.safeParse({
      archiveId: validUUID,
      sourceQualityScore: 3.5,
    });
    expect(result.success).toBe(false);
  });
});

// ─── urlIngestionRequestSchema ────────────────────────────────────

describe("urlIngestionRequestSchema", () => {
  it("accepts valid HTTPS URL with archiveId", () => {
    const result = urlIngestionRequestSchema.safeParse({
      url: "https://example.com",
      archiveId: validUUID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects HTTP URL (blocked per D-09)", () => {
    const result = urlIngestionRequestSchema.safeParse({
      url: "http://example.com",
      archiveId: validUUID,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-URL string", () => {
    const result = urlIngestionRequestSchema.safeParse({
      url: "not-a-url",
      archiveId: validUUID,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing url", () => {
    const result = urlIngestionRequestSchema.safeParse({
      archiveId: validUUID,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing archiveId", () => {
    const result = urlIngestionRequestSchema.safeParse({
      url: "https://example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID archiveId", () => {
    const result = urlIngestionRequestSchema.safeParse({
      url: "https://example.com",
      archiveId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts with optional userScore", () => {
    const result = urlIngestionRequestSchema.safeParse({
      url: "https://example.com",
      archiveId: validUUID,
      userScore: 4,
    });
    expect(result.success).toBe(true);
  });

  it("rejects userScore < 1", () => {
    const result = urlIngestionRequestSchema.safeParse({
      url: "https://example.com",
      archiveId: validUUID,
      userScore: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects userScore > 5", () => {
    const result = urlIngestionRequestSchema.safeParse({
      url: "https://example.com",
      archiveId: validUUID,
      userScore: 6,
    });
    expect(result.success).toBe(false);
  });
});

// ─── ocrJobApproveSchema ──────────────────────────────────────────

describe("ocrJobApproveSchema", () => {
  it("accepts empty object", () => {
    const result = ocrJobApproveSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ─── ocrJobRejectSchema ───────────────────────────────────────────

describe("ocrJobRejectSchema", () => {
  it("accepts empty object (reason optional)", () => {
    const result = ocrJobRejectSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts with optional reason", () => {
    const result = ocrJobRejectSchema.safeParse({
      reason: "Low quality output",
    });
    expect(result.success).toBe(true);
  });

  it("rejects reason over 1000 characters", () => {
    const result = ocrJobRejectSchema.safeParse({
      reason: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });
});

// ─── ocrPageResultSchema ──────────────────────────────────────────

describe("ocrPageResultSchema", () => {
  it("accepts valid page result", () => {
    const result = ocrPageResultSchema.safeParse({
      pageNumber: 1,
      markdown: "# Page Content",
      tokensUsed: 150,
      durationMs: 2500,
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero pageNumber", () => {
    const result = ocrPageResultSchema.safeParse({
      pageNumber: 0,
      markdown: "# Content",
      tokensUsed: 10,
      durationMs: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative pageNumber", () => {
    const result = ocrPageResultSchema.safeParse({
      pageNumber: -1,
      markdown: "# Content",
      tokensUsed: 10,
      durationMs: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty markdown", () => {
    const result = ocrPageResultSchema.safeParse({
      pageNumber: 1,
      markdown: "",
      tokensUsed: 10,
      durationMs: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative tokensUsed", () => {
    const result = ocrPageResultSchema.safeParse({
      pageNumber: 1,
      markdown: "# Content",
      tokensUsed: -1,
      durationMs: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative durationMs", () => {
    const result = ocrPageResultSchema.safeParse({
      pageNumber: 1,
      markdown: "# Content",
      tokensUsed: 10,
      durationMs: -1,
    });
    expect(result.success).toBe(false);
  });
});

// ─── ocrJobResultSchema ───────────────────────────────────────────

describe("ocrJobResultSchema", () => {
  it("accepts valid job result", () => {
    const result = ocrJobResultSchema.safeParse({
      qualityScore: 4,
      totalPages: 5,
      totalTokens: 2500,
      totalDurationMs: 12000,
      hasUnverified: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects qualityScore < 1", () => {
    const result = ocrJobResultSchema.safeParse({
      qualityScore: 0,
      totalPages: 5,
      totalTokens: 2500,
      totalDurationMs: 12000,
      hasUnverified: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects qualityScore > 5", () => {
    const result = ocrJobResultSchema.safeParse({
      qualityScore: 6,
      totalPages: 5,
      totalTokens: 2500,
      totalDurationMs: 12000,
      hasUnverified: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero totalPages", () => {
    const result = ocrJobResultSchema.safeParse({
      qualityScore: 4,
      totalPages: 0,
      totalTokens: 2500,
      totalDurationMs: 12000,
      hasUnverified: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative totalTokens", () => {
    const result = ocrJobResultSchema.safeParse({
      qualityScore: 4,
      totalPages: 5,
      totalTokens: -1,
      totalDurationMs: 12000,
      hasUnverified: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative totalDurationMs", () => {
    const result = ocrJobResultSchema.safeParse({
      qualityScore: 4,
      totalPages: 5,
      totalTokens: 2500,
      totalDurationMs: -1,
      hasUnverified: false,
    });
    expect(result.success).toBe(false);
  });
});
