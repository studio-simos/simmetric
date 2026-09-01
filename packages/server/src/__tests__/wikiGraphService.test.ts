// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck
import { describe, it, expect } from "@jest/globals";
import {
  detectCommunities,
  buildGraphologyGraph,
  mulberry32,
  cyrb53,
  type CommunityPartition,
} from "../services/wikiGraphService";
import type { ArchiveGraph } from "../services/archiveGraphService";

// Deterministic 8-node fixture graph. Nodes a..h with a known edge structure:
//   cluster A: a-b, a-c, b-c  (triangle)
//   cluster B: d-e, d-f, e-f   (triangle)
//   bridge:    c-d             (single inter-cluster edge)
//   leaf:      g-h             (isolated pair, degree 1 each)
//   isolated:  (none — all 8 used)
// Degrees: a=2 b=2 c=3 d=3 e=2 f=2 g=1 h=1
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

const ARCHIVE_ID = "archive-uuid-1";

describe("wikiGraphService — determinism + golden + god nodes + edge cases", () => {
  it("determinism: same graph + same archiveId → byte-identical communities (D-04)", () => {
    const r1 = detectCommunities(fixtureGraph, ARCHIVE_ID);
    const r2 = detectCommunities(fixtureGraph, ARCHIVE_ID);
    expect(r1.communities).toEqual(r2.communities);
    expect(JSON.stringify(r1.communities)).toBe(JSON.stringify(r2.communities));
  });

  it("golden snapshot: 8-node fixture partition matches the hardcoded golden (D-05; dep bump FAILS)", () => {
    // This golden reflects the REAL graphology@0.26.0 + graphology-communities-louvain@2.0.2
    // output for the fixture above, seeded with mulberry32(cyrb53("archive-uuid-1")).
    // A dep bump that changes this partition FAILS this test — surfacing non-determinism at CI.
    const result = detectCommunities(fixtureGraph, ARCHIVE_ID);
    // Golden reflects real louvain@2.0.2 output: 3 communities
    // (triangle-A=0, triangle-B=1, leaf-pair g-h=2). The c-d bridge does NOT
    // merge the two triangles under this seed — louvain keeps them separate.
    // If louvain's tie-breaks shift on a dep bump, this deep-equal fails.
    const golden: Record<string, number> = {
      a: 0,
      b: 0,
      c: 0,
      d: 1,
      e: 1,
      f: 1,
      g: 2,
      h: 2,
    };
    // Normalize community ids to 0-based contiguous (louvain may return 1-based or
    // sparse; remap so the golden is stable across louvain id-packing variants).
    const remapped = normalizeCommunityIds(result.communities);
    expect(remapped).toEqual(golden);
  });

  it("god nodes: top-10 by degree, EXCLUDING degree<=1 stubs (resolves A3)", () => {
    const result = detectCommunities(fixtureGraph, ARCHIVE_ID);
    // Degrees: a=2 b=2 c=3 d=3 e=2 f=2 g=1 h=1
    // Stubs (degree<=1): g, h → excluded
    // Qualifying (degree>=2): a,b,c,d,e,f — sorted desc by degree:
    //   c(3), d(3), a(2), b(2), e(2), f(2)  → order among ties is by slug asc (stable)
    const expectedOrder = ["c", "d", "a", "b", "e", "f"];
    expect(result.godNodes).toEqual(expectedOrder);
    // Stubs never appear
    expect(result.godNodes).not.toContain("g");
    expect(result.godNodes).not.toContain("h");
  });

  it("god nodes: fewer than topN qualify → returns fewer (no padding)", () => {
    const small: ArchiveGraph = {
      nodes: [
        { id: "x", title: "X", category: "page", slug: "x" },
        { id: "y", title: "Y", category: "page", slug: "y" },
      ],
      edges: [{ source: "x", target: "y" }],
    };
    const result = detectCommunities(small, "small-archive");
    // Both x,y have degree 1 → filtered as stubs → 0 god nodes (no padding)
    expect(result.godNodes).toEqual([]);
  });

  it("empty graph: 0 nodes → empty partition, no throw", () => {
    const result = detectCommunities({ nodes: [], edges: [] }, "empty");
    expect(result.communities).toEqual({});
    expect(result.count).toBe(0);
    expect(result.modularity).toBe(0);
    expect(result.godNodes).toEqual([]);
  });

  it("single-node graph: 1 node, 0 edges → 1 community, 0 god nodes (degree 0)", () => {
    const result = detectCommunities(
      {
        nodes: [{ id: "a", title: "A", category: "x", slug: "a" }],
        edges: [],
      },
      "single",
    );
    expect(Object.keys(result.communities)).toEqual(["a"]);
    expect(result.godNodes).toEqual([]); // degree 0, filtered as stub (degree<=1)
  });

  it("seed purity: cyrb53 is a pure function of the input string (D-04)", () => {
    expect(cyrb53("abc")).toBe(cyrb53("abc"));
    expect(cyrb53("abc")).not.toBe(cyrb53("abd"));
  });

  it("mulberry32: same seed → same sequence", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    const seq1 = Array.from({ length: 5 }, () => r1());
    const seq2 = Array.from({ length: 5 }, () => r2());
    expect(seq1).toEqual(seq2);
  });

  it("buildGraphologyGraph: constructs undirected graph, dedupes parallel edges, skips dangling", () => {
    const g = buildGraphologyGraph(
      [
        { id: "a", title: "A", category: "x", slug: "a" },
        { id: "b", title: "B", category: "x", slug: "b" },
      ],
      [
        { source: "a", target: "b" },
        { source: "a", target: "b" }, // parallel → merged
        { source: "a", target: "ghost" }, // dangling target → skipped
      ],
    );
    expect(g.nodes()).toEqual(["a", "b"]);
    expect(g.edges().length).toBe(1); // merged
  });

  it("no Math.random() in wikiGraphService.ts source (determinism — D-04)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../services/wikiGraphService.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/Math\.random/);
  });
});

// Helper: remap community ids to 0-based contiguous so the golden is stable
// across louvain id-packing variants (some versions start at 1, others 0).
function normalizeCommunityIds(
  communities: Record<string, number>,
): Record<string, number> {
  const idSet = new Set(Object.values(communities));
  const sortedIds = Array.from(idSet).sort((x, y) => x - y);
  const remap = new Map<number, number>();
  sortedIds.forEach((orig, i) => remap.set(orig, i));
  const out: Record<string, number> = {};
  for (const [slug, cid] of Object.entries(communities)) {
    out[slug] = remap.get(cid)!;
  }
  return out;
}