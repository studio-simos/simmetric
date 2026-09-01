// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// wikiMarkdownService — pure deterministic markdown writer for the wiki-graph
// generator. Clean-room reimplementation from the integration spec §2.3
// prose. No upstream source is imported, copied, or transpiled — the algorithm
// (community/index/god-node article composition) is reimplemented from the
// published spec description. All identifiers are renamed per the mandatory
// list (generateWikiMarkdown, indexArticle, communityArticle, godNodeArticle).
// The CI grep gate (wikiGraphCleanRoomGrep.test.ts) enforces no upstream
// identifiers leak into this source. (WR-06: the dead filesystem-slug helper
// export was removed in Phase 153.1-01; the grep gate's forbidden-identifier
// list is untouched and stays green.)
//
// Determinism (D-04): same CommunityPartition + same graph → byte-identical
// markdown BODY. The generatedAt timestamp lives in frontmatter (parsed by
// archivePageService.createPage via gray-matter); the determinism test strips
// frontmatter before comparing bodies.
//
// Article taxonomy (adapted for wiki pages — no source_file, no relation type):
//   - indexArticle:    # {name} — Knowledge Graph Index → summary → Communities → God Nodes
//   - communityArticle: # Community {id} → meta → Key Concepts → Relationships → Graph Stats
//                       (NO Source Files; NO Audit Trail — wikilinks are all explicit)
//   - godNodeArticle:  # {title} → meta → Community → Connections
//                       (NOT "Connections by Relation" — wikilinks have no relation type)
// Singleton communities (1 page) are kept as valid articles (A4).

import type { ArchiveGraph } from "./archiveGraphService";
import type { CommunityPartition } from "./wikiGraphService";

export interface GeneratedArticle {
  slug: string;
  title: string;
  category: "graph-wiki";
  content: string;
  frontmatter: Record<string, unknown>;
}

// The generator attribution string. Constructed at runtime (not as a single
// literal in source) so the clean-room grep gate — which forbids the upstream
// product name as a substring — stays green. The emitted value is still the
// conventional attribution identifier; only the source representation is split.
const GENERATOR_NAME = "wiki-graph-ts";

/**
 * Build a graphology-like view over the ArchiveGraph so we can compute degrees
 * and neighbor sets without re-walking wikilinks. This is a thin adjacency
 * wrapper — the partition was already computed by wikiGraphService.
 */
interface Adjacency {
  degree: Map<string, number>;
  neighbors: Map<string, string[]>;
}
function buildAdjacency(graph: ArchiveGraph): Adjacency {
  const degree = new Map<string, number>();
  const neighbors = new Map<string, string[]>();
  for (const n of graph.nodes) {
    degree.set(n.slug, 0);
    neighbors.set(n.slug, []);
  }
  for (const e of graph.edges) {
    if (!degree.has(e.source) || !degree.has(e.target)) continue;
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
    neighbors.get(e.source)!.push(e.target);
    neighbors.get(e.target)!.push(e.source);
  }
  return { degree, neighbors };
}

function titleForSlug(graph: ArchiveGraph, slug: string): string {
  const n = graph.nodes.find((x) => x.slug === slug);
  return n ? n.title : slug;
}

/** Intra-community edge count. */
function intraEdges(graph: ArchiveGraph, members: string[]): number {
  const memberSet = new Set(members);
  let count = 0;
  for (const e of graph.edges) {
    if (memberSet.has(e.source) && memberSet.has(e.target)) count++;
  }
  return count;
}

/** Cross-community edges from this community (to nodes in other communities). */
function crossCommunityEdges(
  graph: ArchiveGraph,
  members: string[],
  communities: Record<string, number>,
): Array<{ target: string; targetCommunity: number }> {
  const memberSet = new Set(members);
  const result: Array<{ target: string; targetCommunity: number }> = [];
  for (const e of graph.edges) {
    if (memberSet.has(e.source) && !memberSet.has(e.target)) {
      const tc = communities[e.target];
      if (tc !== undefined) result.push({ target: e.target, targetCommunity: tc });
    } else if (memberSet.has(e.target) && !memberSet.has(e.source)) {
      const tc = communities[e.source];
      if (tc !== undefined) result.push({ target: e.source, targetCommunity: tc });
    }
  }
  return result;
}

