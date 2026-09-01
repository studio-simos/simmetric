// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 97 (MEM-02) — pure path-rank helper for memory retrieval (Wave 2).
 *
 * Hierarchical path-ranking for memory retrieval. Returns a `[tier, tiebreak]`
 * tuple or `null` when the two paths share no relationship. Lower tier =
 * stronger match. The tiered-match idea follows a common hierarchical pattern;
 * independent TS implementation with a dotted-path separator (per D-01).
 *
 * Tiers (ROADMAP explicit — 0-5):
 *   0 — exact match (same path)
 *   1 — memory is a descendant of the lookup (memory path starts with lookup)
 *   2 — memory is an ancestor of the lookup (lookup path starts with memory)
 *   3 — same immediate parent, different last segment (siblings)
 *   4 — shared ancestor segment deeper than the immediate parent
 *   5 — only the last segment is shared
 *   null — no relation
 *
 * Tiebreak (second element): used to order memories within the same tier.
 * For tiers 1/2 it's the depth difference (how far apart the paths are).
 * For tiers 3/4/5 it's a stable tiebreak (0 or the shared depth).
 *
 * PURE module — no DB, no IO, no imports beyond stdlib. Unit-testable in isolation.
 */

const PATH_SEP = ".";

/** Split a dotted path into segments. Empty string → empty array. */
function pathParts(path: string | null | undefined): string[] {
  if (!path) return [];
  if (path === "") return [];
  return path.split(PATH_SEP);
}

/** Parent path of a dotted path (the path without its last segment), or null if root. */
function parentPath(path: string | null | undefined): string | null {
  const parts = pathParts(path);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join(PATH_SEP);
}

/**
 * Count the number of leading segments shared between `a` and `b`.
 * `["a","b","c"]` vs `["a","b","d"]` → 2 (shares "a.b").
 */
function sharedPrefixLength(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Path prefix match score. Returns `[tier, tiebreak]` or `null`.
 *
 * `memoryPath` is the path of a stored memory; `lookupPath` is the path being
 * queried (e.g. derived from the conversation context). Lower tier = stronger.
 */
export function pathRank(
  memoryPath: string | null,
  lookupPath: string | null,
): [number, number] | null {
  if (!memoryPath || memoryPath === "") return null;
  if (!lookupPath || lookupPath === "") return null;

  const memParts = pathParts(memoryPath);
  const lookParts = pathParts(lookupPath);
  if (memParts.length === 0 || lookParts.length === 0) return null;

  // Tier 0: exact match (same path).
  if (memParts.length === lookParts.length) {
    const exact = memParts.every((seg, i) => seg === lookParts[i]);
    if (exact) return [0, 0];
  }

  // Tier 1: memory is a descendant of lookup (memory starts with lookup).
  if (memParts.length > lookParts.length) {
    const isDescendant = lookParts.every((seg, i) => seg === memParts[i]);
    if (isDescendant) return [1, memParts.length - lookParts.length];
  }

  // Tier 2: memory is an ancestor of lookup (lookup starts with memory).
  if (memParts.length < lookParts.length) {
    const isAncestor = memParts.every((seg, i) => seg === lookParts[i]);
    if (isAncestor) return [2, lookParts.length - memParts.length];
  }

  // Same length but not exact (handled above) → check tiers 3, 4, and 5.
  const shared = sharedPrefixLength(memParts, lookParts);

  if (memParts.length === lookParts.length) {
    // Tier 3: same immediate parent (shared prefix is length-1), different last segment.
    if (shared === memParts.length - 1 && shared > 0) {
      return [3, 0];
    }
    // Tier 4: shared ancestor segment but NOT the immediate parent (shared > 0
    // and shared < length-1). E.g. preferences.theme.dark vs preferences.color.light
    // shares "preferences" (shared=1, length=3) — tier 4.
    if (shared > 0 && shared < memParts.length - 1) {
      return [4, shared];
    }
    // Tier 5: only the last segment is shared (no shared prefix), same length.
    if (shared === 0 && memParts[memParts.length - 1] === lookParts[lookParts.length - 1]) {
      return [5, 0];
    }
  } else {
    // Different lengths — check tier 4 (shared ancestor deeper than immediate parent).
    if (shared > 0) {
      return [4, shared];
    }
    // Tier 5 fallback: different lengths but last segment matches.
    if (memParts[memParts.length - 1] === lookParts[lookParts.length - 1]) {
      return [5, 0];
    }
  }

  return null;
}