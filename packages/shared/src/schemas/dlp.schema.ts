// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

/**
 * DLP pattern configuration schemas (quick 260829-ony — DLP_FEATURES_SPEC
 * §2.3). One source of truth for the /api/system/dlp/patterns CRUD + test
 * endpoints; handlers validate with safeParse (conventions.md).
 */

/**
 * Machine name: snake_case (letters, digits, underscore) — the audit-log
 * identifier and the built-in seed natural key. Max 100 (spec §2.3).
 */
const dlpPatternNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_]+$/, "Name must be snake_case");

/**
 * Regex SOURCE string (no /…/ delimiters). Max 2000 (spec §2.3). Compile
 * validation (invalid regex → 400) happens server-side in
 * dlpPatternService.compileRegex — the ReDoS v1 mitigation is validation at
 * save, not a runtime timeout (spec §4.2).
 */
const dlpPatternSourceSchema = z.string().min(1).max(2000);

const patternFlagsSchema = z
  .string()
  .max(10)
  .regex(/^[a-z]*$/i, "Flags must contain only regex flag letters")
  .default("gu");

const replacementSchema = z.string().max(100).default("[REDACTED]");

// POST /api/system/dlp/patterns — create a CUSTOM pattern (isBuiltIn is
// server-assigned true only for the migration seed; a create is always custom).
export const createDlpPatternSchema = z.object({
  name: dlpPatternNameSchema,
  displayName: z.string().min(1).max(200),
  pattern: dlpPatternSourceSchema,
  patternFlags: patternFlagsSchema,
  replacement: replacementSchema,
  isEnabled: z.boolean().default(true),
});

/**
 * PUT /api/system/dlp/patterns/:id — update.
 *
 * All fields optional (partial). BUILT-IN immutability (spec §4.4) is
 * ENFORCED AT THE ROUTE, not in the schema: for isBuiltIn rows the handler
 * rejects any payload carrying pattern/patternFlags/replacement (400) and
 * accepts only displayName + isEnabled. The schema stays permissive because
 * custom patterns legitimately update all fields.
 */
export const updateDlpPatternSchema = z
  .object({
    displayName: z.string().min(1).max(200),
    pattern: dlpPatternSourceSchema,
    patternFlags: z.string().max(10).regex(/^[a-z]*$/i),
    replacement: z.string().max(100),
    isEnabled: z.boolean(),
  })
  .partial();

// POST /api/system/dlp/patterns/:id/test — sample text to scan (no persist).
// 10k cap keeps a malicious sample from pegging the event loop on a wide regex.
export const testPatternSchema = z.object({
  sample: z.string().min(1).max(10_000),
});

// :id path param validation (Express params are string | string[] under
// noUncheckedIndexedAccess typing) — mirrors memoryIdParamSchema conventions.
export const dlpPatternIdParamSchema = z.object({
  id: z.string().uuid("Invalid pattern ID"),
});
type DlpPatternIdParam = z.infer<typeof dlpPatternIdParamSchema>;

type CreateDlpPatternInput = z.infer<typeof createDlpPatternSchema>;
type UpdateDlpPatternInput = z.infer<typeof updateDlpPatternSchema>;
type TestPatternInput = z.infer<typeof testPatternSchema>;

/**
 * Shape returned by GET /api/system/dlp/patterns and accepted back in edits
 * (frontend contract — mirrors the DlpPattern model minus timestamps).
 */
const dlpPatternResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  pattern: z.string(),
  patternFlags: z.string(),
  replacement: z.string(),
  isEnabled: z.boolean(),
  isBuiltIn: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DlpPatternResponse = z.infer<typeof dlpPatternResponseSchema>;