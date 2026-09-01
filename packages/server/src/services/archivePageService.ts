// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { slugify } from "../utils/slugify";
import { logEvent } from "./eventLogService";
import matter from "gray-matter";
import { simpleGit } from "simple-git";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { CreatePageInput, UpdatePageInput } from "@simmetric-chat/shared";
import { deriveTitle, UUID_RE, PLACEHOLDERS } from "../utils/deriveTitle";
import { validateWritablePath } from "../utils/archivePath";
import { MULTI_CONFIG_TSVECTOR } from "./ftsService";

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");

/**
 * Maintain the PostgreSQL tsvector FTS column for a page (quick 260811-lxh).
 *
 * The `searchVector` column existed since the initial schema but had no
 * producer — wiki_query's ftsArchivePages, the archiveSearch route, and
 * synthesis Pass 3 all read it, so every FTS query returned 0 rows in
 * production (767/767 NULL). This mirrors the document_chunks producer
 * (routes/documents.ts:860: `to_tsvector('english', ...)`).
 *
 * Best-effort: a failure is logged and does NOT throw — the page write
 * already succeeded; FTS lag is preferable to failing the write (same
 * non-blocking contract as the chunk FTS insert in documents.ts:873).
 */
async function setSearchVector(pageId: string, bodyText: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "archive_pages" ap
      SET "searchVector" = to_tsvector('english', ${bodyText}),
          "searchVectorMulti" = (
            SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)}
            FROM (SELECT ${bodyText}::text AS t) AS t
          )
      WHERE ap."id" = ${pageId}
    `;
  } catch (err: unknown) {
    logger.error("[archive] Failed to update searchVector", {
      pageId,
      error: (err as Error).message,
    });
  }
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
    const captured = match[1];
    if (!captured) continue;
    const target = captured.split("|")[0]!.split("#")[0]!.trim();
    if (target) {
      links.add(target);
    }
  }
  return Array.from(links);
}

/**
 * Resolve slug collisions by checking both DB and filesystem.
 * Appends -2, -3, etc. to the slug until a unique name is found.
 */
async function resolveCollision(
  baseDir: string,
  archiveId: string,
  slug: string,
  category: string,
): Promise<string> {
  let candidateSlug = slug;
  let suffix = 1;

  while (true) {
    // The (archiveId, slug) unique index is NOT partial — it covers soft-deleted
    // rows too. A deletedAt: null filter would declare a slug free while the
    // hard index still holds it, making createPage throw P2002 (the re-upload
    // of a deleted wiki page failed with "Assegnazione fallita" until this
    // filter was removed).
    const existing = await prisma.archivePage.findFirst({
      where: { archiveId, slug: candidateSlug },
    });
    if (existing) {
      suffix++;
      candidateSlug = `${slug}-${suffix}`;
      continue;
    }

    const filePath = path.join(
      baseDir,
      "wiki",
      category,
      `${candidateSlug}.md`,
    );
    try {
      await fs.access(filePath);
      suffix++;
      candidateSlug = `${slug}-${suffix}`;
      continue;
    } catch {
      break;
    }
  }

  return candidateSlug;
}

/**
 * Create a page within an archive using the file-first dual-write pattern (ARCH-04).
 *
 * 10-step pipeline:
 * 1. Load archive, throw if deleted or missing
 * 2. Derive slug from title, resolve collisions
 * 3. Determine file path
 * 4. Validate path against traversal
 * 5. Write .md file to filesystem
 * 6. Compute SHA-256 content hash
 * 7. Parse frontmatter with gray-matter
 * 8. Extract wikilinks
 * 9. Create Prisma record
 * 10. Git commit + event log
 */
export async function createPage(
  archiveId: string,
  input: CreatePageInput,
  userId: string,
) {
  const archive = await prisma.archive.findFirst({
    where: { id: archiveId, deletedAt: null },
  });
  if (!archive) {
    throw new Error(`Archive not found: ${archiveId}`);
  }

  const archiveDir = path.join(ARCHIVES_BASE, archive.slug);
  const category = input.category || "entities";

  // Pre-compute content-derived fields (same regardless of slug)
  const contentHash = crypto
    .createHash("sha256")
    .update(input.content)
    .digest("hex");

  const parsed = matter(input.content);
  const frontmatterData = parsed.data;
  const bodyText = parsed.content;
  const wikilinks = extractWikilinks(bodyText);

  // D-12: defense-in-depth UUID/placeholder rejection. The route already
  // rejects these via Zod refine; this re-validates so an internal caller
  // bypassing the route cannot bake an unreadable identifier into the KB.
  if (input.title) {
    const trimmed = input.title.trim();
    if (UUID_RE.test(trimmed) || PLACEHOLDERS.has(trimmed)) {
      throw new Error(
        "Page title cannot be a UUID or placeholder; provide a human-readable title or omit it for derivation",
      );
    }
  }

  // D-10: when title is omitted (or empty), derive a readable title from
  // bodyText + slug via deriveTitle. Slug is seeded from input.title (or
  // the slugify fallback "page") so deriveTitle's slug-humanization step
  // has a reasonable starting point.
  const providedTitle = input.title && input.title.trim() ? input.title : "";
  const seedSlug = slugify(providedTitle, "page");
  const resolvedTitle = providedTitle || deriveTitle(bodyText, seedSlug);

  // Retry loop to handle P2002 race conditions on slug collision.
  // Between resolveCollision() (check) and prisma.archivePage.create() (insert),
  // a concurrent request may claim the same slug. On P2002, re-resolve and retry.
  const MAX_SLUG_RETRIES = 5;
  let page: Awaited<ReturnType<typeof prisma.archivePage.create>> | undefined;
  // When the caller supplies an explicit slug (e.g. the wiki-graph generator's
  // deterministic article slugs), honor it as the starting point instead of
  // deriving from the title — the generated god-node/community/index slugs are
  // part of the determinism contract and must not be re-derived or suffixed.
  let slug = input.slug ?? slugify(resolvedTitle, "page");

  for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
    slug = await resolveCollision(archiveDir, archiveId, slug, category);

    const relativeFilePath = path.join("wiki", category, `${slug}.md`);
    const filePath = path.join(archiveDir, relativeFilePath);

    validateWritablePath(archiveDir, relativeFilePath);

    const fileDir = path.dirname(filePath);
    await fs.mkdir(fileDir, { recursive: true });
    await fs.writeFile(filePath, input.content, "utf-8");

    try {
      page = await prisma.archivePage.create({
        data: {
          archiveId,
          slug,
          title: resolvedTitle,
          category,
          frontmatter: (Object.keys(frontmatterData).length > 0 ? frontmatterData : undefined) as Prisma.InputJsonValue,
          bodyText,
          contentHash,
          wikilinks,
          createdBy: userId,
        },
      });
      break; // Success — exit retry loop
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "P2002" && attempt < MAX_SLUG_RETRIES - 1) {
        // Unique constraint violation — slug was claimed concurrently.
        // Clean up the file we just wrote (the winner owns the file).
        try {
          await fs.unlink(filePath);
        } catch { /* best-effort cleanup */ }
        logger.warn("[archive] Slug collision detected, retrying", {
          archiveId,
          slug,
          attempt,
        });
        // Continue from the suffixed candidate — resetting to the base slug
        // would re-probe the exact slug that just collided (and re-write its
        // file). The next resolveCollision() pass suffixes it further.
        continue;
      }
      throw err;
    }
  }

  if (!page) {
    throw new Error(`Failed to create page after ${MAX_SLUG_RETRIES} retries`);
  }

  // Maintain the tsvector FTS column (quick 260811-lxh) — best-effort,
  // non-blocking: the page row is already committed.
  await setSearchVector(page.id, bodyText);

  logger.info("[archive] Page created", {
    archiveId,
    slug,
    title: resolvedTitle,
    category,
  });

  try {
    const relativeFilePath = path.join("wiki", category, `${slug}.md`);
    const git = simpleGit(archiveDir);
    await git.add(relativeFilePath);
    await git.commit(`page:create ${relativeFilePath}`);
  } catch (err: unknown) {
    logger.error("[archive] Git commit failed for page create", {
      error: (err as Error).message,
      archiveId,
      slug,
    });
  }

  logEvent("archive_page", page.id, "archive_page.created", userId, {
    archiveId,
    slug,
    title: resolvedTitle,
    category,
  }).catch((err) => {
    logger.error("[archive] Failed to log event", {
      error: (err as Error).message,
      pageId: page.id,
    });
  });

  return page;
}

/**
 * Retrieve a single page by archive ID and slug (composite key).
 */
export async function getPage(archiveId: string, slug: string) {
  const page = await prisma.archivePage.findFirst({
    where: { archiveId, slug, deletedAt: null },
  });
  if (!page) {
    throw new Error(`Page not found: ${archiveId}/${slug}`);
  }
  return maybeMigrateFonti(page);
}

/**
 * Lazy-migrate legacy `sources: [{ fileName }]` frontmatter to the canonical
 * `Fonti: [[raw_sources/<fileName>]]` wikilink array (Phase 79-03 D-07 /
 * WIKI-01). Called from getPage (read path) and from updatePage (write path
 * — see inline migrate below).
 *
 * Idempotent: if `Fonti` is already present OR `sources` is absent, returns
 * the page unchanged. Otherwise:
 *   - Computes `Fonti` from `sources[].fileName`
 *   - Best-effort persists BOTH DB (prisma.archivePage.update frontmatter)
 *     AND file (fs.writeFile with matter.stringify recomposition — F77 D-04
 *     landmine: use matter.stringify(body, migratedFm), never string-concat).
 *   - Returns the page with the migrated frontmatter.
 *
 * Best-effort: any persist failure is logged and does NOT throw — the read
 * still returns the migrated frontmatter in-memory so the caller sees the
 * canonical shape even if the side-effect persist fails (RESEARCH Open
 * Question 3: rebuildIndex reads from file, so we attempt the file persist
 * for consistency, but a failure is non-fatal).
 */
async function maybeMigrateFonti<
  T extends { id: string; archiveId: string; slug: string; category: string; bodyText: string; frontmatter: unknown },
>(page: T): Promise<T> {
  const fm = (page.frontmatter as Record<string, unknown> | null) ?? {};
  if (!Array.isArray(fm.sources) || fm.Fonti) {
    return page;
  }
  const fonti = (fm.sources as Array<{ fileName: string }>).map(
    (s) => `[[raw_sources/${s.fileName}]]`,
  );
  const migratedFm: Record<string, unknown> = { ...fm, Fonti: fonti };
  delete migratedFm.sources;

  // Best-effort file persist (needs archive slug → archive dir).
  try {
    const archive = await prisma.archive.findFirst({
      where: { id: page.archiveId, deletedAt: null },
    });
    if (archive) {
      const archiveDir = path.join(ARCHIVES_BASE, archive.slug);
      const relativePath = path.join("wiki", page.category, `${page.slug}.md`);
      const filePath = path.join(archiveDir, relativePath);
      const migratedContent = matter.stringify(page.bodyText, migratedFm);
      await fs.writeFile(filePath, migratedContent, "utf-8");
    }
  } catch (err: unknown) {
    logger.warn("[archive] Lazy migrate file persist failed", {
      pageId: page.id,
      error: (err as Error).message,
    });
  }

  // Best-effort DB persist.
  try {
    await prisma.archivePage.update({
      where: { id: page.id },
      data: { frontmatter: migratedFm as Prisma.InputJsonValue },
    });
  } catch (err: unknown) {
    logger.warn("[archive] Lazy migrate DB persist failed", {
      pageId: page.id,
      error: (err as Error).message,
    });
  }

  return { ...page, frontmatter: migratedFm };
}

/**
 * List pages within an archive, optionally filtered by category.
 *
 * Returns plain Prisma records. The computed `relatedCount` augmentation
 * (quick 260723-ke9 — topic-overlap related page count) is applied ONLY in
 * the UI list route handler, NOT here, so internal callers (synthesis,
 * archiveIndexService) that call getPages for their own purposes don't pay
 * the extra query + O(n) related-count computation on every run.
 *
 * Phase 155 / CSW-06 (D-07): the `take` param bounds the findMany so an
 * unbounded archivePage load can't OOM. Default 500 — callers needing all
 * pages pass an explicit limit or paginate. Note: synthesis's
 * runSynthesisCollectionStage calls getPages(archiveId) relying on the full
 * page set for entity extraction; that caller passes an explicit large take
 * (see synthesisStages.ts) so the default does not silently truncate it.
 */
export async function getPages(archiveId: string, category?: string, take = 500) {
  const where: Prisma.ArchivePageWhereInput = { archiveId, deletedAt: null };
  if (category) {
    where.category = category;
  }
  return prisma.archivePage.findMany({ where, take });
}

/**
 * Update a page's title, category, slug, and/or content.
 *
 * - Title changes without slug rename by default
 * - Category changes move the file between directories
 * - Slug changes move the file, update DB, and propagate wikilink renames
 * - Content changes rewrite FS, recompute hash, reparse frontmatter
 */
export async function updatePage(
  archiveId: string,
  slug: string,
  input: UpdatePageInput,
  userId: string,
) {
  const existing = await prisma.archivePage.findFirst({
    where: { archiveId, slug, deletedAt: null },
  });
  if (!existing) {
    throw new Error(`Page not found: ${archiveId}/${slug}`);
  }

  const archive = await prisma.archive.findFirst({
    where: { id: archiveId, deletedAt: null },
  });
  if (!archive) {
    throw new Error(`Archive not found: ${archiveId}`);
  }

  const archiveDir = path.join(ARCHIVES_BASE, archive.slug);

  const oldCategory = existing.category;
  const newCategory = input.category ?? oldCategory;
  const newContent = input.content ?? existing.bodyText;
  const newSlug = input.slug ?? slug;
  const slugChanged = newSlug !== slug;

  const oldRelativePath = path.join("wiki", oldCategory, `${slug}.md`);
  const newRelativePath = path.join("wiki", newCategory, `${newSlug}.md`);
  const newFilePath = path.join(archiveDir, newRelativePath);

  validateWritablePath(archiveDir, newRelativePath);

  // Phase 79-03 D-07: lazy-migrate legacy `sources` -> `Fonti` on write.
  // If the incoming content's frontmatter has `sources` and no `Fonti`,
  // recompute `Fonti` from `sources` and re-stringify via matter.stringify
  // (F77 D-04 landmine — never string-concat frontmatter). The migrated
  // content becomes what we writeFile + hash + parse for DB frontmatter.
  let effectiveContent = newContent;
  const preParsed = matter(newContent);
  if (Array.isArray(preParsed.data.sources) && !preParsed.data.Fonti) {
    const fonti = (preParsed.data.sources as Array<{ fileName: string }>).map(
      (s) => `[[raw_sources/${s.fileName}]]`,
    );
    const migratedFm: Record<string, unknown> = { ...preParsed.data, Fonti: fonti };
    delete migratedFm.sources;
    effectiveContent = matter.stringify(preParsed.content, migratedFm);
  }

  const newFileDir = path.dirname(newFilePath);
  await fs.mkdir(newFileDir, { recursive: true });
  await fs.writeFile(newFilePath, effectiveContent, "utf-8");

  if (oldCategory !== newCategory || slugChanged) {
    const oldFilePath = path.join(archiveDir, oldRelativePath);
    try {
      await fs.unlink(oldFilePath);
    } catch (err: unknown) {
      logger.warn(
        "[archive] Could not remove old page file after move",
        { error: (err as Error).message, oldPath: oldFilePath },
      );
    }
  }

  const contentHash = crypto
    .createHash("sha256")
    .update(effectiveContent)
    .digest("hex");

  const parsed = matter(effectiveContent);
  const frontmatterData = parsed.data;
  const bodyText = parsed.content;
  const wikilinks = extractWikilinks(bodyText);

  const updated = await prisma.archivePage.update({
    where: { id: existing.id, updatedAt: existing.updatedAt },
    data: {
      title: input.title ?? existing.title,
      slug: newSlug,
      category: newCategory,
      frontmatter:
        (Object.keys(frontmatterData).length > 0 ? frontmatterData : undefined) as Prisma.InputJsonValue,
      bodyText,
      contentHash,
      wikilinks,
    },
  }).catch((err: unknown) => {
    const error = err as { code?: string };
    if (error.code === "P2025") {
      throw new Error(`Conflict: page was modified concurrently (${archiveId}/${slug})`);
    }
    throw err;
  });

  logger.info("[archive] Page updated", {
    archiveId,
    slug: newSlug,
    oldCategory,
    newCategory,
    slugChanged,
  });

  // Maintain the tsvector FTS column (quick 260811-lxh) — best-effort,
  // non-blocking: the page row is already committed.
  await setSearchVector(updated.id, bodyText);

  try {
    const git = simpleGit(archiveDir);
    if (oldCategory !== newCategory || slugChanged) {
      await git.rm(oldRelativePath);
    }
    await git.add(newRelativePath);
    await git.commit(`page:update ${newRelativePath}`);
  } catch (err: unknown) {
    logger.error("[archive] Git commit failed for page update", {
      error: (err as Error).message,
      archiveId,
      slug: newSlug,
    });
  }

  logEvent("archive_page", updated.id, "archive_page.updated", userId, {
    archiveId,
    slug: newSlug,
    title: updated.title,
  }).catch((err) => {
    logger.error("[archive] Failed to log event", {
      error: (err as Error).message,
      pageId: updated.id,
    });
  });

  // Propagate wikilink renames after the main page update
  let renamePropagated = 0;
  if (slugChanged) {
    try {
      const { propagateRename } = await import("./archiveBacklinkService");
      renamePropagated = await propagateRename(archiveId, slug, newSlug, userId);
    } catch (err: unknown) {
      logger.error("[archive] Rename propagation failed", {
        error: (err as Error).message,
        archiveId,
        oldSlug: slug,
        newSlug,
      });
    }
  }

  return { ...updated, renamePropagated };
}

/**
 * Hard-delete all generated pages for an archive in a given category.
 *
 * Used by the wiki-graph pipeline (Plan 153-02 / D-03) to make re-runs
 * idempotent: a re-run HARD-DELETES prior `graph-wiki` rows for the archive
 * BEFORE regenerating, so stale articles don't accumulate. Generated pages
 * have no authored content to preserve — this is the documented hard-delete
 * exception (mirrors the MCPConnection uninstall exception in AGENTS.md).
 *
 * `prisma.archivePage.deleteMany` bypasses the `withSoftDelete()` extension
 * (NOT a soft delete — soft-deleted rows hold the `(archiveId, slug)` unique
 * index and accumulate; Pitfall 6). The DB delete is the load-bearing step;
 * the file + git cleanup is best-effort (catch + warn, never throw).
 *
 * Mirrors `deletePage`'s file + git cleanup pattern (lines 543-596) but for a
 * bulk hard-delete: query prior rows for their slugs, deleteMany, then
 * fs.unlink + git rm each .md file, then a single git commit.
 *
 * @returns the number of DB rows hard-deleted.
 */
export async function deleteGeneratedPages(
  archiveId: string,
  category: string,
): Promise<number> {
  // Query prior rows first — we need their slugs to clean up files, and
  // deleteMany does not return the deleted rows. Filter deletedAt: null so
  // a prior interrupted run's soft-deleted rows (if any ever existed) are
  // included in the slug list but the count reflects live rows. The
  // deleteMany below is unfiltered on deletedAt (it hard-deletes everything
  // matching archiveId+category, tombstoned or not — the bulk cleanup).
  const prior = await prisma.archivePage.findMany({
    where: { archiveId, category, deletedAt: null },
    select: { id: true, slug: true, category: true },
  });
  if (prior.length === 0) return 0;

  // HARD DELETE — generated pages have no authored content; mirrors the
  // MCPConnection uninstall hard-delete exception (AGENTS.md). NOT a soft
  // delete — soft-deleted rows hold the (archiveId, slug) unique index and
  // accumulate (Pitfall 6). deleteMany bypasses withSoftDelete().
  await prisma.archivePage.deleteMany({ where: { archiveId, category } });

  // File + git cleanup — best-effort. A failure here MUST NOT throw; the DB
  // delete is the load-bearing step. Mirrors deletePage:566-580 but bulk.
  const archive = await prisma.archive.findFirst({
    where: { id: archiveId },
    select: { slug: true },
  });
  if (archive) {
    const archiveDir = path.join(ARCHIVES_BASE, archive.slug);
    let git: ReturnType<typeof simpleGit> | null = null;
    try {
      git = simpleGit(archiveDir);
    } catch {
      git = null;
    }
    let removedAnyFile = false;
    for (const p of prior) {
      const relativePath = path.join("wiki", category, `${p.slug}.md`);
      const filePath = path.join(archiveDir, relativePath);
      try {
        await fs.unlink(filePath);
        removedAnyFile = true;
      } catch {
        /* best-effort — file may already be gone */
      }
      if (git) {
        try {
          await git.rm(relativePath);
        } catch {
          /* best-effort — git rm fails if the file was never tracked */
        }
      }
    }
    if (git && removedAnyFile) {
      try {
        await git.commit("wiki-graph: cleanup prior generated pages");
      } catch {
        /* best-effort — nothing to commit if no tracked files changed */
      }
    }
  }

  logger.info("[archive] deleteGeneratedPages hard-deleted rows", {
    archiveId,
    category,
    count: prior.length,
  });

  return prior.length;
}

/**
 * Delete a page (DB record + filesystem).
 *
 * Performs a hard delete: soft-deletes the DB record AND removes the .md file
 * from disk so it no longer appears in ZIP exports or filesystem listings.
 * The file is also git-rm'd to keep the git history consistent.
 */
export async function deletePage(archiveId: string, slug: string) {
  const existing = await prisma.archivePage.findFirst({
    where: { archiveId, slug, deletedAt: null },
  });
  if (!existing) {
    throw new Error(`Page not found: ${archiveId}/${slug}`);
  }

  // Soft-delete the DB record
  await prisma.archivePage.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
  });

  // Remove the .md file from disk
  const archive = await prisma.archive.findFirst({
    where: { id: archiveId, deletedAt: null },
  });
  if (archive) {
    const archiveDir = path.join(ARCHIVES_BASE, archive.slug);
    const relativePath = path.join("wiki", existing.category, `${slug}.md`);
    const filePath = path.join(archiveDir, relativePath);

    try {
      await fs.unlink(filePath);

      // Git rm the deleted file
      try {
        const git = simpleGit(archiveDir);
        await git.rm(relativePath);
        await git.commit(`page:delete ${relativePath}`);
      } catch (gitErr: unknown) {
        logger.error("[archive] Git rm failed for page delete", {
          error: (gitErr as Error).message,
          archiveId,
          slug,
        });
      }
    } catch (fsErr: unknown) {
      logger.warn("[archive] Could not remove page file during delete", {
        error: (fsErr as Error).message,
        filePath,
      });
    }
  }

  logger.info("[archive] Page deleted", {
    archiveId,
    slug,
    title: existing.title,
  });

  return { message: "Page deleted successfully" };
}

/**
 * Rebuild the DB index from filesystem .md files.
 *
 * Walks wiki/entities/, wiki/concepts/, wiki/decisions/.
 * For each .md (excluding _index.md), upserts via (archiveId, slug) key.
 * Returns reindexed and error counts.
 */
export async function rebuildIndex(
  archiveId: string,
): Promise<{ reindexed: number; errors: number }> {
  const archive = await prisma.archive.findFirst({
    where: { id: archiveId, deletedAt: null },
  });
  if (!archive) {
    throw new Error(`Archive not found: ${archiveId}`);
  }

  const archiveDir = path.join(ARCHIVES_BASE, archive.slug);
  const wikiDir = path.join(archiveDir, "wiki");

  let reindexed = 0;
  let errors = 0;

  const categories = ["entities", "concepts", "decisions"];

  for (const category of categories) {
    const catDir = path.join(wikiDir, category);

    let entries: { name: string }[];
    try {
      entries = await fs
        .readdir(catDir, { withFileTypes: true })
        .then((d) =>
          d.filter(
            (e) =>
              e.isFile() && e.name.endsWith(".md") && e.name !== "_index.md",
          ),
        );
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fileName = entry.name;
      const pageSlug = fileName.replace(/\.md$/, "");
      const filePath = path.join(catDir, fileName);

      try {
        const content = await fs.readFile(filePath, "utf-8");
        const contentHash = crypto
          .createHash("sha256")
          .update(content)
          .digest("hex");
        const parsed = matter(content);
        const frontmatterData = parsed.data;
        const bodyText = parsed.content;
        const wikilinks = extractWikilinks(bodyText);

        const title =
          (frontmatterData.title as string) ||
          pageSlug
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());

        let recordSlug = pageSlug;
        if (
          frontmatterData.slug &&
          typeof frontmatterData.slug === "string"
        ) {
          recordSlug = frontmatterData.slug;
        }

        const upserted = await prisma.archivePage.upsert({
          where: { archiveId_slug: { archiveId, slug: recordSlug } },
          create: {
            archiveId,
            slug: recordSlug,
            title,
            category,
            frontmatter:
              (Object.keys(frontmatterData).length > 0 ? frontmatterData : undefined) as Prisma.InputJsonValue,
            bodyText,
            contentHash,
            wikilinks,
            createdBy: archive.createdBy,
          },
          update: {
            title,
            category,
            frontmatter:
              (Object.keys(frontmatterData).length > 0 ? frontmatterData : undefined) as Prisma.InputJsonValue,
            bodyText,
            contentHash,
            wikilinks,
            updatedAt: new Date(),
          },
        });

        // Maintain the tsvector FTS column (quick 260811-lxh) — best-effort,
        // non-blocking: the upsert already committed.
        await setSearchVector(upserted.id, bodyText);

        reindexed++;
      } catch (err: unknown) {
        logger.error("[archive] Reindex error", {
          archiveId,
          file: fileName,
          error: (err as Error).message,
        });
        errors++;
      }
    }
  }

  logger.info("[archive] Reindex complete", { archiveId, reindexed, errors });

  return { reindexed, errors };
}
