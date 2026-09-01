// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// wikiGraphStage — orchestrator for the graph-wiki generation pipeline.
//
// Plan 153-02 / WIKI-01. Resolves the locked decisions:
//   - D-01 (admin-triggered, extends synthesis infrastructure): reuses the
//     SynthesisRun row for observability (status, pagesWritten, error) but
//     runs a SEPARATE pipeline (A2 — no LLM passes, no BudgetTracker). The
//     trigger route (routes/synthesis.ts POST /trigger-graph-wiki) creates
//     the SynthesisRun row and fires this orchestrator fire-and-forget.
//   - D-02 (reuse ArchivePage + existing read paths): generated articles
//     are written as regular ArchivePage rows with category "graph-wiki"
//     via archivePageService.createPage (inherits locks, backlinks,
//     validation, searchVectorMulti population from Phase 151). No new
//     read path — wiki_query / archiveSearch / ArchiveDetailPage tree read
//     graph-wiki rows uniformly via the existing category filter.
//   - D-03 (idempotent re-run): deleteGeneratedPages HARD-DELETES prior
//     graph-wiki rows for the archive (and unlinks + git rm's their .md
//     files) BEFORE regenerating. Generated pages have no authored
//     content — the hard-delete exception (mirrors MCPConnection uninstall).
//   - A6 (createdBy): generated pages use the triggering admin's userId
//     (the runId's createdBy / req.userId on the trigger endpoint) as
//     createdBy. The `generated: true` frontmatter is the real
//     machine-generated signal.
//
// Clean-room (D-06): this orchestrator contains NO upstream
// identifiers — it only wires the pure generator (Plan 01) to the DB +
// synthesis-run observability. The clean-room grep gate covers
// wikiGraphService.ts + wikiMarkdownService.ts (the algorithm modules);
// this module is integration glue.

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { buildArchiveGraph } from "./archiveGraphService";
import { detectCommunities } from "./wikiGraphService";
import { generateWikiMarkdown } from "./wikiMarkdownService";
import { createPage, deleteGeneratedPages } from "./archivePageService";

// gray-matter is already a server dep (archivePageService.ts:6) — reuse it
// to prepend the generated frontmatter as a YAML `---` block so
// archivePageService.createPage's `matter(input.content)` parse (line 153)
// extracts the frontmatter into the `frontmatter` JSON column.
import matter from "gray-matter";

interface WikiGraphPipelineResult {
  pagesWritten: number;
  status: "COMPLETED" | "FAILED";
}

/**
 * runWikiGraphPipeline — the orchestrator.
 *
 *   1. Mark the reused SynthesisRun row PROCESSING (mirror synthesisStages
 *      Setup — the row was created PENDING by the trigger route).
 *   2. Load the archive (404 → FAILED).
 *   3. buildArchiveGraph(archiveId) — the existing wikilink graph.
 *   4. Empty-graph guard: 0 nodes → log skip, COMPLETED pagesWritten=0.
 *   5. detectCommunities (Plan 01 — seeded Louvain, pure function of
 *      archiveId per D-04).
 *   6. generateWikiMarkdown (Plan 01 — clean-room article writer).
 *   7. deleteGeneratedPages(archiveId, "graph-wiki") — D-03 idempotent
 *      hard-delete + file cleanup.
 *   8. Per GeneratedArticle: prepend the frontmatter YAML, createPage with
 *      category "graph-wiki" + createdBy = userId. Per-article errors are
 *      logged and the pipeline continues (partial success — mirrors the
 *      LLM synthesis pipeline's resilience).
 *   9. Update SynthesisRun COMPLETED + pagesWritten.
 *  10. On error → SynthesisRun FAILED + error message (mirror
 *      synthesisStages catch path).
 *
 * This is a SEPARATE pipeline (resolves A2): it does NOT call
 * `runPipelineStages`, does NOT instantiate BudgetTracker, does NOT call
 * `callSynthesisLLMStage`, does NOT run the LLM 5-pass pipeline. The graph
 * + markdown are pure functions (Plan 01); only the DB write is I/O.
 */
