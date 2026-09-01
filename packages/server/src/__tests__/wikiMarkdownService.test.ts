// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck
import { describe, it, expect } from "@jest/globals";
import matter from "gray-matter";
import {
  generateWikiMarkdown,
  indexArticle,
  communityArticle,
  godNodeArticle,
  type GeneratedArticle,
} from "../services/wikiMarkdownService";
import type { ArchiveGraph } from "../services/archiveGraphService";
import type { CommunityPartition } from "../services/wikiGraphService";

// Same 8-node fixture used in wikiGraphService.test.ts (kept independent so
// these tests do not depend on the graph service at runtime).
const fixtureGraph: ArchiveGraph = {
  nodes: [
    { id: "a", title: "Alpha", category: "page", slug: "a" },
    { id: "b", title: "Bravo", category: "page", slug: "b" },
    { id: "c", title: "Charlie", category: "page", slug: "c" },
    { id: "d", title: "Delta", category: "page", slug: "d" },
    { id: "e", title: "Echo", category: "page", slug: "e" },
    { id: "f", title: "Foxtrot", category: "page", slug: "f" },
    { id: "g", title: "Golf", category: "page", slug: "g" },
    { id: "h", title: "Hotel", category: "page", slug: "h" },
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "a", target: "c" },
    { source: "b", target: "c" },
    { source: "d", target: "e" },
    { source: "d", target: "f" },
    { source: "e", target: "f" },
    { source: "c", target: "d" },
    { source: "g", target: "h" },
  ],
};

// A partition matching the real louvain output (3 communities) so the markdown
// structure tests reflect a realistic partition.
const fixturePartition: CommunityPartition = {
  communities: { a: 0, b: 0, c: 0, d: 1, e: 1, f: 1, g: 2, h: 2 },
  count: 3,
  modularity: 0.4765625,
  godNodes: ["c", "d", "a", "b", "e", "f"],
};

const ARCHIVE_NAME = "Test Archive";
const RUN_ID = "run-1";
const ARCHIVE_ID = "archive-uuid-1";

