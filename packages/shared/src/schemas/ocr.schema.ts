// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== OCR Job Schemas =====

// OCR Model Config Schema
const ocrModelConfigSchema = z.object({
  name: z.string(),
  namePattern: z.string(),
  inputMode: z.enum(["single_image", "multi_image", "base64_array"]),
  supportedModes: z.array(z.enum(["text", "table", "figure", "generic"])),
  promptTemplate: z.enum(["deepseek-ocr", "glm-ocr", "generic"]),
  contextWindow: z.number().int().positive(),
  specialTokens: z.array(z.string()).optional(),
});
export type OcrModelConfig = z.infer<typeof ocrModelConfigSchema>;

const ocrModelCatalogSchema = z.array(ocrModelConfigSchema);
type OcrModelCatalog = z.infer<typeof ocrModelCatalogSchema>;

const ocrUnknownModelErrorSchema = z.object({
  error: z.string(),
  suggestedFallback: z.literal("generic").optional(),
});
type OcrUnknownModelError = z.infer<typeof ocrUnknownModelErrorSchema>;

// POST /api/archives/:id/ocr — create an OCR job for a file in an archive
export const ocrJobRequestSchema = z.object({
  archiveId: z.string().uuid("Invalid archive ID"),
  model: z.string().max(200).optional(),
  ocrMode: z.enum(["text", "table", "figure", "generic"]).optional(),
  customInstructions: z.string().max(10000).optional(),
  sourceQualityScore: z.number().int().min(1).max(5).optional(),
});
type OcrJobRequest = z.infer<typeof ocrJobRequestSchema>;

// POST /api/archives/:id/ocr/batch — create OCR jobs for multiple PDFs
const batchOcrJobRequestSchema = z.object({
  model: z.string().max(200).optional(),
  ocrMode: z.enum(["text", "table", "figure", "generic"]).optional(),
  customInstructions: z.string().max(10000).optional(),
  sourceQualityScore: z.number().int().min(1).max(5).optional(),
});
type BatchOcrJobRequest = z.infer<typeof batchOcrJobRequestSchema>;

// POST /api/ingest/url — ingest a URL into an archive
export const urlIngestionRequestSchema = z.object({
  url: z
    .string()
    .url("Invalid URL")
    .refine((val) => val.startsWith("https://"), {
      message: "Only HTTPS URLs are supported for security",
    }),
  archiveId: z.string().uuid("Invalid archive ID"),
  userScore: z.number().int().min(1).max(5).optional(),
});
type UrlIngestionRequest = z.infer<typeof urlIngestionRequestSchema>;

// POST .../jobs/:jobId/approve — approve an OCR job
export const ocrJobApproveSchema = z.object({});

// POST .../jobs/:jobId/reject — reject an OCR job
export const ocrJobRejectSchema = z.object({
  reason: z.string().max(1000).optional(),
});
type OcrJobRejectInput = z.infer<typeof ocrJobRejectSchema>;

// --- OCR Page Result Schema ---
// Validates the output of a single page OCR call before storing.
export const ocrPageResultSchema = z.object({
  pageNumber: z.number().int().positive(),
  markdown: z.string().min(1, "OCR produced empty output for page"),
  tokensUsed: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
type OcrPageResult = z.infer<typeof ocrPageResultSchema>;

// --- OCR Job Result Schema ---
// Stored in OcrJob.result JSON column
export const ocrJobResultSchema = z.object({
  qualityScore: z.number().min(1).max(5),
  totalPages: z.number().int().positive(),
  totalTokens: z.number().int().nonnegative(),
  totalDurationMs: z.number().int().nonnegative(),
  hasUnverified: z.boolean(),
});
type OcrJobResult = z.infer<typeof ocrJobResultSchema>;

// POST /api/ocr/preview — preview system prompt for a model+mode+instructions
export const ocrPreviewRequestSchema = z.object({
  model: z.string().max(200),
  ocrMode: z.enum(["text", "table", "figure", "generic"]).optional(),
  customInstructions: z.string().max(10000).optional(),
});
type OcrPreviewRequest = z.infer<typeof ocrPreviewRequestSchema>;

// POST /api/ocr/preferences — save OCR preferences per user+workspace
export const ocrPreferencesSchema = z.object({
  workspaceId: z.string().uuid(),
  model: z.string().max(200).optional(),
  ocrMode: z.enum(["text", "table", "figure", "generic"]).optional(),
  customInstructions: z.string().max(10000).optional(),
});
type OcrPreferencesInput = z.infer<typeof ocrPreferencesSchema>;
