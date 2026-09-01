// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for the vendor pgvector helper (Phase 91-02, D-07 FIRST-CLASS).
 *
 * The helper mirrors pgvector's `toSql` algorithm (src/index.ts) so the
 * `$1::vector` string-cast path works identically under tsx (dev), node dist
 * (production CJS), and any future ESM/CJS mix — without depending on the
 * ESM-only `pgvector/pg` `registerTypes` runtime import.
 *
 * `parseVectorDim` parses `format_type(atttypid, atttypmod)` output (e.g.
 * `"vector(384)"`) for the D-05 dim-mismatch BLOCK check performed by
 * `PgVectorProvider.initialize()` (plan 91-03).
 */
import { toPgVector, parseVectorDim } from "../utils/pgvectorHelper";

describe("toPgVector (vendor pgvector toSql — D-07 FIRST-CLASS universal path)", () => {
  test("serializes a dense integer array to '[v1,v2,v3]' (no spaces)", () => {
    expect(toPgVector([1, 2, 3])).toBe("[1,2,3]");
  });

  test("returns null for null input", () => {
    expect(toPgVector(null)).toBeNull();
  });

  test("preserves float precision without scientific notation for typical magnitudes", () => {
    expect(toPgVector([0.1, -0.2, 3.14])).toBe("[0.1,-0.2,3.14]");
  });

  test("returns '[]' for empty array edge case", () => {
    expect(toPgVector([])).toBe("[]");
  });

  test("throws 'expected array or sparse vector' for non-array input", () => {
    expect(() => toPgVector("not-array" as any)).toThrow(
      "expected array or sparse vector"
    );
  });

  test("uses map+join algorithm (NOT JSON.stringify which adds spaces)", () => {
    expect(toPgVector([1.5, 2.5])).toBe("[1.5,2.5]");
  });
});

describe("parseVectorDim (regex parser for format_type output — D-05 dim-mismatch)", () => {
  test("parses 'vector(384)' → 384", () => {
    expect(parseVectorDim("vector(384)")).toBe(384);
  });

  test("parses 'vector(768)' → 768", () => {
    expect(parseVectorDim("vector(768)")).toBe(768);
  });

  test("returns null for 'integer' (non-vector column — absence, not mismatch)", () => {
    expect(parseVectorDim("integer")).toBeNull();
  });

  test("returns null for 'text' (non-vector column — absence, not mismatch)", () => {
    expect(parseVectorDim("text")).toBeNull();
  });
});