// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// wikiGraphService — pure deterministic graph + community partition module.
//
// Determinism contract (D-04):
//   seed = mulberry32(cyrb53(archiveId))
//   The Louvain `graphology-communities-louvain` v2.0.2 call receives this seeded
//   RNG via its `rng` option. Same archive graph + same dep versions + same
//   archiveId → same community partition (byte-identical modulo frontmatter
//   timestamps, normalized out of the determinism unit-test comparison).
//
// Dep pin (D-05):
//   graphology@0.26.0 + graphology-communities-louvain@2.0.2 are pinned EXACT in
//   packages/server/package.json. A bump that changes the Louvain partition
//   FAILS the golden-snapshot unit test — surfacing non-determinism at CI time.
//
// Module format (A1): both packages ship CJS builds (verified via
//   node_modules/*/package.json exports — `require`/CJS build present, no
//   "type": "module"). Named imports `import { Graph } from "graphology"` and
//   default import `import louvain from "graphology-communities-louvain"` resolve
//   under the server's CJS tsconfig (esModuleInterop: true). No jest mocks or
//   moduleNameMapper needed; the real library loads under jest so the golden
//   snapshot reflects real louvain output.
//
// Clean-room (D-06): this module is a clean-room reimplementation from the
//   integration spec §2.3 prose. No upstream source is imported,
//   copied, or transpiled. Renamed identifiers: detectCommunities, computeGodNodes,
//   buildGraphologyGraph, mulberry32, cyrb53. CI grep gate enforces that no
//   upstream identifiers leak into this source (see the forbidden-identifiers
//   list in wikiGraphCleanRoomGrep.test.ts).

import graphology from "graphology";
import louvain from "graphology-communities-louvain";
import type { ArchiveGraph, GraphNode, GraphEdge } from "./archiveGraphService";

// graphology@0.26.0 ships a CJS build where `Graph` is a named export, but the
// bundled d.ts declares `Graph` as the default export only — a mismatch. Under
// tsc's `__importDefault` (production build), `import Graph from "graphology"`
// resolves to the whole module object (not the constructor), so `new Graph()`
// throws. Under swc/jest the interop differs and it happens to work. To satisfy
// BOTH runtimes with one import, take a default import (matches the d.ts) and
// pull the constructor off the runtime namespace (the CJS named `Graph`).
// `esModuleInterop` wraps the CJS module as `{ default: module }`, so
// `(graphology as any).Graph` is the real constructor in both tsc and swc.
//
// The bundled d.ts pulls its instance methods from `graphology-types`, which is
// not installed as a resolvable package here (skipLibCheck skips the d.ts body,
// leaving the instance type method-less). Rather than add a types-only dep, we
// declare a minimal GraphLike interface covering exactly the surface this
// module uses (nodes/edges/degree/addNode/hasNode/mergeEdge). The runtime class
// satisfies it structurally.
interface GraphLike {
  nodes(): string[];
  edges(): string[];
  degree(node: string): number;
  addNode(node: string): void;
  hasNode(node: string): boolean;
  mergeEdge(source: string, target: string): void;
}
type GraphConstructor = new (opts: {
  type: "directed" | "undirected";
}) => GraphLike;
const Graph = (graphology as unknown as { Graph: GraphConstructor }).Graph;

export interface CommunityPartition {
  communities: Record<string, number>; // slug → communityId
  count: number;
  modularity: number;
  godNodes: string[];
}

/**
 * mulberry32 — public-domain seeded PRNG (~10 LOC).
 * Source: public-domain algorithm (Bryan O'Sullivan / bryc's gist).
 * Returns a function () => number in [0, 1). Deterministic given the seed.
 * Per D-04: the ONLY rng used in this module (the built-in nondeterministic
 * global rng is never referenced — see the clean-room grep gate test).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * cyrb53 — stable non-cryptographic string hash (public-domain, ~10 LOC).
 * Source: bryc's cyrb53 (https://github.com/bryc). Returns a uint32.
 * Per D-04: hashes the archiveId (UUID string) into a uint32 seed for mulberry32.
 * Pure function of the input string alone — no persisted seed row.
 */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return h2 >>> 0; // uint32 seed for mulberry32
}

/**
 * Build a graphology undirected Graph from ArchiveGraph {nodes,edges}.
 * mergeEdge dedupes parallel edges. Dangling edges (target/source not in nodes)
 * are skipped via hasNode guards.
 */
export function buildGraphologyGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphLike {
  const g = new Graph({ type: "undirected" });
  for (const n of nodes) {
    g.addNode(n.slug);
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.mergeEdge(e.source, e.target); // mergeEdge dedupes parallel edges
    }
  }
  return g;
}

/**
 * Compute god nodes: top-N by degree, EXCLUDING nodes with degree <= 1 (stub
 * filter — resolves A3). Sort is stable: ties broken by slug ascending so the
 * output is deterministic. If fewer than topN qualify, returns fewer (no padding).
 *
 * WR-07 (Phase 153.1-01): the unused `communities` parameter was removed —
 * the body never read it (god-node selection is global by degree, not
 * community-scoped). The selection logic is otherwise unchanged.
 */
function computeGodNodes(
  graph: GraphLike,
  topN = 10,
): string[] {
  const candidates = graph
    .nodes()
    .map((slug) => ({ slug, degree: graph.degree(slug) }))
    .filter((n) => n.degree > 1) // stub filter: exclude degree <= 1
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree; // degree desc
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0; // slug asc (stable tie-break)
    })
    .slice(0, topN)
    .map((n) => n.slug);
  return candidates;
}

/**
 * detectCommunities — the pure deterministic entry point.
 *
 * (1) buildGraphologyGraph from the ArchiveGraph {nodes,edges} (reuses
 *     archiveGraphService.buildArchiveGraph's output — never re-walks wikilinks).
 * (2) seed = mulberry32(cyrb53(archiveId)) — pure function of archiveId (D-04).
 * (3) louvain.detailed(g, { rng, resolution: 1, fastLocalMoves: true }).
 * (4) computeGodNodes — top-10 by degree excluding degree<=1 stubs.
 *
 * Empty graph (0 nodes) short-circuits to an empty partition (does NOT call
 * louvain on an empty graph — it may throw).
 */
export function detectCommunities(
  graph: ArchiveGraph,
  archiveId: string,
): CommunityPartition {
  // Empty-graph guard: louvain on 0 nodes may throw; short-circuit.
  if (graph.nodes.length === 0) {
    return { communities: {}, count: 0, modularity: 0, godNodes: [] };
  }

  const g = buildGraphologyGraph(graph.nodes, graph.edges);

  const rng = mulberry32(cyrb53(archiveId));
  const details = louvain.detailed(g, {
    rng,
    resolution: 1,
    fastLocalMoves: true,
  });

  const godNodes = computeGodNodes(g);

  return {
    communities: details.communities as Record<string, number>,
    count: details.count,
    modularity: details.modularity,
    godNodes,
  };
}