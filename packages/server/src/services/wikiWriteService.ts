// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { withPageLock } from "./wikiLockService";
import { createPage, updatePage, getPage } from "./archivePageService";
import { getArchive } from "./archiveService";
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import matter from "gray-matter";
import { establishBacklinks } from "./archiveBacklinkService";
import { validatePageContent, validateSlugAgainstConvention } from "./archiveSchemaValidator";
import { getArchiveConfig } from "./archiveConfigService";

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
 * Classify whether a proposed edit is destructive.
 *
 * An edit is destructive if it removes >30% of lines or drops >3 wikilinks.
 * Creating a page from empty oldContent is never destructive.
 *
 * Uses line-based comparison instead of character count to avoid false positives
 * from reformatting, whitespace changes, or YAML frontmatter additions.
 */
function destructiveClassifier(
  oldContent: string,
  newContent: string,
): { isDestructive: boolean; percentRemoved: number; wikilinksLost: number } {
  if (!oldContent || oldContent.length === 0) {
    return { isDestructive: false, percentRemoved: 0, wikilinksLost: 0 };
  }

  // Line-based comparison: count non-empty lines to avoid flagging
  // whitespace reformatting as "destructive" content removal.
  const oldNonEmptyLines = oldContent.split("\n").filter((line) => line.trim().length > 0);
  const newNonEmptyLines = newContent.split("\n").filter((line) => line.trim().length > 0);

  const percentRemoved =
    oldNonEmptyLines.length > 0
      ? (1 - newNonEmptyLines.length / oldNonEmptyLines.length) * 100
      : 0;

  const oldLinks = extractWikilinks(oldContent);
  const newLinks = extractWikilinks(newContent);
  const newLinkSet = new Set(newLinks);

  let wikilinksLost = 0;
  for (const link of oldLinks) {
    if (!newLinkSet.has(link)) {
      wikilinksLost++;
    }
  }

  const isDestructive = percentRemoved > 30 || wikilinksLost > 3;

  return {
    isDestructive,
    percentRemoved: Math.max(0, percentRemoved),
    wikilinksLost,
  };
}

/**
 * Generate a preview of a proposed wiki edit.
 *
 * Fetches existing content (if updating), runs destructive classification,
 * creates a WikiEditRun record with status PENDING, and returns the run.
 */
export async function generatePreview(
  archiveId: string,
  slug: string,
  proposedContent: string,
  userId: string,
  action: "create" | "update",
) {
  let oldContent = "";
  if (action === "update") {
    try {
      const existing = await getPage(archiveId, slug);
      oldContent = existing.bodyText;
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.warn("[wikiWrite] Page not found for preview", {
        archiveId,
        slug,
        error: message,
      });
    }
  }

  const destructive = destructiveClassifier(oldContent, proposedContent);

  const run = await prisma.wikiEditRun.create({
    data: {
      archiveId,
      pageSlug: slug,
      action,
      status: "PENDING",
      previewJson: {
        oldContent,
        newContent: proposedContent,
        diff: { old: oldContent, new: proposedContent },
        destructive: destructive.isDestructive,
        percentRemoved: destructive.percentRemoved,
        wikilinksLost: destructive.wikilinksLost,
      },
      createdBy: userId,
    },
  });

  logger.info("[wikiWrite] Preview generated", {
    runId: run.id,
    archiveId,
    slug,
    destructive: destructive.isDestructive,
  });

  return run;
}

/**
 * Apply a pending wiki edit under a per-page lock.
 *
 * Writes the page (create or update), captures the git commit hash,
 * updates the WikiEditRun status to APPLIED, and establishes
 * bidirectional backlinks.
 */
