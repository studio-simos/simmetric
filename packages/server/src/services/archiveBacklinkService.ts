// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { updatePage } from "./archivePageService";
import matter from "gray-matter";
import { simpleGit } from "simple-git";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");

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
 * Establish bidirectional backlinks for a newly written page.
 *
 * For every wikilink target found in `content`, checks if the target
 * page already links back to `sourceSlug`. If not, appends a
 * "## Backlinks" section to the target page.
 *
 * Each target update is isolated in try/catch — failure of one
 * does not block others or the main operation.
 */
export async function establishBacklinks(
  archiveId: string,
  sourceSlug: string,
  content: string,
  userId: string,
): Promise<void> {
  const targets = extractWikilinks(content).filter((t) => t !== sourceSlug);

  let established = 0;
  let skipped = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      const targetPage = await prisma.archivePage.findFirst({
        where: { archiveId, slug: target, deletedAt: null },
      });

      if (!targetPage) {
        skipped++;
        continue;
      }

      const backlinkRegex = new RegExp(
        "\\[\\[" + sourceSlug + "(\\||#|\\]\\])",
        "i",
      );
      const hasBacklink = backlinkRegex.test(targetPage.bodyText);

      if (hasBacklink) {
        continue;
      }

      const existingBody = targetPage.bodyText;
      let newBody: string;
      if (existingBody.includes("## Backlinks")) {
        newBody = existingBody + `\n- [[${sourceSlug}]]`;
      } else {
        newBody =
          existingBody +
          `\n\n---\n\n## Backlinks\n- [[${sourceSlug}]]\n`;
      }

      const frontmatter =
        (targetPage.frontmatter as Record<string, unknown>) || {};
      const hasFrontmatter = Object.keys(frontmatter).length > 0;
      const fullContent = hasFrontmatter
        ? matter.stringify(newBody, frontmatter)
        : newBody;

      await updatePage(archiveId, target, { content: fullContent }, userId);
      established++;
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      failed++;
      logger.error("[archive] Failed to establish backlink", {
        archiveId,
        sourceSlug,
        targetSlug: target,
        error: message,
      });
    }
  }

  logger.info("[archive] Backlink establishment complete", {
    archiveId,
    sourceSlug,
    established,
    skipped,
    failed,
  });
}

/**
 * Propagate a page rename across all pages that wikilink to the old slug.
 *
 * Scans every ArchivePage in the archive whose bodyText contains "[[oldSlug",
 * updates wikilink references, writes files back to disk, updates DB records,
 * and commits all changes in a single git commit.
 *
 * Returns the count of pages that were updated.
 */
export async function propagateRename(
  archiveId: string,
  oldSlug: string,
  newSlug: string,
  _userId: string,
): Promise<number> {
  const archive = await prisma.archive.findFirst({
    where: { id: archiveId, deletedAt: null },
  });
  if (!archive) {
    throw new Error(`Archive not found: ${archiveId}`);
  }

  const archiveDir = path.join(ARCHIVES_BASE, archive.slug);

  const pages = await prisma.archivePage.findMany({
    where: {
      archiveId,
      deletedAt: null,
      bodyText: { contains: `[[${oldSlug}` },
    },
  });

  if (pages.length === 0) {
    return 0;
  }

  // Regex to match [[oldSlug]], [[oldSlug|alias]], [[oldSlug#heading]]
  const oldSlugRegex = new RegExp(
    `\\[\\[${oldSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\||#|\\]\\])`,
    "g",
  );

  let updatedCount = 0;

  for (const page of pages) {
    try {
      const newBodyText = page.bodyText.replace(oldSlugRegex, (match, terminator) => {
        return `[[${newSlug}${terminator}`;
      });

      if (newBodyText === page.bodyText) {
        continue;
      }

      const frontmatter = (page.frontmatter as Record<string, unknown>) || {};
      const hasFrontmatter = Object.keys(frontmatter).length > 0;
      const fullContent = hasFrontmatter
        ? matter.stringify(newBodyText, frontmatter)
        : newBodyText;

      const relativeFilePath = path.join("wiki", page.category, `${page.slug}.md`);
      const filePath = path.join(archiveDir, relativeFilePath);

      await fs.writeFile(filePath, fullContent, "utf-8");

      const contentHash = crypto
        .createHash("sha256")
        .update(fullContent)
        .digest("hex");

      const wikilinks = extractWikilinks(newBodyText);

      await prisma.archivePage.update({
        where: { id: page.id },
        data: {
          bodyText: newBodyText,
          contentHash,
          wikilinks,
          updatedAt: new Date(),
        },
      });

      updatedCount++;
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[archive] Failed to propagate rename", {
        archiveId,
        oldSlug,
        newSlug,
        pageSlug: page.slug,
        error: message,
      });
    }
  }

  if (updatedCount > 0) {
    try {
      const git = simpleGit(archiveDir);
      await git.add("./*");
      await git.commit(`rename: propagate ${oldSlug} -> ${newSlug}`);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[archive] Git commit failed for rename propagation", {
        error: message,
        archiveId,
        oldSlug,
        newSlug,
      });
    }
  }

  logger.info("[archive] Rename propagation complete", {
    archiveId,
    oldSlug,
    newSlug,
    affected: updatedCount,
  });

  return updatedCount;
}
