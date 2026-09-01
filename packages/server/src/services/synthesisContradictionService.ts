// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { logger } from "../utils/logger";
import { callSynthesisLLM } from "./synthesisService";

// ===== Types =====

/**
 * Minimal ArchivePage shape matching the Prisma model fields used by this service.
 * Defined locally since @simmetric-chat/shared does not yet export an ArchivePage type.
 */
export interface ArchivePage {
  id: string;
  archiveId: string;
  slug: string;
  title: string;
  bodyText: string;
  wikilinks: string[];
  createdAt: Date;
  createdBy: string;
}

/**
 * Matches the shape defined in synthesisContradictionItemSchema (Plan 01),
 * extended with an optional `reason` from the per-pair LLM judgment (D-08,
 * additive — does not break the existing schema).
 */
export interface SynthesisContradictionItem {
  pageSlug: string;
  claimA: { text: string; source: string; date: string };
  claimB: { text: string; source: string; date: string };
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason?: string;
}

// ===== Constants =====

/**
 * Jaccard token overlap threshold (D-07). Calibrated on the D-17 fixture:
 *   - cost-page vs cost-update (contradictory): Jaccard ≈ 0.67
 *   - cost-page vs cost-context (high overlap, no contradiction): Jaccard ≈ 0.33
 *   - cost-page vs weather (unrelated): Jaccard = 0
 * 0.15 keeps the contradictory pair and the high-overlap pair while excluding
 * the negative control, so the LLM judgment (D-08) decides whether the
 * overlap is a real contradiction.
 */
const JACCARD_THRESHOLD = 0.15;

/**
 * Stopword set covering EN + IT basic stopwords (D-07). Pure TS, no deps.
 */
const STOPWORDS = new Set<string>([
  // English
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "is", "are", "was",
  "were", "be", "for", "on", "at", "by", "with", "as", "that", "this", "it",
  "from", "has", "have", "had", "not", "will", "would", "can", "could",
  // Italian
  "il", "la", "di", "e", "un", "una", "uno", "del", "della", "dei", "al",
  "alla", "ai", "alle", "da", "per", "con", "su", "tra", "fra", "che",
  "chi", "come", "cosa", "quando", "dove", "perché", "se", "non", "più",
  "sono", "essere", "stato", "stata", "stati", "state", "ho", "ha", "hai",
  "ha", "abbiamo", "avete", "hanno", "mio", "mia", "tuo", "tua", "suo",
  "sua", "questo", "questa", "quello", "quella",
]);

// ===== Tokenization + Jaccard (D-07) =====

/**
 * Tokenize text for Jaccard overlap: lowercase, replace non-letter/number
 * characters with space, split on whitespace, filter tokens with length > 2
 * and non-stopword. Pure, deterministic, air-gap compatible.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/**
 * Jaccard coefficient on two token sets: |A ∩ B| / |A ∪ B|.
 * Returns 0 if either set is empty. Pure, deterministic.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ===== Wikilink extraction (kept — used elsewhere) =====

/**
 * Extract [[wikilinks]] from Markdown content.
 * Handles aliases ([[target|alias]]) and headings ([[target#heading]]).
 * Returns deduplicated array of target slugs.
 */
function extractWikilinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g;
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const target = match[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (target) {
      links.add(target);
    }
  }
  return Array.from(links);
}

// Phase 180 dead-code sweep: the defensive `export { extractWikilinks }`
// re-export was REMOVED — the "existing callers" it guarded against never
// materialized (zero importers; detectContradictions below is the only
// consumer and it lives in this file).

// ===== Jaccard pair candidates (D-07) =====

export interface JaccardPair {
  a: ArchivePage;
  b: ArchivePage;
  overlap: number;
}

/**
 * Pair new/modified pages with existing pages by Jaccard token overlap (D-07).
 * Replaces the legacy wikilink-overlap prefilter (which required 3 shared
 * `[[wikilinks]]` — the root-cause of `contradictionsFound=0`).
 *
 * Pairs with overlap >= JACCARD_THRESHOLD are returned, sorted descending by
 * overlap so the BudgetTracker processes the highest-overlap pairs first (D-09).
 * Self-pairs (a.id === b.id) are filtered out.
 */