export async function applyWikiEdit(runId: string, userId: string) {
  const run = await prisma.wikiEditRun.findUnique({
    where: { id: runId },
  });
  if (!run) {
    throw new Error(`WikiEditRun not found: ${runId}`);
  }
  if (run.status !== "PENDING" && run.status !== "APPROVED") {
    throw new Error(
      `WikiEditRun status is ${run.status}, expected PENDING or APPROVED`,
    );
  }

  const previewJson = run.previewJson as Record<string, any>;
  const { archiveId, pageSlug, action } = run;

  const config = await getArchiveConfig(archiveId);
  const validation = validatePageContent(previewJson.newContent || "", config, "agent");
  const slugValidation = validateSlugAgainstConvention(pageSlug, config);

  const allWarnings = [...validation.warnings, ...slugValidation.warnings];
  const allViolations = [...validation.violations, ...slugValidation.violations];

  if (allWarnings.length > 0) {
    logger.warn("[wikiWrite] Schema warnings for agent write", {
      archiveId,
      pageSlug,
      warnings: allWarnings.map((v) => v.message),
    });
  }
  if (allViolations.length > 0) {
    logger.warn("[wikiWrite] Schema violations for agent write (non-blocking)", {
      archiveId,
      pageSlug,
      violations: allViolations.map((v) => v.message),
    });
  }

  const result = await withPageLock(archiveId, pageSlug, async () => {
    if (action === "create") {
      const category = previewJson.category || "entities";
      await createPage(
        archiveId,
        { title: pageSlug, content: previewJson.newContent, category },
        userId,
      );
    } else {
      await updatePage(
        archiveId,
        pageSlug,
        { content: previewJson.newContent },
        userId,
      );
    }

    const archive = await getArchive(archiveId);
    const archiveDir = path.resolve(
      process.cwd(),
      "storage/archives",
      archive.slug,
    );
    const git = simpleGit(archiveDir);
    const log = await git.log({ n: 1 });
    const commitHash = log.latest?.hash;

    if (!commitHash) {
      throw new Error("Failed to retrieve git commit hash after page write");
    }

    const updatedPreviewJson = {
      ...previewJson,
      commitHash,
    };

    await prisma.wikiEditRun.update({
      where: { id: runId },
      data: {
        status: "APPLIED",
        approvedBy: userId,
        previewJson: updatedPreviewJson,
      },
    });

    await establishBacklinks(
      archiveId,
      pageSlug,
      previewJson.newContent,
      userId,
    );

    return { success: true as const, commitHash, warnings: allWarnings.map((v) => v.message), violations: allViolations.map((v) => v.message) };
  });

  logger.info("[wikiWrite] Edit applied", {
    runId,
    archiveId,
    pageSlug,
    commitHash: result.commitHash,
  });

  return result;
}

/**
 * Abort an in-progress git revert and restore the working tree.
 */
async function cleanupRevert(git: SimpleGit) {
  try {
    await git.raw(["revert", "--abort"]);
  } catch {
    try {
      await git.raw(["reset", "--hard", "HEAD"]);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.warn("[wikiWrite] Failed to clean up revert working tree", {
        error: message,
      });
    }
  }
}

/**
 * Revert an applied wiki edit by reverting its git commit.
 *
 * Uses `git revert --no-commit` to restore the page to the state
 * before the edit. If conflict markers are detected, the revert is
 * aborted and an error is thrown.
 */
export async function revertWikiEdit(runId: string, userId: string) {
  const run = await prisma.wikiEditRun.findUnique({
    where: { id: runId },
  });
  if (!run) {
    throw new Error(`WikiEditRun not found: ${runId}`);
  }
  if (run.status !== "APPLIED") {
    throw new Error(
      `WikiEditRun status is ${run.status}, expected APPLIED`,
    );
  }

  const previewJson = run.previewJson as Record<string, any>;
  const commitHash = previewJson.commitHash;
  if (!commitHash) {
    throw new Error("WikiEditRun has no commitHash");
  }

  const archive = await getArchive(run.archiveId);
  const archiveDir = path.resolve(
    process.cwd(),
    "storage/archives",
    archive.slug,
  );
  const git = simpleGit(archiveDir);

  await git.raw(["revert", "--no-commit", commitHash]);

  const page = await prisma.archivePage.findFirst({
    where: {
      archiveId: run.archiveId,
      slug: run.pageSlug,
      deletedAt: null,
    },
  });
  if (!page) {
    await cleanupRevert(git);
    throw new Error(
      `Page not found: ${run.archiveId}/${run.pageSlug}`,
    );
  }

  const filePath = path.join(
    archiveDir,
    "wiki",
    page.category,
    `${page.slug}.md`,
  );

  let fileContent: string;
  try {
    fileContent = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    await cleanupRevert(git);
    throw new Error(`Failed to read reverted file: ${message}`, { cause: err });
  }

  if (fileContent.includes("<<<<<<<")) {
    await git.raw(["revert", "--abort"]);
    throw new Error("Automatic undo failed due to conflicts");
  }

  await git.add(".");
  await git.commit(`page:revert ${commitHash}`);

  const parsed = matter(fileContent);
  const frontmatterData = parsed.data;
  const bodyText = parsed.content;
  const wikilinks = extractWikilinks(bodyText);
  const contentHash = crypto
    .createHash("sha256")
    .update(fileContent)
    .digest("hex");

  await prisma.archivePage.update({
    where: { id: page.id },
    data: {
      bodyText,
      contentHash,
      wikilinks,
      frontmatter:
        (Object.keys(frontmatterData).length > 0 ? (frontmatterData as Prisma.InputJsonValue) : undefined),
    },
  });

  await prisma.wikiEditRun.update({
    where: { id: runId },
    data: { status: "REVERTED", approvedBy: userId },
  });

  logger.info("[wikiWrite] Edit reverted", {
    runId,
    archiveId: run.archiveId,
    pageSlug: run.pageSlug,
    commitHash,
  });

  return { success: true as const };
}
