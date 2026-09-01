// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

type DiffOp = -1 | 0 | 1; // DELETE, EQUAL, INSERT

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

/**
 * Compute a semantic diff between two strings.
 * Uses diff-match-patch with semantic cleanup.
 */
// Intentionally not exported — internal primitive of computeLineDiff below
// (Phase 180 sweep: WikiDiffViewer imports only computeLineDiff).
function computeDiff(oldText: string, newText: string): DiffSegment[] {
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, text]) => ({ op: op as DiffOp, text }));
}

/**
 * Compute a side-by-side diff: split into left (old) and right (new) segments
 * aligned by line. Simpler version for paragraph-level diffs.
 */
export function computeLineDiff(
  oldText: string,
  newText: string
): { left: DiffSegment[]; right: DiffSegment[] } {
  const diffs = computeDiff(oldText, newText);
  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];

  for (const segment of diffs) {
    if (segment.op === 0) {
      left.push(segment);
      right.push(segment);
    } else if (segment.op === -1) {
      left.push(segment);
    } else if (segment.op === 1) {
      right.push(segment);
    }
  }

  return { left, right };
}