export function jaccardPairCandidates(
  newPages: ArchivePage[],
  existingPages: ArchivePage[],
): JaccardPair[] {
  if (newPages.length === 0 || existingPages.length === 0) return [];

  const pairs: JaccardPair[] = [];
  for (const np of newPages) {
    const tokensA = tokenize(np.bodyText);
    for (const ep of existingPages) {
      if (np.id === ep.id) continue; // self-pair filter
      const tokensB = tokenize(ep.bodyText);
      const overlap = jaccard(tokensA, tokensB);
      if (overlap >= JACCARD_THRESHOLD) {
        pairs.push({ a: np, b: ep, overlap });
      }
    }
  }
  pairs.sort((x, y) => y.overlap - x.overlap);
  return pairs;
}

// ===== Contradiction Marker (kept — used elsewhere) =====

/**
 * Build an inline Markdown contradiction marker per D-06.
 *
 * Format: [CONTRADICTION: source=<sourceFileName>, date=<sourceDate>]<claim>[/CONTRADICTION]
 *
 * The date must be ISO 8601 format. Inputs come from trusted sources
 * (sourceFileName from the database, sourceDate from system clock).
 */
export function buildContradictionMarker(
  claim: string,
  sourceFileName: string,
  sourceDate: string,
): string {
  return `[CONTRADICTION: source=${sourceFileName}, date=${sourceDate}]${claim}[/CONTRADICTION]`;
}

// ===== Claim Summary Extraction (reused for D-08 prompt) =====

/**
 * Extract the first meaningful sentence or paragraph from bodyText.
 *
 * - Skips heading lines (starting with # or whitespace + #)
 * - Skips empty lines
 * - Skips frontmatter blocks (delimited by --- lines)
 * - Truncates to maxLength characters
 */
export function extractClaimSummary(
  bodyText: string,
  maxLength: number = 300,
): string {
  if (!bodyText || bodyText.trim() === "") return "";

  const lines = bodyText.split("\n");

  // Skip frontmatter if present
  let startIdx = 0;
  if (lines[0]?.trim() === "---") {
    let inFrontmatter = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        if (!inFrontmatter) {
          inFrontmatter = true;
        } else {
          startIdx = i + 1;
          break;
        }
      }
    }
  }

  // Find first non-empty, non-heading line
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "") continue;
    if (/^#{1,6}\s/.test(trimmed)) continue;

    const firstSentence = extractFirstSentence(trimmed);
    return firstSentence.slice(0, maxLength);
  }

  return "";
}

function extractFirstSentence(text: string): string {
  const match = text.match(/(.+?[.!?])(?:\s|$)/);
  if (match) {
    return match[1]!;
  }
  return text;
}

// ===== Per-pair LLM judgment (D-08) =====

/**
 * Ask the LLM whether two page claims are in contradiction (D-08).
 *
 * Reuses `callSynthesisLLM` (PHI gate D-15 inherited) and `extractClaimSummary`
 * for the prompt. 1 LLM call per pair. Returns a SynthesisContradictionItem on
 * `contradiction: true`, null on `contradiction: false`.
 *
 * On LLM throw or parse failure, re-throws so the caller routes through
 * `recordLlmFailure` (SC4 conservative choice — D-13 abort counters preserved).
 */
export async function judgePairContradiction(
  pageA: ArchivePage,
  pageB: ArchivePage,
  archiveId: string,
): Promise<SynthesisContradictionItem | null> {
  const claimA = extractClaimSummary(pageA.bodyText);
  const claimB = extractClaimSummary(pageB.bodyText);
  const prompt =
    `Claim A: "${claimA}"\nClaim B: "${claimB}"\n` +
    `Are these two claims in contradiction? Reply JSON: { "contradiction": boolean, "reason": string }`;

  const { content } = await callSynthesisLLM(prompt, undefined, archiveId);

  // Robust JSON extraction — mirror parseDecisionJson: first {...} block.
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Unparseable → treat as "no contradiction" rather than throw. The LLM
    // returned something, just not JSON. Throwing on parse failure would
    // trip recordLlmFailure for a non-LLM-failure reason. The conservative
    // SC4 path is for actual LLM failures (throw), not non-JSON responses.
    return null;
  }

  let parsed: { contradiction?: boolean; reason?: string };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (parsed.contradiction !== true) return null;

  return {
    pageSlug: pageA.slug,
    claimA: {
      text: claimA || pageA.bodyText.slice(0, 300),
      source: pageA.slug,
      date: pageA.createdAt.toISOString(),
    },
    claimB: {
      text: claimB || pageB.bodyText.slice(0, 300),
      source: pageB.slug,
      date: pageB.createdAt.toISOString(),
    },
    confidence: "HIGH",
    reason: parsed.reason || "",
  };
}

