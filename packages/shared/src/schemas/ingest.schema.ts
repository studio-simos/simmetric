// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Ingest Schemas =====
// Shared contract between collector (producer) and server (consumer) for the
// document ingestion pipeline. Field names match the live collector contract
// (`chunkText`, status `"processed"`) — see packages/collector/src/routes/ingest.ts.
// These schemas are the hardening for Bug B (`text`/`chunkText` drift) and the
// status callback validation (T-60-06).

// --- Ingest Chunk Schema ---
// A single chunk returned by the collector in the ingest response payload.
// Field is `chunkText` (NOT `text`) to match the live collector contract at
// ingest.ts:233. Bug B regression guard.
export const IngestChunkSchema = z.object({
  chunkIndex: z.number().int().min(0),
  chunkText: z.string(),
  paragraph: z.number().int().min(0).optional(),
  charStart: z.number().int().min(0).optional(),
  charEnd: z.number().int().min(0).optional(),
});
export type IngestChunk = z.infer<typeof IngestChunkSchema>;

// --- Ingest Response Schema ---
// Validates the collector's response payload before it is trusted by the
// server. Producer-side safeParse lives in packages/collector/src/routes/ingest.ts.
// `status` enum includes `"processed"` (the live collector value at ingest.ts:245),
// plus `"completed"` and `"failed"` for completeness/forward-compat.
export const IngestResponseSchema = z.object({
  documentId: z.string().uuid(),
  status: z.enum(["processed", "completed", "failed"]),
  chunkCount: z.number().int().min(0).optional(),
  chunks: z.array(IngestChunkSchema).optional(),
  embeddingModel: z.string().optional(),
  table: z.string().optional(),
  error: z.string().optional(),
  // D-04: OCR-skipped reason string — populated when OCR was bypassed
  // (e.g., no vision model configured). Optional, forward-compatible.
  ocrSkipped: z.string().optional(),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

// --- Ingest Status Callback Schema ---
// Validates the collector→server status callback body on PUT /api/documents/:id/status.
// `status` enum is strict: only `"completed"` and `"failed"` are valid terminal
// statuses (the collector's notifyServerStatus helper sends these).
// `statusMessage` is kept as an optional alias for backward-compat with the
// existing collector field at ingest.ts:24-27.
export const IngestStatusCallbackSchema = z.object({
  status: z.enum(["completed", "failed"]),
  chunkCount: z.number().int().min(0).optional(),
  embeddingModel: z.string().optional(),
  error: z.string().optional(),
  statusMessage: z.string().optional(),
  ocrSkipped: z.string().optional(),
});
export type IngestStatusCallback = z.infer<typeof IngestStatusCallbackSchema>;

// --- Reembed Request Schema (W4/D-06) ---
// Validates the body of POST /api/ingest/reembed — the collector endpoint that
// re-embeds chunk text and rewrites vectors with the shared chunk id
// `${documentId}-${chunkIndex}`. Called by the server's reindex script
// (Plan 06) over HTTP with `X-Collector-Secret` auth. `chunks` is allowed to
// be empty (no-op idempotent: the handler returns chunkCount: 0 without
// touching the vector store). `workspaceName` is optional (legacy workspaces
// may only have the id). `embeddingModel` is optional (falls back to the
// collector's configured model).
const ReembedChunkSchema = z.object({
  chunkIndex: z.number().int().min(0),
  chunkText: z.string().min(1),
});
type ReembedChunk = z.infer<typeof ReembedChunkSchema>;

export const ReembedRequestSchema = z.object({
  documentId: z.string().uuid(),
  workspaceId: z.string(),
  workspaceName: z.string().optional(),
  chunks: z.array(ReembedChunkSchema).min(0),
  embeddingModel: z.string().optional(),
  // 260830-ur9: optional re-stamp passthrough — when the server provides these
  // (reembed-documents route sends the Document row's type/createdAt), the
  // collector re-stamps documentType + documentCreatedAt(+Ms) on the rewritten
  // vectors so re-embedding preserves filterability. Absent = legacy shape.
  documentType: z.string().optional(),
  documentCreatedAt: z.string().optional(),
});
type ReembedRequest = z.infer<typeof ReembedRequestSchema>;

// --- Wiki Pages Ingest Schema (WR-09) ---
// Moved here from the inline definition that lived in
// packages/collector/src/routes/ingest.ts so the contract is shared between
// the collector (producer) and any server-side consumer, mirroring the
// ReembedRequestSchema pattern. CLAUDE.md mandates that all request
// validation schemas live in packages/shared/src/schemas/.
//
// 260721-lrm (D-01): `embeddingModel` is optional so the server's
// `indexWikiPage` can pass the admin-configured `EMBEDDING_MODEL` system
// setting through to the collector, restoring ingest↔query symmetry with
// `hybridSearchService.ts:296`. Missing field → `undefined` → collector
// falls back to its configured default (backward-compat, do NOT 400).
// T-lrm-01: reject path-traversal / absolute-path values so `embeddingModel`
// cannot escape the collector's fixed `cacheDir` when interpolated into the
// cache-path lookup. `..` and leading `/` are the only patterns that could
// break out of `${cacheDir}/${model}/tokenizer.json`.
export const WikiPagesIngestSchema = z.object({
  archiveId: z.string().uuid(),
  pageId: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  bodyText: z.string(),
  contentHash: z.string(),
  embeddingModel: z.string()
    .refine(
      (s) => !s || (!s.includes("..") && !s.startsWith("/")),
      "embeddingModel must not contain path-traversal or absolute-path sequences",
    )
    .optional(),
});
type WikiPagesIngest = z.infer<typeof WikiPagesIngestSchema>;

// --- Safe-id allowlist (WR-06 / CR-01 alignment) ---
// Collector route handlers interpolate `workspaceId` / `documentId` into
// LanceDB SQL `where()` / `delete()` predicates. The CR-01 route-layer fix
// (commit 303424ffd) uses an allowlist of `[A-Za-z0-9_:-]` to reject SQL
// metacharacters at the boundary. These schemas reuse the SAME allowlist so
// runtime validation does not regress legacy id shapes the route layer
// currently accepts (e.g. `ws-1`, `workspace_x`, `doc-1`, `global`,
// `archive:<uuid>`). Do NOT switch these to `z.string().uuid()` — that would
// reject legitimate non-UUID ids and break the server→collector flow.
const SAFE_ID_RE = /^[A-Za-z0-9_:-]+$/;
const safeIdSchema = z.string().regex(SAFE_ID_RE, "Invalid id (allowlist: A-Za-z0-9_:-)");

// --- RAG metadata filter schemas (260830-ur9) ---
// Optional documentTypes + dateFrom/dateTo filters threaded from rag_search
// through hybridSearch → collector → vector providers.
//
// `ragFilterDocumentTypeSchema` matches the Prisma Document.type values the
// server's documents.ts typeMap produces for FILE uploads (pdf/md/txt/csv/
// docx/xlsx). Do NOT reuse documentTypeSchema from document.schema.ts — it
// has pptx/youtube and lacks txt/xlsx (wrong filter semantics; youtube
// transcripts are never matched by a documentTypes filter by design).
export const ragFilterDocumentTypeSchema = z.enum(["pdf", "md", "txt", "csv", "docx", "xlsx"]);

/** ISO-parseable refinement — shared by dateFrom/dateTo (datetime-safe check). */
const isoDateString = z.string().refine(
  (s) => !Number.isNaN(new Date(s).getTime()),
  "must be an ISO-parseable date string",
);

export const RagMetadataFilterSchema = z
  .object({
    // max(6) bounds the backstop findMany `in:` list (T-260830-05 DoS bound).
    documentTypes: z.array(ragFilterDocumentTypeSchema).max(6)
      .refine((arr) => new Set(arr).size === arr.length, "documentTypes must not contain duplicates")
      .optional(),
    dateFrom: isoDateString.optional(),
    dateTo: isoDateString.optional(),
  })
  .refine(
    (f) => !(f.dateFrom && f.dateTo) || new Date(f.dateFrom).getTime() <= new Date(f.dateTo).getTime(),
    "dateFrom must be <= dateTo",
  );
type RagMetadataFilter = z.infer<typeof RagMetadataFilterSchema>;

/**
 * Server-side normalized filter shape (hybridSearchService normalizes
 * date-only bounds to full UTC ISO strings and adds epoch-ms mirrors for
 * Qdrant's numeric range DSL). This is what flows INTO the collector.
 */
export interface HybridSearchFilters {
  documentTypes?: string[];
  dateFrom?: string;
  dateTo?: string;
  dateFromMs?: number;
  dateToMs?: number;
}

// --- Ingest Query Request Schema (WR-06) ---
// Validates the body of POST /api/ingest/query. `limit` defaults to 5 when
// omitted and is capped at 100 to prevent an unbounded vector scan. The
// `workspaceId` allowlist matches the CR-01 route-layer boundary.
// 260830-ur9: optional `filters` (all-optional object; `{}` is a no-op) —
// absent/empty filters is byte-identical to the pre-filter contract.
export const IngestQueryRequestSchema = z.object({
  query: z.string().min(1),
  workspaceId: safeIdSchema,
  workspaceName: z.string().optional(),
  limit: z.number().int().positive().max(100).default(5),
  embeddingModel: z.string().optional(),
  filters: RagMetadataFilterSchema.optional(),
});
type IngestQueryRequest = z.infer<typeof IngestQueryRequestSchema>;

// --- Rerank Request Schema (Phase 93 / RER-01) ---
// Validates the body of POST /api/ingest/rerank — the collector-side CrossEncoder
// reranker inference endpoint. Mirrors IngestQueryRequestSchema's read-only
// stance (D-02: NO requireCollectorSecret; the server's rerankCandidates does
// not send X-Collector-Secret, mirroring /ingest/query). `candidates` is the
// RRF-fused top-K list produced upstream by the server; the collector scores
// each `{query, candidate.chunkText}` pair through the CrossEncoder and returns
// sigmoid probabilities (D-05). Capped at 100 candidates to bound inference
// latency (SC3 design target ~50ms warm +1 hop per candidate). `chunkId` and
// `documentId` ride through so the server can re-align scores with the original
// RRF list without re-keying. `source`/`chunkIndex`/`metadata` are optional
// pass-through fields (Phase 90 CIT-01 6-value `source` widening) so the
// server can preserve citation provenance across the rerank hop.
export const RerankRequestSchema = z.object({
  query: z.string().min(1),
  candidates: z
    .array(
      z.object({
        chunkId: z.string(),
        documentId: z.string(),
        chunkText: z.string().min(1),
        score: z.number(),
        source: z.string().optional(),
        chunkIndex: z.number().int().min(0).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(100),
});
type RerankRequest = z.infer<typeof RerankRequestSchema>;

// --- Ingest Delete Request Schema (WR-06) ---
// Validates the shape used by DELETE /api/ingest/:documentId. `documentId`
// comes from req.params; `workspaceId` / `workspaceName` from req.query. The
// handler assembles them into this object before safeParse.
export const IngestDeleteRequestSchema = z.object({
  documentId: safeIdSchema,
  workspaceId: safeIdSchema.optional(),
  workspaceName: z.string().optional(),
});
type IngestDeleteRequest = z.infer<typeof IngestDeleteRequestSchema>;

// --- Ingest Upload Body Schema (WR-06) ---
// Validates the multipart form fields of POST /api/ingest (multer populates
// req.body from text form fields). `embeddingModel` is required (the route
// already rejects requests without it). `ocrMode` is a strict enum — an
// invalid value is 400'd instead of silently falling through to an empty
// parse result. `docType` defaults to "md" to match the existing route.
export const IngestUploadBodySchema = z.object({
  documentId: safeIdSchema,
  workspaceId: safeIdSchema.optional(),
  workspaceName: z.string().optional(),
  embeddingModel: z.string().min(1),
  docType: z.string().default("md"),
  ocrModel: z.string().optional(),
  ocrMode: z.enum(["auto", "vision", "skip"]).default("auto"),
  ocrSkipped: z.string().optional(),
});
type IngestUploadBody = z.infer<typeof IngestUploadBodySchema>;

// --- Archive Page Parse Request / Callback Schemas (KB-05 / KB-06) ---
// Shared contract between the server (dispatch) and the collector (parse-only
// endpoint at POST /api/ingest/archive-page). `documentId` is optional — the
// KB-06 upload path has no source document, while the KB-05 copy-from-doc
// path carries it through for traceability. The collector parses via the
// existing `parseFile` (md/xlsx/docx/pptx) and callbacks the server with
// `archivePageParseCallbackSchema`. Parse-only — no chunk/embed/store (D-05).
export const archivePageParseRequestSchema = z.object({
  jobId: z.string().uuid("Invalid job ID"),
  archiveId: z.string().uuid("Invalid archive ID"),
  documentId: z.string().uuid("Invalid document ID").optional(),
});
type ArchivePageParseRequestInput = z.infer<typeof archivePageParseRequestSchema>;

export const archivePageParseCallbackSchema = z.object({
  status: z.enum(["completed", "failed"]),
  extractedText: z.string().optional(),
  title: z.string().max(500).optional(),
  error: z.string().max(2000).optional(),
});
type ArchivePageParseCallbackInput = z.infer<typeof archivePageParseCallbackSchema>;