// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { logger } from "../utils/logger";

export interface GuardIssue {
  pageNumber: number;
  type:
    | "UNVERIFIED_TAG"
    | "UNBALANCED_FENCE"
    | "TABLE_MISMATCH"
    | "HEADING_GAP"
    | "EMPTY_OUTPUT"
    | "HANDWRITING";
  detail: string;
  severity: "warning" | "error";
}

export interface GuardResult {
  markdown: string;
  hasUnverified: boolean;
  unverifiedCount: number;
  hasHandwriting: boolean;
  hasEmpty: boolean;
  issues: GuardIssue[];
}

const UNVERIFIED_RE = /\[UNVERIFIED:\s*([^\]]*)\]/gi;
const HANDWRITING_RE = /\[HANDWRITING:\s*([^\]]*)\]/gi;
const FENCE_RE = /^```\s*$/gm;

function countChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

function computeFourGramUniqueness(text: string): number {
  const words = text.trim().split(/\s+/);
  if (words.length < 4) return 1.0;
  const fourGrams: string[] = [];
  for (let i = 0; i <= words.length - 4; i++) {
    fourGrams.push(words.slice(i, i + 4).join(" "));
  }
  const unique = new Set(fourGrams);
  return unique.size / fourGrams.length;
}

function parseTableColumns(lines: string[]): {
  headerCols: number;
  rows: Array<{ index: number; cols: number }>;
} | null {
  const headerIdx = lines.findIndex(
    (l) => l.trim().startsWith("|") && l.trim().endsWith("|")
  );
  if (headerIdx === -1) return null;
  const headerCols = lines[headerIdx]!.trim().split("|").filter(Boolean).length;
  const sepIdx = headerIdx + 1;
  if (
    sepIdx >= lines.length ||
    !/^\|[\s\-:|]+\|$/.test(lines[sepIdx]!.trim())
  ) {
    return null;
  }
  const rows: Array<{ index: number; cols: number }> = [];
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("|") && line.endsWith("|")) {
      const cols = line.split("|").filter(Boolean).length;
      rows.push({ index: i, cols });
    } else if (line === "") {
      break;
    }
  }
  return { headerCols, rows };
}

export function applyHallucinationGuard(
  markdown: string,
  pageNumber: number,
  skipDegeneration = false,
): GuardResult {
  const issues: GuardIssue[] = [];
  let resultMarkdown = markdown;
  let hasUnverified = false;
  let unverifiedCount = 0;
  let hasHandwriting = false;
  let hasEmpty = false;

  if (markdown.trim().length === 0) {
    hasEmpty = true;
    issues.push({
      pageNumber,
      type: "EMPTY_OUTPUT",
      detail: `Page ${pageNumber} produced empty output from OCR model.`,
      severity: "error",
    });
    logger.error(`[ocr] Empty OCR output detected for page ${pageNumber}`);
    return {
      markdown: `[FAILED: OCR model returned empty output for page ${pageNumber}]`,
      hasUnverified: false,
      unverifiedCount: 0,
      hasHandwriting: false,
      hasEmpty: true,
      issues,
    };
  }

  const unverifiedMatches = [...markdown.matchAll(UNVERIFIED_RE)];
  unverifiedCount = unverifiedMatches.length;
  hasUnverified = unverifiedCount > 0;

  const handwritingMatches = [...markdown.matchAll(HANDWRITING_RE)];
  hasHandwriting = handwritingMatches.length > 0;
  if (hasHandwriting) {
    issues.push({
      pageNumber,
      type: "HANDWRITING",
      detail: `${handwritingMatches.length} handwriting tag(s) detected on page ${pageNumber}.`,
      severity: "warning",
    });
    logger.warn(
      `[ocr] ${handwritingMatches.length} handwriting tag(s) on page ${pageNumber}`
    );
  }

  const allFenceMatches = [...resultMarkdown.matchAll(FENCE_RE)];
  const fenceCount = allFenceMatches.length;
  if (fenceCount % 2 !== 0) {
    const openCount = Math.ceil(fenceCount / 2);
    const closeCount = Math.floor(fenceCount / 2);
    issues.push({
      pageNumber,
      type: "UNBALANCED_FENCE",
      detail: `Unbalanced code fences on page ${pageNumber}: ${openCount} open, ${closeCount} close. Auto-fixed by appending closing fence.`,
      severity: "error",
    });
    logger.warn(`[ocr] Unbalanced code fences on page ${pageNumber}`);
    if (!resultMarkdown.endsWith("\n")) {
      resultMarkdown += "\n";
    }
    resultMarkdown += "```\n";
  }

  const headingMatches: Array<{ level: number; text: string }> = [];
  let headingMatch: RegExpExecArray | null;
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  while ((headingMatch = headingRegex.exec(resultMarkdown)) !== null) {
    headingMatches.push({
      level: headingMatch[1]!.length,
      text: headingMatch[2]!.trim(),
    });
  }
  for (let i = 1; i < headingMatches.length; i++) {
    const prev = headingMatches[i - 1]!;
    const curr = headingMatches[i]!;
    const gap = curr.level - prev.level;
    if (gap > 1) {
      issues.push({
        pageNumber,
        type: "HEADING_GAP",
        detail: `Heading hierarchy gap on page ${pageNumber}: "${prev.text}" (H${prev.level}) to "${curr.text}" (H${curr.level}). Skipped ${gap - 1} level(s).`,
        severity: "warning",
      });
      logger.warn(
        `[ocr] Heading gap on page ${pageNumber}: H${prev.level} to H${curr.level}`
      );
    }
  }

  const lines = resultMarkdown.split("\n");
  const tableInfo = parseTableColumns(lines);
  if (tableInfo) {
    for (const row of tableInfo.rows) {
      if (row.cols !== tableInfo.headerCols) {
        issues.push({
          pageNumber,
          type: "TABLE_MISMATCH",
          detail: `Table column mismatch on page ${pageNumber}: expected ${tableInfo.headerCols} columns, got ${row.cols} in data row. Auto-fixed by padding.`,
          severity: "error",
        });
        logger.error(
          `[ocr] Table column mismatch on page ${pageNumber}: expected ${tableInfo.headerCols}, got ${row.cols}`
        );
        const originalLine = lines[row.index]!;
        const existingCells = originalLine.split("|").filter(Boolean);
        while (existingCells.length < tableInfo.headerCols) {
          existingCells.push(" ");
        }
        lines[row.index] = "| " + existingCells.join(" | ") + " |";
        resultMarkdown = lines.join("\n");
      }
    }
  }

  // The degeneration (4-gram uniqueness) checks are skipped for KB/archive
  // jobs (skipDegeneration=true) — those jobs opt out via ocrStages so
  // legitimately repetitive text (e.g. legislative documents) is not
  // discarded. The empty-output check above is unconditional. The
  // unverified-tag ratio, handwriting, fence/heading/table checks all
  // remain active regardless of skipDegeneration.
  if (!skipDegeneration) {
    const uniqueness = computeFourGramUniqueness(resultMarkdown);
    if (uniqueness < 0.3) {
      // Extreme degeneration: the output is almost entirely repetitive.
      // Discard it completely — saving garbage is worse than an error marker.
      const issueType = "EMPTY_OUTPUT" as const; // treat as effectively empty
      issues.push({
        pageNumber,
        type: issueType,
        detail: `Text degeneration detected on page ${pageNumber}: 4-gram uniqueness ratio is ${(uniqueness * 100).toFixed(1)}% (< 30%). Output discarded as it contains only repetitive/looping text.`,
        severity: "error",
      });
      logger.warn(
        `[ocr] Severe text degeneration on page ${pageNumber}: uniqueness=${uniqueness.toFixed(2)}, output discarded`
      );
      return {
        markdown: `[FAILED: OCR output for page ${pageNumber} was discarded — severe text degeneration detected (${(uniqueness * 100).toFixed(0)}% unique 4-grams). Retry with a different OCR mode or model.]`,
        hasUnverified: false,
        unverifiedCount: 0,
        hasHandwriting: false,
        hasEmpty: true,
        issues,
      };
    }

    if (uniqueness < 0.5) {
      issues.push({
        pageNumber,
        type: "UNVERIFIED_TAG",
        detail: `Possible text degeneration detected on page ${pageNumber}: 4-gram uniqueness ratio is ${(uniqueness * 100).toFixed(1)}% (< 50%). Repetitive output may indicate model looping.`,
        severity: "warning",
      });
      logger.warn(
        `[ocr] Text degeneration detected on page ${pageNumber}: uniqueness=${uniqueness.toFixed(2)}`
      );
      resultMarkdown = `[WARNING: Possible text degeneration detected — repetitive output. Verify content manually.]\n${resultMarkdown}`;
    }
  }

  let unverifiedCharCount = 0;
  for (const match of unverifiedMatches) {
    unverifiedCharCount += match[0].length;
  }
  const totalChars = countChars(resultMarkdown);
  const unverifiedRatio =
    totalChars > 0 ? unverifiedCharCount / totalChars : 0;
  if (unverifiedRatio > 0.5) {
    issues.push({
      pageNumber,
      type: "UNVERIFIED_TAG",
      detail: `Over 50% of page ${pageNumber} content is marked UNVERIFIED (${(unverifiedRatio * 100).toFixed(1)}%). Source may be illegible.`,
      severity: "warning",
    });
    logger.warn(
      `[ocr] Critical UNVERIFIED ratio on page ${pageNumber}: ${(unverifiedRatio * 100).toFixed(1)}%`
    );
    resultMarkdown = `[WARNING: Over 50% of this page is marked UNVERIFIED. Source may be illegible.]\n${resultMarkdown}`;
  }

  return {
    markdown: resultMarkdown,
    hasUnverified,
    unverifiedCount,
    hasHandwriting,
    hasEmpty,
    issues,
  };
}
