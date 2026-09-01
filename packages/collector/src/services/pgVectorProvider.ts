// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * PgVectorProvider — Phase 91-03 (D-01..D-09).
 *
 * Implements the `VectorStoreProvider` interface (5 methods) backed by a raw
 * `pg.Pool` against a PostgreSQL instance with the `pgvector` extension.
 * Collector-owned (no Prisma) per D-01; the URL arrives via runtime config
 * from the server (`/api/system/settings/vector-db-config`) per D-02.
 *
 * Key decisions (locked in 91-CONTEXT.md):
 *   - D-03: per-dim tables `chunk_vectors_<dim>` (derived from
 *     `getEmbeddingProvider().getDimension()`). The `table` param of the
 *     interface (LanceDB convention `ws_<id>`) is IGNORED — pgvector routes
 *     by embedding dimension, not workspace.
 *   - D-04: HNSW index with `vector_cosine_ops` (NEVER IVFFlat — Pitfall 1),
 *     `m = 16`, `ef_construction = 64` (pgvector defaults).
 *   - D-05: dim-mismatch BLOCK + fail-loud in `initialize()` via
 *     `format_type(atttypid, atttypmod)` introspection on `pg_attribute`.
 *   - D-06: lazy auto-provisioning (`CREATE EXTENSION/TABLE/INDEX IF NOT
 *     EXISTS`), idempotent — same precedent as `pg_trgm` in `ftsService.ts:32`.
 *   - D-07 (INVERTED per RESEARCH §Q1): the vendor `toPgVector` helper +
 *     `$1::vector` string-cast is the FIRST-CLASS universal path. The
 *     ESM-only `pgvector/pg` `registerTypes` is an OPTIONAL dev-only
 *     optimization loaded via dynamic `await import('pgvector/pg')` in a
 *     module-scope try/catch. Under `node dist` (production CJS) the
 *     dynamic import compiles to `require()` and throws `ERR_REQUIRE_ESM`
 *     → caught → `registerTypesFn` stays null → vendor path used. Under
 *     `tsx` (dev) the dynamic import succeeds → `registerTypes` is wired
 *     on the Pool `onConnect` hook as an optimization. Correctness is
 *     NEVER gated on `registerTypes` — the vendor path produces identical
 *     SQL results.
 *   - D-09: score = `1 - (embedding <=> query)` (cosine similarity, 0..1,
 *     higher = better) — aligns with Qdrant's score shape.
 *
 * Security: all `workspaceId`/`documentId` values are parameterized (`$1`,
 * `$2`); the table name is derived from `getDimension()` (an integer), never
 * from user input. `WHERE workspace_id = $1` is MANDATORY in search and
 * `getByDocumentId` (cross-workspace leakage prevention, defense-in-depth
 * with server-side RBAC).
 */

import { Pool } from "pg";
import { toPgVector, parseVectorDim } from "../utils/pgvectorHelper";
import { getEmbeddingProvider } from "./embeddings";
import { withRetry } from "../utils/retry";
import { logger } from "../utils/logger";
import type { VectorStoreProvider, VectorDocument, VectorSearchResult } from "./vectorStore";

/**
 * Optional `pgvector/pg` `registerTypes` loader (D-07 refinement).
 *
 * Loaded ONCE at module scope via dynamic `import("pgvector/pg")` in a
 * `.then()` chain (no top-level `await` — collector `module: "commonjs"`
 * forbids top-level await). The dynamic `import()` compiles to
 * `Promise.resolve().then(() => __importStar(require("pgvector/pg")))`
 * under CJS — which throws `ERR_REQUIRE_ESM` on the ESM-only `pgvector`
 * 0.3.0 package under `node dist`. The `.catch()` keeps the module load
 * crash-free; `registerTypesFn` stays null and the vendor `toPgVector` +
 * `$1::vector` cast path is used (FIRST-CLASS).
 *
 * NOTE: because the loader runs asynchronously, `registerTypesFn` is null
 * at construction time when the dynamic import is still pending. This is
 * acceptable — `registerTypes` is an OPTIONAL optimization (saves a
 * string-format step when available); the vendor path produces identical
 * SQL semantics. Once the import resolves, the Pool's `onConnect` hook
 * cannot be retroactively added to a live pool, so the optimization only
 * takes effect for pools constructed AFTER the import resolves. In
 * practice the collector's single Pool is constructed at first
 * `getVectorStore()` call (after server config fetch), which is well after
 * module load — but to be safe, the constructor reads `registerTypesFn`
 * at construction time, not at module-eval time.
 */
