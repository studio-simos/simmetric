// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { getUniqueFilePath } from "../utils/fileUtils";
import { parseFile, parseYoutubeUrl } from "../services/parser";
import { chunkText } from "../services/chunker";
import { getEmbeddingProvider, checkEmbeddingModelAvailability } from "../services/embeddings";
import { getVectorStore, type VectorDocument } from "../services/vectorStore";
import { getReranker } from "../services/reranker";
import { IngestResponseSchema, ReembedRequestSchema, WikiPagesIngestSchema, IngestQueryRequestSchema, IngestDeleteRequestSchema, IngestUploadBodySchema, RerankRequestSchema, archivePageParseRequestSchema, sanitizeFileName } from "@simmetric-chat/shared";

/**
 * Notify the server of document processing status.
 * Best-effort — failures are logged but don't block the response.
 */
async function notifyServerStatus(documentId: string, status: string, chunkCount?: number, statusMessage?: string) {
  const env = getEnv();
  try {
    await axios.put(`${env.SERVER_URL}/api/documents/${documentId}/status`, {
      status,
      ...(chunkCount !== undefined && { chunkCount }),
      ...(statusMessage && { statusMessage }),
    }, {
      timeout: 5000,
      headers: {
        "X-Collector-Secret": env.COLLECTOR_SECRET,
      },
    });
  } catch (err: any) {
    logger.warn(`[ingest] Failed to notify server of status ${status} for ${documentId}: ${err.message}`);
  }
}

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "text/markdown",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

const UPLOADS_DIR = "storage/uploads/";

