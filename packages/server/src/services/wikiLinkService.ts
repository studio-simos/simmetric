// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma from "../utils/prisma";
import { propagateRename } from "./archiveBacklinkService";

export interface ResolvedWikilink {
  slug: string;
  title: string;
  exists: boolean;
  category?: string;
}

/**
 * Resolve an array of wikilink slugs to page metadata.
 * Deduplicates slugs internally and strips aliases/anchors.
 */
export async function resolveWikilinks(
  slugs: string[],
  archiveId?: string,
): Promise<ResolvedWikilink[]> {
  if (slugs.length === 0) return [];
  const uniqueSlugs = [...new Set(slugs.map(s => s.split("|")[0]!.split("#")[0]!.trim()))];

  const pages = await prisma.archivePage.findMany({
    where: {
      slug: { in: uniqueSlugs },
      deletedAt: null,
      ...(archiveId && { archiveId }),
    },
    select: { slug: true, title: true, category: true },
  });

  const pageMap = new Map(pages.map(p => [p.slug, p]));

  return uniqueSlugs.map(slug => {
    const page = pageMap.get(slug) as { title: string; category: string | null } | undefined;
    return {
      slug,
      title: page?.title || slug,
      exists: !!page,
      category: page?.category || undefined,
    };
  });
}

/**
 * Extract [[wikilinks]] from Markdown content.
 * Handles aliases ([[target|alias]]) and headings ([[target#heading]]).
 * Returns deduplicated array of target slugs.
 */
export function extractWikilinkSlugs(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g;
  return [...new Set([...content.matchAll(regex)].map(m => m[1]!.split("|")[0]!.split("#")[0]!.trim()))];
}

/**
 * Redirect wikilinks across an archive per a { oldSlug: newSlug } mapping
 * (Phase 79-04 D-11). Thin wrapper over the tested `propagateRename` —
 * calls it once per entry (A→C, B→C for a 2-page merge). Each propagateRename
 * call has its own per-page try/catch + git commit, so a partial failure is
 * recoverable and non-fatal to the caller.
 */
export async function redirectWikilinks(
  archiveId: string,
  mapping: Record<string, string>,
  userId: string,
): Promise<void> {
  for (const [oldSlug, newSlug] of Object.entries(mapping)) {
    if (oldSlug === newSlug) continue;
    await propagateRename(archiveId, oldSlug, newSlug, userId);
  }
}
