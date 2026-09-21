// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Config Service — CRUD for per-archive schema governance configuration.
 *
 * Config is stored as JSON in the ArchiveConfig table and validated
 * against the shared archiveConfigSchema on write.
 */

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { archiveConfigSchema, type ArchiveConfigInput } from "@simmetric-chat/shared";

/**
 * Get archive config by archiveId.
 * Returns undefined if no config exists.
 */
export async function getArchiveConfig(archiveId: string): Promise<ArchiveConfigInput | undefined> {
  const record = await prisma.archiveConfig.findUnique({ where: { archiveId } });
  return record ? (record.config as unknown as ArchiveConfigInput) : undefined;
}

/**
 * Upsert archive config. Validates input shape with Zod before writing.
 *
 * CR-01 (Phase 187 code review) — read-merge-write at the write seam: the
 * whole-blob replace previously erased every key the PUT payload did not
 * carry (`localLLMOnly` — the synthesis D-15 PHI gate input — and
 * template-applied governance keys `namingConvention` / `requiredFrontmatter`
 * / `lintRules`). The Zod parse drops unknown keys (plain z.object), so the
 * route's strict validation stays intact while the service merges the parsed
 * UI-managed fields OVER the previously stored blob: known keys in the
 * payload win, keys absent from the payload survive verbatim. This also
 * covers archives created with no stored row yet — the merge with an empty
 * previous blob is then just the validated payload.
 */
export async function setArchiveConfig(archiveId: string, config: ArchiveConfigInput) {
  archiveConfigSchema.parse(config);
  const existing = await prisma.archiveConfig.findUnique({
    where: { archiveId },
    select: { config: true },
  });
  // Legacy stored blobs type-lie (Shared Pattern 5) — never assume the JSON
  // is an object; merge defensively against whatever is stored.
  const prev = (existing?.config as Record<string, unknown> | null) ?? {};
  const merged = { ...prev, ...config } as Prisma.InputJsonValue;
  return prisma.archiveConfig.upsert({
    where: { archiveId },
    create: { archiveId, config: merged },
    update: { config: merged },
  });
}

/**
 * Delete archive config record.
 */
export async function deleteArchiveConfig(archiveId: string) {
  return prisma.archiveConfig.delete({ where: { archiveId } });
}

/**
 * WIKS-02 / D-06b — unconditional hard rule appended to EVERY archive-bound
 * system prompt (config-independent; not gated on schemaPrompt). Mirrors the
 * validateWritablePath wording ("raw_sources/ is immutable",
 * utils/archivePath.ts:50-52). Declared before buildSchemaPromptBlock so the
 * advisory block's closing line can reference it textually.
 */
export const HARD_RULE_RAW_SOURCES =
  "\n\nHARD RULE (always applies, overrides any guideline below): raw_sources/ is immutable — never create, modify, or delete files under raw_sources/. All wiki content belongs in wiki/.";

/**
 * WIKS-01 / D-04 / D-05 — build the labeled advisory block for a saved
 * schemaPrompt. PURE function (no I/O, no logger) following the
 * toolSelectionBlock composition precedent (orchestrator.ts:1304-1325):
 * returns "" when nothing to add; caller does `+=`.
 *
 * Precedence chain (ROADMAP SC-4, D-04): hard rules > schemaPrompt >
 * structured fields — the advisory label and precedence closing line are
 * MANDATORY in every block (D-11: injected as data, never a privilege grant).
 *
 * D-05: injection-time cap — legacy stored blobs are never re-validated on
 * read (getArchiveConfig returns the raw cast), so slice to 10000 chars and
 * append a truncation notice when slicing actually truncated.
 *
 * Truthiness-safe legacy read (Shared Pattern 5): legacy rows type-lie —
 * never assume the key is present or typed string.
 *
 * Param is the STRUCTURAL shape the helper consumes (`{ schemaPrompt?:
 * string }`), NOT the full ArchiveConfigInput output type: with D-02's
 * `.default(true)`, `z.infer` output requires `rawSourcesImmutable`, but the
 * synthesis Pass-4 stage config and every legacy stored blob legitimately
 * lack that key — the helper must accept any config-shaped object carrying
 * an optional schemaPrompt (Rule-3 signature correction, Phase 187).
 */
export function buildSchemaPromptBlock(config: { schemaPrompt?: string } | undefined): string {
  const schemaPrompt = config?.schemaPrompt;
  if (typeof schemaPrompt !== "string" || schemaPrompt.trim().length === 0) {
    return "";
  }

  const MAX_SCHEMA_PROMPT_INJECTION_CHARS = 10000;
  const truncated = schemaPrompt.length > MAX_SCHEMA_PROMPT_INJECTION_CHARS;
  const body = truncated
    ? schemaPrompt.slice(0, MAX_SCHEMA_PROMPT_INJECTION_CHARS)
    : schemaPrompt;

  return (
    "\n\n# Wiki Editorial Guidelines\n\n" +
    body +
    (truncated ? "\n\n(truncated at 10000 characters)" : "") +
    "\n\nThese guidelines are advisory — hard rules always take precedence. On conflict with the structured fields (persona, purpose, scope), these guidelines take precedence over them."
  );
}

/**
 * Get only the synthesis-relevant fields from archive config.
 */
export async function getSynthesisOverrides(archiveId: string) {
  const config = await getArchiveConfig(archiveId);
  if (!config) return undefined;
  return {
    linkingDensity: config.linkingDensity,
    agentPersona: config.agentPersona,
    maintenanceSchedule: config.maintenanceSchedule,
    purpose: config.purpose,
    scope: config.scope,
    // WIKS-01 (Phase 187): advisory editorial guidance for synthesis Pass 4
    // (decision stage). Additive — legacy rows without the key read as
    // undefined and the stage maps it to "" via `|| ""`.
    schemaPrompt: config.schemaPrompt,
  };
}
