// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Synthesis Page Writer — SYNTH-03, SYNTH-06
 *
 * Applies approved synthesis changes with source lineage tracking in frontmatter,
 * bidirectional wikilink insertion, and _index.md regeneration.
 *
 * Conflict detection (RESEARCH Pitfall 3): re-reads page updatedAt and compares
 * with preview.createdAt to prevent overwriting concurrent edits.
 */

import matter from "gray-matter";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import type { SynthesisPreview } from "@simmetric-chat/shared";

// Type for the change entries within the synthesis preview
interface SynthesisChangeEntry {
  pageSlug: string;
  action: "create" | "update" | "skip";
  category: string;
  title: string;
  currentContent?: string;
  proposedContent: string;
  confidence: string;
  sources: Array<{ fileName: string; ingestDate: string }>;
  approved: boolean;
}

/**
 * Build YAML frontmatter with source lineage fields per SYNTH-03 / WIKI-01.
 *
 * Phase 79-03 D-04/D-05: the persisted citation field is now `Fonti` — an
 * array of `[[raw_sources/<fileName>]]` wikilinks — replacing the legacy
 * `sources: [{ fileName, ingestDate }]` object array. `ingestDate` is
 * dropped from the persisted frontmatter entirely (D-05: the preview
 * schema in packages/shared/src/schemas/synthesis.schema.ts still carries
 * `ingestDate` as INPUT for this function, but it is no longer echoed
 * into the persisted frontmatter).
 *
 * Injects:
 *   - Fonti: array of `[[raw_sources/<fileName>]]` wikilink strings
 *   - synthesis_generation: integer (incremented if already present)
 *   - confidence: from change.confidence
 *   - last_synthesis: ISO timestamp
 */
export function buildSourceFrontmatter(
  change: SynthesisChangeEntry,
  existingGeneration: number,
): Record<string, unknown> {
  return {
    Fonti: change.sources.map((s) => `[[raw_sources/${s.fileName}]]`),
    synthesis_generation: existingGeneration + 1,
    confidence: change.confidence,
    last_synthesis: new Date().toISOString(),
  };
}

/**
 * Extract [[wikilinks]] from Markdown content.
 * Handles aliases ([[target|alias]]) and headings ([[target#heading]]).
 * Returns deduplicated array of target slugs.
 */
function extractWikilinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g;
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const target = match[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (target) {
      links.add(target);
    }
  }
  return Array.from(links);
}

/**
 * Apply approved synthesis changes with source lineage tracking.
 *
 * For each approved change:
 *   1. Re-read the page from DB to check updatedAt for conflict detection
 *   2. If page was modified after preview generation, skip as conflict
 *   3. Build YAML frontmatter with source lineage fields
 *   4. Write via archivePageService.createPage / updatePage (file-first)
 *   5. After all writes: insert bidirectional wikilinks
 *   6. After all writes: rebuild _index.md
 *
 * Returns { applied, conflicts } counts.
 */
