// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { logger } from "../utils/logger";
import fs from "fs/promises";
import path from "path";

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");

/**
 * Append a structured Markdown table row to the archive's log.md file.
 *
 * The log.md file is created by archiveService.createArchive() with the table
 * header already in place. This function only appends rows — it never reads or
 * truncates the file.
 *
 * Row format: | ISO timestamp | source | change | description |
 *
 * @param archiveSlug - The slug of the archive whose log to append to
 * @param entry - The log entry with source, change, and description fields
 */
export async function appendToLog(
  archiveSlug: string,
  entry: { source: string; change: string; description: string },
): Promise<void> {
  const logPath = path.resolve(ARCHIVES_BASE, archiveSlug, "log.md");

  const timestamp = new Date().toISOString();
  const row = `| ${timestamp} | ${entry.source} | ${entry.change} | ${entry.description} |\n`;

  await fs.appendFile(logPath, row, "utf-8");

  logger.info("[archive] Log entry appended", {
    archive: archiveSlug,
    entry,
  });
}
