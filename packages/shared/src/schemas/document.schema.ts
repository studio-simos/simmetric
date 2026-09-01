// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Document Schemas =====

export const documentTypeSchema = z.enum(["pdf", "md", "csv", "docx", "pptx", "youtube"]);

export const uploadDocumentSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
});

export const processDocumentSchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
  documentType: documentTypeSchema,
  filePath: z.string().min(1, "File path is required"),
  workspaceId: z.string().uuid("Invalid workspace ID"),
});

export const youtubeTranscriptSchema = z.object({
  url: z.string().url("Invalid YouTube URL").refine(
    (val) => /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)/.test(val),
    { message: "Must be a valid YouTube URL" },
  ),
  workspaceId: z.string().uuid("Invalid workspace ID"),
  documentId: z.string().uuid("Invalid document ID"),
});

// Quick 260815-gak — bulk document delete request contract.
// One request soft-deletes up to 500 documents (replaces the N+1 sequential
// DELETE loop in DocumentsPage that exhausted the rate-limiter bucket).
export const bulkDeleteDocumentsSchema = z.object({
  documentIds: z
    .array(z.string().min(1, "Document ID is required"))
    .min(1, "At least one document ID is required")
    .max(500, "Maximum 500 documents per bulk delete"),
});
type BulkDeleteDocumentsInput = z.infer<typeof bulkDeleteDocumentsSchema>;

type DocumentType = z.infer<typeof documentTypeSchema>;
type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;
type ProcessDocumentInput = z.infer<typeof processDocumentSchema>;
type YoutubeTranscriptInput = z.infer<typeof youtubeTranscriptSchema>;