let registerTypesFn: ((client: import("pg").Client) => Promise<void>) | null = null;
void import("pgvector/pg")
  .then((mod: any) => {
    registerTypesFn = (mod as any).registerTypes ?? null;
    if (registerTypesFn) {
      logger.info("[pgvector] pgvector/pg registerTypes loaded (dev/tsx path)");
    }
  })
  .catch((err: any) => {
    logger.warn(
      `[pgvector] pgvector/pg registerTypes unavailable (${err?.code ?? err?.message ?? String(err)}); ` +
        `using vendor toPgVector + ::vector cast fallback (FIRST-CLASS path)`,
    );
  });

/**
 * PgVectorProvider — third `VectorStoreProvider` implementation alongside
 * LanceDB (default) and Qdrant. Owns a raw `pg.Pool` (D-01, no Prisma) and
 * auto-provisions its schema lazily on `initialize()` (D-06).
 */
export class PgVectorProvider implements VectorStoreProvider {
  private pool: Pool;
  private dim: number = 0;
  private tableName: string = "";

  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      // `onConnect` runs on every pooled client acquisition — registers the
      // pgvector Oid parser/serializer so `number[]` params bind natively.
      // Only set when `registerTypesFn` loaded (dev/tsx path); under node dist
      // this stays undefined and the vendor `toPgVector` + `$1::vector` cast
      // path is used instead (identical SQL semantics). The `pg` types
      // declare `onConnect: (client: ClientBase) => void`; the loader returns
      // a `Promise<void>`, so cast to `any` to satisfy the PoolConfig shape
      // (pg accepts async onConnect at runtime — the type is just narrower).
      ...(registerTypesFn ? { onConnect: ((client: import("pg").Client) => { void registerTypesFn!(client); }) as any } : {}),
    });
    // Idle-client disconnects (common during docker-compose PG restarts) would
    // crash the Node process without this handler.
    this.pool.on("error", (err, _client) => {
      logger.error(`[pgvector] pool idle client error: ${err.message}`);
    });
  }

  /**
   * Lazy auto-provisioning (D-06). Idempotent — safe to call on every
   * collector start. Mirrors the `CREATE EXTENSION IF NOT EXISTS pg_trgm`
   * precedent in `ftsService.ts:32`.
   *
   * Sequence:
   *   1. Resolve embedding dim → derive table name `chunk_vectors_<dim>` (D-03)
   *   2. `CREATE EXTENSION IF NOT EXISTS vector` (withRetry — docker-compose race)
   *   3. `CREATE TABLE IF NOT EXISTS` with `vector(<dim>)` typed column
   *   4. `CREATE INDEX IF NOT EXISTS ... USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)` (D-04)
   *   5. `CREATE INDEX IF NOT EXISTS ... ON (workspace_id)` (BTREE for filter)
   *   6. dim-mismatch BLOCK check via `format_type` + `parseVectorDim` (D-05)
   */
  async initialize(): Promise<void> {
    // 1. Resolve dim + table name
    const embProvider = await getEmbeddingProvider();
    this.dim = embProvider.getDimension();
    this.tableName = `chunk_vectors_${this.dim}`;

    // 2. CREATE EXTENSION (withRetry absorbs docker-compose PG startup race)
    try {
      await withRetry(() => this.pool.query("CREATE EXTENSION IF NOT EXISTS vector"), {
        maxRetries: 5,
        baseDelayMs: 1000,
      });
    } catch (err: any) {
      // 42704 = undefined_file (extension not installed in the PG image).
      if (err?.code === "42704" || (err?.message ?? "").includes("extension") && (err?.message ?? "").includes("not available")) {
        throw new Error(
          "pgvector extension not installed. Use the pgvector/pgvector:pg16 Docker image, " +
            "or install manually: apt-get install postgresql-16-pgvector (Debian), " +
            "brew install pgvector (macOS), or build from github.com/pgvector/pgvector. " +
            "Then run: CREATE EXTENSION vector;",
          { cause: err },
        );
      }
      throw err;
    }

    // 3. CREATE TABLE (per-dim, vector(<dim>) typed — required for HNSW opclass)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        chunk_id        TEXT PRIMARY KEY,
        embedding       vector(${this.dim}) NOT NULL,
        workspace_id    TEXT NOT NULL,
        document_id     TEXT NOT NULL,
        document_name   TEXT,
        chunk_index     INTEGER,
        chunk_text      TEXT,
        metadata        JSONB,
        created_at      TIMESTAMPTZ DEFAULT now()
      );
    `);

    // 4. HNSW index (D-04 — NEVER IVFFlat: Pitfall 1 HIGHEST RISK)
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_embedding_hnsw
      ON ${this.tableName} USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    // 5. workspace_id BTREE index (filter for search/getByDocumentId)
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_ws_idx
      ON ${this.tableName} (workspace_id);
    `);

    // 6. dim-mismatch BLOCK (D-05 — defense-in-depth)
    // After `CREATE TABLE IF NOT EXISTS`, the table might already exist with a
    // DIFFERENT dim (e.g. embedding model changed without dropping the table).
    // The table name `chunk_vectors_<dim>` makes this rare, but a manual schema
    // edit or a model swap mid-process could trigger it. Fail-loud — NEVER
    // silent re-embed (Pitfall 1 silent corruption).
    const dimResult = await this.pool.query(
      `
      SELECT format_type(a.atttypid, a.atttypmod) AS column_type
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE c.relname = $1
        AND a.attname = 'embedding'
        AND n.nspname = 'public'
        AND a.attnum > 0
        AND NOT a.attisdropped;
      `,
      [this.tableName],
    );
    if (dimResult.rows.length > 0) {
      const declaredType: string = dimResult.rows[0].column_type;
      const declared = parseVectorDim(declaredType);
      // `declared === null` means the column is somehow not a vector type —
      // NOT a dim mismatch (absence, not divergence). Skip the check in that
      // case (it would only happen if someone manually altered the column).
      if (declared !== null && declared !== this.dim) {
        logger.error(
          `[pgvector] dim-mismatch on table ${this.tableName}: ` +
            `declared vector(${declared}) ≠ embedding provider dim ${this.dim}. ` +
            `Re-embed required: drop table ${this.tableName} and re-ingest, ` +
            `or switch embedding model.`,
        );
        throw new Error(
          `pgvector dim-mismatch: table ${this.tableName} declares vector(${declared}) ` +
            `but embedding provider produces ${this.dim}-dim vectors. ` +
            `Re-embed required (drop table + re-ingest).`,
        );
      }
    }

    logger.info(
      `[pgvector] initialized: table ${this.tableName}, dim ${this.dim}, ` +
        `HNSW index (vector_cosine_ops, m=16, ef_construction=64)`,
    );
  }

  /**
   * Graceful shutdown — drain the Pool. Called from the collector's SIGTERM
   * hook. Idempotent (calling twice is a no-op — `pool.end()` is safe).
   */
  async close(): Promise<void> {
    await this.pool.end();
    logger.info("[pgvector] pool closed");
  }

  /**
   * 1. Upsert document vectors (idempotent via `ON CONFLICT (chunk_id) DO UPDATE`).
   *
   * `chunk_id` is the logical TEXT primary key (`${documentId}-${chunkIndex}`)
   * — pgvector accepts arbitrary TEXT, unlike Qdrant's UUID constraint (F60).
   *
   * The `table` param is IGNORED (D-03 — LanceDB convention `ws_<id>`; pgvector
   * uses per-dim tables derived from `getDimension()`).
   */
  async addDocuments(table: string, documents: VectorDocument[]): Promise<void> {
    // table param is the LanceDB convention (ws_<id>); pgvector uses per-dim
    // tables derived from getDimension() (D-03).
    void table;
    if (documents.length === 0) return;

    // Safety cap: pg has a 65535-param limit; 8 params per row → ~8000 rows
    // max. Split into chunks of 1000 to stay well under the limit.
    const BATCH = 1000;
    for (let offset = 0; offset < documents.length; offset += BATCH) {
      const batch = documents.slice(offset, offset + BATCH);
      const values: (string | number | null)[] = [];
      const placeholders: string[] = [];
      let i = 1;
      for (const doc of batch) {
        values.push(
          doc.id,
          toPgVector(doc.values),
          doc.metadata.workspaceId,
          doc.metadata.documentId,
          doc.metadata.documentName,
          doc.metadata.chunkIndex,
          doc.metadata.chunkText ?? null,
          JSON.stringify(doc.metadata),
        );
        placeholders.push(
          `($${i}, $${i + 1}::vector, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}::jsonb)`,
        );
        i += 8;
      }
      const sql = `
        INSERT INTO ${this.tableName}
          (chunk_id, embedding, workspace_id, document_id, document_name, chunk_index, chunk_text, metadata)
        VALUES
          ${placeholders.join(", ")}
        ON CONFLICT (chunk_id) DO UPDATE SET
          embedding     = EXCLUDED.embedding,
          workspace_id = EXCLUDED.workspace_id,
          document_id  = EXCLUDED.document_id,
          document_name = EXCLUDED.document_name,
          chunk_index  = EXCLUDED.chunk_index,
          chunk_text   = EXCLUDED.chunk_text,
          metadata     = EXCLUDED.metadata;
      `;
      await withRetry(() => this.pool.query(sql, values), { maxRetries: 3, baseDelayMs: 500 });
    }

    logger.info(`[pgvector] Added ${documents.length} vectors to ${this.tableName}`);
  }

  /**
   * 2. kNN search with cosine similarity (D-09 — score = `1 - (embedding <=> query)`).
   *
   * `WHERE workspace_id = $1` is MANDATORY (cross-workspace leakage prevention,
   * defense-in-depth with server-side RBAC). The optional `documentId` filter
   * short-circuits via `($3::text IS NULL OR document_id = $3)`.
   *
   * 260830-ur9: optional RAG metadata pre-filters read from the filter object
   * (server-normalized HybridSearchFilters). Predicates are appended ONLY for
   * provided keys, as additional numbered params (index counter composes
   * dynamically — LIMIT position shifts accordingly):
   *   - documentTypes → `metadata->>'documentType' = ANY($n::text[])` binding
   *     the JS string[] directly (pg driver serializes text[]).
   *   - dateFrom/dateTo → lexicographic range on the JSONB-stamped full UTC
   *     ISO string `metadata->>'documentCreatedAt'` (chronologically correct
     *     because both sides are full UTC ISO strings — the ingest stamp and the
   *     server normalization both use toISOString). All bindings are
   *     parameterized $n (no string interpolation — T-260830-02).
   *
   * LIMITATION (orchestrator-accepted, 260830-ur9): legacy rows ingested
   * before stamping lack the metadata keys → `metadata->>'documentType'`
   * is NULL → they are EXCLUDED whenever a metadata filter is active. Legacy
   * docs regain filterability via admin re-embed (reembed re-stamps).
   *
   * `ORDER BY embedding <=> $2::vector` is the canonical kNN form the HNSW
   * `vector_cosine_ops` opclass accelerates (PV-02 SC3 EXPLAIN Index Scan).
   *
   * The `table` param is IGNORED (D-03).
   */
  async search(
    table: string,
    queryVector: number[],
    limit: number = 10,
    filter?: Record<string, any>,
  ): Promise<VectorSearchResult[]> {
    // table param is the LanceDB convention (ws_<id>); pgvector uses per-dim
    // tables derived from getDimension() (D-03).
    void table;
    const workspaceId: string = filter?.workspaceId;
    const documentId: string | null = filter?.documentId ?? null;
    const documentTypes: string[] | undefined = Array.isArray(filter?.documentTypes) && filter.documentTypes.length > 0
      ? filter.documentTypes
      : undefined;
    const dateFrom: string | undefined = typeof filter?.dateFrom === "string" ? filter.dateFrom : undefined;
    const dateTo: string | undefined = typeof filter?.dateTo === "string" ? filter.dateTo : undefined;

    if (documentTypes || dateFrom || dateTo) {
      logger.debug(
        `[pgvector] metadata pre-filter active` +
          `${documentTypes ? ` documentTypes=[${documentTypes.join(",")}]` : ""}` +
          `${dateFrom ? ` dateFrom=${dateFrom}` : ""}` +
          `${dateTo ? ` dateTo=${dateTo}` : ""} — legacy rows lacking stamps are excluded`,
      );
    }

    // Build the parameterized WHERE clauses in order; index counter composes
    // dynamically so LIMIT always points at the last param.
    const whereClauses: string[] = [
      "workspace_id = $1",
      "($3::text IS NULL OR document_id = $3)",
    ];
    const params: unknown[] = [workspaceId, toPgVector(queryVector), documentId, limit];
    let nextIdx = 5;

    let typesIdx: number | undefined;
    let fromIdx: number | undefined;
    let toIdx: number | undefined;
    if (documentTypes) {
      typesIdx = nextIdx++;
      params.splice(params.length - 1, 0, documentTypes);
    }
    if (dateFrom) {
      fromIdx = nextIdx++;
      params.splice(params.length - 1, 0, dateFrom);
    }
    if (dateTo) {
      toIdx = nextIdx++;
      params.splice(params.length - 1, 0, dateTo);
    }

    if (typesIdx !== undefined) {
      whereClauses.push(`metadata->>'documentType' = ANY($${typesIdx}::text[])`);
    }
    if (fromIdx !== undefined) {
      whereClauses.push(`metadata->>'documentCreatedAt' >= $${fromIdx}`);
    }
    if (toIdx !== undefined) {
      whereClauses.push(`metadata->>'documentCreatedAt' <= $${toIdx}`);
    }

    const limitIdx = params.length; // limit is always the LAST param
    const sql = `
      SELECT
        chunk_id,
        1 - (embedding <=> $2::vector) AS score,
        workspace_id,
        document_id,
        document_name,
        chunk_index,
        chunk_text,
        metadata
      FROM ${this.tableName}
      WHERE ${whereClauses.join("\n        AND ")}
      ORDER BY embedding <=> $2::vector
      LIMIT $${limitIdx};
    `;
    const result = await withRetry(
      () => this.pool.query(sql, params),
      { maxRetries: 3, baseDelayMs: 500 },
    );
    return result.rows.map((row: any) => ({
      id: row.chunk_id,
      score: Number(row.score),
      text: row.chunk_text ?? undefined,
      metadata: {
        documentId: row.document_id,
        workspaceId: row.workspace_id,
        documentName: row.document_name,
        chunkIndex: row.chunk_index,
        ...(row.metadata ?? {}),
      },
    }));
  }

  /**
   * 3. Delete by documentId (404-tolerant — DELETE on a non-existent row is a
   * SQL no-op, mirroring QdrantProvider's 404-as-success pattern).
   *
   * The interface signature does NOT pass `workspaceId` to this method
   * (matches QdrantProvider.deleteByDocumentId which filters by documentId
   * only — `documentId` is unique per workspace by contract).
   *
   * The `table` param is IGNORED (D-03).
   */
  async deleteByDocumentId(table: string, documentId: string): Promise<void> {
    void table;
    const sql = `DELETE FROM ${this.tableName} WHERE document_id = $1;`;
    await withRetry(() => this.pool.query(sql, [documentId]), { maxRetries: 3, baseDelayMs: 500 });
    logger.info(`[pgvector] Deleted vectors for document ${documentId} from ${this.tableName}`);
  }

  /**
   * 4. Delete by workspaceId (404-tolerant — DELETE on an empty table is a
   * SQL no-op).
   *
   * The `table` param is IGNORED (D-03).
   */
  async deleteByWorkspaceId(table: string, workspaceId: string): Promise<void> {
    void table;
    const sql = `DELETE FROM ${this.tableName} WHERE workspace_id = $1;`;
    await withRetry(() => this.pool.query(sql, [workspaceId]), { maxRetries: 3, baseDelayMs: 500 });
    logger.info(`[pgvector] Deleted vectors for workspace ${workspaceId} from ${this.tableName}`);
  }

  /**
   * 5. Retrieve all chunks for a document (metadata-only — no `embedding`
   * column selected, no vector query). Used by the server for FTS re-index
   * migration. `score: 0` mirrors QdrantProvider.getByDocumentId.
   *
   * `WHERE document_id = $1 AND workspace_id = $2` — workspace_id MANDATORY
   * (defense-in-depth RBAC, mirrors QdrantProvider).
   *
   * The `table` param is IGNORED (D-03).
   */
  async getByDocumentId(
    table: string,
    documentId: string,
    workspaceId: string,
  ): Promise<VectorSearchResult[]> {
    void table;
    const sql = `
      SELECT
        chunk_id,
        workspace_id,
        document_id,
        document_name,
        chunk_index,
        chunk_text,
        metadata
      FROM ${this.tableName}
      WHERE document_id = $1 AND workspace_id = $2;
    `;
    const result = await withRetry(
      () => this.pool.query(sql, [documentId, workspaceId]),
      { maxRetries: 3, baseDelayMs: 500 },
    );
    return result.rows.map((row: any) => ({
      id: row.chunk_id,
      score: 0,
      text: row.chunk_text ?? undefined,
      metadata: {
        documentId: row.document_id,
        workspaceId: row.workspace_id,
        documentName: row.document_name,
        chunkIndex: row.chunk_index,
        ...(row.metadata ?? {}),
      },
    }));
  }
}