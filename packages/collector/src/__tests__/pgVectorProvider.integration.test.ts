// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Integration tests for PgVectorProvider against real PostgreSQL + pgvector
 * extension (Phase 91-04, PV-01 SC2 + PV-02 SC3).
 *
 * These tests require a REAL PostgreSQL with the pgvector extension running on
 * port 5433 (dedicated `pgvector_test` DB — NEVER 5432, NEVER the main dev DB;
 * see Pitfall 4 `integration-harness-maindb-leak`). Operator starts the
 * service before running:
 *
 *   docker run -d -p 5433:5432 \
 *     -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_DB=pgvector_test \
 *     pgvector/pgvector:pg16
 *
 * When PG + pgvector is UNAVAILABLE, the entire suite SKIPS via a
 * `describe.skip` gate — the jest output shows skipped tests (NOT false
 * passes, NOT silent fails). The `PG_AVAILABLE` flag is set by
 * `integration-globalSetup.cjs` which probes the port + extension before any
 * test file loads.
 *
 * Test matrix (RESEARCH §Q10):
 *   1. Upsert → search → delete end-to-end (PV-01 SC2)
 *   2. EXPLAIN Index Scan using HNSW (NOT Seq Scan) with >200 rows (PV-02 SC3
 *      HIGHEST RISK — Pitfall 1 silent Seq Scan closed)
 *   3. dim-mismatch BLOCK on real schema via ALTER TABLE (PV-02 SC3 — D-05
 *      fail-loud verified end-to-end, NOT just mock)
 *   4. Upsert idempotency via ON CONFLICT (chunk_id) DO UPDATE
 *
 * `getEmbeddingProvider` is mocked to return dim 384 (default
 * `Xenova/all-MiniLM-L6-v2`) — avoids loading the heavy Xenova pipeline
 * (5-30s model load) which is orthogonal to the pgvector provider behavior
 * under test. The mock controls the table name derivation
 * (`chunk_vectors_384`); the PG queries themselves are REAL (no mock on
 * `pg.Pool`).
 */

import { Pool } from "pg";
import { PgVectorProvider } from "../services/pgVectorProvider";
import { toPgVector } from "../utils/pgvectorHelper";

// Mock getEmbeddingProvider to avoid loading the Xenova model (slow, requires
// @xenova/transformers cache). The mock returns dim 384 so the provider
// derives table name `chunk_vectors_384`. This is a unit-test-style mock on
// the embedding factory ONLY — the pg.Pool and all SQL are real.
jest.mock("../services/embeddings", () => ({
  getEmbeddingProvider: jest.fn().mockResolvedValue({
    getDimension: () => 384,
    embed: jest.fn(),
    getModelName: () => "Xenova/all-MiniLM-L6-v2",
  }),
}));

const PG_AVAILABLE = process.env.PGVECTOR_AVAILABLE === "true";
const TEST_URL = process.env.PGVECTOR_TEST_URL!;

/** Generate a random unit-normalized vector of the given dimension. */
function makeRandomVector(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random());
}

/**
 * Integration suite — gated on PG availability. When PG+pgvector is not
 * reachable on port 5433, `describe.skip` renders the suite as skipped in the
 * jest output with a clear reason (NOT a false pass).
 */
