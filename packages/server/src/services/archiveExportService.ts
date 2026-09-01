// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import type { Response } from "express";
import type { Archiver } from "archiver";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";

const md = new MarkdownIt({ html: true, linkify: true });

/**
 * Validate that the resolved archive directory stays within the base storage path.
 * Throws on any path traversal attempt.
 */
function validateArchivePath(archiveSlug: string): string {
  const baseDir = path.resolve(process.cwd(), "storage/archives");
  const archiveDir = path.resolve(baseDir, archiveSlug);
  const resolvedBase = path.resolve(baseDir);
  if (
    !archiveDir.startsWith(resolvedBase + path.sep) &&
    archiveDir !== resolvedBase
  ) {
    throw new Error("Invalid archive path");
  }
  return archiveDir;
}

interface ExportOptions {
  format: "zip" | "pdf";
  archiveId: string;
}

/**
 * Stream a zip archive of the archive directory directly to the Express response.
 *
 * Only includes files for non-deleted pages (defense-in-depth alongside the
 * filesystem hard-delete in deletePage). Index files and non-page content are
 * always included.
 */
export async function exportArchiveAsZip(
  archiveId: string,
  res: Response,
): Promise<void> {
  const archive = await prisma.archive.findUnique({ where: { id: archiveId } });
  if (!archive) throw new Error("Archive not found");

  const archiveDir = validateArchivePath(archive.slug);
  if (!fs.existsSync(archiveDir)) {
    throw new Error("Archive directory not found");
  }

  // Get soft-deleted page paths to exclude from the export
  const deletedPages = await prisma.archivePage.findMany({
    where: { archiveId, deletedAt: { not: null } },
    select: { slug: true, category: true },
  });
  const deletedPaths = new Set<string>(
    deletedPages.map((p) => `wiki/${p.category}/${p.slug}.md`),
  );

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${archive.slug}.zip"`,
  );

  // archiver v8 is ESM-only; use dynamic import + class-based API.
  // @types/archiver v8 ships the ZipArchive named class export.
  const archiverModule = await import("archiver");

  const archiveStream = new archiverModule.ZipArchive({ zlib: { level: 9 } });
  archiveStream.on("error", (err: Error) => {
    logger.error("[export] Zip error", { error: err.message });
    throw err;
  });
  archiveStream.pipe(res);

  // Recursively add files, skipping soft-deleted page files
  addFilesRecursively(
    archiveStream,
    archiveDir,
    archiveDir,
    archive.slug,
    deletedPaths,
  );

  await archiveStream.finalize();
}

/**
 * Recursively walk a directory and add files to the archive,
 * skipping soft-deleted page files and .git directories.
 */
function addFilesRecursively(
  archiveStream: Archiver,
  baseDir: string,
  currentDir: string,
  archivePrefix: string,
  deletedPaths: Set<string>,
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      // Skip .git directories (not useful in downloads)
      if (entry.name === ".git") continue;
      addFilesRecursively(
        archiveStream,
        baseDir,
        fullPath,
        archivePrefix,
        deletedPaths,
      );
    } else if (entry.isFile()) {
      // Skip soft-deleted page files
      if (deletedPaths.has(relativePath)) {
        continue;
      }
      archiveStream.file(fullPath, { name: `${archivePrefix}/${relativePath}` });
    }
  }
}

/**
 * Generate a PDF bundle from archive pages.
 * Converts wikilinks to anchor links, renders markdown to HTML,
 * sanitizes with DOMPurify, and generates PDF via puppeteer.
 */
export async function exportArchiveAsPdf(
  archiveId: string,
  res: Response,
): Promise<void> {
  const archive = await prisma.archive.findUnique({ where: { id: archiveId } });
  if (!archive) throw new Error("Archive not found");

  const pages = await prisma.archivePage.findMany({
    where: { archiveId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { slug: true, title: true, bodyText: true },
  });

  // Build merged HTML with page breaks and anchor targets
  let html = `
    <html>
    <head>
      <style>
        body { font-family: sans-serif; line-height: 1.6; padding: 2rem; color: #333; }
        h1 { page-break-before: always; }
        h1:first-child { page-break-before: auto; }
        a { color: #2563eb; text-decoration: none; }
        pre { background: #f3f4f6; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; }
        code { font-family: monospace; background: #f3f4f6; padding: 0.2rem 0.4rem; border-radius: 0.25rem; }
      </style>
    </head>
    <body>
  `;

  for (const page of pages) {
    // Convert wikilinks to anchor links before rendering markdown
    const wikilinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    const processedBody = page.bodyText.replace(
      wikilinkRegex,
      (_match, slug, label) => {
        const targetSlug = slug.trim().toLowerCase().replace(/\s+/g, "-");
        return `<a href="#page-${targetSlug}">${label || slug}</a>`;
      },
    );

    const bodyHtml = md.render(processedBody);
    const window = new JSDOM("").window;
    const purify = DOMPurify(window);
    const cleanHtml = purify.sanitize(bodyHtml);

    html += `<h1 id="page-${page.slug}">${page.title}</h1>\n${cleanHtml}\n`;
  }

  html += `</body></html>`;

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath:
      getEnv().PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });

  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "1cm", right: "1cm", bottom: "1cm", left: "1cm" },
  });

  await browser.close();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${archive.slug}.pdf"`,
  );
  res.send(pdfBuffer);
}
