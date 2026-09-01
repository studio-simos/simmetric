// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP pattern configuration service (quick 260829-ony — DLP_FEATURES_SPEC
 * §2.3/§2.4).
 *
 * The DB `dlp_patterns` table is the source of truth; the hardcoded
 * DLP_PATTERNS const in dlpFilter.ts is the graceful-degradation fallback
 * (spec §2.4 point 2) applied by scanContentAsync when the DB is unreachable.
 *
 * Caching (spec §2.4 point 5 + §4.5):
 * - DB rows cached in-memory with a 5-minute TTL — cross-instance changes
 *   propagate within the TTL even without shared invalidation.
 * - Compiled RegExp cached per pattern row id + source + flags so repeated
 *   scans never recompile. invalidateCache() (called by every CRUD mutation)
 *   clears BOTH caches.
 *
 * This module owns DB + compile + test logic only — no HTTP, and the scan
 * EXECUTION stays in dlpFilter.ts (scanWithPatterns) so the module-import
 * direction is one-way: dlpFilter → dlpPatternService (no cycle).
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

/** Canonical row shape returned by the service (plain JSON-safe object). */
export interface DlpPatternRow {
  id: string;
  name: string;
  displayName: string;
  pattern: string;
  patternFlags: string;
  replacement: string;
  isEnabled: boolean;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Compiled pattern + metadata consumed by dlpFilter.scanWithPatterns. */
export interface CompiledDlpPattern {
  type: string;
  regex: RegExp;
  replacement: string;
}

/** Spec §4.5 — v1 cross-instance invalidation = 5-minute TTL. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Spec §4.9 — max 50 CUSTOM (non built-in) patterns per instance. */
export const MAX_CUSTOM_PATTERNS = 50;

let cachedPatterns: DlpPatternRow[] | null = null;
let cacheLoadedAt = 0;
const compiledCache = new Map<string, RegExp>();

/**
 * Compile a pattern source + flags into a RegExp.
 *
 * Throws on an invalid/uncompilable regex — the routes map that throw to a
 * 400 (spec §4.2 v1 ReDoS mitigation: validation at save, no runtime
 * timeout — admins are trusted; the compile check blocks accidental hangs).
 * Also the inline-validation primitive the frontend dialog mirrors.
 */
export function compileRegex(pattern: string, patternFlags: string): RegExp {
  try {
    return new RegExp(pattern, patternFlags);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid regex pattern: ${message}`, { cause: err });
  }
}

function compiledFor(row: DlpPatternRow): RegExp {
  const key = `${row.id}:${row.pattern}:${row.patternFlags}`;
  const hit = compiledCache.get(key);
  if (hit) return hit;
  const compiled = new RegExp(row.pattern, row.patternFlags);
  compiledCache.set(key, compiled);
  return compiled;
}

/**
 * Active (isEnabled) pattern rows: createdAt ASC (built-ins seeded first —
 * spec §4.3 sequential redaction order: the first pattern that matches wins;
 * already-redacted text is not re-scanned), name ASC as the deterministic
 * tie-break. Throws on DB failure — the CALLER (scanContentAsync) owns the
 * built-in fallback so a cache-hit hot path never pays a try/catch.
 */
export async function getActivePatterns(): Promise<DlpPatternRow[]> {
  if (cachedPatterns && Date.now() - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedPatterns;
  }
  const rows = (await prisma.dlpPattern.findMany({
    where: { isEnabled: true },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
  })) as DlpPatternRow[];
  cachedPatterns = rows;
  cacheLoadedAt = Date.now();
  return rows;
}

/**
 * Compiled active patterns for scanning — same DB contract as
 * getActivePatterns with the per-row regex resolved from the compiled cache.
 * Throws on DB failure (fallback ownership: dlpFilter.scanContentAsync).
 */
export async function getActiveCompiledPatterns(): Promise<CompiledDlpPattern[]> {
  const rows = await getActivePatterns();
  return rows.map((row) => ({
    type: row.name,
    regex: compiledFor(row),
    replacement: row.replacement,
  }));
}

/** ALL pattern rows (enabled + disabled) for the admin list. */
export async function listPatterns(): Promise<DlpPatternRow[]> {
  return (await prisma.dlpPattern.findMany({
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
  })) as DlpPatternRow[];
}

/** Custom (non built-in) pattern count for the §4.9 cap. */
export async function countCustomPatterns(): Promise<number> {
  return prisma.dlpPattern.count({ where: { isBuiltIn: false } });
}

/**
 * Clear the row cache AND the compiled-regex map. Called by every CRUD
 * mutation route (spec §2.4 point 4) and after test mutations that need a
 * deterministic cache state.
 */
export function invalidateCache(): void {
  cachedPatterns = null;
  cacheLoadedAt = 0;
  compiledCache.clear();
}

/** Test-only seam: force-expire the TTL so a test can exercise reload. */
export function expireCacheForTest(): void {
  cacheLoadedAt = 0;
}

/** Test-only seam: inspect whether the row cache is warm. */
export function isCacheWarmForTest(): boolean {
  return cachedPatterns !== null && cacheLoadedAt > 0;
}

export interface PatternTestResult {
  matches: Array<{ index: number; length: number; matchedText: string }>;
  redactedText: string;
}

/**
 * Test ONE pattern against sample text WITHOUT persisting anything (audit
 * safe — neither the sample nor the matches reach EventLog). Throws on an
 * invalid regex (routes map to 400). Zero-length-match guard prevents an
 * infinite loop for patterns like `a*`.
 */
export function testPattern(pattern: string, patternFlags: string, sampleText: string): PatternTestResult {
  const regex = compileRegex(pattern, patternFlags);
  const matches: Array<{ index: number; length: number; matchedText: string }> = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = regex.exec(sampleText)) !== null) {
    matches.push({ index: match.index, length: match[0].length, matchedText: match[0] });
    // Zero-length match would never advance lastIndex — force progress.
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      if (regex.lastIndex > sampleText.length) break;
    }
    if (++guard > 10_000) break;
  }
  const redactedText = sampleText.replace(regex, "[REDACTED]");
  regex.lastIndex = 0; // do not leak global-regex state to the caller
  return { matches, redactedText };
}

/** Log-and-skip compiled-cache wrinkle: only called by scanContentAsync path. */
export function logDbFallback(err: unknown): void {
  logger.warn("[dlpPatternService] DB unavailable — falling back to built-in DLP patterns", {
    error: err instanceof Error ? err.message : String(err),
  });
}