// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

export interface MaintenanceSuggestion {
  type: "stale" | "contradiction" | "redlink";
  pageSlug: string;
  message: string;
}

/**
 * MergeSuggestion (Phase 79-04 D-09) — SEPARATE from MaintenanceSuggestion.
 *
 * Detects conceptually duplicate/similar pages via a multi-criteria heuristic
 * (D-08): title-normalized match OR content-overlap (wikilink Jaccard / token
 * Jaccard on page bodies). Returned alongside the existing `suggestions` array
 * (D-10 backward-compatible response shape).
 */
export interface MergeSuggestion {
  pageA: string;
  pageB: string;
  similarity: number;
  reason: "title-normalized" | "content-overlap";
  message?: string;
}

// ---------------------------------------------------------------------------
// D-08 heuristic helpers — conservative thresholds (Claude's discretion) to
// minimize false positives. The merge endpoint is human-triggered (divergence
// #3), so a missed pair is recoverable by the admin; a false positive just
// surfaces a suggestion the admin dismisses.
// ---------------------------------------------------------------------------
const TITLE_EDIT_DISTANCE_RATIO = 0.1; // ≤10% of max normalized-title length
const LINK_JACCARD_THRESHOLD = 0.5; // shared half of wikilinks
const TOKEN_JACCARD_THRESHOLD = 0.4; // top-50 token overlap

/**
 * Normalize a page title for duplicate detection: lowercase, strip diacritics
 * and punctuation, collapse whitespace to `-`. "Café Corp." and "cafe-corp"
 * both normalize to "cafe-corp".
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^\w\s]/g, "") // strip punctuation
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Tokenize page body for content-overlap Jaccard: lowercase, split on
 * non-word, filter tokens longer than 3 chars (stop-word heuristic), sort
 * deterministically so `slice(0, 50)` is stable across calls.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .sort();
}

/**
 * Standard Levenshtein edit distance (DP). Used for fuzzy title matching so
 * near-duplicates ("ACME Corp" vs "ACME Corporation") still surface.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/**
 * Generate proactive maintenance suggestions for a wiki archive.
 *
 * Checks for:
 * 1. Stale pages — not updated in 30+ days
 * 2. Flagged contradictions — pages with frontmatter.flaggedContradictions > 0
 * 3. Redlinks — wikilink references pointing to non-existent pages
 * 4. Merge suggestions (D-08/D-09) — duplicate/similar page pairs detected via
 *    title-normalized match OR content-overlap (wikilink/token Jaccard).
 *
 * Returns `{ suggestions, mergeSuggestions }` (D-10 backward-compatible — the
 * `suggestions` field is preserved verbatim; `mergeSuggestions` is additive).
 */
