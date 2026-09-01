// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Vector Store — Strategy Pattern
 *
 * Default: LanceDB (local, air-gapped compatible)
 * Extensible: Qdrant for enterprise deployments
 *
 * Each vector entry stores metadata for NotebookLM-style citations:
 * - documentId, workspaceId, pageNumber, lineStart, lineEnd, paragraph
 */

import axios from "axios";
import crypto from "crypto";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { PgVectorProvider } from "./pgVectorProvider";

/**
 * Fixed project namespace for deterministic UUIDv5 derivation of Qdrant point
 * IDs from the shared logical chunk id `${documentId}-${chunkIndex}` (D-06).
 *
 * Qdrant point IDs MUST be either an unsigned integer or a standard UUID (36
 * chars). The shared chunk-id format `${documentId}-${chunkIndex}` (e.g.
 * `f00b98c1-...-0`) is neither — the `-<chunkIndex>` suffix breaks UUID format
 * and the value is not a uint64 — so Qdrant rejects the upsert with HTTP 400
 * "value ... is not a valid point ID". This silently broke every vector write
 * (upload + reembed) against Qdrant since the shared-id format was introduced
 * (collections persisted 0 points), surfacing as UAT Test 5 (upload 400) and
 * Test 11 (reindex 500).
 *
 * The fix is encapsulated entirely inside QdrantProvider: the logical chunk id
 * is mapped to a deterministic UUIDv5 for the Qdrant point id (idempotent —
 * re-runs produce the same UUID, so reembed's delete-then-add stays atomic),
 * and the logical chunk id is carried in the point payload as `chunkId` so
 * search/getByDocumentId can return it back to callers. LanceDB accepts
 * arbitrary string ids, so LanceDBProvider is unchanged and callers continue
 * to use `${documentId}-${chunkIndex}` everywhere — the Qdrant constraint does
 * not leak past the provider boundary.
 */
const SIMMETRIC_CHAT_CHUNK_NAMESPACE = "7f3c1a2b-5d4e-4f6a-9b8c-1d2e3f4a5b6c";

/**
 * RFC 4122 UUIDv5 (SHA-1 namespace+name). Implemented locally rather than via
 * the `uuid` package because uuid@14's package.json `exports` map resolves to
 * the ESM build under jest, breaking CJS test compilation. The algorithm is
 * standard and ~15 lines: SHA-1 of (namespaceBytes || nameBytes), set the
 * version (5) and variant (10xx) bits, format as a 36-char UUID.
 */
