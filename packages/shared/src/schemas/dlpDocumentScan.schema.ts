// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

/**
 * Phase 192 (DLP-01..04) — document-pipeline DLP contract vocabulary.
 *
 * One definition point for everything downstream plans (02..08) consume:
 * the entity-class enum (D-02/D-03), the pg-boss scan-job payload (D-01),
 * the eval-gate result shapes (D-11), the legacy backfill request/response
 * (D-12), and the preview unmask query contract (D-10). Handlers validate
 * with safeParse (repo convention); never re-declare these in a consuming
 * package.
 */

// PLACEHOLDER_SYNTAX note (D-03): placeholders are entity-class-instance
// numbered tokens of the form [CLASS_N], e.g. [PERSON_1], [GOV_ID_2] —
// occurrence-stable within a document. The bracket syntax lives server-side
// (masking/normalization in dlpDocumentService; the per-placeholder compiled
// re-composition regex in dlpRecomposeService). Shared only pins the CLASS
// vocabulary below — placeholder matching must never re-declare the class
// list per package.

/**
 * Entity classes (D-02): the fixed five-class vocabulary for document PII.
 * GOV_ID covers CF (Codice Fiscale) + P.IVA; FINANCIAL covers IBAN + amounts
 * detected by NER; PERSON/ADDRESS come from LLM NER; CONTACT covers
 * emails/phones in documents.
 */
export const DLP_ENTITY_CLASSES = [
  "PERSON",
  "ADDRESS",
  "FINANCIAL",
  "GOV_ID",
  "CONTACT",
] as const;

export type DlpEntityClass = (typeof DLP_ENTITY_CLASSES)[number];

export const dlpEntityClassSchema = z.enum(DLP_ENTITY_CLASSES);

/**
 * D-01 — pg-boss `dlp_document_scan` job payload (server→server, sent via
 * jobQueue.send()). documentId is a uuid; workspace/organization ids ride
 * along so the consumer can assert tenancy without a join before touching
 * the document row.
 */
export const dlpScanJobPayloadSchema = z.object({
  documentId: z.string().uuid(),
  workspaceId: z.string().min(1),
  organizationId: z.string().min(1),
});
export type DlpScanJobPayload = z.infer<typeof dlpScanJobPayloadSchema>;

/** Per-class eval row (D-11): detected vs expected counts + FP tally. */
const dlpEvalClassRowSchema = z.object({
  entityClass: dlpEntityClassSchema,
  detected: z.number().int().min(0),
  expected: z.number().int().min(0),
  falsePositives: z.number().int().min(0),
});
export type DlpEvalClassRow = z.infer<typeof dlpEvalClassRowSchema>;

/**
 * D-11 — eval result, discriminated on `noRun`:
 * - no-run arm: `{ noRun: true, passed: false }` — the gate has never run
 *   (fresh install); enablement UI must treat it as "gate not passed".
 * - full-result arm: the persisted run metrics (fpRate, per-class counts,
 *   ISO lastRun timestamp, and which NER mode the run used).
 *
 * The arms are named so dlpEvalRunResponseSchema can extend both (Zod 4
 * discriminated unions have no .extend of their own).
 */
const dlpEvalNoRunArmSchema = z.object({
  noRun: z.literal(true),
  passed: z.literal(false),
});
const dlpEvalFullResultArmSchema = z.object({
  noRun: z.literal(false).optional(),
  passed: z.boolean(),
  fpRate: z.number().min(0),
  totalChecks: z.number().int().min(0),
  perClass: z.array(dlpEvalClassRowSchema),
  lastRun: z.string().datetime(),
  nerMode: z.enum(["live", "stub", "skipped"]),
});
export const dlpEvalResultSchema = z.discriminatedUnion("noRun", [
  dlpEvalNoRunArmSchema,
  dlpEvalFullResultArmSchema,
]);
export type DlpEvalResult = z.infer<typeof dlpEvalResultSchema>;

/** D-11 — POST /api/system/dlp/eval/run response: result + wall duration. */
export const dlpEvalRunResponseSchema = z.discriminatedUnion("noRun", [
  dlpEvalNoRunArmSchema.extend({ durationSeconds: z.number().min(0) }),
  dlpEvalFullResultArmSchema.extend({ durationSeconds: z.number().min(0) }),
]);
export type DlpEvalRunResponse = z.infer<typeof dlpEvalRunResponseSchema>;

/**
 * D-12 — POST /api/system/dlp/backfill request: empty-body trigger (the
 * endpoint counts eligible docs server-side; passthrough tolerated so
 * clients may send `{}` or a JSON body with no declared keys).
 */
export const dlpBackfillRequestSchema = z.object({}).passthrough().optional();

/** D-12 — POST /api/system/dlp/backfill response. */
export const dlpBackfillResponseSchema = z.object({
  enqueued: z.number().int().min(0),
  skipped: z.number().int().min(0),
  totalEligible: z.number().int().min(0),
  errors: z.array(z.string()),
});
export type DlpBackfillResponse = z.infer<typeof dlpBackfillResponseSchema>;

/**
 * D-10 — GET /:documentId/text?unmask=true query contract. Strict
 * literal-union semantics (plan 04 tightening / T-192-21): only the exact
 * strings "true" / "false" (case-insensitive) parse. z.coerce.boolean() is
 * deliberately NOT used: its Boolean() semantics coerce ANY non-empty
 * string — "banana" included — to true, which would make ?unmask=banana a
 * silent unmask attempt. It fails safe to masked at the route (permission
 * still gates), but the strictness is pinned here so the query contract
 * never widens by accident. Handlers gate the unmask arm behind the
 * `dlp:unmask` permission (rbac middleware), not this schema.
 */
const booleanQueryParamSchema = z
  .string()
  .transform((v) => v.toLowerCase())
  .refine((v) => v === "true" || v === "false", {
    message: "Expected 'true' or 'false'",
  })
  .transform((v) => v === "true");

export const dlpUnmaskQuerySchema = z.object({
  unmask: booleanQueryParamSchema.optional(),
});

/**
 * Phase 192 plan 02 (D-02) — LLM NER wire contracts.
 *
 * NER output arm (T-192-04 mitigation): the model's constrained-decoding
 * response is safeParse'd through this schema; entries whose `text` is NOT a
 * verbatim substring of the scanned chunk are DROPPED by the caller
 * (dlpNer — paraphrase guard, never mask by fuzzy match).
 */
export const nerResponseSchema = z.object({
  entities: z.array(
    z.object({
      text: z.string().min(1),
      entityClass: dlpEntityClassSchema,
    }),
  ),
});
export type NerResponse = z.infer<typeof nerResponseSchema>;

/** NER request payload bound (chunkText max mirrors the 10k free-text cap). */
const nerRequestPayloadSchema = z.object({
  chunkText: z.string().min(1).max(10_000),
});