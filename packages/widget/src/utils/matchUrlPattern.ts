// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { globToRegex } from "./globToRegex";

export function matchUrlPattern(patterns: string, pathname: string): boolean {
  if (!patterns || patterns.trim() === "") return false;

  let globPatterns: string[];
  try {
    const parsed = JSON.parse(patterns);
    if (!Array.isArray(parsed)) return false;
    globPatterns = parsed;
  } catch {
    globPatterns = patterns.split(",").map((p) => p.trim()).filter(Boolean);
  }

  for (const pattern of globPatterns) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(pathname)) return true;
    } catch {
      // Invalid pattern, skip
    }
  }
  return false;
}