function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(Buffer.concat([namespaceBytes, Buffer.from(name, "utf8")])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function chunkIdToQdrantId(chunkId: string): string {
  return uuidv5(chunkId, SIMMETRIC_CHAT_CHUNK_NAMESPACE);
}

/**
 * 260830-ur9: the RAG metadata filter keys the server may add to the search
 * filter object. Providers that cannot pre-filter (LanceDB, Chroma) detect
 * these keys, log a single degrade warn, and ignore them — correctness is
 * enforced by the server-side post-retrieval documentIds backstop
 * (package AGENTS.md + plan 260830-ur9 orchestrator-locked design).
 */
const METADATA_FILTER_KEYS = ["documentTypes", "dateFrom", "dateTo", "dateFromMs", "dateToMs"] as const;

function hasMetadataFilterKeys(filter?: Record<string, any>): boolean {
  if (!filter) return false;
  return METADATA_FILTER_KEYS.some((k) => filter[k] !== undefined);
}

/**
 * Escape a string literal for LanceDB SQL `where()` / `delete()` predicates.
 *
 * LanceDB filters use SQL syntax with single-quoted string literals. A raw
 * value containing a single quote breaks out of the literal and allows SQL
 * injection — e.g. `workspaceId = "x' OR '1'='1"` reads or deletes vectors
 * across workspaces (CR-01). Doubling the single quote is the standard SQL
 * escape and keeps the value inside its literal, turning the payload into a
 * harmless string.
 *
 * This is defense-in-depth: route handlers MUST also validate that
 * `workspaceId`/`documentId` are UUIDs (or the allowed `global` /
 * `archive:<uuid>` shapes) before reaching the vector store. The escape alone
 * neutralizes injection even if a caller bypasses validation, but validation
 * rejects malformed inputs early with a clear 400 instead of a silent empty
 * result.
 */
function escapeSqlLiteral(value: string): string {
  return String(value).replace(/'/g, "''");
}

export interface VectorDocument {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

// Intentionally not exported — internal shape of the embedded metadata
// field (Phase 180 sweep: the export had no production consumers).
interface VectorMetadata {
  documentId: string;
  workspaceId: string;
  documentName: string;
  chunkIndex: number;
  pageNumber?: number;
  lineStart?: number;
  lineEnd?: number;
  paragraph?: number;
  charStart?: number;
  charEnd?: number;
  chunkText?: string;
  // 260830-ur9: filterable metadata stamps (RAG metadata filtering).
  documentType?: string;
  documentCreatedAt?: string;
  documentCreatedAtMs?: number;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
  text?: string;
}

export interface VectorStoreProvider {
  addDocuments(table: string, documents: VectorDocument[]): Promise<void>;
  search(table: string, queryVector: number[], limit?: number, filter?: Record<string, any>): Promise<VectorSearchResult[]>;
  deleteByDocumentId(table: string, documentId: string): Promise<void>;
  deleteByWorkspaceId(table: string, workspaceId: string): Promise<void>;
  /** Retrieve all chunks for a document (no vector query needed — metadata-only filter). Used for FTS re-index migration. */
  getByDocumentId(table: string, documentId: string, workspaceId: string): Promise<VectorSearchResult[]>;
}

/**
 * LanceDB provider — default for local/air-gapped deployments.
 * Stores vectors on disk using LanceDB's native format.
 */
class LanceDBProvider implements VectorStoreProvider {
  private db: any = null;
  private dbPath: string;
  private initializing: Promise<any> | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize() {
    if (this.db) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      const lancedb = await import("@lancedb/lancedb");
      this.db = await lancedb.connect(this.dbPath);
      logger.info(`[vector-store] LanceDB connected at ${this.dbPath}`);
    })();

    await this.initializing;
  }

  /**
   * Upsert vectors into a workspace-scoped LanceDB table. Delegates to
   * {@link ensureTable} so concurrent ingestions to a fresh table do not
   * silently drop the loser's records (409 race on createTable).
   */
  async addDocuments(table: string, documents: VectorDocument[]): Promise<void> {
    await this.initialize();

    // Build records, omitting optional numeric fields when undefined.
    // LanceDB cannot infer a data type when every value for a field is null.
    const records = documents.map((doc) => {
      const rec: Record<string, any> = {
        id: doc.id,
        vector: doc.values,
        documentId: doc.metadata.documentId,
        workspaceId: doc.metadata.workspaceId,
        documentName: doc.metadata.documentName,
        chunkIndex: doc.metadata.chunkIndex,
      };
      if (doc.metadata.pageNumber !== undefined) rec.pageNumber = doc.metadata.pageNumber;
      if (doc.metadata.lineStart !== undefined) rec.lineStart = doc.metadata.lineStart;
      if (doc.metadata.lineEnd !== undefined) rec.lineEnd = doc.metadata.lineEnd;
      if (doc.metadata.paragraph !== undefined) rec.paragraph = doc.metadata.paragraph;
      if (doc.metadata.charStart !== undefined) rec.charStart = doc.metadata.charStart;
      if (doc.metadata.charEnd !== undefined) rec.charEnd = doc.metadata.charEnd;
      if (doc.metadata.chunkText !== undefined && doc.metadata.chunkText !== "") rec.chunkText = doc.metadata.chunkText;
      return rec;
    });

    await this.ensureTable(table, records);
    logger.info(`[vector-store] Added ${documents.length} vectors to table "${table}"`);
  }

  /**
   * Idempotent table ensure — mirrors QdrantProvider.ensureCollection.
   *
   * Race-safe under concurrent ingestions to the same fresh workspace table:
   * the loser of a createTable race receives an "already exists" error that
   * was previously swallowed by a bare `catch {}`, silently dropping its
   * records. This method falls back to openTable + add so the loser's records
   * are preserved.
   *
   * Error strings matched against @lancedb/lancedb@0.31.0 (captured by the
   * probe test in vectorStore.test.ts): openTable not-found message contains
   * "was not found"; createTable already-exists message contains
   * "already exists". Both carry code "GenericFailure" — the message
   * substring is the stable discriminator across LanceDB versions, so the
   * predicates fall back to generic substring matching if the exact strings
   * drift.
   */
  private async ensureTable(table: string, records: Record<string, any>[]): Promise<void> {
    try {
      const tbl = await this.db.openTable(table);
      await tbl.add(records);
      return;
    } catch (err: any) {
      if (!this.isTableMissing(err)) throw err;
    }

    // Table missing — first creator wins. If a concurrent caller beats us,
    // createTable throws "already exists" (the 409 race); fall back to
    // openTable + add so this caller's records are NOT dropped.
    try {
      await this.db.createTable(table, records);
      return;
    } catch (createErr: any) {
      if (!this.isAlreadyExists(createErr)) throw createErr;
    }

    const tbl = await this.db.openTable(table);
    await tbl.add(records);
  }

  private isTableMissing(err: any): boolean {
    const msg: string = (err?.message ?? "").toLowerCase();
    // Probe-captured string: "Table 'X' was not found  Caused by: Dataset ... was not found"
    return msg.includes("was not found") || msg.includes("does not exist") || msg.includes("no such");
  }

  private isAlreadyExists(err: any): boolean {
    const msg: string = (err?.message ?? "").toLowerCase();
    // Probe-captured string: "Table 'X' already exists"
    return msg.includes("already exists");
  }

  async search(
    table: string,
    queryVector: number[],
    limit: number = 5,
    filter?: Record<string, any>,
  ): Promise<VectorSearchResult[]> {
    await this.initialize();

    let tbl;
    try {
      tbl = await this.db.openTable(table);
    } catch (err: any) {
      logger.warn(`[vector-store] Table "${table}" not found: ${err?.message ?? err}`);
      return [];
    }

    let query = tbl.search(queryVector).limit(limit);

    // 260830-ur9: LanceDB cannot pre-filter the new metadata keys. Schema
    // evolution on pre-existing tables is unsafe (tables are created from
    // first-records shape via ensureTable), so new filter keys are NEVER
    // composed into SQL here (T-260830-01) — they are logged once and
    // ignored; the server-side backstop enforces correctness.
    if (hasMetadataFilterKeys(filter)) {
      logger.warn(
        "[vector-store] LanceDB does not support metadata filters (documentTypes/date range); server-side backstop enforces correctness",
      );
    }

    if (filter?.workspaceId) {
      query = query.where(`workspaceId = '${escapeSqlLiteral(filter.workspaceId)}'`);
    }
    if (filter?.documentId) {
      query = query.where(`documentId = '${escapeSqlLiteral(filter.documentId)}'`);
    }

    const results = await query.toArray();

    return results.map((r: any) => ({
      id: r.id,
      score: r._distance || 0,
      text: r.chunkText ?? undefined,
      metadata: {
        documentId: r.documentId,
        workspaceId: r.workspaceId,
        documentName: r.documentName,
        chunkIndex: r.chunkIndex,
        pageNumber: r.pageNumber ?? undefined,
        lineStart: r.lineStart ?? undefined,
        lineEnd: r.lineEnd ?? undefined,
        paragraph: r.paragraph ?? undefined,
        charStart: r.charStart ?? undefined,
        charEnd: r.charEnd ?? undefined,
        chunkText: r.chunkText ?? undefined,
      },
    }));
  }

  async deleteByDocumentId(table: string, documentId: string): Promise<void> {
    await this.initialize();
    try {
      const tbl = await this.db.openTable(table);
      await tbl.delete(`documentId = '${escapeSqlLiteral(documentId)}'`);
      logger.info(`[vector-store] Deleted vectors for document ${documentId}`);
    } catch (err: any) {
      logger.warn(`[vector-store] Table "${table}" not found for deletion: ${err?.message ?? err}`);
    }
  }

  async deleteByWorkspaceId(table: string, workspaceId: string): Promise<void> {
    await this.initialize();
    try {
      const tbl = await this.db.openTable(table);
      await tbl.delete(`workspaceId = '${escapeSqlLiteral(workspaceId)}'`);
      logger.info(`[vector-store] Deleted vectors for workspace ${workspaceId}`);
    } catch (err: any) {
      logger.warn(`[vector-store] Table "${table}" not found for deletion: ${err?.message ?? err}`);
    }
  }

  async getByDocumentId(table: string, documentId: string, _workspaceId: string): Promise<VectorSearchResult[]> {
    await this.initialize();
    try {
      const tbl = await this.db.openTable(table);
      // LanceDB query with documentId filter — no vector needed
      const results = await tbl.query().where(`documentId = '${escapeSqlLiteral(documentId)}'`).toArray();
      return results.map((r: any) => ({
        id: r.id,
        score: 0,
        text: r.chunkText ?? undefined,
        metadata: {
          documentId: r.documentId,
          workspaceId: r.workspaceId,
          documentName: r.documentName,
          chunkIndex: r.chunkIndex,
          pageNumber: r.pageNumber ?? undefined,
          lineStart: r.lineStart ?? undefined,
          lineEnd: r.lineEnd ?? undefined,
          paragraph: r.paragraph ?? undefined,
          charStart: r.charStart ?? undefined,
          charEnd: r.charEnd ?? undefined,
          chunkText: r.chunkText ?? undefined,
        },
      }));
    } catch (err: any) {
      logger.warn(`[vector-store] Table "${table}" not found for getByDocumentId: ${err?.message ?? err}`);
      return [];
    }
  }
}

/**
 * Qdrant provider — enterprise deployments via REST API.
 * Requires VECTOR_DB_URL to be configured.
 */
class QdrantProvider implements VectorStoreProvider {
  private url: string;
  private apiKey: string | undefined;
  private headers: Record<string, string>;

  constructor(url: string, apiKey?: string) {
    this.url = url.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.headers = { "Content-Type": "application/json" };
    if (apiKey) {
      this.headers["api-key"] = apiKey;
    }
  }

  private async ensureCollection(table: string, vectorSize: number): Promise<void> {
    try {
      await withRetry(
        () => axios.get(`${this.url}/collections/${table}`, { headers: this.headers, timeout: 5000 }),
        { maxRetries: 3, baseDelayMs: 500 },
      );
      return;
    } catch (err: any) {
      if (err.response?.status !== 404) {
        throw new Error(`Qdrant collection check failed: ${err.message}`, { cause: err });
      }
    }

    // Create the collection. This is a check-then-act race: when several
    // documents are uploaded to the same workspace concurrently, every caller
    // sees the 404 above and races to create — the losers get HTTP 409
    // "already exists". That 409 is idempotent success (the collection exists,
    // which is all we wanted), so we must NOT let withRetry loop on it forever.
    await withRetry(
      async () => {
        try {
          await axios.put(
            `${this.url}/collections/${table}`,
            {
              vectors: {
                size: vectorSize,
                distance: "Cosine",
              },
            },
            { headers: this.headers, timeout: 10000 },
          );
        } catch (err: any) {
          if (err.response?.status === 409) {
            logger.info(`[vector-store] Qdrant collection "${table}" already exists (concurrent create)`);
            return;
          }
          throw err;
        }
      },
      { maxRetries: 3, baseDelayMs: 500 },
    );
    logger.info(`[vector-store] Ensured Qdrant collection "${table}" with vector size ${vectorSize}`);
  }

  async addDocuments(table: string, documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;

    const firstDoc = documents[0]!;
    const vectorSize = firstDoc.values.length;
    await this.ensureCollection(table, vectorSize);

    const points = documents.map((doc) => ({
      id: chunkIdToQdrantId(doc.id),
      vector: doc.values,
      payload: { ...doc.metadata, chunkId: doc.id },
    }));

    await withRetry(
      () =>
        axios.put(
          `${this.url}/collections/${table}/points`,
          { points },
          { headers: this.headers, timeout: 30000 },
        ),
      { maxRetries: 3, baseDelayMs: 500 },
    );

    logger.info(`[vector-store] Added ${documents.length} vectors to Qdrant collection "${table}"`);
  }

  async search(
    table: string,
    queryVector: number[],
    limit: number = 5,
    filter?: Record<string, any>,
  ): Promise<VectorSearchResult[]> {
    const body: any = {
      vector: queryVector,
      limit,
      with_payload: true,
    };

    // 260830-ur9: optional metadata pre-filters. The workspaceId predicate
    // stays MANDATORY (T-260830-03 — filters only narrow, never widen);
    // documentTypes → one must clause with match.any; date bounds → one
    // numeric range clause on documentCreatedAtMs (the *Ms values are the
    // epoch-ms mirrors the SERVER normalizes and sends alongside the ISO
    // strings — Qdrant's range DSL is version-safe on numeric payload).
    // Range clauses are added only when the corresponding *Ms is a finite
    // number. Existing no-filter body shape is unchanged.
    if (filter?.workspaceId || filter?.documentId) {
      body.filter = { must: [] };
      if (filter.workspaceId) {
        body.filter.must.push({ key: "workspaceId", match: { value: filter.workspaceId } });
      }
      if (filter.documentId) {
        body.filter.must.push({ key: "documentId", match: { value: filter.documentId } });
      }
      if (Array.isArray(filter.documentTypes) && filter.documentTypes.length > 0) {
        body.filter.must.push({ key: "documentType", match: { any: filter.documentTypes } });
      }
      const dateFromMs = Number(filter.dateFromMs);
      const dateToMs = Number(filter.dateToMs);
      const range: { gte?: number; lte?: number } = {};
      if (Number.isFinite(dateFromMs)) range.gte = dateFromMs;
      if (Number.isFinite(dateToMs)) range.lte = dateToMs;
      if (range.gte !== undefined || range.lte !== undefined) {
        body.filter.must.push({ key: "documentCreatedAtMs", range });
      }
    }

    // A missing collection means no documents have been ingested yet for this
    // workspace — treat as empty results (mirrors LanceDBProvider behavior),
    // not a fatal error. The 404 is caught inside the retry fn so withRetry does
    // NOT retry it (a missing collection won't materialize on retry); transient
    // errors (500/timeout/network) still get retried as before.
    let notFound = false;
    const response = await withRetry(
      async () => {
        try {
          return await axios.post(
            `${this.url}/collections/${table}/points/search`,
            body,
            { headers: this.headers, timeout: 10000 },
          );
        } catch (err: any) {
          if (err.response?.status === 404) {
            notFound = true;
            return null; // sentinel — resolves the retry fn, no retry attempted
          }
          throw err;
        }
      },
      { maxRetries: 3, baseDelayMs: 500 },
    );

    if (notFound) {
      logger.warn(`[vector-store] Qdrant collection "${table}" not found`);
      return [];
    }

    const results = response!.data.result || [];
    return results.map((r: any) => ({
      id: r.payload?.chunkId ?? String(r.id),
      score: r.score || 0,
      text: r.payload?.chunkText ?? undefined,
      metadata: {
        documentId: r.payload.documentId,
        workspaceId: r.payload.workspaceId,
        documentName: r.payload.documentName,
        chunkIndex: r.payload.chunkIndex,
        pageNumber: r.payload.pageNumber ?? undefined,
        lineStart: r.payload.lineStart ?? undefined,
        lineEnd: r.payload.lineEnd ?? undefined,
        paragraph: r.payload.paragraph ?? undefined,
        charStart: r.payload.charStart ?? undefined,
        charEnd: r.payload.charEnd ?? undefined,
        chunkText: r.payload?.chunkText ?? undefined,
      },
    }));
  }

  async deleteByDocumentId(table: string, documentId: string): Promise<void> {
    // A missing collection means there is nothing to delete (the document was
    // ingested under a different collection name, the collection was wiped, or
    // it was never created). Treat the 404 as idempotent success — mirrors the
    // `search` method — so a stale/orphan document delete does not surface as a
    // noisy 3x-retry + 500. The sentinel resolves withRetry without retrying.
    let notFound = false;
    await withRetry(
      async () => {
        try {
          return await axios.post(
            `${this.url}/collections/${table}/points/delete`,
            {
              filter: {
                must: [{ key: "documentId", match: { value: documentId } }],
              },
            },
            { headers: this.headers, timeout: 10000 },
          );
        } catch (err: any) {
          if (err.response?.status === 404) {
            notFound = true;
            return null;
          }
          throw err;
        }
      },
      { maxRetries: 3, baseDelayMs: 500 },
    );
    if (notFound) {
      logger.warn(`[vector-store] Qdrant collection "${table}" not found for delete (document ${documentId}) — nothing to purge`);
      return;
    }
    logger.info(`[vector-store] Deleted Qdrant vectors for document ${documentId}`);
  }

  async deleteByWorkspaceId(table: string, workspaceId: string): Promise<void> {
    let notFound = false;
    await withRetry(
      async () => {
        try {
          return await axios.post(
            `${this.url}/collections/${table}/points/delete`,
            {
              filter: {
                must: [{ key: "workspaceId", match: { value: workspaceId } }],
              },
            },
            { headers: this.headers, timeout: 10000 },
          );
        } catch (err: any) {
          if (err.response?.status === 404) {
            notFound = true;
            return null;
          }
          throw err;
        }
      },
      { maxRetries: 3, baseDelayMs: 500 },
    );
    if (notFound) {
      logger.warn(`[vector-store] Qdrant collection "${table}" not found for delete (workspace ${workspaceId}) — nothing to purge`);
      return;
    }
    logger.info(`[vector-store] Deleted Qdrant vectors for workspace ${workspaceId}`);
  }

  async getByDocumentId(table: string, documentId: string, workspaceId: string): Promise<VectorSearchResult[]> {
    try {
      const allPoints: any[] = [];
      let offset: string | null = null;
      const limit = 100;

      // Qdrant scroll API with documentId filter — paginate through all points
      do {
        const body: any = {
          limit,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              { key: "documentId", match: { value: documentId } },
              { key: "workspaceId", match: { value: workspaceId } },
            ],
          },
        };
        if (offset) body.offset = offset;

        const response = await withRetry(
          () =>
            axios.post(
              `${this.url}/collections/${table}/points/scroll`,
              body,
              { headers: this.headers, timeout: 30000 },
            ),
          { maxRetries: 3, baseDelayMs: 500 },
        );

        const result = response.data?.result;
        const points = result?.points || [];
        allPoints.push(...points);
        offset = result?.next_page_offset || null;
      } while (offset);

      return allPoints.map((r: any) => ({
        id: r.payload?.chunkId ?? String(r.id),
        score: 0,
        text: r.payload?.chunkText ?? undefined,
        metadata: {
          documentId: r.payload?.documentId || documentId,
          workspaceId: r.payload?.workspaceId || workspaceId,
          documentName: r.payload?.documentName || "",
          chunkIndex: r.payload?.chunkIndex ?? 0,
          pageNumber: r.payload?.pageNumber ?? undefined,
          lineStart: r.payload?.lineStart ?? undefined,
          lineEnd: r.payload?.lineEnd ?? undefined,
          paragraph: r.payload?.paragraph ?? undefined,
          charStart: r.payload?.charStart ?? undefined,
          charEnd: r.payload?.charEnd ?? undefined,
          chunkText: r.payload?.chunkText ?? undefined,
        },
      }));
    } catch (err: any) {
      if (err.response?.status === 404) {
        logger.warn(`[vector-store] Qdrant collection "${table}" not found for getByDocumentId`);
        return [];
      }
      throw err;
    }
  }
}

