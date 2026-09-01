// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Vendor pgvector helper (Phase 91-02, D-07 FIRST-CLASS).
 *
 * Mirrors pgvector's `toSql` algorithm (pgvector-node `src/index.ts`) so the
 * `$1::vector` string-cast path works identically under tsx (dev), node dist
 * (production CJS), and any future ESM/CJS mix — without depending on the
 * ESM-only `pgvector/pg` `registerTypes` runtime import (which throws
 * `ERR_REQUIRE_ESM` under `node dist` because `pgvector` 0.3.0 is
 * `"type": "module"`).
 *
 * The `pgvector/pg` `registerTypes` optimization is OPTIONAL and loaded via
 * dynamic `await import('pgvector/pg')` try/catch in `PgVectorProvider`
 * (plan 91-03) — it never gates correctness. This helper is the universal
 * path: pure string manipulation, zero runtime deps (no `pg`, no `pgvector`).
 */

/**
 * Serialize a dense `number[]` to a pgvector literal `[v1,v2,...]` string
 * accepted by the SQL `::vector` cast. Mirrors pgvector's `toSql` exactly
 * (`Number.prototype.toString` + `,` join + `[]` wrap) so float precision is
 * preserved without scientific notation for typical embedding magnitudes
 * (|v| < 1000). Returns null for null input. Throws for non-array input
 * (mirrors pgvector's `expected array or sparse vector` error).
 */
export function toPgVector(values: number[] | null): string | null {
  if (values === null) return null;
  if (!Array.isArray(values)) {
    throw new Error("expected array or sparse vector");
  }
  return "[" + values.map((v) => Number(v).toString()).join(",") + "]";
}

/**
 * Parse `format_type(atttypid, atttypmod)` output (e.g. `"vector(384)"`) →
 * the declared dimension. Returns null for non-vector columns (e.g.
 * `"integer"`, `"text"`) — null means "not a vector column", NOT a dim
 * mismatch. Used by `PgVectorProvider.initialize()` for the D-05
 * dim-mismatch BLOCK check against `getEmbeddingProvider().getDimension()`.
 */
export function parseVectorDim(columnType: string): number | null {
  const match = /vector\((\d+)\)/.exec(columnType);
  return match ? parseInt(match[1]!, 10) : null;
}