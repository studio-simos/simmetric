// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Lightweight browser-compatible logger utility.
 *
 * Wraps `console.error` with a consistent formatted prefix matching the winston
 * pattern used in server/widget packages. Zero external dependencies — pure
 * TypeScript with the same `{ error: "..." }` metadata convention.
 *
 * Format: `[module] message { "error": "..." }`
 */

interface LoggerMeta {
  error?: unknown;
  [key: string]: unknown;
}

function formatMeta(meta?: LoggerMeta): string {
  if (!meta) return "";
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    serialized[key] = value instanceof Error ? value.message : value;
  }
  return " " + JSON.stringify(serialized);
}

export const logger = {
  error(message: string, meta?: LoggerMeta): void {
    console.error(`${message}${formatMeta(meta)}`);
  },
  warn(message: string, meta?: LoggerMeta): void {
    console.warn(`${message}${formatMeta(meta)}`);
  },
};