export async function runWikiGraphPipeline(
  archiveId: string,
  userId: string,
  runId: string,
): Promise<WikiGraphPipelineResult> {
  try {
    // 1. PROCESSING transition (mirror synthesisStages Setup stage).
    await prisma.synthesisRun.update({
      where: { id: runId },
      data: {
        status: "PROCESSING",
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });

    // 2. Load archive.
    const archive = await prisma.archive.findFirst({
      where: { id: archiveId, deletedAt: null },
      select: { id: true, slug: true, name: true },
    });
    if (!archive) {
      throw new Error(`Archive not found: ${archiveId}`);
    }

    // 3. Idempotent re-run (D-03): hard-delete prior graph-wiki rows for this
    //    archive BEFORE building the graph AND before any generation. Running
    //    this BEFORE buildArchiveGraph ensures the graph is built from AUTHORED
    //    pages only — prior generated graph-wiki rows are NOT fed back as nodes
    //    (a generated page is never an input to the next generation). This also
    //    satisfies the CR-02 invariant: a re-run on an archive that became empty
    //    (authored pages deleted) clears the stale generated rows even though
    //    the new run produces no output (the empty-graph guard fires AFTER the
    //    cleanup). The D-03 contract: a re-run leaves zero stale generated pages
    //    regardless of whether the new run produces output.
    const deletedPrior = await deleteGeneratedPages(archiveId, "graph-wiki");
    if (deletedPrior > 0) {
      logger.info("[wiki-graph] deleted prior generated pages", {
        archiveId,
        runId,
        deletedPrior,
      });
    }

    // 4. Build the wikilink graph from the remaining (authored) pages — never
    //    re-walk wikilinks, and never include generated graph-wiki rows (they
    //    were just deleted above).
    const graph = await buildArchiveGraph(archiveId);

    // 5. Empty-graph guard — AFTER the stale-row cleanup so a re-run on an
    //    archive that became empty still clears prior generated rows.
    if (graph.nodes.length === 0) {
      logger.info("[wiki-graph] archive has no pages, skipping", {
        archiveId,
        runId,
      });
      await prisma.synthesisRun.update({
        where: { id: runId },
        data: { status: "COMPLETED", pagesWritten: 0 },
      });
      return { pagesWritten: 0, status: "COMPLETED" };
    }

    // 6. Community detection (seeded Louvain — pure function of archiveId).
    const partition = detectCommunities(graph, archiveId);

    // 6. Clean-room markdown writer.
    const archiveName = archive.name || "Archive";
    const articles = generateWikiMarkdown(
      graph,
      partition,
      archiveName,
      runId,
      archiveId,
    );

    // 7. Per-article createPage. The article's `frontmatter` (generated: true,
    // generator, archiveId, runId, generatedAt, communityId?) must be
    // prepended as a YAML `---` block so createPage's `matter()` parse
    // extracts it into the `frontmatter` JSON column. Per-article errors
    // are logged and the pipeline continues (partial success — mirrors
    // the LLM synthesis pipeline's resilience pattern).
    let pagesWritten = 0;
    for (const article of articles) {
      try {
        // Build the full content string: frontmatter YAML block + body.
        // gray-matter.stringify(body, frontmatter) is the safe path
        // (F77 D-04 landmine — never string-concat frontmatter; the yaml
        // serializer escapes values correctly).
        const fullContent = matter.stringify(article.content, article.frontmatter);
        await createPage(
          archiveId,
          {
            title: article.title,
            category: "graph-wiki",
            content: fullContent,
            slug: article.slug,
          },
          userId, // A6 — the triggering admin's userId
        );
        pagesWritten++;
      } catch (err: unknown) {
        logger.warn("[wiki-graph] failed to write generated article", {
          archiveId,
          runId,
          slug: article.slug,
          title: article.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 9. COMPLETED + pagesWritten.
    await prisma.synthesisRun.update({
      where: { id: runId },
      data: { status: "COMPLETED", pagesWritten },
    });

    logger.info("[wiki-graph] pipeline completed", {
      archiveId,
      runId,
      pagesWritten,
      deletedPrior,
    });

    return { pagesWritten, status: "COMPLETED" };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("[wiki-graph] pipeline failed", {
      archiveId,
      runId,
      error: errMsg,
    });
    try {
      await prisma.synthesisRun.update({
        where: { id: runId },
        data: { status: "FAILED", error: errMsg },
      });
    } catch (updateErr: unknown) {
      logger.error("[wiki-graph] failed to mark run FAILED", {
        runId,
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    }
    return { pagesWritten: 0, status: "FAILED" };
  }
}