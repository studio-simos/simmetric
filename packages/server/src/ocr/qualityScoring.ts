// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Quality confidence scoring for OCR pipeline output.
 *
 * Computes per-page scores and document-level aggregate scores
 * using weighted heuristic deductions (no LLM calls, sub-1ms).
 *
 * Deduction rules:
 * - UNVERIFIED ratio bands: 0%→0, 1-10%→-1, 11-30%→-2, 31-50%→-3, 50%+→-4
 * - Error-severity guard issues: -0.5 each
 * - Warning-severity guard issues: -0.25 each
 * - Clamped to 1-5 range, rounded to nearest integer
 */

interface PageQualityEntry {
  pageNumber: number;
  score: number;
  unverifiedRatio: number;
}

export interface QualityScore {
  overall: number;
  perPage: PageQualityEntry[];
  summary: string;
}

/**
 * Compute a per-page quality score (1-5).
 *
 * Starts from a perfect 5 and deducts based on:
 * - UNVERIFIED tag ratio relative to total word count
 * - Error-severity guard issues (-0.5 each)
 * - Warning-severity guard issues (-0.25 each)
 *
 * @param markdown - The page's OCR markdown output
 * @param hasUnverified - Whether UNVERIFIED tags are present
 * @param unverifiedCount - Number of UNVERIFIED tag occurrences
 * @param guardIssues - Issues from the hallucination guard
 * @returns Integer score between 1 and 5
 */
export function computePageQualityScore(
  markdown: string,
  hasUnverified: boolean,
  unverifiedCount: number,
  guardIssues: Array<{ type: string; severity: string }>
): number {
  let score = 5;

  // Count total words for ratio calculation
  const totalWordCount = markdown.trim().split(/\s+/).length || 1;

  // Deduct based on UNVERIFIED ratio
  if (hasUnverified && unverifiedCount > 0) {
    const unverifiedRatio = unverifiedCount / totalWordCount;

    if (unverifiedRatio <= 0.01) {
      // 0% — no deduction
    } else if (unverifiedRatio <= 0.10) {
      // 1-10% → -1
      score -= 1;
    } else if (unverifiedRatio <= 0.30) {
      // 11-30% → -2
      score -= 2;
    } else if (unverifiedRatio <= 0.50) {
      // 31-50% → -3
      score -= 3;
    } else {
      // 50%+ → -4 (floor at 1)
      score -= 4;
    }
  }

  // Deduct per issue severity
  for (const issue of guardIssues) {
    if (issue.severity === "error") {
      score -= 0.5;
    } else if (issue.severity === "warning") {
      score -= 0.25;
    }
  }

  // Clamp to 1-5 range and round to nearest integer
  const clamped = Math.max(1, Math.min(5, score));
  return Math.round(clamped);
}

/**
 * Compute a document-level quality score from per-page scores.
 *
 * Calculates weighted overall average across all pages and generates
 * a human-readable summary describing the quality level.
 *
 * @param pageScores - Array of per-page scores with page numbers
 * @param _totalDurationMs - Total OCR job duration (reserved for future use)
 * @param _totalTokens - Total tokens consumed (reserved for future use)
 * @returns QualityScore with overall, perPage, and summary
 */
export function computeDocumentQualityScore(
  pageScores: Array<{ score: number; pageNumber: number }>,
  _totalDurationMs: number,
  _totalTokens: number
): QualityScore {
  const pageCount = pageScores.length;

  if (pageCount === 0) {
    return {
      overall: 1,
      perPage: [],
      summary: getSummaryForScore(1),
    };
  }

  // Compute overall: average of page scores, clamped to 1-5, rounded
  const sum = pageScores.reduce((acc, p) => acc + p.score, 0);
  const rawOverall = sum / pageCount;
  const overall = Math.max(1, Math.min(5, Math.round(rawOverall)));

  const perPage: PageQualityEntry[] = pageScores.map((p) => ({
    pageNumber: p.pageNumber,
    score: p.score,
    unverifiedRatio: 0, // Source data not available at this level
  }));

  return {
    overall,
    perPage,
    summary: getSummaryForScore(overall),
  };
}

/**
 * Get a human-readable summary string for a quality score (1-5).
 */
function getSummaryForScore(score: number): string {
  switch (score) {
    case 5:
      return "Excellent — clean transcription with no issues detected";
    case 4:
      return "Good — minor issues, transcription is reliable";
    case 3:
      return "Acceptable — some structural issues or moderate uncertainty, verify key sections";
    case 2:
      return "Poor — significant uncertainty or structural corruption, requires careful review";
    case 1:
      return "Unusable — most content is uncertain or corrupted, do not rely on this output";
    default:
      return "Unknown quality level";
  }
}

/**
 * Compute the source quality score (OCR-07).
 *
 * This is the pre-ingestion source quality that the user can set.
 * It is distinct from the OCR pipeline's quality score — this reflects
 * the quality of the source document itself (legibility, scan quality).
 *
 * @param userProvidedScore - Optional user-provided score (1-5)
 * @returns Source quality score (user-provided or default 3)
 */
export function computeSourceQualityScore(
  userProvidedScore: number | undefined
): number {
  if (
    userProvidedScore !== undefined &&
    userProvidedScore >= 1 &&
    userProvidedScore <= 5
  ) {
    return userProvidedScore;
  }
  return 3; // Default: neutral/unknown source quality
}