/**
 * Chroma provider — self-hosted lightweight vector database.
 * Uses the official chromadb npm SDK. Intended for mid-scale deployments
 * between single-node LanceDB and full-cluster Qdrant.
 *
 * Reuses VECTOR_DB_URL (same as Qdrant). Chroma auto-creates collections
 * on first use via getOrCreateCollection (no separate ensure-collection
 * step needed, unlike Qdrant).
 */
export class ChromaProvider implements VectorStoreProvider {
  private client: any = null;
  private url: string;

  constructor(url: string) {
    this.url = url.replace(/\/$/, "");
  }

  private async ensureCollection(table: string): Promise<any> {
    if (!this.client) {
      const { ChromaClient } = await import("chromadb");
      this.client = new ChromaClient({ path: this.url });
    }
    // Chroma 0.5+ auto-creates with getOrCreateCollection — no separate
    // creation step needed. Use SDK defaults for tenant/database (D-C-01).
    const collection = await this.client.getOrCreateCollection({ name: table });
    return collection;
  }

  async addDocuments(table: string, documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;

    const collection = await this.ensureCollection(table);

    const ids = documents.map((doc) => doc.id);
    const embeddings = documents.map((doc) => doc.values);
    const metadatas = documents.map((doc) => {
      const meta: Record<string, boolean | number | string | null> = {
        documentId: doc.metadata.documentId,
        workspaceId: doc.metadata.workspaceId,
        documentName: doc.metadata.documentName,
        chunkIndex: doc.metadata.chunkIndex,
      };
      if (doc.metadata.pageNumber !== undefined) meta.pageNumber = doc.metadata.pageNumber;
      if (doc.metadata.lineStart !== undefined) meta.lineStart = doc.metadata.lineStart;
      if (doc.metadata.lineEnd !== undefined) meta.lineEnd = doc.metadata.lineEnd;
      if (doc.metadata.paragraph !== undefined) meta.paragraph = doc.metadata.paragraph;
      if (doc.metadata.charStart !== undefined) meta.charStart = doc.metadata.charStart;
      if (doc.metadata.charEnd !== undefined) meta.charEnd = doc.metadata.charEnd;
      return meta;
    });
    const texts = documents.map((doc) => doc.metadata.chunkText ?? "");

    await collection.add({ ids, embeddings, metadatas, documents: texts });
    logger.info(`[vector-store] Added ${documents.length} vectors to Chroma collection "${table}"`);
  }

