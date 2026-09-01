// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  createArchiveSchema,
  updateArchiveSchema,
  createPageSchema,
  updatePageSchema,
  archiveSearchQuerySchema,
} from "../schemas/archive.schema";

// ─── Archive Schemas ─────────────────────────────────────────────

describe("createArchiveSchema", () => {
  it("accepts valid archive creation payload", () => {
    const result = createArchiveSchema.safeParse({
      name: "My Wiki",
      description: "A knowledge base",
    });
    expect(result.success).toBe(true);
  });

  it("accepts payload without optional description", () => {
    const result = createArchiveSchema.safeParse({ name: "Minimal Wiki" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createArchiveSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name over 200 characters", () => {
    const result = createArchiveSchema.safeParse({ name: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects description over 2000 characters", () => {
    const result = createArchiveSchema.safeParse({
      name: "Wiki",
      description: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = createArchiveSchema.safeParse({ description: "No name" });
    expect(result.success).toBe(false);
  });
});

describe("updateArchiveSchema", () => {
  it("accepts only name update", () => {
    const result = updateArchiveSchema.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });

  it("accepts only description update", () => {
    const result = updateArchiveSchema.safeParse({ description: "New desc" });
    expect(result.success).toBe(true);
  });

  it("accepts null description", () => {
    const result = updateArchiveSchema.safeParse({ description: null });
    expect(result.success).toBe(true);
  });

  it("rejects empty object", () => {
    const result = updateArchiveSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = updateArchiveSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});

describe("createPageSchema", () => {
  it("accepts valid page creation payload", () => {
    const result = createPageSchema.safeParse({
      title: "My Page",
      content: "# Hello\n\nWorld",
      category: "concepts",
    });
    expect(result.success).toBe(true);
  });

  // D-12: title is now optional — service derives it via deriveTitle when omitted.
  it("accepts missing title (derivation will fill it at the service layer)", () => {
    const result = createPageSchema.safeParse({
      content: "Content",
      category: "entities",
    });
    expect(result.success).toBe(true);
  });

  it("rejects UUID title", () => {
    const result = createPageSchema.safeParse({
      title: "550e8400-e29b-41d4-a716-446655440000",
      content: "Content",
      category: "entities",
    });
    expect(result.success).toBe(false);
  });

  it("rejects placeholder title (Untitled)", () => {
    const result = createPageSchema.safeParse({
      title: "Untitled",
      content: "Content",
      category: "entities",
    });
    expect(result.success).toBe(false);
  });

  it("rejects placeholder title (New Page)", () => {
    const result = createPageSchema.safeParse({
      title: "New Page",
      content: "Content",
      category: "entities",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty content", () => {
    const result = createPageSchema.safeParse({
      title: "Page",
      content: "",
      category: "decisions",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid category", () => {
    const result = createPageSchema.safeParse({
      title: "Page",
      content: "Content",
      category: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects title over 500 characters", () => {
    const result = createPageSchema.safeParse({
      title: "x".repeat(501),
      content: "Content",
      category: "concepts",
    });
    expect(result.success).toBe(false);
  });
});

describe("updatePageSchema", () => {
  it("accepts partial update with title only", () => {
    const result = updatePageSchema.safeParse({ title: "New Title" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with content only", () => {
    const result = updatePageSchema.safeParse({ content: "New content" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with category only", () => {
    const result = updatePageSchema.safeParse({ category: "entities" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid category", () => {
    const result = updatePageSchema.safeParse({ category: "invalid" });
    expect(result.success).toBe(false);
  });
});

describe("archiveSearchQuerySchema", () => {
  it("accepts valid search query", () => {
    const result = archiveSearchQuerySchema.safeParse({ query: "hello world" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it("accepts query with custom limit", () => {
    const result = archiveSearchQuerySchema.safeParse({
      query: "hello",
      limit: "10",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  it("accepts query with category filter", () => {
    const result = archiveSearchQuerySchema.safeParse({
      query: "pattern",
      category: "concepts",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty query", () => {
    const result = archiveSearchQuerySchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });

  it("rejects limit over 100", () => {
    const result = archiveSearchQuerySchema.safeParse({
      query: "test",
      limit: "101",
    });
    expect(result.success).toBe(false);
  });

  it("rejects limit below 1", () => {
    const result = archiveSearchQuerySchema.safeParse({
      query: "test",
      limit: "0",
    });
    expect(result.success).toBe(false);
  });
});