// ===== Contradiction Detection (refactored — D-06/D-07/D-08/D-09) =====

/**
 * Minimal BudgetTracker interface consumed by detectContradictions. Matches
 * the shape exported by synthesisBudgetService.ts.
 */
interface BudgetTrackerLike {
  canContinue(passName: string): boolean;
  consumeLlmCall(passName: string): boolean;
  consumeTokens?(tokens: number, passName: string): boolean;
}

export interface DetectContradictionsArgs {
  newPages: ArchivePage[];
  existingPages: ArchivePage[];
  archiveId: string;
  tracker: BudgetTrackerLike;
  recordLlmFailure: (pageSlug: string, passName: string, err: unknown) => boolean;
  passName?: string;
}

/**
 * Detect contradictions between new/modified pages and existing archive pages.
 *
 * Replaces the dual-gated legacy implementation (LLM `FLAG_CONTRADICTION` AND
 * legacy wikilink-overlap prefilter — root-cause of
 * `contradictionsFound=0`). The new pass is independent of the Pass 4 LLM
 * verdict (D-06):
 *   1. Pair new vs existing pages by Jaccard token overlap (D-07).
 *   2. For each pair above threshold (descending overlap), check the budget
 *      tracker (D-09). If exhausted, log truncated pairs and stop.
 *   3. Call `judgePairContradiction` (D-08) per pair. On LLM failure, route
 *      through `recordLlmFailure` (SC4 conservative — preserves D-13 abort
 *      counters). If recordLlmFailure returns true (abort threshold reached),
 *      stop processing.
 *   4. Accumulate contradictions[] and return.
 */
export async function detectContradictions(
  args: DetectContradictionsArgs,
): Promise<SynthesisContradictionItem[]> {
  const {
    newPages,
    existingPages,
    archiveId,
    tracker,
    recordLlmFailure,
    passName = "pass4b_contradiction",
  } = args;

  const pairs = jaccardPairCandidates(newPages, existingPages);
  if (pairs.length === 0) return [];

  const contradictions: SynthesisContradictionItem[] = [];
  const truncated: Array<{ a: string; b: string; overlap: number }> = [];

  for (const pair of pairs) {
    if (!tracker.canContinue(passName)) {
      // Budget exhausted — log pairs not judged (D-09: no silent cap) and stop.
      truncated.push({ a: pair.a.slug, b: pair.b.slug, overlap: pair.overlap });
      continue;
    }

    try {
      const item = await judgePairContradiction(pair.a, pair.b, archiveId);
      tracker.consumeLlmCall(passName);
      if (item) {
        contradictions.push(item);
      }
    } catch (err: unknown) {
      const aborted = recordLlmFailure(pair.a.slug, passName, err);
      if (aborted) {
        // Abort threshold reached — stop processing. Remaining pairs are
        // implicitly truncated (logged below if any).
        logger.warn("[synthesis] pass4b_contradiction aborted by recordLlmFailure", {
          pass: passName,
          pageSlug: pair.a.slug,
        });
        break;
      }
      // Continue to the next pair on a non-aborting failure.
    }
  }

  if (truncated.length > 0) {
    logger.warn("[synthesis] pass4b_contradiction budget truncated pairs not judged", {
      pass: passName,
      truncatedCount: truncated.length,
      truncated, // includes slugs + overlap so the operator can see what was missed
    });
  }

  return contradictions;
}