  async search(
    table: string,
    queryVector: number[],
    limit: number = 5,
    filter?: Record<string, any>,
  ): Promise<VectorSearchResult[]> {
    let collection: any;
    try {
      collection = await this.ensureCollection(table);
    } catch (err: any) {
      logger.warn(`[vector-store] Chroma collection "${table}" not found: ${err?.message ?? err}`);
      return [];
    }

    try {
      // 260830-ur9 / T-260830-06: Chroma's where DSL cannot express arrays
      // (a raw documentTypes array errors) and bare date strings would
      // silently become implicit $eq matches against the raw ISO string
      // (silently returning []). Degrade, mirroring the LanceDB design:
      // copy ONLY allowlisted scalar keys into the where object
      // (workspaceId, documentId when present — NEVER widened per
      // T-260830-03), strip the metadata-filter keys, and log one warn when
      // anything was stripped. An empty where object degrades to undefined
      // (identical to today's no-filter call). Correctness is enforced by
      // the server-side post-retrieval documentIds backstop.
      const where: Record<string, any> = {};
      if (filter?.workspaceId !== undefined) where.workspaceId = filter.workspaceId;
      if (filter?.documentId !== undefined) where.documentId = filter.documentId;
      const strippedKeys = METADATA_FILTER_KEYS.filter((k) => filter?.[k] !== undefined);
      if (strippedKeys.length > 0) {
        logger.warn(
          "[vector-store] Chroma does not support metadata filters (documentTypes/date range); server-side backstop enforces correctness",
        );
      }
      const result = await collection.query({
        queryEmbeddings: [queryVector],
        nResults: limit,
        where: Object.keys(where).length > 0 ? where : undefined,
      });

      // Chroma returns nested arrays — unpack the first (and only) query result
      const ids: string[] = result.ids?.[0] ?? [];
      const distances: number[] = result.distances?.[0] ?? [];
      const metadatas: Record<string, any>[] = result.metadatas?.[0] ?? [];
      const documents: (string | null)[] = result.documents?.[0] ?? [];

      return ids.map((id: string, i: number) => {
        const distance = distances[i] ?? 0;
        // Chroma returns cosine distance (1 - cosine_similarity) by default.
        // Convert to a score where higher = better: 1 - distance = cosine_similarity.
        const score = Math.max(0, 1 - distance);
        const meta = metadatas[i] ?? {};
        return {
          id,
          score,
          text: documents[i] ?? undefined,
          metadata: {
            documentId: meta.documentId ?? "",
            workspaceId: meta.workspaceId ?? "",
            documentName: meta.documentName ?? "",
            chunkIndex: meta.chunkIndex ?? 0,
            pageNumber: meta.pageNumber ?? undefined,
            lineStart: meta.lineStart ?? undefined,
            lineEnd: meta.lineEnd ?? undefined,
            paragraph: meta.paragraph ?? undefined,
            charStart: meta.charStart ?? undefined,
            charEnd: meta.charEnd ?? undefined,
            chunkText: documents[i] ?? undefined,
          },
        };
      });
    } catch (err: any) {
      // 404-as-empty: if the collection doesn't exist, return []
      logger.warn(`[vector-store] Chroma query error on "${table}": ${err?.message ?? err}`);
      return [];
    }
  }

