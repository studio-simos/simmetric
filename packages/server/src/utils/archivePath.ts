// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import path from "path";

/**
 * Validate that a target path stays within the archive base directory.
 * Uses path.resolve + prefix check as defense-in-depth against path traversal.
 * Throws on any traversal attempt.
 */
export function validateArchivePath(
  archiveBase: string,
  targetPath: string
): void {
  const resolvedTarget = path.resolve(archiveBase, targetPath);
  const resolvedBase = path.resolve(archiveBase);
  if (
    !resolvedTarget.startsWith(resolvedBase + path.sep) &&
    resolvedTarget !== resolvedBase
  ) {
    throw new Error(
      `Path traversal detected: ${targetPath} is outside archive directory`,
    );
  }
}

/**
 * D-03: defense-in-depth for raw_sources/ immutability (WIKI-02).
 *
 * Rejects any write target NOT under <archiveBase>/wiki/. By construction
 * createPage/updatePage always build `relativeFilePath = path.join("wiki", category, ...)`
 * so the guard passes for legitimate writes; it locks the invariant against
 * future regressions that might try to write or delete under raw_sources/.
 *
 * Calls validateArchivePath first to keep the anti-traversal check.
 */
export function validateWritablePath(
  archiveBase: string,
  targetPath: string
): void {
  validateArchivePath(archiveBase, targetPath);
  const wikiBase = path.resolve(archiveBase, "wiki");
  const resolvedTarget = path.resolve(archiveBase, targetPath);
  if (
    !resolvedTarget.startsWith(wikiBase + path.sep) &&
    resolvedTarget !== wikiBase
  ) {
    throw new Error(
      `Write target outside wiki/ directory: ${targetPath}. raw_sources/ is immutable.`,
    );
  }
}
