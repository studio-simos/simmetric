// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * pdfjsFonts.ts — resolve the pdfjs-dist bundled standard-fonts directory.
 *
 * WHY the trailing path separator is mandatory: pdfjs-dist's Node binary-data
 * factory concatenates the standard-font FILENAME directly onto the provided
 * base (`base + filename`, no separator inserted), so the base must itself
 * end with a path separator for the resulting font path to resolve.
 *
 * WHY existence-checked candidates instead of a single literal: the jest
 * `moduleNameMapper` intercepts `require.resolve` of anything starting with
 * the pdfjs-dist package name (it maps to the source-level mock), so under
 * jest the primary candidate is unresolvable and a cwd-based candidate is
 * needed; under tsx dev the pnpm workspace layout keeps the package behind a
 * symlink in packages/server/node_modules. Each candidate is stat-checked so
 * a layout that matches none degrades to the empty string — pdfjs then keeps
 * its built-in warn-and-continue behavior for missing font data, exactly as
 * before this helper existed (font issues are non-fatal by design).
 */

import path from "path";
import fs from "fs";

let cached: string | undefined;

function candidatePaths(): string[] {
  const candidates: string[] = [];
  // Primary: resolve inside the installed pdfjs-dist package itself — walks
  // packages/server/node_modules (pnpm symlink) to the real store in tsx dev
  // and works identically in the Docker runtime stage where
  // /app/packages/server/node_modules/pdfjs-dist exists after the prod
  // install.
  try {
    candidates.push(
      path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts"),
    );
  } catch {
    // jest's moduleNameMapper intercepts this require — fall through to the
    // cwd-based candidates below.
  }
  // Flat / hoisted layout fallback (the one that fires under jest — the
  // mapper intercepts require.resolve, but the real directory exists on disk
  // relative to the cwd, which jest runs from packages/server).
  candidates.push(path.resolve(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts"));
  // Explicit workspace fallback (monorepo layout resolved from the repo root).
  candidates.push(
    path.resolve(process.cwd(), "packages", "server", "node_modules", "pdfjs-dist", "standard_fonts"),
  );
  return candidates;
}

/**
 * Absolute filesystem path to the pdfjs-dist bundled standard_fonts
 * directory, terminated with a path separator (pdfjs appends the font
 * filename directly onto this base). Returns "" when no candidate layout
 * exists — pdfjs then falls back to its current warn-and-continue behavior.
 * Memoized: resolution runs at most once per process.
 */
export function getPdfStandardFontDataUrl(): string {
  if (cached !== undefined) {
    return cached;
  }
  cached = "";
  for (const candidate of candidatePaths()) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        cached = candidate.endsWith(path.sep) ? candidate : candidate + path.sep;
        break;
      }
    } catch {
      // Candidate not present in this layout — try the next one.
    }
  }
  return cached;
}