export async function getMaintenanceSuggestions(
  _workspaceId: string,
  archiveId: string,
): Promise<{ suggestions: MaintenanceSuggestion[]; mergeSuggestions: MergeSuggestion[] }> {
  const suggestions: MaintenanceSuggestion[] = [];
  const mergeSuggestions: MergeSuggestion[] = [];

  try {
    // 1. Stale pages (not updated in 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const stalePages = await prisma.archivePage.findMany({
      where: {
        archiveId,
        deletedAt: null,
        updatedAt: { lt: thirtyDaysAgo },
      },
      select: { slug: true, title: true, updatedAt: true },
    });

    for (const page of stalePages) {
      suggestions.push({
        type: "stale",
        pageSlug: page.slug,
        message: `Page "${page.title}" was last updated on ${page.updatedAt.toISOString().split("T")[0]} and may be outdated.`,
      });
    }

    // 2. Pages with flagged contradictions in frontmatter JSON
    // D-11: typed $queryRaw row — the SELECT projects quoted camelCase aliases
    // (Pitfall 3), so the row interface mirrors the projection verbatim.
    interface ContradictionPageRow {
      slug: string;
      title: string;
      frontmatter: Prisma.JsonObject | null;
    }
    const contradictionPages: Array<ContradictionPageRow> = await prisma.$queryRaw<Array<ContradictionPageRow>>`
      SELECT "slug", "title", "frontmatter"
      FROM "archive_pages"
      WHERE "deletedAt" IS NULL
        AND "archiveId" = ${archiveId}
        AND ("frontmatter"->>'flaggedContradictions')::int > 0
    `;

    for (const page of contradictionPages) {
      const fm = page.frontmatter as Record<string, unknown> | null;
      const count = (fm?.flaggedContradictions as number) ?? 0;
      suggestions.push({
        type: "contradiction",
        pageSlug: page.slug as string,
        message: `Page "${page.title}" has ${count} flagged contradiction(s) from synthesis.`,
      });
    }

    // 3. Redlinks — referenced wikilinks with no corresponding page slug.
    // D-08: reuse the same `pages` findMany for merge heuristic (zero extra
    // queries) by adding `bodyText` to the select.
    const pages = await prisma.archivePage.findMany({
      where: { archiveId, deletedAt: null },
      select: { slug: true, title: true, wikilinks: true, bodyText: true },
    });

    const existingSlugs = new Set(pages.map((p) => p.slug));
    const redlinkSet = new Set<string>();

    for (const page of pages) {
      for (const link of page.wikilinks || []) {
        if (!existingSlugs.has(link)) {
          redlinkSet.add(link);
        }
      }
    }

    for (const link of redlinkSet) {
      suggestions.push({
        type: "redlink",
        pageSlug: link,
        message: `Referenced wikilink [[${link}]] points to a page that does not exist.`,
      });
    }

    // 4. Merge suggestions (D-08/D-09) — in-memory pairwise scan over `pages`.
    for (let i = 0; i < pages.length; i++) {
      for (let j = i + 1; j < pages.length; j++) {
        const a = pages[i]!;
        const b = pages[j]!;

        const normA = normalizeTitle(a.title);
        const normB = normalizeTitle(b.title);
        const maxLen = Math.max(normA.length, normB.length, 1);
        const titleDist = levenshtein(normA, normB);
        const titleMatch =
          normA === normB || titleDist <= Math.max(1, Math.floor(maxLen * TITLE_EDIT_DISTANCE_RATIO));

        const linksA = new Set(a.wikilinks || []);
        const linksB = new Set(b.wikilinks || []);
        const linkInter = [...linksA].filter((x) => linksB.has(x)).length;
        const linkUnion = new Set([...linksA, ...linksB]).size;
        const linkJaccard = linkUnion > 0 ? linkInter / linkUnion : 0;

        const tokA = new Set(tokenize(a.bodyText || "").slice(0, 50));
        const tokB = new Set(tokenize(b.bodyText || "").slice(0, 50));
        const tokInter = [...tokA].filter((x) => tokB.has(x)).length;
        const tokUnion = new Set([...tokA, ...tokB]).size;
        const tokJaccard = tokUnion > 0 ? tokInter / tokUnion : 0;

        if (titleMatch) {
          mergeSuggestions.push({
            pageA: a.slug,
            pageB: b.slug,
            similarity: 1 - titleDist / maxLen,
            reason: "title-normalized",
            message: `Pages "${a.title}" and "${b.title}" have normalized-title match (edit distance ${titleDist}).`,
          });
        } else if (linkJaccard >= LINK_JACCARD_THRESHOLD || tokJaccard >= TOKEN_JACCARD_THRESHOLD) {
          mergeSuggestions.push({
            pageA: a.slug,
            pageB: b.slug,
            similarity: Math.max(linkJaccard, tokJaccard),
            reason: "content-overlap",
            message: `Pages "${a.title}" and "${b.title}" overlap (link Jaccard ${linkJaccard.toFixed(2)}, token Jaccard ${tokJaccard.toFixed(2)}).`,
          });
        }
      }
    }

    logger.info("[maintenance] Suggestions generated", {
      archiveId,
      stale: stalePages.length,
      contradictions: contradictionPages.length,
      redlinks: redlinkSet.size,
      merges: mergeSuggestions.length,
      total: suggestions.length,
    });

    return { suggestions, mergeSuggestions };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[maintenance] Failed to generate suggestions", { error: message, archiveId });
    return { suggestions: [], mergeSuggestions: [] };
  }
}