export async function applyApprovedChanges(
  archiveId: string,
  preview: SynthesisPreview,
  approvedSlugs: string[],
  userId: string,
): Promise<{ applied: number; conflicts: string[] }> {
  // Dynamic imports for Bree compatibility
  const { getPage, createPage, updatePage, rebuildIndex } =
    require("./archivePageService");
  const prismaClient = require("../utils/prisma").default;

  const previewCreatedAt = new Date(preview.createdAt).getTime();
  const conflicts: string[] = [];
  let applied = 0;

  // Filter changes to only approved slugs
  const changes = (preview.changes as SynthesisChangeEntry[]).filter((c) =>
    approvedSlugs.includes(c.pageSlug),
  );

  if (changes.length === 0) {
    logger.info("[synthesis] applyApprovedChanges: no approved changes", {
      archiveId,
      previewRunId: preview.runId,
    });
    return { applied: 0, conflicts: [] };
  }

  logger.info("[synthesis] Applying approved changes", {
    archiveId,
    runId: preview.runId,
    changeCount: changes.length,
    approvedSlugs,
  });

  for (const change of changes) {
    try {
      // 1. Re-read page from DB to get current updatedAt
      let existingPage;
      try {
        existingPage = await getPage(archiveId, change.pageSlug);
      } catch {
        existingPage = null;
      }

      // 2. Conflict detection (RESEARCH Pitfall 3):
      //    If page exists and was updated AFTER preview generation, skip
      if (existingPage) {
        const pageUpdatedAt = new Date(existingPage.updatedAt).getTime();
        if (pageUpdatedAt > previewCreatedAt) {
          logger.warn("[synthesis] Conflict detected", {
            archiveId,
            pageSlug: change.pageSlug,
            pageUpdatedAt: existingPage.updatedAt.toISOString(),
            previewCreatedAt: preview.createdAt,
          });
          conflicts.push(change.pageSlug);
          continue;
        }
      }

      // 3. Determine existing synthesis_generation
      let existingGeneration = 0;
      if (existingPage?.frontmatter) {
        const fm = existingPage.frontmatter as Record<string, unknown>;
        if (typeof fm.synthesis_generation === "number") {
          existingGeneration = fm.synthesis_generation;
        }
      }

      // 4. Build frontmatter with source lineage
      const frontmatterData = buildSourceFrontmatter(change, existingGeneration);

      // 5. Combine frontmatter + content using gray-matter
      const fullContent = matter.stringify(
        change.proposedContent,
        frontmatterData,
      );

      // 6. Write the page (file-first via archivePageService)
      if (change.action === "create") {
        await createPage(archiveId, {
          title: change.title,
          category: change.category || "entities",
          content: fullContent,
        }, userId);
      } else {
        await updatePage(archiveId, change.pageSlug, {
          title: change.title,
          category: change.category,
          content: fullContent,
        }, userId);
      }

      applied++;
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] Failed to apply change", {
        archiveId,
        pageSlug: change.pageSlug,
        action: change.action,
        error: message,
      });
      conflicts.push(change.pageSlug);
    }
  }

  // 7. Insert bidirectional wikilinks (SYNTH-06)
  if (applied > 0) {
    try {
      await insertBidirectionalWikilinks(archiveId, changes, prismaClient);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] Failed to insert bidirectional wikilinks", {
        archiveId,
        error: message,
      });
    }
  }

  // 8. Rebuild _index.md (SYNTH-06)
  if (applied > 0) {
    try {
      await rebuildIndex(archiveId);
      logger.info("[synthesis] Index rebuilt after applying changes", {
        archiveId,
      });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] Failed to rebuild index", {
        archiveId,
        error: message,
      });
    }
  }

  logger.info("[synthesis] applyApprovedChanges complete", {
    archiveId,
    applied,
    conflicts: conflicts.length,
  });

  return { applied, conflicts };
}

/**
 * Insert bidirectional wikilinks for synthesized pages.
 */
async function insertBidirectionalWikilinks(
  archiveId: string,
  changes: SynthesisChangeEntry[],
  prismaClient: typeof prisma,
): Promise<void> {
  for (const change of changes) {
    const sourceWikilinks = extractWikilinks(change.proposedContent);

    for (const targetSlug of sourceWikilinks) {
      try {
        const targetPage = await prismaClient.archivePage.findFirst({
          where: {
            archiveId,
            slug: targetSlug,
            deletedAt: null,
          },
        });

        if (!targetPage) continue;

        const targetWikilinks: string[] = Array.isArray(targetPage.wikilinks)
          ? (targetPage.wikilinks as string[])
          : [];

        if (!targetWikilinks.includes(change.pageSlug)) {
          await prismaClient.archivePage.update({
            where: { id: targetPage.id },
            data: {
              wikilinks: [...targetWikilinks, change.pageSlug],
            },
          });
        }
      } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
        logger.warn("[synthesis] Failed to insert bidirectional wikilink", {
          archiveId,
          sourceSlug: change.pageSlug,
          targetSlug,
          error: message,
        });
      }
    }
  }
}
