// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import path from "path";
import fs from "fs/promises";
import { logger } from "../utils/logger";
import { getArchive } from "./archiveService";
import { getPages } from "./archivePageService";

/**
 * Generate an _index.md file for a specific archive category directory.
 *
 * The _index.md is auto-generated from the database state — it is never user-edited
 * and is always regenerated when pages are created, updated, or deleted.
 *
 * @param archiveId - The UUID of the archive
 * @param category - Optional category subdirectory (entities, concepts, decisions).
 *                   If omitted, generates the root wiki _index.md.
 */
export async function generateIndexFile(
  archiveId: string,
  category?: string
): Promise<void> {
  const archive = await getArchive(archiveId);
  // Phase 155 / CSW-06 (D-07): getPages now defaults to take=500. Index
  // generation needs ALL pages in the archive/category to build the _index.md
  // listing, so pass an explicit large take that preserves the pre-bounding
  // behavior. This is a batch generation job, not a request-handler loop.
  const pages = await getPages(archiveId, category, 100000);

  const targetDir = category
    ? path.resolve(
        process.cwd(),
        "storage/archives",
        archive.slug,
        "wiki",
        category
      )
    : path.resolve(
        process.cwd(),
        "storage/archives",
        archive.slug,
        "wiki"
      );

  const indexPath = path.join(targetDir, "_index.md");

  const heading = category || archive.name + " Wiki";
  const now = new Date().toISOString();

  const content = [
    "---",
    `title: ${category || "Wiki"}`,
    `generated: ${now}`,
    `page_count: ${pages.length}`,
    "---",
    "",
    `# ${heading}`,
    "",
    `_Auto-generated index file. Last updated: ${now}_`,
    "",
    "| Title | Slug | Category | Last Updated |",
    "|-------|------|----------|--------------|",
    ...pages.map(
      (page) =>
        `| ${page.title} | ${page.slug} | ${page.category || ""} | ${page.updatedAt} |`
    ),
    "",
  ].join("\n");

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(indexPath, content, "utf-8");

  logger.info("[archive] _index.md generated", {
    archive: archive.slug,
    category: category || "root",
    pages: pages.length,
  });
}

/**
 * Regenerate all _index.md files for an archive (root + three categories).
 *
 * Called after a full `rebuildIndex()` to ensure every directory has an
 * up-to-date index file reflecting the current database state.
 *
 * @param archiveId - The UUID of the archive
 * @returns Object with the count of generated index files
 */
export async function rebuildAllIndexFiles(
  archiveId: string
): Promise<{ generated: number }> {
  await generateIndexFile(archiveId);
  await generateIndexFile(archiveId, "entities");
  await generateIndexFile(archiveId, "concepts");
  await generateIndexFile(archiveId, "decisions");

  logger.info("[archive] All _index.md files regenerated", { archiveId });

  return { generated: 4 };
}
