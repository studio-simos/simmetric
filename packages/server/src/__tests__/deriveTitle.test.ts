// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for deriveTitle / isTitleDerivable (KB-03, D-10).
 *
 * Pure unit tests — no Prisma mock needed. Only exercises two pure functions
 * exported from src/utils/deriveTitle.ts.
 */
import { deriveTitle, isTitleDerivable, UUID_RE, PLACEHOLDERS } from "../utils/deriveTitle";

describe("deriveTitle", () => {
  test("Test 1: heading markdown → heading text", () => {
    expect(deriveTitle("# Introduction to Cardiology\n\nBody text", "intro")).toBe(
      "Introduction to Cardiology",
    );
  });

  test("Test 2: first non-empty line with frontmatter stripped", () => {
    const body = "---\ntitle: Some frontmatter\n---\nFirst meaningful line\nMore text";
    expect(deriveTitle(body, "slug-x")).toBe("First meaningful line");
  });

  test("Test 3: slug humanized fallback when no heading and no body", () => {
    expect(deriveTitle("", "patient-diagnosis-summary")).toBe(
      "Patient Diagnosis Summary",
    );
  });

  test("Test 4: UUID in body is rejected → slug humanized fallback", () => {
    expect(
      deriveTitle("550e8400-e29b-41d4-a716-446655440000", "page-slug"),
    ).toBe("Page Slug");
  });

  test("Test 5: placeholder in body is rejected → slug fallback", () => {
    expect(deriveTitle("Untitled\nbody", "real-slug")).toBe("Real Slug");
  });

  test("empty slug + empty body → Untitled fallback", () => {
    expect(deriveTitle("", "")).toBe("Untitled");
  });
});

describe("isTitleDerivable", () => {
  test("Test 6: UUID, placeholder, empty, whitespace, null are derivable; real title is not", () => {
    expect(isTitleDerivable("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isTitleDerivable("Untitled")).toBe(true);
    expect(isTitleDerivable("Real Title")).toBe(false);
    expect(isTitleDerivable("")).toBe(true);
    expect(isTitleDerivable(null)).toBe(true);
    expect(isTitleDerivable(undefined)).toBe(true);
    expect(isTitleDerivable("   ")).toBe(true);
  });

  test("Test 7: idempotency — a real title is not derivable, so backfill skips it", () => {
    expect(isTitleDerivable("My Real Title")).toBe(false);
  });

  test("placeholder set includes New Page and Untitled Page", () => {
    expect(PLACEHOLDERS.has("New Page")).toBe(true);
    expect(PLACEHOLDERS.has("Untitled Page")).toBe(true);
    expect(PLACEHOLDERS.has("Untitled")).toBe(true);
  });

  test("UUID_RE matches canonical UUID v4", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(UUID_RE.test("not-a-uuid")).toBe(false);
  });
});