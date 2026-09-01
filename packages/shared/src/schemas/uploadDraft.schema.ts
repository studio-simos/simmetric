// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== UploadDraft Schemas (Phase 68) =====
// See docs/DESTINATION_MODEL.md:203-266 (Phase-68 Build-Scope Freeze Checklist).
// Decisions D-02..D-06 refined in .planning/phases/68-prisma-schema-zod-schemas/68-CONTEXT.md.

// D-05: parseStatus type-safety. Prisma stays `String @default("uploaded")` (no
// Prisma enum, additive migration A4). Mirrors the `documentTypeSchema` pattern
// (z.enum + String Prisma in document.schema.ts:5). Used for server-side
// comparisons (reaper Fase 69 `where parseStatus !== "done"`, fan-out).
const UPLOAD_DRAFT_STATUSES = ["uploaded", "assigned", "done"] as const;
const uploadDraftStatusSchema = z.enum(UPLOAD_DRAFT_STATUSES);
type UploadDraftStatus = z.infer<typeof uploadDraftStatusSchema>;

// D-02: MIME allowlist closed union. Stage-time accepts everything the unified
// upload area supports: 8 collector MIME (packages/collector/src/routes/ingest.ts:38-47)
// + 4 OCR image MIME. Assign-time (Fase 69) narrows — images only on the KB leg.
// Defense-in-depth: Zod rejects unsupported MIME before multer touches the FS.
const draftMimeTypeSchema = z.enum([
  "application/pdf",
  "text/markdown",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
]);

// D-06: IDOR defense-in-depth. createUploadDraftSchema validates ONLY the
// client-controlled multipart metadata. The server sets every other field:
//   id (uuid default), the owner FK (JWT — never client-controllable), filePath
//   (multer dest), parseStatus="uploaded" (default), ragEnabled/kbEnabled=false,
//   assignedArchiveId=null, ragJobId/kbJobId=null, expiresAt=now()+retention,
//   createdAt/updatedAt. Client cannot control FK/status/expiry.
export const createUploadDraftSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  originalName: z.string().min(1).max(255), // D-04: 255 chars, OS-safe
  fileSize: z.number().int().positive().max(104857600), // D-04: 100MB cap
  mimeType: draftMimeTypeSchema,
});
type CreateUploadDraftInput = z.infer<typeof createUploadDraftSchema>;

// D-03: body of POST /api/uploads/:id/assign (route Fase 69). Booleans drive the
// fan-out legs; archiveId is only required when kb=true. UI mapping in Fase 71:
// both → {rag:true,kb:true}, unassigned → {rag:false,kb:false}.
export const assignDraftSchema = z.object({
  rag: z.boolean(),
  kb: z.boolean(),
  archiveId: z.string().uuid().optional(),
});
export type AssignDraftInput = z.infer<typeof assignDraftSchema>;

// D-07 (Phase 76): rename body for PATCH /api/uploads/:id. 1-500 char — the
// rename target is a display name (NOT an OS filename), so 500 wins over the
// 255 cap in createUploadDraftSchema (RESEARCH Open Question #1). Empty is
// rejected; no uniqueness constraint (names are not unique). Rename is
// non-destructive and allowed in every parseStatus state (unassigned,
// in-flight, done) — the produced Document/archive is NOT renamed (D-07).
export const renameUploadSchema = z.object({
  originalName: z.string().min(1).max(500),
});
type RenameUploadInput = z.infer<typeof renameUploadSchema>;

// D-03: UI destination chooser labels (Fase 71, DST-01). 4 discrete labels that
// the UI maps 1:1 to the assignDraftSchema booleans.
const draftDestinationSchema = z.enum(["rag", "kb", "both", "unassigned"]);
export type DraftDestination = z.infer<typeof draftDestinationSchema>;

// 71-02 D-17: URL sourceType stage body (separate from multipart
// createUploadDraftSchema — do NOT weaken the multipart validation by making
// mimeType optional). The stage route branches on `req.body.sourceType`.
// URL drafts are stored in existing UploadDraft columns: filePath=<url>,
// mimeType="text/url" sentinel (String column, no DB enum, no schema
// migration per WARNING 3.3), originalName=<url>, fileSize=0.
// draftMimeTypeSchema 12-enum is UNCHANGED — "text/url" is NOT added to the
// enum; it's a sentinel stored directly by the URL branch, not validated
// through draftMimeTypeSchema.
export const createUploadDraftUrlSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  sourceType: z.literal("url"),
  url: z.string().url("Enter a valid http(s) URL"),
  archiveId: z.string().uuid("Invalid archive ID"),
  ocrMode: z.string().optional(),
});
type CreateUploadDraftUrlInput = z.infer<typeof createUploadDraftUrlSchema>;