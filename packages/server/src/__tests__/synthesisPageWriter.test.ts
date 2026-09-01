// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * synthesisPageWriter unit tests — Phase 79-03 WIKI-01 (D-04/D-05).
 *
 * Verifies that buildSourceFrontmatter emits the new `Fonti` wikilink array
 * citation format (`[[raw_sources/<file>]]`) and that the persisted
 * frontmatter object no longer carries `sources` or `ingestDate` (D-05:
 * ingestDate is dropped from persisted frontmatter only — the preview
 * schema in packages/shared/src/schemas/synthesis.schema.ts stays
 * unchanged and remains the input shape for this function).
 */
import "./helpers/setupEnv";

import matter from "gray-matter";
import { buildSourceFrontmatter } from "../services/synthesisPageWriter";

describe("buildSourceFrontmatter — Fonti wikilink array (D-04/D-05)", () => {
  const baseChange = {
    pageSlug: "acme-corp",
    action: "create" as const,
    category: "entities",
    title: "ACME Corp",
    proposedContent: "# ACME Corp\n\nBody.",
    confidence: "high",
    sources: [{ fileName: "foo.md", ingestDate: "2026-01-01" }],
    approved: true,
  };

  it("returns Fonti array of [[raw_sources/<file>]] for each source", () => {
    const fm = buildSourceFrontmatter(
      { ...baseChange, sources: [{ fileName: "foo.md", ingestDate: "2026-01-01" }, { fileName: "bar.md", ingestDate: "2026-02-02" }] },
      0,
    );
    expect(Array.isArray(fm.Fonti)).toBe(true);
    expect(fm.Fonti).toEqual(["[[raw_sources/foo.md]]", "[[raw_sources/bar.md]]"]);
  });

  it("does NOT include a `sources` key in the returned object", () => {
    const fm = buildSourceFrontmatter(baseChange, 0);
    expect(fm).not.toHaveProperty("sources");
  });

  it("does NOT include any `ingestDate` key in the returned object (D-05)", () => {
    const fm = buildSourceFrontmatter(baseChange, 0);
    expect(fm).not.toHaveProperty("ingestDate");
    // Also no nested ingestDate inside any value (Fonti is a string array).
    expect(JSON.stringify(fm)).not.toContain("ingestDate");
  });

  it("preserves synthesis_generation, confidence, last_synthesis keys", () => {
    const fm = buildSourceFrontmatter(baseChange, 3);
    expect(fm.synthesis_generation).toBe(4);
    expect(fm.confidence).toBe("high");
    expect(typeof fm.last_synthesis).toBe("string");
  });

  it("matter.stringify(content, buildSourceFrontmatter(...)) produces frontmatter with Fonti: line and no sources:/ingestDate: lines", () => {
    const fm = buildSourceFrontmatter(baseChange, 0);
    const rendered = matter.stringify(baseChange.proposedContent, fm);
    expect(rendered).toContain("Fonti:");
    expect(rendered).not.toContain("sources:");
    expect(rendered).not.toContain("ingestDate:");
    // The wikilink citation appears in the rendered frontmatter.
    expect(rendered).toContain("[[raw_sources/foo.md]]");
  });
});