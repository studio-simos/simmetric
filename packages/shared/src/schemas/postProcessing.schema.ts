// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// Phase 98 (POST-01 D-06): Zod validation for tag + follow-up suggestion LLM JSON output.
// If parse fails, generateTagsAndFollowUps skips silently (fire-and-forget).
export const autoTagsSchema = z.object({
  tags: z.array(z.string().max(20)).max(5),
  followUps: z.array(z.string().max(100)).max(3),
});

type AutoTagsResult = z.infer<typeof autoTagsSchema>;

// Phase 157 (CSW-12 D-08): Zod validation for the batched title + tags + follow-up LLM JSON output.
// If parse fails, generateBatchedTitleTagsAndFollowUps skips silently (fire-and-forget).
export const batchedPostProcessingSchema = z.object({
  title: z.string().max(80),
  tags: z.array(z.string().max(20)).max(5),
  followUps: z.array(z.string().max(100)).max(3),
});

type BatchedPostProcessingResult = z.infer<typeof batchedPostProcessingSchema>;