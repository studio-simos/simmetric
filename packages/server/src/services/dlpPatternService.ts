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
 * Caching (spec §4.5 + CR-02 185-05):
 * - DB rows cached in-memory per ORG with a 5-minute TTL — cross-instance
 *   changes propagate within the TTL even without shared invalidation. The
 *   CR-02 fix: the cache is keyed by the orgId argument (null key for the
 *   absent-store arm) so one org's rows can never leak into another org's
 *   scans (the pre-185 module-level pair was org-blind).
 * - Built-in patterns are GLOBAL safety rails: an org-scoped read always
 *   merges (org's customs OR isBuiltIn) — built-ins redact in EVERY org
 *   (the CR-02 fail-open class is closed). Built-in rows stay pinned to the
 *   default org in the DB (schema M3 backfill); only the READ is org-agnostic
 *   for built-ins.
 * - Compiled RegExp cached per pattern row id + source + flags so repeated
 *   scans never recompile. invalidateCache() (called by every CRUD mutation)
 *   clears EVERY org entry plus the compiled map.
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

/**
 * CR-02 (185-05): per-org row cache keyed by the orgId argument (null = the
 * absent-store arm — pre-185 unscoped semantics). One org's rows can never
 * be reused by another org's scan within the TTL.
 */
const patternCache = new Map<string | null, { rows: DlpPatternRow[]; loadedAt: number }>();
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
 * Active (isEnabled) pattern rows for ONE org (CR-02 org-explicit contract):
 * - orgId PROVIDED (in-request scans — chat/widget stream always run inside
 *   the ALS window): where = isEnabled AND (organizationId = orgId OR
 *   isBuiltIn) — built-ins are global safety rails, not tenant data, so they
 *   redact in EVERY org.
 * - orgId ABSENT (no ALS store — pre-185 equivalence for any non-request
 *   caller): the unscoped isEnabled-only where (byte-identical pre-185 arm).
 *
 * Ordering: createdAt ASC (built-ins seeded first — spec §4.3 sequential
 * redaction order: the first pattern that matches wins; already-redacted
 * text is not re-scanned), name ASC as the deterministic tie-break. Throws
 * on DB failure — the CALLER (scanContentAsync) owns the built-in fallback
 * so a cache-hit hot path never pays a try/catch.
 */
export async function getActivePatterns(orgId?: string): Promise<DlpPatternRow[]> {
  const cacheKey = orgId ?? null;
  const hit = patternCache.get(cacheKey);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) {
    return hit.rows;
  }
  // CR-02: built-ins are org-agnostic in scans — an org-scoped read merges
  // the org's customs with the built-ins (OR), never drops the rails.
  const where = orgId
    ? { isEnabled: true, OR: [{ organizationId: orgId }, { isBuiltIn: true }] }
    : { isEnabled: true };
  const rows = (await prisma.dlpPattern.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
  })) as DlpPatternRow[];
  patternCache.set(cacheKey, { rows, loadedAt: Date.now() });
  return rows;
}

/**
 * Compiled active patterns for scanning — same DB contract as
 * getActivePatterns with the per-row regex resolved from the compiled cache.
 * `getActiveCompiledPatterns(orgId?)` threads the org from its caller
 * (dlpFilter.scanContentAsync reads the ambient tenant store). Throws on DB
 * failure (fallback ownership: dlpFilter.scanContentAsync).
 */
export async function getActiveCompiledPatterns(orgId?: string): Promise<CompiledDlpPattern[]> {
  const rows = await getActivePatterns(orgId);
  return rows.map((row) => ({
    type: row.name,
    regex: compiledFor(row),
    replacement: row.replacement,
  }));
}

/**
 * ALL pattern rows (enabled + disabled) for the admin list — same optional
 * orgId contract as getActivePatterns: an org-scoped admin list shows the
 * org's customs PLUS the built-ins (visible-but-not-cross-org-mutable by
 * design; the update/delete routes' org assertions stay fail-closed).
 */
export async function listPatterns(orgId?: string): Promise<DlpPatternRow[]> {
  const where = orgId
    ? { OR: [{ organizationId: orgId }, { isBuiltIn: true }] }
    : {};
  return (await prisma.dlpPattern.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
  })) as DlpPatternRow[];
}

/** Custom (non built-in) pattern count for the §4.9 cap. */
export async function countCustomPatterns(): Promise<number> {
  return prisma.dlpPattern.count({ where: { isBuiltIn: false } });
}

/**
 * Clear EVERY org's row cache AND the compiled-regex map. Called by every
 * CRUD mutation route (spec §2.4 point 4) and after test mutations that need
 * a deterministic cache state. Org-blind by design: any mutation invalidates
 * all orgs (the next scan of each org reloads its own rows).
 */
export function invalidateCache(): void {
  patternCache.clear();
  compiledCache.clear();
}

/** Test-only seam: force-expire the TTL so a test can exercise reload. */
export function expireCacheForTest(): void {
  for (const entry of patternCache.values()) {
    entry.loadedAt = 0;
  }
}

/** Test-only seam: inspect whether the row cache is warm. */
export function isCacheWarmForTest(): boolean {
  return patternCache.size > 0;
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