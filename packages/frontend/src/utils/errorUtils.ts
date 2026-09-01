// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Extract a human-readable error message from an unknown caught value.
 *
 * Since TypeScript 4.4+, catch variables default to `unknown` (not `any`).
 * This utility safely extracts a message string for display in toasts, error
 * banners, and logs without casting to `any`.
 *
 * @param err  - The caught value (throw can be anything).
 * @param fallback - Default message when `err` is not an Error instance.
 */
export function getErrorMessage(err: unknown, fallback = "An unexpected error occurred"): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}
