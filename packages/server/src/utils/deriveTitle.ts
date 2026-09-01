// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * deriveTitle — derive a human-readable ArchivePage title from content + slug.
 *
 * Used by:
 *  - archivePageService.createPage (preventive: derive on omitted title)
 *  - archivePageTitleBackfill (corrective: idempotent startup backfill of
 *    UUID/placeholder-titled pages)
 *
 * Decision D-10: derivation order is
 *   1. First markdown heading (`# ...`)
 *   2. First non-empty bodyText line (frontmatter stripped via gray-matter)
 *   3. Humanized slug (`patient-diagnosis-summary` → `Patient Diagnosis Summary`)
 *
 * UUIDs and placeholder strings are NEVER used as derived titles — if the
 * chosen source is a UUID or placeholder, the next source is tried, falling
 * back to the humanized slug. This preserves chain-of-custody of wiki pages
 * (AI-SPEC "chain-of-custody della pagina wiki") so that unreadable
 * identifiers are never baked into the KB and do not compound across
 * re-synthesis cycles.
 */
import matter from "gray-matter";

/** Multiline regex: capture text of the first `# Heading` line. */
const HEADING_RE = /^#\s+(.+)$/m;
/** UUID v1-v5 format detector (case-insensitive). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Placeholder titles that must never be persisted to the KB. */
const PLACEHOLDERS = new Set(["Untitled", "New Page", "Untitled Page"]);

/** Re-exported so callers (createPage validation, backfill) can reuse. */
export { UUID_RE, PLACEHOLDERS };

/**
 * Derive a readable title from body content + slug.
 *
 * Order (D-10): heading → first non-empty body line → humanized slug.
 * UUID/placeholder sources are skipped; if all sources fail, returns
 * `"Untitled"` as the last-resort fallback.
 */
export function deriveTitle(bodyText: string, slug: string): string {
  // Step 1: first markdown heading.
  const heading = bodyText.match(HEADING_RE)?.[1]?.trim();
  if (heading && !UUID_RE.test(heading) && !PLACEHOLDERS.has(heading)) {
    return heading;
  }

  // Step 2: first non-empty body line (frontmatter stripped via gray-matter).
  const stripped = matter(bodyText).content;
  const firstLine = stripped
    .split(/\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (
    firstLine &&
    !UUID_RE.test(firstLine) &&
    !PLACEHOLDERS.has(firstLine)
  ) {
    return firstLine;
  }

  // Step 3: humanize the slug (`patient-diagnosis-summary` → `Patient Diagnosis Summary`).
  const humanized = slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  if (humanized) {
    return humanized;
  }

  // Last resort — no heading, no body, no slug.
  return "Untitled";
}

/**
 * Whether a page title should be (re)derived. Returns true for:
 *  - null/undefined/empty/whitespace-only titles
 *  - titles that are UUIDs
 *  - titles in the PLACEHOLDERS set
 *
 * Used by the idempotent backfill task to skip pages with already-readable
 * titles (T-64-09 mitigation).
 */
export function isTitleDerivable(
  title: string | null | undefined,
): boolean {
  if (!title || !title.trim()) return true;
  const t = title.trim();
  return UUID_RE.test(t) || PLACEHOLDERS.has(t);
}