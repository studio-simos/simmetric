// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Synthesis Orphan Service — SYNTH-07
 *
 * Detects orphan pages (pages with no incoming wikilinks or standard
 * Markdown references) and broken wikilinks (wikilinks pointing to
 * non-existent page slugs).
 *
 * RESEARCH Pitfall 5: A page is only orphaned if BOTH the wikilinks array
 * AND standard Markdown links in other pages' bodyText yield zero references.
 */

import { logger } from "../utils/logger";
import prisma from "../utils/prisma";

// ============================================================================
// Constants
// ============================================================================

// System pages that should never be flagged as orphans
const SYSTEM_SLUGS = new Set(["_index", "log"]);

// Categories to exclude from orphan detection (SYNTH-07 targets content pages)
const EXCLUDED_CATEGORIES = new Set(["inventory"]);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Escape special regex characters in a string for safe pattern matching.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// detectOrphanPages — find pages with no incoming references (SYNTH-07)
// ============================================================================

export async function detectOrphanPages(
  archiveId: string,
): Promise<Array<{ slug: string; title: string }>> {
  try {
    const pages = await prisma.archivePage.findMany({
      where: { archiveId, deletedAt: null },
      select: {
        slug: true,
        title: true,
        category: true,
        wikilinks: true,
        bodyText: true,
      },
    });

    if (pages.length === 0) return [];

    const orphanResults: Array<{ slug: string; title: string }> = [];

    for (const page of pages) {
      const slug = page.slug;

      // Exclude system pages
      if (SYSTEM_SLUGS.has(slug)) continue;

      // Exclude inventory category pages (SYNTH-07 targets content pages)
      if (EXCLUDED_CATEGORIES.has(page.category)) continue;

      // A page with outgoing wikilinks is connected (not an orphan),
      // even if no other page references it back.
      const pageWikilinks: string[] = Array.isArray(page.wikilinks)
        ? (page.wikilinks as string[])
        : [];
      if (pageWikilinks.length > 0) continue;

      // Check 1: Does any other page have this slug in its wikilinks array?
      let hasWikilinkRef = false;
      for (const other of pages) {
        if (other.slug === slug) continue;
        const otherWikilinks: string[] = Array.isArray(other.wikilinks)
          ? (other.wikilinks as string[])
          : [];
        if (otherWikilinks.includes(slug)) {
          hasWikilinkRef = true;
          break;
        }
      }

      if (hasWikilinkRef) continue;

      // Check 2: Does any other page's bodyText contain a standard Markdown
      //          link referencing this page? Pattern: [text](slug.md)
      let hasMarkdownRef = false;
      const mdLinkPattern = new RegExp(
        `\\[.*?\\]\\(${escapeRegex(slug)}\\.md\\)`,
        "i",
      );

      for (const other of pages) {
        if (other.slug === slug) continue;
        if (mdLinkPattern.test(other.bodyText || "")) {
          hasMarkdownRef = true;
          break;
        }
      }

      // Page is ONLY orphaned if BOTH checks yield zero references (Pitfall 5)
      if (!hasMarkdownRef) {
        orphanResults.push({ slug: page.slug, title: page.title });
      }
    }

    logger.info("[synthesis] Orphan detection complete", {
      archiveId,
      totalPages: pages.length,
      orphansFound: orphanResults.length,
    });

    return orphanResults;
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] Orphan detection failed", {
      archiveId,
      error: message,
    });
    return [];
  }
}

// ============================================================================
// detectBrokenWikilinks — find wikilinks pointing to non-existent slugs
// ============================================================================

export async function detectBrokenWikilinks(
  archiveId: string,
): Promise<Array<{ sourcePageSlug: string; brokenTarget: string }>> {
  try {
    const pages = await prisma.archivePage.findMany({
      where: { archiveId, deletedAt: null },
      select: {
        slug: true,
        wikilinks: true,
      },
    });

    if (pages.length === 0) return [];

    // Build the set of all valid page slugs
    const validSlugs = new Set(pages.map((p) => p.slug));

    const brokenResults: Array<{
      sourcePageSlug: string;
      brokenTarget: string;
    }> = [];

    for (const page of pages) {
      const wikilinks: string[] = Array.isArray(page.wikilinks)
        ? (page.wikilinks as string[])
        : [];

      for (const target of wikilinks) {
        if (!validSlugs.has(target)) {
          brokenResults.push({
            sourcePageSlug: page.slug,
            brokenTarget: target,
          });
        }
      }
    }

    logger.info("[synthesis] Broken wikilink detection complete", {
      archiveId,
      totalPages: pages.length,
      brokenFound: brokenResults.length,
    });

    return brokenResults;
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] Broken wikilink detection failed", {
      archiveId,
      error: message,
    });
    return [];
  }
}
