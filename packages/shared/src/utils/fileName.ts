// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Single source of truth for filename sanitization (quick 260808-vzm).
 *
 * Used by server, collector, and frontend so the stored name, the disk
 * filename, and the displayed name are all consistent and free of spaces,
 * path separators, control characters, non-ASCII characters, and traversal
 * sequences.
 *
 * Algorithm:
 * 1. Coerce to string and trim.
 * 2. Split off the extension: the substring after the LAST dot, but only if
 *    it is 1-10 characters of [a-zA-Z0-9]; otherwise treat the whole string
 *    as base with no extension.
 * 3. Sanitize the base: replace every character NOT in [a-zA-Z0-9._-] with
 *    a dash; collapse dash runs; collapse dot runs (neutralizes ".." and
 *    leading ".." traversal); strip leading dots and leading/trailing dashes.
 * 4. Sanitize the extension: keep only [a-zA-Z0-9], lowercase, cap at 10
 *    chars; drop entirely if empty.
 * 5. If the sanitized base is empty, use the fallback.
 * 6. Reassemble as base + (ext ? "." + ext : "").
 * 7. Truncate to 255 chars (OS-safe cap), preserving the extension.
 *
 * Pure string helper — no imports, no zod, no business logic (precedent:
 * `normalizeSource` in packages/shared/src/types/index.ts).
 */
export function sanitizeFileName(name: string, fallback = "untitled"): string {
  const trimmed = String(name ?? "").trim();

  // Split off the extension: substring after the LAST dot, only if it is
  // 1-10 characters of [a-zA-Z0-9].
  const lastDot = trimmed.lastIndexOf(".");
  let base = trimmed;
  let ext = "";
  if (lastDot > 0) {
    const candidate = trimmed.slice(lastDot + 1);
    if (/^[a-zA-Z0-9]{1,10}$/.test(candidate)) {
      base = trimmed.slice(0, lastDot);
      ext = candidate;
    }
  }

  // Sanitize the base: path separators -> dot (collapses into the dot-run
  // collapse below, so "../../etc/passwd" -> "etc.passwd" — no separators,
  // no traversal, no leading dots), other invalid chars -> dash, collapse
  // dash runs, collapse dot runs (neutralizes ".."), strip leading and
  // trailing dots/dashes (hidden files / traversal).
  const sanitizedBase = base
    .replace(/[\\/]/g, ".")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");

  // Sanitize the extension: keep only [a-zA-Z0-9], lowercase, cap at 10.
  const sanitizedExt = ext
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 10);

  const finalBase = sanitizedBase || fallback;
  const assembled = sanitizedExt ? `${finalBase}.${sanitizedExt}` : finalBase;

  // Truncate to 255 chars, preserving the extension: if truncation would cut
  // into the extension, truncate the base instead and re-append it.
  if (assembled.length <= 255) {
    return assembled;
  }
  if (!sanitizedExt) {
    return assembled.slice(0, 255);
  }
  const extWithDot = `.${sanitizedExt}`;
  const maxBase = 255 - extWithDot.length;
  return `${finalBase.slice(0, maxBase)}${extWithDot}`;
}
