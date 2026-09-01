// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * D-17 Deterministic archive fixture for synthesis pipeline tests.
 *
 * Provides a stable, deterministic set of archive pages used to reproduce
 * D-01 branch (b) (Pass 4 no-op fallback) and to exercise the D-03 guard
 * (discarding empty/whitespace `suggestedContent`).
 *
 * The fixture deliberately includes:
 *   - A contradictory pair ("X costa 100" vs "X costa 200") for D-01/D-17
 *     reproduction.
 *   - A negative-control page with zero token overlap with the others.
 *   - A high-overlap-but-no-contradiction page (same topic, consistent claim).
 *
 * No Date.now(), no random — purely deterministic.
 */

// Re-export the minimal ArchivePage shape so tests can import a single type.
export type { ArchivePage } from "../../services/synthesisContradictionService";

import type { ArchivePage } from "../../services/synthesisContradictionService";

/**
 * Extended page shape used by the pipeline (includes `category` and
 * `frontmatter`, which the contradiction service interface does not model).
 */
export interface SynthesisFixturePage extends ArchivePage {
  category?: string;
  frontmatter?: Record<string, unknown> | null;
}

/**
 * Deterministic archive pages for D-17 reproduction.
 *
 * All pages share `archiveId: "archive-test"` and `createdBy: "user-test"`.
 * `createdAt` values are distinct ISO timestamps (deterministic, no Date.now).
 */
export const SYNTHESIS_FIXTURE_PAGES: SynthesisFixturePage[] = [
  {
    id: "page-cost-1",
    archiveId: "archive-test",
    slug: "cost-page",
    title: "Cost Page",
    bodyText: "Il prodotto X costa 100 euro al chilo.",
    wikilinks: ["X"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    createdBy: "user-test",
    category: "entities",
    frontmatter: { synthesis_generation: 1 },
  },
  {
    id: "page-cost-2",
    archiveId: "archive-test",
    slug: "cost-update",
    title: "Cost Update",
    bodyText: "Il prodotto X costa 200 euro al chilo.",
    wikilinks: ["X"],
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    createdBy: "user-test",
    category: "entities",
    frontmatter: { synthesis_generation: 1 },
  },
  {
    id: "page-weather",
    archiveId: "archive-test",
    slug: "weather",
    title: "Weather",
    bodyText: "Il tempo oggi è soleggiato e mite.",
    wikilinks: [],
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    createdBy: "user-test",
    category: "entities",
    frontmatter: { synthesis_generation: 1 },
  },
  {
    id: "page-cost-context",
    archiveId: "archive-test",
    slug: "cost-context",
    title: "Cost Context",
    bodyText: "Il prodotto X è venduto al chilo.",
    wikilinks: ["X"],
    createdAt: new Date("2026-01-04T00:00:00.000Z"),
    createdBy: "user-test",
    category: "entities",
    frontmatter: { synthesis_generation: 1 },
  },
];