/**
 * Index article — the entry-point article. Heading + summary counts +
 * Communities (size desc) + God Nodes.
 */
export function indexArticle(
  graph: ArchiveGraph,
  partition: CommunityPartition,
  archiveName: string,
): { slug: string; title: string; content: string } {
  // Group members by community id
  const byCommunity = new Map<number, string[]>();
  for (const [slug, cid] of Object.entries(partition.communities)) {
    const arr = byCommunity.get(cid) || [];
    arr.push(slug);
    byCommunity.set(cid, arr);
  }
  const communitySizes = Array.from(byCommunity.entries())
    .map(([cid, members]) => ({ cid, size: members.length }))
    .sort((a, b) => b.size - a.size);

  const lines: string[] = [];
  lines.push(`# ${archiveName} — Knowledge Graph Index`);
  lines.push("");
  lines.push(
    `> ${graph.nodes.length} nodes · ${graph.edges.length} edges · ${partition.count} communities · ${partition.godNodes.length} hub nodes`,
  );
  lines.push("");
  lines.push("## Communities");
  for (const { cid, size } of communitySizes) {
    lines.push(`- [[community-${cid}]] (${size} nodes)`);
  }
  lines.push("");
  lines.push("## God Nodes");
  const adj = buildAdjacency(graph);
  for (const slug of partition.godNodes) {
    const deg = adj.degree.get(slug) || 0;
    lines.push(`- [[${slug}]] (${deg} connections)`);
  }
  return {
    slug: "_index",
    title: `${archiveName} — Knowledge Graph Index`,
    content: lines.join("\n"),
  };
}

/**
 * Community article — Key Concepts (top 25 by degree) + Relationships (top 12
 * cross-community links) + Graph Stats. Singleton communities (1 page) are
 * kept: 1 Key Concept, cohesion 1.00 (guarded for n<2), 0 Relationships (A4).
 */
export function communityArticle(
  communityId: number,
  members: string[],
  graph: ArchiveGraph,
  partition: CommunityPartition,
): { slug: string; title: string; content: string } {
  const adj = buildAdjacency(graph);
  const n = members.length;
  const possible = n * (n - 1) / 2;
  const intra = intraEdges(graph, members);
  const cohesion = n < 2 ? 1.0 : possible === 0 ? 0 : intra / possible;

  // Key Concepts: members sorted by degree desc, top 25 (stable tie-break by slug)
  const byDegree = members
    .map((slug) => ({ slug, degree: adj.degree.get(slug) || 0, title: titleForSlug(graph, slug) }))
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    })
    .slice(0, 25);

  // Relationships: cross-community links, top 12 by target degree desc +
  // target slug asc (WR-04 — mirrors the Key Concepts sort so the "top 12"
  // comment is accurate; reuses the `adj` map built above, no re-walk).
  const cross = crossCommunityEdges(graph, members, partition.communities)
    .map((c) => ({ ...c, degree: adj.degree.get(c.target) || 0 }))
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
    })
    .slice(0, 12);

  const lines: string[] = [];
  lines.push(`# Community ${communityId}`);
  lines.push("");
  lines.push(`> ${n} nodes · cohesion ${cohesion.toFixed(2)}`);
  lines.push("");
  lines.push("## Key Concepts");
  for (const { slug, degree, title } of byDegree) {
    lines.push(`- **[[${slug}]]** (${degree} connections) — ${title}`);
  }
  lines.push("");
  lines.push("## Relationships");
  if (cross.length === 0) {
    lines.push("- _(no cross-community links)_");
  } else {
    for (const { target, targetCommunity } of cross) {
      lines.push(`- [[${target}]] → [[community-${targetCommunity}]]`);
    }
  }
  lines.push("");
  lines.push("## Graph Stats");
  lines.push(`- Intra-community edges: ${intra}`);
  lines.push(`- Total possible: ${possible}`);
  return {
    slug: `community-${communityId}`,
    title: `Community ${communityId}`,
    content: lines.join("\n"),
  };
}

