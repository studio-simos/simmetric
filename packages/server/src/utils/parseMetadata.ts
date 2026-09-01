// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Parse a JSON metadata string (ChatMessage.metadata / Chunk.metadata) into a
 * typed `Record<string, unknown>`, returning `{}` for any null/undefined/empty/
 * unparseable/non-object input.
 *
 * Phase 155 / CSW-04: centralizes the ad-hoc `JSON.parse(...metadata...)` +
 * try/catch call sites that previously swallowed parse failures (or let them
 * 500 a request). The `postProcessingService.ts:175-178` `{}` fallback is the
 * canonical pattern codified here.
 *
 * Pure helper — no Prisma / DB access (mirrors `slugify.ts`, `ssrfGuard.ts`).
 *
 * @param raw  the JSON string column value (nullable per `schema.prisma`)
 * @returns the parsed object, or `{}` on any failure/null/non-object input
 */
export function parseMetadata(
  raw: string | null | undefined
): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  // Reject non-object primitives/arrays — defends against `JSON.parse("5")`,
  // `JSON.parse("true")`, `JSON.parse("null")`, `JSON.parse("[1,2]")` leaking
  // a non-`Record<string, unknown>` shape into downstream `meta.tokenUsage`
  // / `meta.model` / `meta.chunkIndex` accessors.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}