// Ensure the multer destination exists at module load — diskStorage does not
// create the directory, so a missing storage/uploads/ (fresh clone, wiped
// storage dir) made EVERY upload fail with ENOENT → 500. Mirrors the server's
// DRAFTS_DIR mkdirSync at uploads.ts:64.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const uniquePath = getUniqueFilePath(UPLOADS_DIR, file.originalname);
    cb(null, path.basename(uniquePath));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = [".pdf", ".md", ".txt", ".csv", ".docx", ".xlsx", ".pptx"];

    if (ALLOWED_MIME_TYPES.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype} (${ext}). Allowed: PDF, MD, CSV, DOCX, XLSX, PPTX`));
    }
  },
});

// Upload rate limiting removed: the collector is an internal microservice and
// every mutating route is already gated by `requireCollectorSecret`. A per-IP
// cap of 10/min throttled legitimate bulk archive imports (all server traffic
// shares one IP). The secret check is the real authz boundary.

const router = Router();

/**
 * Build a human-readable collection/table name for Qdrant/LanceDB.
 *
 * Format: `ws_{sanitizedName}_{shortUuid}` when both name and ID are available.
 * Falls back to `ws_{uuid}` when only the ID is known (legacy format, still valid).
 * Global workspace and wiki pages use fixed names.
 *
 * The UUID-prefix ensures uniqueness even when two workspaces share the same name.
 * The sanitization strips non-alphanumeric chars and truncates to 30 chars.
 */
function buildCollectionName(workspaceId: string, workspaceName?: string): string {
  if (!workspaceId || workspaceId === "global") return "global";
  if (workspaceId.startsWith("archive:")) return "wiki_pages";

  if (workspaceName) {
    const sanitized = workspaceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "workspace";
    const shortId = workspaceId.slice(0, 8);
    return `ws_${sanitized}_${shortId}`;
  }

  return `ws_${workspaceId}`;
}

/**
 * Safe-character allowlist for ids that are interpolated into LanceDB SQL
 * `where()` / `delete()` predicates (CR-01). Permits the characters used by
 * every legitimate id shape in this system — bare UUIDs (`a1b2-...`), the
 * `global` table name, the `archive:<uuid>` wiki prefix, and the `ws-<n>`
 * synthetic ids used in tests — while rejecting every SQL-injection payload:
 * single quotes (`x' OR '1'='1`), semicolons, parentheses, whitespace, and
 * other SQL metacharacters are all outside this set. This is the primary
 * boundary; `escapeSqlLiteral` in vectorStore.ts is the defense-in-depth
 * backstop that neutralizes a quote even if it slips through.
 */
const SAFE_ID_RE = /^[A-Za-z0-9_:-]+$/;

/**
 * Validate a workspaceId before it is interpolated into a LanceDB SQL filter.
 * Allowed shapes: `global`, a bare UUID, or `archive:<uuid>`. Any value
 * containing a quote or other SQL metacharacter is rejected with a 400 here.
 */
function isValidWorkspaceId(id: string): boolean {
  return SAFE_ID_RE.test(id);
}

/** Validate a document/page id contains only safe characters before it reaches a SQL filter. */
function isValidDocumentId(id: string): boolean {
  return SAFE_ID_RE.test(id);
}

/**
 * Constant-time comparison of the X-Collector-Secret header against the
 * configured secret (WR-04). String `!==` short-circuits on the first
 * differing byte, leaking the secret length/prefix via timing. The reembed
 * endpoint is destructive (rewrites vectors), so the shared secret follows
 * the same timing-safe discipline already used for API keys.
 */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Express middleware that enforces a valid X-Collector-Secret header (WR-05).
 * The collector is an internal service reached over HTTP from the server; any
 * client that can reach port 3210 could otherwise read, write, or delete
 * vectors. The reembed endpoint already enforced this — phase 60 extends the
 * same boundary to the other mutating routes (POST /ingest, DELETE
 * /ingest/:documentId, POST /ingest/youtube, POST/DELETE /ingest/wiki-pages).
 * Read-only routes (/health, /ingest/query, /ingest/chunks/:documentId,
 * /ingest/rerank) are left open to avoid breaking existing server call sites
 * that do not yet send the secret; they remain protected at the network layer
 * (trusted internal network only). Uses `secretEquals` (constant-time) per
 * WR-04. D-02 (Phase 93): /ingest/rerank is a read-only pure function over
 * {query, candidates} — the server's rerankCandidates does NOT send
 * X-Collector-Secret, mirroring /ingest/query.
 */
function requireCollectorSecret(req: any, res: any, next: any): void {
  const env = getEnv();
  const presented = String(req.headers["x-collector-secret"] ?? "");
  if (!secretEquals(presented, env.COLLECTOR_SECRET)) {
    res.status(401).json({ error: "Invalid collector secret" });
    return;
  }
  next();
}

// Health check
router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "collector" });
});

// GET /api/ingest/chunks/:documentId — retrieve all chunks for a document from the vector store
router.get("/ingest/chunks/:documentId", async (req, res) => {
  try {
    const { documentId } = req.params;
    const workspaceId = String(req.query.workspaceId || "global");
    const workspaceName = typeof req.query.workspaceName === "string" ? req.query.workspaceName : undefined;

    // Boundary validation (CR-01): reject non-UUID ids before they reach a
    // LanceDB SQL `where()` clause. Without this, a caller can submit
    // `documentId = "x' OR '1'='1"` to read chunks across documents.
    if (!isValidDocumentId(documentId)) {
      return res.status(400).json({ error: "Invalid documentId (UUID required)" });
    }
    if (!isValidWorkspaceId(workspaceId)) {
      return res.status(400).json({ error: "Invalid workspaceId" });
    }

    const tableName = buildCollectionName(workspaceId, workspaceName);

    const vectorStore = await getVectorStore();
    const results = await vectorStore.getByDocumentId(tableName, documentId, workspaceId);

    const chunks = results.map((r, i) => ({
      chunkIndex: r.metadata.chunkIndex ?? i,
      chunkText: r.metadata.chunkText || r.text || "",
      paragraph: r.metadata.paragraph ?? undefined,
      charStart: r.metadata.charStart ?? undefined,
      charEnd: r.metadata.charEnd ?? undefined,
    }));

    res.json({ documentId, chunkCount: chunks.length, chunks });
  } catch (err: any) {
    logger.error("[ingest] Chunk retrieval failed", { error: err.message });
    res.status(500).json({ error: "Chunk retrieval failed", details: err.message });
  }
});

// POST /api/ingest — receive a document, parse, chunk, embed, and store
router.post("/ingest", requireCollectorSecret, upload.single("file"), async (req, res) => {
  // Hoisted so the catch block can notify the server of the failed documentId
  // even when the failure occurs after the body was parsed.
  let failedDocumentId: string | undefined;
  try {
    // WR-06: validate the multipart form fields (multer populates req.body
    // from text fields). `ocrMode` is a strict enum — an invalid value is
    // 400'd instead of silently falling through to an empty parse result.
    const parsedBody = IngestUploadBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        error: "Invalid ingest request",
        details: parsedBody.error.flatten().fieldErrors,
      });
    }
    const { documentId, workspaceId, workspaceName, embeddingModel, docType, ocrModel, ocrMode } = parsedBody.data;
    failedDocumentId = documentId;

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    logger.info(`[ingest] Processing document ${documentId}`, {
      workspaceId,
      embeddingModel,
      docType,
      ocrModel,
      originalName: req.file.originalname,
    });

    // Step 1: Parse the document
    const parsed = await parseFile(req.file.path, req.file.originalname, ocrModel, ocrMode);
    logger.info(`[ingest] Parsed document: ${parsed.metadata.pages || "N/A"} pages, ${parsed.text.length} chars`);

    // Step 2: Chunk the text
    const chunks = await chunkText(parsed.text, documentId, {
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    logger.info(`[ingest] Created ${chunks.length} chunks`);

    // Step 3: Generate embeddings
    const embeddingProvider = await getEmbeddingProvider(embeddingModel);
    const texts = chunks.map((c) => c.text);
    const embeddings = await embeddingProvider.embed(texts);
    logger.info(`[ingest] Generated ${embeddings.length} embeddings with model ${embeddingProvider.getModelName()}`);

    // Step 4: Store in vector DB with citation metadata.
    // 260830-ur9: stamp filterable metadata on every chunk — documentType (from
    // the parsed docType form field), documentCreatedAt (full UTC ISO string,
    // the server's canonical form) and its epoch-ms mirror used by Qdrant's
    // numeric range DSL. All chunks share the same stamp (document-level fact).
    const documentCreatedAt = new Date().toISOString();
    const documentCreatedAtMs = Date.now();
    const vectorStore = await getVectorStore();
    const tableName = buildCollectionName(workspaceId || "global", workspaceName);

    const documents: VectorDocument[] = chunks.map((chunk, i) => {
      const emb = embeddings[i];
      if (!emb) throw new Error(`Missing embedding at index ${i}`);
      return {
        id: `${documentId}-${i}`,
        values: emb,
        metadata: {
          documentId,
          workspaceId: workspaceId || "global",
          // quick 260808-vzm: sanitize so RAG citations show the same name
          // the server stored (spaces -> dashes, no traversal/control chars).
          documentName: sanitizeFileName(req.file!.originalname),
          chunkIndex: i,
          chunkText: chunk.text,
          paragraph: chunk.metadata.paragraph,
          charStart: chunk.metadata.charStart,
          charEnd: chunk.metadata.charEnd,
          // 260830-ur9 metadata filter stamps (RAG metadata filtering).
          documentType: docType,
          documentCreatedAt,
          documentCreatedAtMs,
        },
      };
    });

    await vectorStore.addDocuments(tableName, documents);
    logger.info(`[ingest] Stored ${documents.length} vectors in table "${tableName}"`);

    // Step 5: Clean up uploaded file
    try {
      fs.unlinkSync(req.file.path);
    } catch {
      // Ignore cleanup errors
    }

    // Step 6: Notify server of completion. Forward ocrSkipped (if the parser
    // set it) as the statusMessage so the server can surface the skip reason
    // to the user instead of silently completing with 0 chunks (CR-01 fix).
    const ocrSkipped = parsed.metadata?.ocrSkipped;
    await notifyServerStatus(documentId, "completed", chunks.length, ocrSkipped);

    // Include chunk text so the server can populate PostgreSQL FTS (document_chunks.searchVector)
    const responseChunks = chunks.map((chunk, i) => ({
      chunkIndex: i,
      chunkText: chunk.text,
      paragraph: chunk.metadata.paragraph,
      charStart: chunk.metadata.charStart,
      charEnd: chunk.metadata.charEnd,
    }));

    const responsePayload = {
      documentId,
      chunkCount: chunks.length,
      chunks: responseChunks,
      embeddingModel: embeddingProvider.getModelName(),
      table: tableName,
      status: "processed" as const,
      // Surface the skip reason at the producer boundary (CR-01/WR-01 fix):
      // previously declared in IngestResponseSchema but never populated.
      ...(ocrSkipped ? { ocrSkipped } : {}),
    };

    // Producer-side contract validation — mirrors wiki-pages safeParse pattern
    // at :423-427. If the payload we're about to send drifts from the shared
    // schema, fail loudly rather than silently sending a malformed body to the
    // server (Bug B hardening).
    const contractCheck = IngestResponseSchema.safeParse(responsePayload);
    if (!contractCheck.success) {
      logger.error("[ingest] contract violation (producer)", {
        issues: contractCheck.error.flatten().fieldErrors,
      });
      await notifyServerStatus(documentId, "failed", undefined, "ingest contract violation (producer)");
      return res.status(500).json({ error: "Ingest contract violation (producer)" });
    }

    res.json(responsePayload);
  } catch (err: any) {
    logger.error("[ingest] Processing failed", { error: err.message, stack: err.stack });

    // Notify server of failure (best-effort — failedDocumentId may be
    // undefined if the body itself failed to parse, in which case we have
    // nothing to notify about).
    if (failedDocumentId) {
      try { await notifyServerStatus(failedDocumentId, "failed", undefined, err.message); } catch { /* ignore */ }
    }

    // Clean up uploaded file on failure
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore cleanup errors */ }
    }

    res.status(500).json({ error: "Document processing failed", details: err.message });
  }
});

// POST /api/ingest/query — search vectors in a workspace
router.post("/ingest/query", async (req, res) => {
  try {
    // WR-06: validate the full body (was: ad-hoc presence checks only).
    // `workspaceId` allowlist matches the CR-01 route-layer boundary; `limit`
    // is capped at 100 to prevent an unbounded vector scan.
    const parsed = IngestQueryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid ingest query request",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { query, workspaceId, workspaceName, limit, embeddingModel, filters } = parsed.data;

    // Use the explicit embedding model if provided (ensures query uses the
    // same model as document ingestion), otherwise fall back to provider config.
    const embeddingProvider = await getEmbeddingProvider(embeddingModel || undefined);
    const embeddings = await embeddingProvider.embed([query]);
    const queryVector = embeddings[0];
    if (!queryVector) throw new Error("Embedding returned empty result for query");

    const vectorStore = await getVectorStore();
    const tableName = buildCollectionName(workspaceId, workspaceName);
    // 260830-ur9: merge optional metadata filters into the provider filter
    // object. Absent/empty filters → the object remains exactly { workspaceId }
    // (byte-identical to the pre-filter contract). workspaceId is always
    // mandatory (T-260830-03 — filters may only narrow, never widen scoping);
    // the new keys are spread ONLY when present so the no-filter shape is
    // unchanged for every provider.
    const hasFilters = !!filters && (filters.documentTypes !== undefined || filters.dateFrom !== undefined || filters.dateTo !== undefined);
    const results = await vectorStore.search(tableName, queryVector, limit, {
      workspaceId,
      ...(hasFilters && filters.documentTypes ? { documentTypes: filters.documentTypes } : {}),
      ...(hasFilters && filters.dateFrom ? { dateFrom: filters.dateFrom } : {}),
      ...(hasFilters && filters.dateTo ? { dateTo: filters.dateTo } : {}),
    });

    // Expose `dimension` derived from the embedding provider (source of truth).
    // This unblocks `inspect-embeddings.ts` Path A (strict dim equality, SC-5):
    // `body.dimension` is populated → `storedDim` is defined → the script
    // performs the strict dim equality check instead of falling back to Path B
    // (non-zero result count). `getDimension()` is sync (KNOWN_MODEL_DIMS map)
    // and adds no latency. It does not depend on the vector store results, so
    // it is present even when the table is empty or missing.
    res.json({ results, dimension: embeddingProvider.getDimension() });
  } catch (err: any) {
    logger.error("[ingest] Query failed", { error: err.message });
    res.status(500).json({ error: "Vector search failed", details: err.message });
  }
});

// POST /api/ingest/rerank — CrossEncoder reranking of RRF-fused candidates
// (Phase 93 / RER-01). Read-only pure function over {query, candidates}:
// scores each {query, candidate.chunkText} pair through the CrossEncoder and
// returns sigmoid probabilities (D-05), sorted DESC by score. D-02: mirrors
// /ingest/query — NO requireCollectorSecret (the server's rerankCandidates
// does not send X-Collector-Secret). The reranker is lazy-loaded on first
// call via getReranker() (default-OFF is a server-side SystemConfig gate,
// planned in 93-02; the collector endpoint is always available).
router.post("/ingest/rerank", async (req, res) => {
  try {
    const parsed = RerankRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid rerank request",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { query, candidates } = parsed.data;

    // Lazy singleton: getReranker() returns the cached CrossEncoderReranker
    // for the configured RERANKER_MODEL (no double-load race — guarded by the
    // `initializing` promise mutex inside the provider).
    const reranker = await getReranker();
    // rerank() returns { score }[] in candidate order (scored[i] ↔ candidates[i])
    // so we can re-align by index, then sort DESC by score.
    const scored = await reranker.rerank(
      query,
      candidates.map((c) => ({ chunkText: c.chunkText })),
    );
    const reranked = candidates
      .map((c, i) => ({ ...c, score: scored[i]?.score ?? 0 }))
      .sort((a, b) => b.score - a.score);

    res.json({ results: reranked });
  } catch (err: any) {
    logger.error("[ingest] Rerank failed", { error: err.message });
    res.status(500).json({ error: "Rerank failed", details: err.message });
  }
});

// DELETE /api/ingest/:documentId — remove document vectors
router.delete("/ingest/:documentId", requireCollectorSecret, async (req, res) => {
  try {
    // WR-06: validate params + query shape. Both ids feed LanceDB SQL
    // `where()` / `delete()` predicates; the safeIdSchema allowlist (CR-01)
    // rejects SQL metacharacters at the boundary.
    const parsed = IngestDeleteRequestSchema.safeParse({
      documentId: req.params.documentId,
      workspaceId: typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined,
      workspaceName: typeof req.query.workspaceName === "string" ? req.query.workspaceName : undefined,
    });
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid ingest delete request",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { documentId, workspaceId, workspaceName } = parsed.data;
    const wsId = workspaceId || "global";

    const vectorStore = await getVectorStore();
    const tableName = buildCollectionName(wsId, workspaceName);

    await vectorStore.deleteByDocumentId(tableName, documentId);

    res.json({ documentId, status: "deleted" });
  } catch (err: any) {
    logger.error("[ingest] Delete failed", { error: err.message });
    res.status(500).json({ error: "Vector deletion failed", details: err.message });
  }
});

// POST /api/ingest/reembed — re-embed chunk text and rewrite vectors with the
// shared chunk id `${documentId}-${chunkIndex}` (W4/D-06). Called by the
// server's reindex script (Plan 06) over HTTP with `X-Collector-Secret` auth.
// Idempotent: deleteByDocumentId runs before addDocuments so stale vectors are
// replaced atomically. Air-gap compatible: uses the local embedding provider
// (getEmbeddingProvider with EMBEDDING_PROVIDER=local default). No external API
// calls. The endpoint does NOT accept arbitrary vectors — it re-embeds from
// `chunkText`, so a caller cannot inject crafted vectors (T-60-07b mitigation).
router.post("/ingest/reembed", requireCollectorSecret, async (req, res) => {
  try {
    const parsed = ReembedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid reembed request",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { documentId, workspaceId, workspaceName, chunks, embeddingModel, documentType, documentCreatedAt } = parsed.data;

    const embeddingProvider = await getEmbeddingProvider(embeddingModel || undefined);
    const dimension = embeddingProvider.getDimension();
    const modelName = embeddingProvider.getModelName();

    // No-op idempotent path: empty chunks → nothing to rewrite. Return early
    // without touching the vector store so a caller cannot accidentally wipe a
    // document's vectors by passing an empty array.
    if (chunks.length === 0) {
      return res.json({ documentId, chunkCount: 0, embeddingModel: modelName, dimension });
    }

    const vectorStore = await getVectorStore();
    const tableName = buildCollectionName(workspaceId, workspaceName);

    // Idempotency: delete existing vectors for this document BEFORE writing the
    // new ones. This guarantees that re-running reembed with the same chunks
    // produces the same final state (no duplicates, no stale entries). T-60-07b.
    await vectorStore.deleteByDocumentId(tableName, documentId);

    // Re-embed chunk texts. `embed` uses a for...of loop internally for local
    // providers (embeddings.ts:96-106) — no parallel batch embedding, per
    // RESEARCH.md Anti-Pattern (avoids OOM on large batches).
    const texts = chunks.map((c) => c.chunkText);
    const embeddings = await embeddingProvider.embed(texts);

    // Re-write vectors with the shared chunk id `${documentId}-${chunkIndex}`
    // (D-06/ING-01 alignment). `documentName` is empty here because the reembed
    // endpoint does not have the original filename; the server already stores
    // it on the `documents.name` column.
    //
    // 260830-ur9: when the parsed body provides documentType/documentCreatedAt
    // (the server's reembed-documents route sends the Document row's values),
    // re-stamp them (+ epoch-ms mirror derived from documentCreatedAt) so
    // re-embedding newly-ingested docs preserves filterability and legacy docs
    // gain stamps on admin re-embed. Absent → fields omitted (current shape).
    const restampDocumentCreatedAtMs =
      documentCreatedAt !== undefined && !Number.isNaN(new Date(documentCreatedAt).getTime())
        ? new Date(documentCreatedAt).getTime()
        : undefined;
    const documents: VectorDocument[] = chunks.map((chunk, i) => {
      const emb = embeddings[i];
      if (!emb) throw new Error(`Missing embedding at index ${i}`);
      return {
        id: `${documentId}-${chunk.chunkIndex}`,
        values: emb,
        metadata: {
          documentId,
          workspaceId: workspaceId || "global",
          documentName: "",
          chunkIndex: chunk.chunkIndex,
          chunkText: chunk.chunkText,
          ...(documentType !== undefined ? { documentType } : {}),
          ...(documentCreatedAt !== undefined ? { documentCreatedAt } : {}),
          ...(restampDocumentCreatedAtMs !== undefined ? { documentCreatedAtMs: restampDocumentCreatedAtMs } : {}),
        },
      };
    });

    await vectorStore.addDocuments(tableName, documents);
    logger.info(`[ingest] Reembedded ${documents.length} chunks for ${documentId} in "${tableName}"`);

    return res.json({
      documentId,
      chunkCount: chunks.length,
      embeddingModel: modelName,
      dimension,
    });
  } catch (err: any) {
    logger.error("[ingest] Reembed failed", { error: err.message });
    return res.status(500).json({ error: "Reembed failed", details: err.message });
  }
});

// POST /api/ingest/youtube — extract and ingest a YouTube transcript
router.post("/ingest/youtube", requireCollectorSecret, async (req, res) => {
  try {
    const { url, documentId, workspaceId, workspaceName, embeddingModel } = req.body;

    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    if (!documentId) {
      res.status(400).json({ error: "documentId is required" });
      return;
    }

    if (!embeddingModel) {
      res.status(400).json({ error: "embeddingModel is required" });
      return;
    }

    const model = embeddingModel;
    const wsId = workspaceId || null;

    logger.info(`[ingest] Processing YouTube URL: ${url}`);

    // Step 1: Extract transcript
    const parsed = await parseYoutubeUrl(url);
    if (!parsed.text || parsed.text.trim().length === 0) {
      res.status(422).json({ error: "No transcript available for this video" });
      return;
    }

    logger.info(`[ingest] YouTube transcript extracted: ${parsed.text.length} chars`);

    // Step 2: Chunk the transcript
    const chunks = await chunkText(parsed.text, documentId, {
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    // Step 3: Generate embeddings
    const embeddingProvider = await getEmbeddingProvider(model);
    const texts = chunks.map((c) => c.text);
    const embeddings = await embeddingProvider.embed(texts);

    // Step 4: Store in vector DB.
    // 260830-ur9: documentType "youtube" is acceptable at write side — the
    // query filter enum stays the 6 FILE document types; youtube content is
    // simply never matched by a documentTypes filter (documented in the plan).
    const documentCreatedAt = new Date().toISOString();
    const documentCreatedAtMs = Date.now();
    const vectorStore = await getVectorStore();
    const tableName = buildCollectionName(wsId || "global", workspaceName);

    const documents: VectorDocument[] = chunks.map((chunk, i) => {
      const emb = embeddings[i];
      if (!emb) throw new Error(`Missing embedding at index ${i}`);
      return {
        id: `${documentId}-${i}`,
        values: emb,
        metadata: {
          documentId,
          workspaceId: wsId || "global",
          documentName: `YouTube: ${parsed.metadata.youtubeVideoId}`,
          chunkIndex: i,
          chunkText: chunk.text,
          paragraph: chunk.metadata.paragraph,
          charStart: chunk.metadata.charStart,
          charEnd: chunk.metadata.charEnd,
          documentType: "youtube",
          documentCreatedAt,
          documentCreatedAtMs,
        },
      };
    });

    await vectorStore.addDocuments(tableName, documents);

    // Include chunk text so the server can populate PostgreSQL FTS (document_chunks.searchVector)
    const responseChunks = chunks.map((chunk, i) => ({
      chunkIndex: i,
      chunkText: chunk.text,
      paragraph: chunk.metadata.paragraph,
      charStart: chunk.metadata.charStart,
      charEnd: chunk.metadata.charEnd,
    }));

    const responsePayload = {
      documentId,
      chunkCount: chunks.length,
      chunks: responseChunks,
      embeddingModel: embeddingProvider.getModelName(),
      table: tableName,
      videoId: parsed.metadata.youtubeVideoId,
      status: "processed" as const,
    };

    // Producer-side contract validation (YouTube path) — same guard as document path.
    // Note: videoId is not in IngestResponseSchema; strip it before validation.
    const { videoId: _videoId, ...schemaPayload } = responsePayload;
    const schemaCheck = IngestResponseSchema.safeParse(schemaPayload);
    if (!schemaCheck.success) {
      logger.error("[ingest] contract violation (producer, youtube)", {
        issues: schemaCheck.error.flatten().fieldErrors,
      });
      await notifyServerStatus(documentId, "failed", undefined, "ingest contract violation (producer, youtube)");
      return res.status(500).json({ error: "Ingest contract violation (producer, youtube)" });
    }

    res.json(responsePayload);
  } catch (err: any) {
    logger.error("[ingest] YouTube processing failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "YouTube processing failed", details: err.message });
  }
});

// POST /api/ingest/wiki-pages — chunk, embed, and store wiki page vectors (route: /ingest/wiki-pages mounted on /api)
router.post("/ingest/wiki-pages", requireCollectorSecret, async (req, res) => {
  try {
    const parsed = WikiPagesIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors });
    }
    const { archiveId, pageId, slug, title, bodyText, contentHash, embeddingModel } = parsed.data;

    const table = "wiki_pages";
    const workspaceId = `archive:${archiveId}`;

    // Delete existing vectors for this page
    const vectorStore = await getVectorStore();
    await vectorStore.deleteByDocumentId(table, pageId);

    // Chunk the body text
    const chunks = await chunkText(bodyText, pageId, { chunkSize: 800, chunkOverlap: 100 });
    if (chunks.length === 0) {
      return res.json({ status: "completed", chunkCount: 0 });
    }

    // 260721-lrm (D-02): pre-flight the embedding model availability so a
    // missing local Xenova cache surfaces as a structured 503 instead of a
    // silent 500 at embed() time. Returning 200 with chunkCount:0 would
    // mark the page as indexed with no vectors, which is misleading. The
    // server's indexWikiPage try/catch logs the failure; the structured
    // body lets it surface the model name.
    const availability = await checkEmbeddingModelAvailability(embeddingModel);
    if (!availability.available) {
      logger.warn(`[ingest] wiki-pages embedding model unavailable: ${availability.error}`);
      return res.status(503).json({
        error: availability.error,
        embeddingModel: availability.model,
        available: false,
      });
    }

    // 260721-lrm (D-01): pass embeddingModel through so archive pages embed
    // with the admin-configured EMBEDDING_MODEL (matches the document upload
    // route at :262 and the query route at :377). Missing embeddingModel →
    // getEmbeddingProvider(undefined) → collector default (backward-compat).
    const embeddingProvider = await getEmbeddingProvider(embeddingModel);
    const embeddings = await embeddingProvider.embed(chunks.map((c) => c.text));

    // Store vectors
    const documents: VectorDocument[] = chunks.map((chunk, i) => {
      const emb = embeddings[i];
      if (!emb) throw new Error(`Missing embedding at index ${i}`);
      return {
        id: `${pageId}-${i}`,
        values: emb,
        metadata: {
          documentId: pageId,
          workspaceId,
          documentName: title,
          chunkIndex: i,
          chunkText: chunk.text,
          paragraph: chunk.metadata.paragraph,
          charStart: chunk.metadata.charStart,
          charEnd: chunk.metadata.charEnd,
          pageSlug: slug,
          archiveId,
          contentHash,
        },
      };
    });

    await vectorStore.addDocuments(table, documents);

    return res.json({
      status: "completed",
      chunkCount: documents.length,
    });
  } catch (err: any) {
    logger.error("[ingest] wiki-pages failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ingest/wiki-pages/:pageId — remove wiki page vectors (route: /ingest/wiki-pages/:pageId mounted on /api)
router.delete("/ingest/wiki-pages/:pageId", requireCollectorSecret, async (req, res) => {
  try {
    const { pageId } = req.params;
    // Boundary validation (CR-01): pageId feeds a LanceDB SQL `delete()`
    // predicate. Reject non-UUID values to prevent SQL injection.
    if (!isValidDocumentId(pageId)) {
      return res.status(400).json({ error: "Invalid pageId (UUID required)" });
    }
    const table = "wiki_pages";
    const vectorStore = await getVectorStore();
    await vectorStore.deleteByDocumentId(table, pageId);
    return res.json({ status: "deleted", pageId });
  } catch (err: any) {
    logger.error("[ingest] wiki-pages delete failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ingest/archive-page — parse-only endpoint for KB-05 / KB-06
 * archive import pipeline (D-05).
 *
 * Receives a multipart file + { jobId, archiveId, documentId? } form fields,
 * parses the file via the existing `parseFile` (md/xlsx/docx/pptx), and
 * callbacks the server at PUT /api/archives/import/:jobId/callback with the
 * extracted text and a title derived from the filename (extension stripped,
 * D-02). Parse-only — does NOT chunk, embed, or touch the vector store. The
 * collector stays within its HTTP-only boundary: no Prisma, no DB writes.
 *
 * On parse failure the server is notified via the same callback URL with
 * status=failed + the error message, and the endpoint returns 500. The temp
 * file is cleaned up in a finally block (mirrors the existing /ingest route
 * cleanup pattern).
 *
 * Auth: requireCollectorSecret (X-Collector-Secret header, WR-05). The server
 * dispatches with the same secret so the boundary is mutual.
 */
router.post("/ingest/archive-page", requireCollectorSecret, upload.single("file"), async (req, res) => {
  let jobId: string | undefined;
  try {
    const parsedBody = archivePageParseRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        error: "Invalid archive-page parse request",
        details: parsedBody.error.flatten().fieldErrors,
      });
    }
    jobId = parsedBody.data.jobId;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // D-05: reuse the existing parseFile — it already handles md (direct
    // read), xlsx (node-xlsx), docx (mammoth/officeparser), pptx (officeparser).
    // No ocrModel/ocrMode needed — the archive import path is for
    // machine-readable office/markdown files, not image-only PDFs (those go
    // through the OCR pipeline).
    const parsed = await parseFile(req.file.path, req.file.originalname);

    // D-02: title = filename with extension stripped. The server's
    // createPage applies D-12 UUID/placeholder rejection on top of this
    // title (Plan 03 defense-in-depth). quick 260808-vzm: sanitize BEFORE
    // stripping the extension so the title matches the stored sanitized name.
    const title = sanitizeFileName(req.file.originalname).replace(/\.[^.]+$/, "");

    const env = getEnv();
    await axios.put(
      `${env.SERVER_URL}/api/archives/import/${jobId}/callback`,
      {
        status: "completed",
        extractedText: parsed.text,
        title,
      },
      {
        timeout: 5000,
        headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
      },
    );

    return res.json({ jobId, status: "completed" });
  } catch (err: any) {
    logger.error("[ingest] archive-page parse failed", { error: err.message, jobId });

    // Best-effort failure callback so the server can flip the ArchiveImportJob
    // to FAILED instead of leaving it stuck in PROCESSING. The callback is
    // fire-and-forget — failures here are logged but do not change the 500
    // response we return to the caller (the server already knows the job is
    // PROCESSING; the FAILED transition is the collector's responsibility to
    // communicate).
    if (jobId) {
      const env = getEnv();
      axios
        .put(
          `${env.SERVER_URL}/api/archives/import/${jobId}/callback`,
          { status: "failed", error: err.message },
          { timeout: 5000, headers: { "X-Collector-Secret": env.COLLECTOR_SECRET } },
        )
        .catch(() => {
          /* best-effort — server may be unreachable */
        });
    }

    return res.status(500).json({ error: err.message });
  } finally {
    // Clean up the temp file regardless of success/failure — mirrors the
    // existing /ingest route cleanup pattern at :295 and :347.
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore cleanup errors */ }
    }
  }
});

export default router;