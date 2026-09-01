// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Wiki Schemas =====

const wikiQueryParamsSchema = z
  .object({
    query: z.string().min(1).max(500).optional(),
    slug: z.string().min(1).max(200).optional(),
    archiveId: z.string().uuid().optional(),
    depth: z.coerce.number().int().min(1).max(3).default(1),
  })
  .refine((data) => data.query || data.slug, {
    message: "Either query or slug is required",
  });
type WikiQueryParams = z.infer<typeof wikiQueryParamsSchema>;

export const wikiWritePreviewSchema = z.object({
  archiveId: z.string().uuid(),
  slug: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  action: z.enum(["create", "update"]),
  category: z.enum(["entities", "concepts", "decisions"]).default("entities"),
});
type WikiWritePreviewInput = z.infer<typeof wikiWritePreviewSchema>;

export const wikiWriteApproveRejectSchema = z.object({
  runId: z.string().uuid(),
});
type WikiWriteApproveRejectInput = z.infer<
  typeof wikiWriteApproveRejectSchema
>;

export const wikilinkResolveSchema = z.object({
  slugs: z.array(z.string().min(1)).min(1).max(50),
  archiveId: z.string().uuid().optional(),
});
type WikilinkResolveInput = z.infer<typeof wikilinkResolveSchema>;

export const wikiDistillSchema = z.object({
  archiveId: z.string().uuid(),
  title: z.string().min(1).max(500),
  category: z.enum(["entities", "concepts", "decisions"]).default("entities"),
  chatId: z.string().uuid(),
  messageIds: z.array(z.string().uuid()).min(1).max(500).optional(),
});
type WikiDistillInput = z.infer<typeof wikiDistillSchema>;

// Phase 79-04 D-10 — body schema for POST /maintenance/:archiveId/merge
export const mergePagesSchema = z
  .object({
    pageA: z.string().min(1, "pageA slug required"),
    pageB: z.string().min(1, "pageB slug required"),
    title: z.string().min(1, "Merge title required").max(500),
    slug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9-]+$/, "Slug must be lowercase, alphanumeric, hyphens only")
      .optional(),
  })
  .refine((d) => d.pageA !== d.pageB, {
    message: "Cannot merge a page with itself",
  });
type MergePagesInput = z.infer<typeof mergePagesSchema>;
