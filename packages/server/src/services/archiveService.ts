// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { slugify } from "../utils/slugify";
import { logEvent } from "./eventLogService";
import { simpleGit } from "simple-git";
import fs from "fs/promises";
import path from "path";
import type { CreateArchiveInput, UpdateArchiveInput } from "@simmetric-chat/shared";
// D-15: PHI gate propagation — populates ArchiveConfig.config.localLLMOnly
// from WorkspaceTemplate.constraints.localLLMOnly on archive create.
import { propagateLocalLLMOnlyForUser } from "./archiveLocalLLMOnlyPropagation";

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");

/**
 * Build the Markdown table header for log.md.
 */
function buildLogHeader(archiveSlug: string, archiveName: string): string {
  return [
    `# ${archiveName} — Operation Log`,
    "",
    "| Timestamp | Source | Change | Description |",
    "|-----------|--------|--------|-------------|",
  ].join("\n");
}

/**
 * Build a log.md entry row recording archive creation.
 */
function buildLogCreationRow(): string {
  const timestamp = new Date().toISOString();
  return `| ${timestamp} | system | archive:init | Archive created |\n`;
}

/**
 * Create a new Archive with full directory scaffolding, git init, and log.md.
 *
 * 1. Derive slug from name
 * 2. Resolve slug collisions (append -2, -3)
 * 3. Create directory structure
 * 4. Initialize git repository
 * 5. Create initial log.md
 * 6. Create Prisma Archive record
 * 7. Fire-and-forget event log
 */
