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

// Phase 204 (DEBT-SW-05, FEAT-01) — document text edit request contract.
// Body-only edit (archivePages body precedent): the request carries ONLY the
// edited full text — never a storageKey/filePath/type (T-204-07: stored-file
// keys compose server-side, no client input crosses into the storage layer).
// min(1): empty string and null/missing body are 400s (the DEBT-SW-05 empty
// probe) — a zero-length edit would zero the document text.
export const updateDocumentTextSchema = z.object({
  body: z.string().min(1),
});
type UpdateDocumentTextInput = z.infer<typeof updateDocumentTextSchema>;

// api-design sweep (2026-09-24) — opt-in keyset pagination for GET /documents.
// Cursor mode activates when `cursor` OR `limit` is present (absent query
// = legacy bare-array response, byte-identical). Cursor is opaque
// (base64url of `v1|<createdAt ISO>|<id>` — utils/httpError.ts encodeCursor);
// limit is hard-capped at 100 (skill: never an unbounded default).
export const documentListQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID").optional(),
  cursor: z.string().min(1).optional(),
  // NOTE: no .default() — a default would make `limit` always-present after
  // parsing, activating cursor mode for paramless requests (legacy array
  // response must stay byte-identical). The route falls back to 50 itself.
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

type DocumentType = z.infer<typeof documentTypeSchema>;
type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;
type ProcessDocumentInput = z.infer<typeof processDocumentSchema>;
type YoutubeTranscriptInput = z.infer<typeof youtubeTranscriptSchema>;