  async deleteByDocumentId(table: string, documentId: string): Promise<void> {
    try {
      const collection = await this.ensureCollection(table);
      await collection.delete({ where: { documentId } });
      logger.info(`[vector-store] Deleted Chroma vectors for document ${documentId} in collection "${table}"`);
    } catch (err: any) {
      logger.warn(
        `[vector-store] Chroma collection "${table}" not found for delete (document ${documentId}): ${err?.message ?? err}`,
      );
    }
  }

  async deleteByWorkspaceId(table: string, workspaceId: string): Promise<void> {
    try {
      const collection = await this.ensureCollection(table);
      await collection.delete({ where: { workspaceId } });
      logger.info(`[vector-store] Deleted Chroma vectors for workspace ${workspaceId} in collection "${table}"`);
    } catch (err: any) {
      logger.warn(
        `[vector-store] Chroma collection "${table}" not found for delete (workspace ${workspaceId}): ${err?.message ?? err}`,
      );
    }
  }

  async getByDocumentId(table: string, documentId: string, workspaceId: string): Promise<VectorSearchResult[]> {
    try {
      const collection = await this.ensureCollection(table);
      const result = await collection.get({ where: { documentId, workspaceId } });

      const ids: string[] = result.ids ?? [];
      const metadatas: Record<string, any>[] = result.metadatas ?? [];
      const documents: (string | null)[] = result.documents ?? [];

      return ids.map((id: string, i: number) => {
        const meta = metadatas[i] ?? {};
        return {
          id,
          score: 0, // mirror QdrantProvider pattern
          text: documents[i] ?? undefined,
          metadata: {
            documentId: meta.documentId ?? documentId,
            workspaceId: meta.workspaceId ?? workspaceId,
            documentName: meta.documentName ?? "",
            chunkIndex: meta.chunkIndex ?? 0,
            pageNumber: meta.pageNumber ?? undefined,
            lineStart: meta.lineStart ?? undefined,
            lineEnd: meta.lineEnd ?? undefined,
            paragraph: meta.paragraph ?? undefined,
            charStart: meta.charStart ?? undefined,
            charEnd: meta.charEnd ?? undefined,
            chunkText: documents[i] ?? undefined,
          },
        };
      });
    } catch (err: any) {
      logger.warn(
        `[vector-store] Chroma collection "${table}" not found for getByDocumentId: ${err?.message ?? err}`,
      );
      return [];
    }
  }
}

