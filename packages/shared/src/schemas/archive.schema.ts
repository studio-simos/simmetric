// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Archive Schemas =====

export const createArchiveSchema = z.object({
  name: z.string().min(1, "Archive name is required").max(200, "Archive name must be at most 200 characters"),
  description: z.string().max(2000, "Description must be at most 2000 characters").optional(),
});

export const updateArchiveSchema = z.object({
  name: z.string().min(1, "Archive name must not be empty").max(200, "Archive name must be at most 200 characters").optional(),
  description: z.string().max(2000, "Description must be at most 2000 characters").nullable().optional(),
  autoIndex: z.boolean().optional(),
}).refine(
  (data) => data.name !== undefined || data.description !== undefined || data.autoIndex !== undefined,
  { message: "At least one field must be provided to update" }
);

// D-12: title optional — omitted means deriveTitle(bodyText, slug) at create time;
// UUID/placeholder rejected defensively at the route layer (refine) and at the
// service layer (defense-in-depth check in archivePageService.createPage).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_TITLES = new Set(["Untitled", "New Page", "Untitled Page"]);

// Phase 153 (WIKI-01): "graph-wiki" is the category for generated wiki-graph
// articles (community / god-node / index). Additive — the DB column is a
// plain String; the enum is only enforced at the route + service layer. The
// existing read paths (wiki_query, archiveSearch, the page tree) filter on
// category uniformly, so graph-wiki rows surface in the existing UI (D-02).
const PAGE_CATEGORIES = [
  "entities",
  "concepts",
  "decisions",
  "graph-wiki",
] as const;
type PageCategory = (typeof PAGE_CATEGORIES)[number];

export const createPageSchema = z.object({
  title: z
    .string()
    .max(500, "Page title must be at most 500 characters")
    .optional()
    .refine(
      (v) =>
        !v ||
        (!UUID_RE.test(v.trim()) && !PLACEHOLDER_TITLES.has(v.trim())),
      {
        message:
          "Page title cannot be a UUID or placeholder; omit it for derivation",
      },
    ),
  content: z.string().min(1, "Page content is required"),
  category: z.enum(PAGE_CATEGORIES, {
    message: "Category must be one of: entities, concepts, decisions, graph-wiki",
  }),
  slug: z
    .string()
    .max(200, "Slug must be at most 200 characters")
    .optional()
    .refine((v) => !v || /^[a-z0-9-]+$/.test(v), {
      message: "Slug must be lowercase alphanumeric with hyphens only",
    }),
});

// D-04 (Phase 77): `body` is a body-only edit field. The route recomposes
// `matter.stringify(body, oldPage.frontmatter ?? {})` into `content` before
// calling `updatePage`, so the frontmatter (incl. Phase 79 WIKI-01 `Fonti`)
// is preserved. `validatePageContent` runs on the raw `body`, not the
// recomposed file. The `.refine` enforces at-least-one-field so an empty
// PUT is rejected at the schema layer rather than silently no-op'ing.
export const updatePageSchema = z.object({
  title: z.string().min(1, "Page title must not be empty").max(500, "Page title must be at most 500 characters").optional(),
  content: z.string().min(1, "Page content must not be empty").optional(),
  body: z.string().min(1, "Page body must not be empty").optional(),
  category: z.enum(PAGE_CATEGORIES, {
    message: "Category must be one of: entities, concepts, decisions, graph-wiki",
  }).optional(),
  slug: z.string().min(1, "Slug must not be empty").max(200, "Slug must be at most 200 characters").optional(),
}).refine(
  (d) => d.title !== undefined || d.content !== undefined || d.body !== undefined || d.category !== undefined || d.slug !== undefined,
  { message: "At least one field must be provided to update" },
);

export const archiveSearchQuerySchema = z.object({
  query: z.string().min(1, "Search query is required").max(500, "Search query must be at most 500 characters"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z.enum(PAGE_CATEGORIES).optional(),
});

export type CreateArchiveInput = z.infer<typeof createArchiveSchema>;
export type UpdateArchiveInput = z.infer<typeof updateArchiveSchema>;
export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
export type ArchiveSearchQuery = z.infer<typeof archiveSearchQuerySchema>;

export const archiveConfigSchema = z.object({
  namingConvention: z.object({ pattern: z.string(), message: z.string() }).optional(),
  requiredFrontmatter: z.record(z.string(), z.object({ type: z.string(), required: z.boolean() })).optional(),
  lintRules: z.array(z.object({
    type: z.string(),
    severity: z.enum(["error", "warning"]),
    config: z.unknown(),
  })).optional(),
  linkingDensity: z.object({ min: z.number(), max: z.number() }).optional(),
  agentPersona: z.enum(["conservative", "balanced", "exploratory"]).optional(),
  maintenanceSchedule: z.string().optional(),
  purpose: z.string().optional(),
  scope: z.string().optional(),
});
export type ArchiveConfigInput = z.infer<typeof archiveConfigSchema>;

export const archiveSchemaTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  config: archiveConfigSchema,
  pageTypes: z.array(z.object({
    name: z.string(),
    requiredSections: z.array(z.string()).default([]),
    optionalSections: z.array(z.string()).default([]),
  })).optional(),
});
export type ArchiveSchemaTemplateInput = z.infer<typeof archiveSchemaTemplateSchema>;

const updateArchiveConfigSchema = archiveConfigSchema.partial();
type UpdateArchiveConfigInput = z.infer<typeof updateArchiveConfigSchema>;

// D-04b / KB-05: copy document(s) into an archive via the async import pipeline.
// Single-doc path: POST /api/archives/:archiveId/copy-from-doc { documentId }.
// Batch path: POST /api/archives/:archiveId/copy-from-doc { documentIds[] } —
// fail-closed: if ANY documentId is inaccessible (assertDocumentReadAccess),
// the whole batch is rejected with 403 (no partial dispatch). The max(50) cap
// prevents runaway batch DoS (T-64-24).
export const copyToArchiveRequestSchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
});
type CopyToArchiveRequestInput = z.infer<typeof copyToArchiveRequestSchema>;

export const copyToArchiveBatchRequestSchema = z.object({
  documentIds: z
    .array(z.string().uuid("Invalid document ID"))
    .min(1, "At least one documentId is required")
    .max(50, "Batch cannot exceed 50 documents"),
});
type CopyToArchiveBatchRequestInput = z.infer<typeof copyToArchiveBatchRequestSchema>;

// D-09 (Phase 87): typed shape for ArchiveConfig.config.localLLMOnly propagation.
// Passthrough preserves arbitrary existing config keys (namingConvention,
// lintRules, requiredFrontmatter, linkingDensity, agentPersona, etc.) that
// archiveLocalLLMOnlyPropagation merges with `localLLMOnly: true` — the spread
// merge must not strip unknown keys. `archiveConfigSchema` (above) is the
// full validation contract for admin writes; this passthrough schema is the
// minimal structural type for the propagation write path, which only sets
// localLLMOnly and preserves the rest verbatim.
const archiveLocalLLMConfigSchema = z.object({
  localLLMOnly: z.boolean(),
}).passthrough();
export type ArchiveLocalLLMConfig = z.infer<typeof archiveLocalLLMConfigSchema>;