(PG_AVAILABLE ? describe : describe.skip)(
  "PgVectorProvider integration (real PG + pgvector, port 5433)",
  () => {
    let provider: PgVectorProvider;
    let pool: Pool;

    beforeAll(async () => {
      provider = new PgVectorProvider(TEST_URL);
      // initialize() auto-provisions: CREATE EXTENSION + CREATE TABLE
      // chunk_vectors_384 + HNSW index (D-06 lazy auto-provisioning).
      await provider.initialize();
      pool = new Pool({ connectionString: TEST_URL });
    });

    afterAll(async () => {
      // Drop the per-dim table so the next run starts clean (idempotent).
      try {
        await pool?.query("DROP TABLE IF EXISTS chunk_vectors_384 CASCADE");
      } catch (_) {
        /* ignore — table may already be gone (dim-mismatch test drops it) */
      }
      try {
        await provider?.close();
      } catch (_) {
        /* ignore */
      }
      try {
        await pool?.end();
      } catch (_) {
        /* ignore */
      }
    });

    afterEach(async () => {
      // Truncate between tests for data isolation (table schema persists).
      try {
        await pool?.query("TRUNCATE chunk_vectors_384");
      } catch (_) {
        /* ignore — table may be in altered state (dim-mismatch test) */
      }
    });

    // -----------------------------------------------------------------
    // Test 1 — Upsert → search → delete end-to-end (PV-01 SC2)
    // -----------------------------------------------------------------
    it("upsert → search → delete round-trip end-to-end", async () => {
      const wsId = "ws_e2e_test";
      await provider.addDocuments(wsId, [
        {
          id: "doc1-0",
          values: makeRandomVector(384),
          metadata: {
            documentId: "doc1",
            workspaceId: wsId,
            documentName: "test.pdf",
            chunkIndex: 0,
            chunkText: "hello world",
          },
        },
      ]);

      const results = await provider.search(wsId, makeRandomVector(384), 10, {
        workspaceId: wsId,
      });
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe("doc1-0");
      expect(results[0]!.metadata.documentId).toBe("doc1");
      expect(results[0]!.metadata.chunkText).toBe("hello world");
      // D-09: cosine similarity score in [0, 1] (higher = better).
      expect(results[0]!.score).toBeGreaterThanOrEqual(0);
      expect(results[0]!.score).toBeLessThanOrEqual(1);

      // Delete by documentId (404-tolerant — no-op on missing rows).
      await provider.deleteByDocumentId(wsId, "doc1");
      const afterDelete = await provider.search(
        wsId,
        makeRandomVector(384),
        10,
        { workspaceId: wsId },
      );
      expect(afterDelete.length).toBe(0);
    });

    // -----------------------------------------------------------------
    // Test 2 — EXPLAIN Index Scan (HNSW, NOT Seq Scan) (PV-02 SC3 HIGHEST RISK)
    // -----------------------------------------------------------------
    it("uses HNSW Index Scan (not Seq Scan) for kNN search with >200 rows", async () => {
      // Seed >200 rows — the PG planner picks Seq Scan for tiny tables and
      // only switches to Index Scan once table statistics suggest it. We
      // insert 250 rows (well above the threshold) and ANALYZE so the planner
      // has up-to-date statistics. This is the HIGHEST RISK Pitfall 1 guard:
      // a silent Seq Scan means HNSW was never built or the planner can't see
      // it — the provider would still "work" but RAG would be O(n) slow.
      const wsId = "ws_explain";
      for (let i = 0; i < 250; i++) {
        await provider.addDocuments(wsId, [
          {
            id: `doc-explain-${i}-0`,
            values: makeRandomVector(384),
            metadata: {
              documentId: `doc-explain-${i}`,
              workspaceId: wsId,
              documentName: "test",
              chunkIndex: 0,
            },
          },
        ]);
      }
      // Refresh planner statistics so the HNSW index is considered.
      await pool.query("ANALYZE chunk_vectors_384");

      const queryVec = toPgVector(makeRandomVector(384));
      const explain = await pool.query(
        `EXPLAIN (FORMAT TEXT) SELECT chunk_id FROM chunk_vectors_384
         WHERE workspace_id = $1
         ORDER BY embedding <=> $2::vector LIMIT 10`,
        [wsId, queryVec],
      );
      const plan = explain.rows
        .map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"])
        .join("\n");

      // PV-02 SC3: MUST use the HNSW index, NOT a sequential scan.
      expect(plan).toMatch(/Index Scan using chunk_vectors_384_embedding_hnsw/);
      expect(plan).not.toMatch(/Seq Scan/);

      // Cleanup the 250-row dataset.
      await provider.deleteByWorkspaceId(wsId, wsId);
    });

    // -----------------------------------------------------------------
    // Test 4 — Upsert idempotency (ON CONFLICT DO UPDATE)
    // -----------------------------------------------------------------
    it("upsert is idempotent — same chunk_id overwrites (no duplicates)", async () => {
      const wsId = "ws_idem";
      // First insert.
      await provider.addDocuments(wsId, [
        {
          id: "doc-idem-0",
          values: makeRandomVector(384),
          metadata: {
            documentId: "doc-idem",
            workspaceId: wsId,
            documentName: "v1",
            chunkIndex: 0,
            chunkText: "first",
          },
        },
      ]);
      // Second insert — same chunk_id, different metadata (EXCLUDED applied).
      await provider.addDocuments(wsId, [
        {
          id: "doc-idem-0",
          values: makeRandomVector(384),
          metadata: {
            documentId: "doc-idem",
            workspaceId: wsId,
            documentName: "v2",
            chunkIndex: 0,
            chunkText: "second",
          },
        },
      ]);

      const results = await provider.getByDocumentId(wsId, "doc-idem", wsId);
      // ON CONFLICT (chunk_id) DO UPDATE — exactly 1 row, no duplicates.
      expect(results.length).toBe(1);
      // EXCLUDED metadata applied (v2 overwrote v1).
      expect(results[0]!.metadata.documentName).toBe("v2");
      expect(results[0]!.metadata.chunkText).toBe("second");

      await provider.deleteByWorkspaceId(wsId, wsId);
    });

    // -----------------------------------------------------------------
    // Test 3 — dim-mismatch BLOCK on real schema (PV-02 SC3 — D-05 fail-loud)
    // -----------------------------------------------------------------
    // Runs LAST because it ALTERs the shared `chunk_vectors_384` table to
    // simulate a model swap without a table drop (the exact scenario D-05
    // protects against). Approach (a) per critical_constraints #3: ALTER
    // TABLE ALTER COLUMN embedding TYPE vector(768) — NO `dimOverride`
    // backdoor in the provider (a backdoor would break the fail-loud
    // contract). After the test, the table is dropped; the outer afterAll
    // handles the final cleanup idempotently.
    describe("dim-mismatch BLOCK (D-05) — real schema via ALTER TABLE", () => {
      beforeAll(async () => {
        // TRUNCATE first — ALTER TYPE fails if existing rows can't be cast
        // (384-dim vectors can't be cast to 768-dim).
        await pool.query("TRUNCATE chunk_vectors_384");
        // Simulate a model swap: the table was created as vector(384), then
        // someone (or a migration) altered the column to vector(768) WITHOUT
        // dropping the table. The provider (dim 384 via mock) routes to
        // chunk_vectors_384, finds the column is vector(768), and MUST throw.
        await pool.query(
          "ALTER TABLE chunk_vectors_384 ALTER COLUMN embedding TYPE vector(768)",
        );
      });

      afterAll(async () => {
        // Drop the mismatched table — the outer afterAll will also try to
        // drop (idempotent). The table is now in a bad state (768-dim column
        // with a 384-dim provider) and should not be reused.
        await pool.query("DROP TABLE IF EXISTS chunk_vectors_384 CASCADE");
      });

      it("throws on dim-mismatch: table vector(768) ≠ provider dim 384", async () => {
        const badProvider = new PgVectorProvider(TEST_URL);
        // initialize() reads format_type(atttypid, atttypmod) → vector(768),
        // parseVectorDim → 768, compares with getDimension() → 384, throws.
        // D-05 fail-loud: NEVER silent re-embed, NEVER fallback.
        await expect(badProvider.initialize()).rejects.toThrow(/dim-mismatch/);
        // Verify the error message references both dims (actionable diagnostic).
        await expect(badProvider.initialize()).rejects.toThrow(/768/);
        await expect(badProvider.initialize()).rejects.toThrow(/384/);
        // Verify NO row was inserted (the throw happened before any upsert).
        const count = await pool.query(
          "SELECT count(*)::int AS c FROM chunk_vectors_384",
        );
        expect(count.rows[0].c).toBe(0);
        // Close the pool of the failed provider (it constructed a Pool but
        // initialize threw before any query; pool still needs draining).
        await badProvider.close();
      });
    });
  },
);