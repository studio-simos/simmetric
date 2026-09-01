// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Synthesis Schemas =====

const synthesisRunStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "APPROVED",
  "REJECTED",
  "PARTIAL",
  "FAILED",
]);
type SynthesisRunStatus = z.infer<typeof synthesisRunStatusSchema>;

const synthesisConfidenceSchema = z.enum([
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNVERIFIED",
]);
export type SynthesisConfidence = z.infer<typeof synthesisConfidenceSchema>;

const synthesisChangeSchema = z.object({
  pageSlug: z.string().min(1),
  action: z.enum(["create", "update", "skip"]),
  category: z.string(),
  title: z.string(),
  currentContent: z.string().optional(),
  proposedContent: z.string(),
  confidence: synthesisConfidenceSchema,
  sources: z.array(
    z.object({
      fileName: z.string(),
      ingestDate: z.string(),
    })
  ),
  approved: z.boolean().default(false),
});

const synthesisContradictionItemSchema = z.object({
  pageSlug: z.string().min(1),
  claimA: z.object({
    text: z.string(),
    source: z.string(),
    date: z.string(),
  }),
  claimB: z.object({
    text: z.string(),
    source: z.string(),
    date: z.string(),
  }),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
});

const synthesisPreviewSchema = z.object({
  runId: z.string().uuid(),
  archiveId: z.string().uuid(),
  status: synthesisRunStatusSchema,
  createdAt: z.string(),
  budgetUsed: z.object({
    pagesRead: z.number().int().nonnegative(),
    pagesWritten: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    llmCallsUsed: z.number().int().nonnegative(),
  }),
  contradictions: z.array(synthesisContradictionItemSchema),
  changes: z.array(synthesisChangeSchema),
});
export type SynthesisPreview = z.infer<typeof synthesisPreviewSchema>;

export const synthesisApproveRejectSchema = z.object({
  pageSlugs: z.array(z.string().min(1)).optional(),
});
type SynthesisApproveRejectInput = z.infer<
  typeof synthesisApproveRejectSchema
>;

export const synthesisTriggerSchema = z.object({
  archiveId: z.string().uuid("Invalid archive ID"),
});
type SynthesisTriggerInput = z.infer<typeof synthesisTriggerSchema>;

// D-13 DIVERGENCE from renameChatSchema: name is NOT optional (min 1) and max
// is 100 (not 200). Synthesis run names are short labels shown in a dense
// list — a 200-char chat title would overflow the run row.
export const renameSynthesisRunSchema = z.object({
  name: z.string().min(1).max(100),
});
type RenameSynthesisRunInput = z.infer<typeof renameSynthesisRunSchema>;
