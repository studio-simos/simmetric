// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma from "../utils/prisma";
import { computeRelatedPairs } from "./archiveRelatedService";

export interface GraphNode {
  id: string;
  title: string;
  category: string;
  slug: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface ArchiveGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function buildArchiveGraph(archiveId: string): Promise<ArchiveGraph> {
  const pages = await prisma.archivePage.findMany({
    where: { archiveId, deletedAt: null },
    select: { id: true, slug: true, title: true, category: true, wikilinks: true },
  });

  const nodes: GraphNode[] = pages.map((p) => ({
    id: p.slug,
    title: p.title,
    category: p.category,
    slug: p.slug,
  }));

  const nodeSet = new Set(pages.map((p) => p.slug));
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];

  // 1. Explicit wikilinks: [[Page Title]] or [[slug|title]] syntax
  for (const page of pages) {
    for (const link of page.wikilinks || []) {
      const targetSlug = link.split("|")[0]!.trim();
      if (nodeSet.has(targetSlug) && targetSlug !== page.slug) {
        const key = [page.slug, targetSlug].sort().join("<->");
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: page.slug, target: targetSlug });
        }
      }
    }
  }

  // 2. Related-page connections: use the same Jaccard token-overlap algorithm
  //    as the sidebar's "related pages" count (computeRelatedPairs). This
  //    ensures the graph edges match exactly what the page list shows.
  const pairs = await computeRelatedPairs(archiveId);
  for (const { a, b } of pairs) {
    const key = [a, b].sort().join("<->");
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({ source: a, target: b });
    }
  }

  return { nodes, edges };
}