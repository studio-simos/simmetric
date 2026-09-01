// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Convert a simple glob pattern to a RegExp for URL path matching.
 * Supported patterns:
 *   *     matches any single path segment (no slashes)
 *   **    matches any number of path segments (including zero)
 *   ?     matches exactly one character
 *   {a,b} matches a or b (alternation)
 *
 * Patterns are matched against pathname only (not query string or hash).
 * Matching is case-insensitive per URL convention.
 */
export function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // Skip trailing slash after **/
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        regex += "\\{";
        i++;
      } else {
        const opts = pattern.slice(i + 1, end).split(",");
        regex += "(" + opts.map(o => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = end + 1;
      }
    } else if (ch !== undefined && ".+^${}()|[]\\".includes(ch)) {
      regex += "\\" + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp("^" + regex + "$", "i");
}