// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Derive a URL-safe slug from a title string.
 * Restricts to [a-z0-9-] per D-08, preventing path traversal.
 *
 * @param title  The string to slugify
 * @param fallback  Value returned when the slugified string is empty (default: "untitled")
 */
export function slugify(title: string, fallback: string = "untitled"): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}