export async function createArchive(
  input: CreateArchiveInput,
  userId: string,
) {
  // Step 1: Derive slug
  let slug = slugify(input.name, "archive");

  // Step 2: Resolve slug collisions
  let collisionSuffix = 1;
  let candidateSlug = slug;
  while (await prisma.archive.findUnique({ where: { slug: candidateSlug } })) {
    collisionSuffix++;
    candidateSlug = `${slug}-${collisionSuffix}`;
  }
  slug = candidateSlug;

  const archiveDir = path.join(ARCHIVES_BASE, slug);

  // Step 3: Create directory structure
  const directories = [
    path.join(archiveDir, "raw_sources"),
    path.join(archiveDir, "wiki", "entities"),
    path.join(archiveDir, "wiki", "concepts"),
    path.join(archiveDir, "wiki", "decisions"),
    path.join(archiveDir, "inventory"),
    path.join(archiveDir, ".internal"),
  ];
  for (const dir of directories) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Step 4-5: Initialize git and create log.md (best-effort — archive works without git)
  try {
    const git = simpleGit(archiveDir);
    const gitignorePath = path.join(archiveDir, ".gitignore");
    await fs.writeFile(gitignorePath, ".internal/\n", "utf-8");
    await git.init();
    await git.addConfig("user.name", `user-${userId}`);
    await git.addConfig("user.email", "user@simmetric-chat");
    await git.add(".gitignore");
    await git.commit("archive: init");

    const logHeader = buildLogHeader(slug, input.name);
    const logRow = buildLogCreationRow();
    const logPath = path.join(archiveDir, "log.md");
    await fs.writeFile(logPath, logHeader + "\n" + logRow, "utf-8");
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.warn("[archive] Git/filesystem setup failed, creating archive without git", {
      error: message,
      slug,
    });
  }

  // Step 6: Create Prisma record
  const archive = await prisma.archive.create({
    data: {
      slug,
      name: input.name,
      description: input.description ?? null,
      createdBy: userId,
    },
  });

  logger.info("[archive] Archive created", {
    archiveId: archive.id,
    slug,
    name: input.name,
  });

  // Step 7: Fire-and-forget event log
  logEvent("archive", archive.id, "archive.created", userId, {
    slug,
    name: input.name,
  }).catch((err) => {
    logger.error("[archive] Failed to log event", {
      error: err.message,
      archiveId: archive.id,
    });
  });

  // Step 8: D-15 PHI gate propagation (fire-and-forget).
  // Populates ArchiveConfig.config.localLLMOnly from the creator's
  // accessible workspaces' templates (strictest-wins). A propagation failure
  // does NOT block archive creation (T-64-32) — the startup backfill
  // corrects any missed propagation on next restart.
  propagateLocalLLMOnlyForUser(userId, archive.id).catch((err: unknown) => {
    logger.error("[archive] localLLMOnly propagation failed", {
      archiveId: archive.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return archive;
}

/**
 * Retrieve a single Archive by ID.
 * Throws if the archive does not exist or has been soft-deleted.
 */
export async function getArchive(archiveId: string) {
  const archive = await prisma.archive.findFirst({
    where: { id: archiveId, deletedAt: null },
    include: {
      creator: {
        select: { id: true, username: true },
      },
    },
  });
  if (!archive) {
    throw new Error(`Archive not found: ${archiveId}`);
  }
  return archive;
}

/**
 * List all non-deleted archives, ordered by most recently updated.
 * Per D-02, global visibility — no workspace filter.
 *
 * Includes a filtered `_count.pages` reflecting only non-deleted pages
 * (ArchivePage rows where deletedAt is null). Excludes soft-deleted pages
 * via Prisma's typed filtered relation count — no raw SQL, no N+1 query.
 */
export async function getArchives() {
  return prisma.archive.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: "desc" },
    include: {
      creator: {
        select: { id: true, username: true },
      },
      _count: {
        select: {
          pages: { where: { deletedAt: null } },
        },
      },
    },
  });
}

/**
 * Update an archive's name and/or description.
 * The slug NEVER changes (D-08 slug immutability).
 */
export async function updateArchive(
  archiveId: string,
  input: UpdateArchiveInput,
) {
  const archive = await prisma.archive.findFirst({
    where: { id: archiveId, deletedAt: null },
  });
  if (!archive) {
    throw new Error(`Archive not found: ${archiveId}`);
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    data.name = input.name;
  }
  if (input.description !== undefined) {
    data.description = input.description;
  }
  if (input.autoIndex !== undefined) {
    data.autoIndex = input.autoIndex;
  }

  const updated = await prisma.archive.update({
    where: { id: archiveId },
    data,
  });

  logger.info("[archive] Archive updated", {
    archiveId,
    slug: archive.slug,
  });

  return updated;
}

/**
 * Soft-delete an archive and cascade soft-delete to all its pages.
 * The filesystem directory and .md files are preserved for git history.
 */
export async function deleteArchive(archiveId: string) {
  const archive = await prisma.archive.findFirst({
    where: { id: archiveId, deletedAt: null },
  });
  if (!archive) {
    throw new Error(`Archive not found: ${archiveId}`);
  }

  const now = new Date();

  // Cascade soft-delete to all pages
  await prisma.archivePage.updateMany({
    where: { archiveId, deletedAt: null },
    data: { deletedAt: now },
  });

  // Soft-delete the archive itself
  await prisma.archive.update({
    where: { id: archiveId },
    data: { deletedAt: now },
  });

  logger.info("[archive] Archive soft-deleted", {
    archiveId,
    slug: archive.slug,
  });

  return { message: "Archive deleted successfully" };
}

// Template directory presets
const TEMPLATES: Record<
  string,
  { directories: string[]; label: string }
> = {
  research: {
    label: "Research",
    directories: ["entities", "concepts", "decisions"],
  },
  project: {
    label: "Project",
    directories: ["entities", "decisions"],
  },
  personal: {
    label: "Personal",
    directories: ["entities", "concepts"],
  },
};

/**
 * Create an archive from a pre-defined template.
 *
 * Supported templates:
 * - research: entities, concepts, decisions (with stub _index.md in each)
 * - project: entities, decisions only
 * - personal: entities, concepts only
 */
export async function createArchiveFromTemplate(
  templateName: string,
  name: string,
  userId: string,
) {
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Unknown template: ${templateName}`);
  }

  // Create the archive via the standard pipeline
  const archive = await createArchive(
    { name, description: `${template.label} archive` },
    userId,
  );

  // Ensure template directories exist (they were already created by createArchive,
  // but some templates use fewer directories — we don't remove extras)
  // Write stub _index.md files in template-specific directories
  const archiveDir = path.join(ARCHIVES_BASE, archive.slug);
  for (const dirName of template.directories) {
    const dirPath = path.join(archiveDir, "wiki", dirName);
    await fs.mkdir(dirPath, { recursive: true });

    const indexPath = path.join(dirPath, "_index.md");
    const indexContent = [
      `---`,
      `title: ${dirName.charAt(0).toUpperCase() + dirName.slice(1)}`,
      `generated: ${new Date().toISOString()}`,
      `pageCount: 0`,
      `---`,
      "",
      `# ${dirName.charAt(0).toUpperCase() + dirName.slice(1)}`,
      "",
      `*Auto-generated index. Pages in this category will be listed here.*`,
      "",
    ].join("\n");

    await fs.writeFile(indexPath, indexContent, "utf-8");
  }

  logger.info("[archive] Archive created from template", {
    archiveId: archive.id,
    slug: archive.slug,
    template: templateName,
  });

  return archive;
}