// Singleton cache
let storeInstance: VectorStoreProvider | null = null;

async function fetchVectorDbConfig(): Promise<{ provider: string; url?: string; apiKey?: string } | null> {
  try {
    const env = getEnv();
    const response = await axios.get(`${env.SERVER_URL}/api/system/settings/vector-db-config`, { timeout: 5000 });
    return response.data as { provider: string; url?: string; apiKey?: string };
  } catch (err: any) {
    logger.warn(`[vector-store] Failed to fetch vector DB config from server: ${err.message}`);
    return null;
  }
}

/**
 * Get the configured vector store provider.
 * Uses a singleton to avoid re-initializing connections.
 * Prefers server system config; falls back to environment variables.
 */
export async function getVectorStore(): Promise<VectorStoreProvider> {
  if (storeInstance) return storeInstance;

  const serverConfig = await fetchVectorDbConfig();
  const env = getEnv();

  const provider = serverConfig?.provider || env.VECTOR_DB_PROVIDER;
  const url = serverConfig?.url || env.VECTOR_DB_URL;
  const apiKey = serverConfig?.apiKey || env.VECTOR_DB_API_KEY;

  switch (provider) {
    case "chroma":
      if (!url) {
        throw new Error("Chroma provider requires VECTOR_DB_URL");
      }
      storeInstance = new ChromaProvider(url);
      logger.info(`[vector-store] Using Chroma provider at ${url}`);
      break;
    case "qdrant":
      if (!url) {
        throw new Error("Qdrant provider requires VECTOR_DB_URL");
      }
      storeInstance = new QdrantProvider(url, apiKey);
      logger.info(`[vector-store] Using Qdrant provider at ${url}`);
      break;
    case "pgvector": {
      // D-02: URL arrives via runtime config from server
      // (/api/system/settings/vector-db-config returns DATABASE_URL when
      // provider==="pgvector"). The collector never reads DATABASE_URL from
      // its own env (CLAUDE.md "no DATABASE_URL on collector" stance preserved).
      if (!url) {
        throw new Error(
          "pgvector provider requires DATABASE_URL via runtime config (server /api/system/settings/vector-db-config)",
        );
      }
      const pgInstance = new PgVectorProvider(url);
      // Lazy auto-provisioning (CREATE EXTENSION/TABLE/INDEX IF NOT EXISTS, D-06)
      // before caching the singleton so the first caller absorbs the DDL cost.
      await pgInstance.initialize();
      storeInstance = pgInstance;
      logger.info(`[vector-store] Using pgvector provider at ${url}`);
      break;
    }
    case "lancedb":
    default:
      storeInstance = new LanceDBProvider(`${env.STORAGE_PATH}/vectors/lancedb`);
      logger.info(`[vector-store] Using LanceDB provider at ${env.STORAGE_PATH}/vectors/lancedb`);
      break;
  }

  return storeInstance;
}