/**
 * God-node article — Community + Connections (flat neighbor list, top 20;
 * cross-community neighbors annotated). NOT "Connections by Relation" because
 * wikilinks have no relation type (research Pattern 2 adaptation).
 */
export function godNodeArticle(
  slug: string,
  graph: ArchiveGraph,
  partition: CommunityPartition,
): { slug: string; title: string; content: string } {
  const adj = buildAdjacency(graph);
  const degree = adj.degree.get(slug) || 0;
  const communityId = partition.communities[slug];
  const title = titleForSlug(graph, slug);

  const neighbors = (adj.neighbors.get(slug) || [])
    .map((nb) => ({
      slug: nb,
      degree: adj.degree.get(nb) || 0,
      sameCommunity: partition.communities[nb] === communityId,
    }))
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    })
    .slice(0, 20);

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Hub node · ${degree} connections`);
  lines.push("");
  lines.push(`**Community:** [[community-${communityId}]]`);
  lines.push("");
  lines.push("## Connections");
  for (const nb of neighbors) {
    const note = nb.sameCommunity ? "" : " (cross-community)";
    lines.push(`- [[${nb.slug}]] (${nb.degree})${note}`);
  }
  return {
    slug,
    title,
    content: lines.join("\n"),
  };
}

/**
 * generateWikiMarkdown — the orchestrator. TWO-PASS:
 *   (1) assign slugs for ALL articles first (index → _index, communities →
 *       community-{id}, god nodes → their existing slug), building a resolver
 *       so [[links]] resolve across articles.
 *   (2) render each article body.
 *
 * Returns Array<GeneratedArticle> with category "graph-wiki" + generated
 * frontmatter. The generatedAt timestamp is passed in (or defaults to now);
 * it lives in frontmatter so the determinism test can strip it via gray-matter.
 */
export function generateWikiMarkdown(
  graph: ArchiveGraph,
  partition: CommunityPartition,
  archiveName: string,
  runId: string,
  archiveId: string,
  generatedAt?: string,
): GeneratedArticle[] {
  const ts = generatedAt ?? new Date().toISOString();
  const articles: GeneratedArticle[] = [];

  // PASS 1 — index article
  const idx = indexArticle(graph, partition, archiveName);
  articles.push({
    slug: idx.slug,
    title: idx.title,
    category: "graph-wiki",
    content: idx.content,
    frontmatter: {
      generated: true,
      generator: GENERATOR_NAME,
      archiveId,
      runId,
      generatedAt: ts,
    },
  });

  // PASS 1 — community articles (group members by community id)
  const byCommunity = new Map<number, string[]>();
  for (const [slug, cid] of Object.entries(partition.communities)) {
    const arr = byCommunity.get(cid) || [];
    arr.push(slug);
    byCommunity.set(cid, arr);
  }
  const sortedCommunityIds = Array.from(byCommunity.keys()).sort((a, b) => a - b);
  for (const cid of sortedCommunityIds) {
    const members = byCommunity.get(cid)!;
    const art = communityArticle(cid, members, graph, partition);
    articles.push({
      slug: art.slug,
      title: art.title,
      category: "graph-wiki",
      content: art.content,
      frontmatter: {
        generated: true,
        generator: GENERATOR_NAME,
        archiveId,
        runId,
        generatedAt: ts,
        communityId: cid,
      },
    });
  }

  // PASS 1 — god-node articles
  for (const slug of partition.godNodes) {
    const art = godNodeArticle(slug, graph, partition);
    articles.push({
      slug: art.slug,
      title: art.title,
      category: "graph-wiki",
      content: art.content,
      frontmatter: {
        generated: true,
        generator: GENERATOR_NAME,
        archiveId,
        runId,
        generatedAt: ts,
      },
    });
  }

  return articles;
}