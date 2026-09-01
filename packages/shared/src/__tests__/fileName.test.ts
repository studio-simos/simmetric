// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for sanitizeFileName — the single source of truth for
 * filename sanitization across server, collector, and frontend.
 *
 * Contract (quick 260808-vzm):
 * - spaces and invalid chars -> dashes
 * - traversal sequences ("..") neutralized
 * - extension preserved and lowercased
 * - empty-after-sanitize -> fallback ("untitled")
 * - result capped at 255 chars with extension preserved
 */
import { sanitizeFileName } from "../utils/fileName";

describe("sanitizeFileName", () => {
  it('"My Report (final).pdf" -> "My-Report-final.pdf" (spaces and parens -> dashes, extension preserved)', () => {
    expect(sanitizeFileName("My Report (final).pdf")).toBe("My-Report-final.pdf");
  });

  it('"../../etc/passwd" -> "etc.passwd" (no traversal sequences, no leading dots, no separators)', () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etc.passwd");
  });

  it('"résumé 2024.txt" -> "r-sum-2024.txt" (non-ASCII substituted with dashes)', () => {
    expect(sanitizeFileName("résumé 2024.txt")).toBe("r-sum-2024.txt");
  });

  it('"file\\u0000name.md" -> "file-name.md" (control chars dropped/substituted)', () => {
    expect(sanitizeFileName("file\u0000name.md")).toBe("file-name.md");
  });

  it('"notes.txt" -> "notes.txt" (clean name unchanged)', () => {
    expect(sanitizeFileName("notes.txt")).toBe("notes.txt");
  });

  it('"Report.PDF" -> "Report.pdf" (extension lowercased)', () => {
    expect(sanitizeFileName("Report.PDF")).toBe("Report.pdf");
  });

  it('"..." -> "untitled" (empty-after-sanitize fallback)', () => {
    expect(sanitizeFileName("...")).toBe("untitled");
  });

  it('"a..b.txt" -> "a.b.txt" (dot runs collapsed, no ".." remains)', () => {
    expect(sanitizeFileName("a..b.txt")).toBe("a.b.txt");
  });

  it('"file with spaces.txt" -> "file-with-spaces.txt"', () => {
    expect(sanitizeFileName("file with spaces.txt")).toBe("file-with-spaces.txt");
  });

  it('"x".repeat(300) + ".pdf" -> length <= 255 with ".pdf" preserved at the end', () => {
    const result = sanitizeFileName("x".repeat(300) + ".pdf");
    expect(result.length).toBeLessThanOrEqual(255);
    expect(result.endsWith(".pdf")).toBe(true);
  });
});
