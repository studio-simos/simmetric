// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck
// Clean-room CI grep gate (D-06).
//
// This test enforces the license-safety contract: no upstream Graphify
// identifiers leak into the wiki-graph source. The algorithm is reimplemented
// from the published spec prose (GRAPHIFY_INTEGRATION_SPEC.md §2.3), NOT from
// any Python source. No Graphify source is imported, copied, or transpiled.
//
// Precedent: packages/server/src/__tests__/ocrRouting.test.ts:145-153.
import fs from "fs";
import path from "path";
import { describe, it, expect } from "@jest/globals";

describe("wiki-graph clean-room grep gate (D-06)", () => {
  // Forbidden upstream identifiers — case-insensitive match.
  // Removing any of these from the list reopens the license-safety contract.
  const FORBIDDEN = [
    "to_wiki",
    "god_nodes",
    "_community_article",
    "_god_node_article",
    "_index_md",
    "_safe_filename",
    "graph.json",
    "graphify",
    "tree-sitter",
    "python",
    "networkx",
    "graspologic",
  ];

  const FILES = [
    path.resolve(__dirname, "../services/wikiGraphService.ts"),
    path.resolve(__dirname, "../services/wikiMarkdownService.ts"),
    path.resolve(__dirname, "../services/wikiGraphStage.ts"),
  ];

  for (const file of FILES) {
    const src = fs.readFileSync(file, "utf-8");
    for (const id of FORBIDDEN) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      it(`${path.basename(file)} contains no upstream identifier "${id}"`, () => {
        expect(src).not.toMatch(new RegExp(escaped, "i"));
      });
    }
  }
});