describe("wikiMarkdownService — markdown structure + slug + cross-link + determinism", () => {
  it("generateWikiMarkdown returns an index + community + god-node articles", () => {
    const articles = generateWikiMarkdown(
      fixtureGraph,
      fixturePartition,
      ARCHIVE_NAME,
      RUN_ID,
      ARCHIVE_ID,
    );
    // 1 index + 3 communities + 6 god nodes = 10
    expect(articles.length).toBeGreaterThanOrEqual(1 + 3);
    const slugs = articles.map((a) => a.slug);
    // Index article present
    expect(slugs).toContain("_index");
    // All articles carry the graph-wiki category + generated frontmatter
    for (const a of articles) {
      expect(a.category).toBe("graph-wiki");
      expect(a.frontmatter.generated).toBe(true);
      expect(a.frontmatter.generator).toBe("wiki-graph-ts");
      expect(a.frontmatter.runId).toBe(RUN_ID);
      expect(a.frontmatter.archiveId).toBe(ARCHIVE_ID);
    }
  });

  it("index article has heading + Communities + God Nodes sections", () => {
    const articles = generateWikiMarkdown(
      fixtureGraph,
      fixturePartition,
      ARCHIVE_NAME,
      RUN_ID,
      ARCHIVE_ID,
    );
    const idx = articles.find((a) => a.slug === "_index")!;
    expect(idx).toBeDefined();
    expect(idx.content).toContain("# Test Archive — Knowledge Graph Index");
    expect(idx.content).toContain("## Communities");
    expect(idx.content).toContain("## God Nodes");
  });

  it("community article has Key Concepts + Relationships + Graph Stats (adapted: no Source Files/Audit Trail)", () => {
    const articles = generateWikiMarkdown(
      fixtureGraph,
      fixturePartition,
      ARCHIVE_NAME,
      RUN_ID,
      ARCHIVE_ID,
    );
    const communityArticles = articles.filter(
      (a) => a.slug.startsWith("community-") && !a.slug.endsWith("-index"),
    );
    expect(communityArticles.length).toBe(3);
    const first = communityArticles[0]!;
    expect(first.content).toContain("## Key Concepts");
    expect(first.content).toContain("## Relationships");
    expect(first.content).toContain("## Graph Stats");
    // Adapted spec: NO Source Files section (wiki pages have no source files)
    expect(first.content).not.toMatch(/## Source Files/);
    // NOT "Connections by Relation" (wikilinks have no relation type)
  });

  it("god-node article has Community + Connections (not Connections by Relation)", () => {
    const articles = generateWikiMarkdown(
      fixtureGraph,
      fixturePartition,
      ARCHIVE_NAME,
      RUN_ID,
      ARCHIVE_ID,
    );
    const god = articles.find((a) => a.slug === "c")!; // god node 'c'
    expect(god).toBeDefined();
    expect(god.content).toContain("**Community:**");
    expect(god.content).toContain("## Connections");
    // Wikilinks have no relation type → NOT "Connections by Relation"
    expect(god.content).not.toMatch(/## Connections by Relation/);
  });

  it("generateWikiMarkdown: community slugs are distinct (id-based, no collision) (WR-06 kept this assertion after slugifyForFs removal)", () => {
    // The slugifyForFs export was removed in Phase 153.1-01 (dead code — no
    // production caller). This test originally framed itself as a
    // slugifyForFs collision-dedup test, but its actual assertion is about
    // `generateWikiMarkdown` producing distinct community slugs (community-0,
    // community-1) — which is valuable independent of slugifyForFs. Kept
    // here with an honest name.
    const graph: ArchiveGraph = {
      nodes: [
        { id: "x", title: "X", category: "page", slug: "x" },
        { id: "y", title: "Y", category: "page", slug: "y" },
      ],
      edges: [{ source: "x", target: "y" }],
    };
    const partition: CommunityPartition = {
      communities: { x: 0, y: 1 },
      count: 2,
      modularity: 0,
      godNodes: [],
    };
    const articles = generateWikiMarkdown(graph, partition, "A", "r", "aid");
    const slugs = articles.map((a) => a.slug);
    // Two community articles: community-0 and community-1 (id-based, no collision)
    expect(slugs.filter((s) => s.startsWith("community-")).length).toBe(2);
    // And they must be distinct
    const communitySlugs = slugs.filter((s) => s.startsWith("community-"));
    expect(new Set(communitySlugs).size).toBe(communitySlugs.length);
  });

  it("cross-link resolution: community articles link to each other (two-pass resolver)", () => {
    const articles = generateWikiMarkdown(
      fixtureGraph,
      fixturePartition,
      ARCHIVE_NAME,
      RUN_ID,
      ARCHIVE_ID,
    );
    const communityArticles = articles.filter((a) =>
      a.slug.startsWith("community-"),
    );
    // At least one community article should reference another community via [[ ]]
    const hasCrossLink = communityArticles.some((a) =>
      /\[\[community-\d+\]\]/.test(a.content),
    );
    expect(hasCrossLink).toBe(true);
  });

  it("determinism: same input → byte-identical markdown BODY (frontmatter stripped via gray-matter) (A5)", () => {
    const fixedNow = "2026-08-25T00:00:00.000Z";
    const run1 = generateWikiMarkdown(
      fixtureGraph,
      fixturePartition,
      ARCHIVE_NAME,
      RUN_ID,
      ARCHIVE_ID,
      fixedNow,
    );
    const run2 = generateWikiMarkdown(
      fixtureGraph,
      fixturePartition,
      ARCHIVE_NAME,
      RUN_ID,
      ARCHIVE_ID,
      fixedNow,
    );
    expect(run1.length).toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      // Strip frontmatter (generatedAt lives there) then compare bodies byte-identical
      const body1 = matter(run1[i]!.content).content;
      const body2 = matter(run2[i]!.content).content;
      expect(body1).toBe(body2);
    }
  });

  it("singleton community (1 page) kept — valid article with 1 Key Concept, cohesion, 0 Relationships (A4)", () => {
    const graph: ArchiveGraph = {
      nodes: [{ id: "solo", title: "Solo", category: "page", slug: "solo" }],
      edges: [],
    };
    const partition: CommunityPartition = {
      communities: { solo: 0 },
      count: 1,
      modularity: 0,
      godNodes: [], // degree 0, filtered
    };
    const articles = generateWikiMarkdown(graph, partition, "Solo A", "r", "aid");
    const community = articles.find((a) => a.slug === "community-0")!;
    expect(community).toBeDefined();
    expect(community.content).toContain("## Key Concepts");
    expect(community.content).toContain("## Relationships");
    // Singleton: cohesion is 1.00 (or 0 — guarded for n<2); 0 relationships
    expect(community.content).toMatch(/cohesion/);
  });

  // WR-04: communityArticle "Relationships" must be sorted by target degree
  // desc + target slug asc tie-break BEFORE .slice(0, 12). The fixture below
  // has two cross-community edges from community-0: c→d (degree 3) and a→e
  // (degree 2). Edge-iteration order finds c→d first (it appears earlier in
  // the edges array), so WITHOUT the sort the first 12 edges would already
  // be in [c→d, a→e] order — not a useful discriminator. To make the sort
  // OBSERVABLE, the fixture deliberately places the lower-degree target (e,
  // degree 2) as the FIRST cross-community edge and the higher-degree target
  // (d, degree 3) as the SECOND. The sort must surface d before e even though
  // e comes first in edge-iteration order.
  it("WR-04: Relationships sorted by target degree desc + target slug asc (higher-degree target surfaces first when not in edge-iteration order)", () => {
    // community-0 = {a, c}; community-1 = {d, e}; bridge edges a→e (deg 2)
    // then c→d (deg 3). Edges array deliberately lists a→e BEFORE c→d so the
    // unsorted slice(0,12) would put e first. The sort must reorder to d, e.
    const graph: ArchiveGraph = {
      nodes: [
        { id: "a", title: "Alpha", category: "page", slug: "a" },
        { id: "c", title: "Charlie", category: "page", slug: "c" },
        { id: "d", title: "Delta", category: "page", slug: "d" },
        { id: "e", title: "Echo", category: "page", slug: "e" },
      ],
      edges: [
        { source: "a", target: "c" }, // intra community-0
        { source: "d", target: "e" }, // intra community-1
        { source: "a", target: "e" }, // cross: a→e (target e, degree 2) — listed FIRST
        { source: "c", target: "d" }, // cross: c→d (target d, degree 3) — listed SECOND
      ],
    };
    const partition: CommunityPartition = {
      communities: { a: 0, c: 0, d: 1, e: 1 },
      count: 2,
      modularity: 0,
      godNodes: [],
    };
    const articles = generateWikiMarkdown(graph, partition, "WR04", "r", "aid");
    const community0 = articles.find((a) => a.slug === "community-0")!;
    expect(community0).toBeDefined();
    // Extract the Relationships section body (between "## Relationships" and
    // the next "## " heading) and assert the order of the [[target]] links.
    const relsMatch = community0.content.match(
      /## Relationships\n([\s\S]*?)(?:\n## |\n*$)/,
    );
    expect(relsMatch).not.toBeNull();
    const relsBody = relsMatch![1];
    const targetOrder = [...relsBody.matchAll(/\[\[([^\]]+)\]\] →/g)].map(
      (m) => m[1],
    );
    // d (degree 3) must appear before e (degree 2) — degree desc sort.
    expect(targetOrder).toEqual(["d", "e"]);
  });
});