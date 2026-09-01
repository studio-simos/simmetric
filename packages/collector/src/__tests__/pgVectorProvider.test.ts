// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for PgVectorProvider (Phase 91-03).
 *
 * Mocks `pg.Pool` (no real DB — integration tests are plan 91-04). Covers
 * the test matrix from RESEARCH §Q10:
 *   1. Table name derivation (`chunk_vectors_<dim>`)
 *   2. dim-mismatch BLOCK (declared 768, provider 384 → throw)
 *   3. dim-mismatch null (non-vector column → skip, no throw)
 *   4. Upsert SQL shape (ON CONFLICT + ::vector + ::jsonb)
 *   5. Search SQL + score math (1 - (embedding <=> $2::vector) AS score)
 *   6. Delete idempotency (DELETE FROM ... WHERE document_id = $1)
 *   7. getByDocumentId metadata-only (no embedding column, score: 0)
 *   8. Batch cap (1500 docs → 2 pool.query calls)
 *   9. close() → pool.end()
 *   10. registerTypes optional (import failure keeps module load crash-free)
 *
 * Mock strategy: jest.mock("pg") replaces the `Pool` constructor with a
 * factory returning a stubbed instance. Each test configures the stub's
 * `query` mock to return fixture rows and captures the SQL+params for
 * assertion. `getEmbeddingProvider` is mocked to return a fixed dim (384).
 */

// Mock the embeddings singleton BEFORE importing the provider so the
// module-scope `import("pgvector/pg")` loader and the `getEmbeddingProvider`
// calls both see the mock. Dim 384 is the canonical Xenova/all-MiniLM-L6-v2.
jest.mock("../services/embeddings", () => ({
  getEmbeddingProvider: jest.fn().mockResolvedValue({ getDimension: () => 384 }),
}));

// Mock pgvector/pg to throw ERR_REQUIRE_ESM by default — simulates the
// production `node dist` CJS path (D-07 refinement: vendor path is FIRST-CLASS).
jest.mock("pgvector/pg", () => {
  const err = new Error("Cannot find module 'pgvector/pg'");
  (err as any).code = "ERR_REQUIRE_ESM";
  throw err;
}, { virtual: true });

// Capture the Pool constructor + instance stubs so each test can configure
// `query`/`on`/`end` on the instance returned by `new Pool(...)`.
let poolInstance: { query: jest.Mock; on: jest.Mock; end: jest.Mock; options: any };
jest.mock("pg", () => {
  return {
    Pool: jest.fn().mockImplementation((config: any) => {
      poolInstance = {
        query: jest.fn(),
        on: jest.fn(),
        end: jest.fn().mockResolvedValue(undefined),
        options: config,
      };
      return poolInstance;
    }),
  };
});

import { PgVectorProvider } from "../services/pgVectorProvider";

// Helper: build a VectorDocument fixture with 384-dim values.
function makeDoc(id: string, workspaceId = "ws1", documentId = "doc1"): import("../services/vectorStore").VectorDocument {
  const values = new Array(384).fill(0.1);
  return {
    id,
    values,
    metadata: {
      documentId,
      workspaceId,
      documentName: "test.pdf",
      chunkIndex: 0,
      chunkText: "hello world",
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("PgVectorProvider.initialize() — auto-provisioning + dim-mismatch BLOCK", () => {
  test("1. derives table name from getEmbeddingProvider().getDimension() (chunk_vectors_384)", async () => {
    const p = new PgVectorProvider("postgres://test");
    poolInstance.query.mockResolvedValue({ rows: [{ column_type: "vector(384)" }] });
    await p.initialize();
    const sqls = poolInstance.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("chunk_vectors_384"))).toBe(true);
    expect(sqls.some((s) => s.includes("CREATE EXTENSION IF NOT EXISTS vector"))).toBe(true);
    expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS chunk_vectors_384"))).toBe(true);
    expect(sqls.some((s) => s.includes("USING hnsw (embedding vector_cosine_ops)"))).toBe(true);
    expect(sqls.some((s) => s.includes("WITH (m = 16, ef_construction = 64)"))).toBe(true);
  });

  test("2. throws on dim-mismatch (declared 768, provider 384) — D-05 fail-loud", async () => {
    const p = new PgVectorProvider("postgres://test");
    // format_type returns vector(768) for the dim-mismatch probe query.
    poolInstance.query.mockImplementation(async (sql: string) => {
      if (sql.includes("format_type")) {
        return { rows: [{ column_type: "vector(768)" }] };
      }
      return { rows: [] };
    });
    await expect(p.initialize()).rejects.toThrow(/dim-mismatch/);
    await expect(p.initialize()).rejects.toThrow(/768/);
    await expect(p.initialize()).rejects.toThrow(/384/);
  });

  test("3. skips dim-mismatch check when column is non-vector (parseVectorDim → null = absence, not mismatch)", async () => {
    const p = new PgVectorProvider("postgres://test");
    poolInstance.query.mockImplementation(async (sql: string) => {
      if (sql.includes("format_type")) {
        return { rows: [{ column_type: "integer" }] };
      }
      return { rows: [] };
    });
    await expect(p.initialize()).resolves.toBeUndefined();
  });
});

describe("PgVectorProvider.addDocuments — upsert SQL shape", () => {
  test("4. emits ON CONFLICT (chunk_id) DO UPDATE + ::vector + ::jsonb casts + toPgVector values", async () => {
    const p = new PgVectorProvider("postgres://test");
    poolInstance.query.mockResolvedValue({ rows: [{ column_type: "vector(384)" }] });
    await p.initialize();
    poolInstance.query.mockClear();

    const doc = makeDoc("doc1-0");
    await p.addDocuments("ws_test", [doc]);

    expect(poolInstance.query).toHaveBeenCalledTimes(1);
    const [sql, params] = poolInstance.query.mock.calls[0]!;
    expect(String(sql)).toContain("INSERT INTO chunk_vectors_384");
    expect(String(sql)).toContain("ON CONFLICT (chunk_id) DO UPDATE SET");
    expect(String(sql)).toContain("::vector");
    expect(String(sql)).toContain("::jsonb");
    // First param is chunk_id, second is the toPgVector string "[0.1,0.1,...]"
    expect(params[0]).toBe("doc1-0");
    expect(typeof params[1]).toBe("string");
    expect(params[1] as string).toMatch(/^\[.*\]$/);
  });

  test("8. splits batches >1000 docs into multiple pool.query calls (batch cap)", async () => {
    const p = new PgVectorProvider("postgres://test");
    poolInstance.query.mockResolvedValue({ rows: [{ column_type: "vector(384)" }] });
    await p.initialize();
    poolInstance.query.mockClear();

    const docs = Array.from({ length: 1500 }, (_, i) => makeDoc(`doc-${i}`));
    await p.addDocuments("ws_test", docs);
    // 1500 / 1000 = 2 batches
    expect(poolInstance.query).toHaveBeenCalledTimes(2);
  });
});

describe("PgVectorProvider.search — cosine SQL + score math", () => {
  async function makeProvider(): Promise<PgVectorProvider> {
    const p = new PgVectorProvider("postgres://test");
    poolInstance.query.mockResolvedValue({ rows: [{ column_type: "vector(384)" }] });
    await p.initialize();
    return p;
  }

  test("5. emits score = 1 - (embedding <=> $2::vector) AS score + mandatory workspace_id filter + ORDER BY + LIMIT", async () => {
    const p = new PgVectorProvider("postgres://test");
    poolInstance.query.mockResolvedValue({ rows: [{ column_type: "vector(384)" }] });
    await p.initialize();
    poolInstance.query.mockClear();

    poolInstance.query.mockResolvedValue({
      rows: [
        {
          chunk_id: "doc1-0",
          score: 0.85,
          workspace_id: "ws1",
          document_id: "doc1",
          document_name: "test.pdf",
          chunk_index: 0,
          chunk_text: "hello",
          metadata: { pageNumber: 1 },
        },
      ],
    });

    const results = await p.search("ws_test", [0.1, 0.2, 0.3], 10, { workspaceId: "ws1" });
    const [sql, params] = poolInstance.query.mock.calls[0]!;
    expect(String(sql)).toContain("1 - (embedding <=> $2::vector) AS score");
    expect(String(sql)).toContain("WHERE workspace_id = $1");
    expect(String(sql)).toContain("ORDER BY embedding <=> $2::vector");
    expect(String(sql)).toContain("LIMIT $4");
    expect(params[0]).toBe("ws1"); // workspace_id mandatory filter
    expect(params[1]).toMatch(/^\[.*\]$/); // toPgVector query vector
    expect(params[2]).toBeNull(); // documentId filter null short-circuit
    expect(params[3]).toBe(10); // limit
    // Result mapping
    expect(results[0]!.id).toBe("doc1-0");
    expect(results[0]!.score).toBe(0.85);
    expect(results[0]!.metadata.documentId).toBe("doc1");
    expect(results[0]!.metadata.pageNumber).toBe(1);
    expect(results[0]!.text).toBe("hello");
  });

  // ─── 260830-ur9: metadata pre-filter predicates ───────────────────────────

  test("ur9-a. documentTypes + date range -> parameterized JSONB predicates with correct $n binding order and shifted limit position", async () => {
    const p = await makeProvider();
    poolInstance.query.mockClear();
    poolInstance.query.mockResolvedValue({ rows: [] });

    await p.search("ws_test", [0.1, 0.2, 0.3], 7, {
      workspaceId: "ws1",
      documentTypes: ["pdf", "md"],
      dateFrom: "2025-01-15T00:00:00.000Z",
      dateTo: "2025-06-01T23:59:59.999Z",
    });

    const [sql, params] = poolInstance.query.mock.calls[0]!;
    const sqlStr = String(sql);
    // documentType IN-list on the JSONB metadata column, bound as a text[] param.
    expect(sqlStr).toContain("metadata->>'documentType' = ANY(");
    // Lexicographic ISO date range on documentCreatedAt.
    expect(sqlStr).toContain("metadata->>'documentCreatedAt' >=");
    expect(sqlStr).toContain("metadata->>'documentCreatedAt' <=");
    // All new values bound as $n params (no string interpolation).
    expect(params).toContainEqual(["pdf", "md"]);
    expect(params).toContainEqual("2025-01-15T00:00:00.000Z");
    expect(params).toContainEqual("2025-06-01T23:59:59.999Z");
    // Param order: $1 workspaceId, $2 vector, $3 documentId, $4 types, $5 from, $6 to, $7 limit.
    expect(params[0]).toBe("ws1");
    expect(params[2]).toBeNull();
    expect(params[3]).toEqual(["pdf", "md"]);
    expect(params[4]).toBe("2025-01-15T00:00:00.000Z");
    expect(params[5]).toBe("2025-06-01T23:59:59.999Z");
    expect(params[6]).toBe(7);
    // LIMIT placeholder must shift accordingly.
    expect(sqlStr).toContain("LIMIT $7");
  });

  test("ur9-b. only dateFrom present -> single date predicate, limit param shifts to $5", async () => {
    const p = await makeProvider();
    poolInstance.query.mockClear();
    poolInstance.query.mockResolvedValue({ rows: [] });

    await p.search("ws_test", [0.1, 0.2, 0.3], 3, {
      workspaceId: "ws1",
      dateFrom: "2025-01-15T00:00:00.000Z",
    });

    const [sql, params] = poolInstance.query.mock.calls[0]!;
    const sqlStr = String(sql);
    expect(sqlStr).toContain("metadata->>'documentCreatedAt' >=");
    expect(sqlStr).not.toContain("metadata->>'documentType'");
    expect(params).toContainEqual("2025-01-15T00:00:00.000Z");
    expect(sqlStr).toContain("LIMIT $5");
    expect(params[4]).toBe(3);
  });

  test("ur9-c. documentTypes only -> type predicate, no date predicates", async () => {
    const p = await makeProvider();
    poolInstance.query.mockClear();
    poolInstance.query.mockResolvedValue({ rows: [] });

    await p.search("ws_test", [0.1, 0.2, 0.3], 3, {
      workspaceId: "ws1",
      documentTypes: ["csv"],
    });

    const [sql, params] = poolInstance.query.mock.calls[0]!;
    const sqlStr = String(sql);
    expect(sqlStr).toContain("metadata->>'documentType' = ANY(");
    expect(sqlStr).not.toContain("metadata->>'documentCreatedAt'");
    expect(params[3]).toEqual(["csv"]);
    expect(sqlStr).toContain("LIMIT $5");
    expect(params[4]).toBe(3);
  });

  test("ur9-d. no filters -> exact current SQL (no metadata predicates, LIMIT $4)", async () => {
    const p = await makeProvider();
    poolInstance.query.mockClear();
    poolInstance.query.mockResolvedValue({ rows: [] });

    await p.search("ws_test", [0.1, 0.2, 0.3], 10, { workspaceId: "ws1" });

    const [sql, params] = poolInstance.query.mock.calls[0]!;
    const sqlStr = String(sql);
    expect(String(sql)).toContain("WHERE workspace_id = $1");
    expect(sqlStr).not.toContain("metadata->>'documentType'");
    expect(sqlStr).not.toContain("metadata->>'documentCreatedAt'");
    expect(sqlStr).toContain("LIMIT $4");
    expect(params[3]).toBe(10);
  });
});

describe("PgVectorProvider delete + getByDocumentId", () => {
  test("6. deleteByDocumentId emits DELETE FROM chunk_vectors_384 WHERE document_id = $1 (404-tolerant — no throw on 0 rows)", async () => {
    const p = new PgVectorProvider("postgres://test");
    poolInstance.query.mockResolvedValue({ rows: [{ column_type: "vector(384)" }] });
    await p.initialize();
    poolInstance.query.mockClear();

    poolInstance.query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(p.deleteByDocumentId("ws_test", "doc1")).resolves.toBeUndefined();
    const [sql, params] = poolInstance.query.mock.calls[0]!;
    expect(String(sql)).toContain("DELETE FROM chunk_vectors_384");
    expect(String(sql)).toContain("WHERE document_id = $1");
    expect(params[0]).toBe("doc1");
  });

  test("7. getByDocumentId metadata-only (no embedding column in SELECT) + score: 0 + WHERE document_id = $1 AND workspace_id = $2", async () => {
    const p = new PgVectorProvider("postgres://test");
    poolInstance.query.mockResolvedValue({ rows: [{ column_type: "vector(384)" }] });
    await p.initialize();
    poolInstance.query.mockClear();

    poolInstance.query.mockResolvedValue({
      rows: [
        {
          chunk_id: "doc1-0",
          workspace_id: "ws1",
          document_id: "doc1",
          document_name: "test.pdf",
          chunk_index: 0,
          chunk_text: "hello",
          metadata: { pageNumber: 1 },
        },
      ],
    });

    const results = await p.getByDocumentId("ws_test", "doc1", "ws1");
    const [sql, params] = poolInstance.query.mock.calls[0]!;
    // metadata-only: NO `embedding` column in SELECT
    expect(String(sql)).not.toContain("embedding");
    expect(String(sql)).toContain("WHERE document_id = $1 AND workspace_id = $2");
    expect(params[0]).toBe("doc1");
    expect(params[1]).toBe("ws1");
    // score: 0 mirrors QdrantProvider.getByDocumentId
    expect(results[0]!.score).toBe(0);
    expect(results[0]!.metadata.documentId).toBe("doc1");
  });
});

describe("PgVectorProvider.close", () => {
  test("9. close() calls pool.end() once", async () => {
    const p = new PgVectorProvider("postgres://test");
    await p.close();
    expect(poolInstance.end).toHaveBeenCalledTimes(1);
  });
});

describe("D-07 ESM-safety — registerTypes optional dev-only", () => {
  test("10. module loads without crashing when pgvector/pg import throws ERR_REQUIRE_ESM (vendor path FIRST-CLASS)", async () => {
    // The jest.mock("pgvector/pg", { virtual: true }) above throws when
    // imported. The module-scope `import("pgvector/pg").catch(...)` in
    // pgVectorProvider.ts must absorb the error and keep `registerTypesFn`
    // null so the Pool is constructed WITHOUT an `onConnect` hook (vendor
    // path used). Re-import the module fresh to exercise the loader.
    jest.resetModules();
    // Re-apply the mocks after resetModules.
    jest.doMock("../services/embeddings", () => ({
      getEmbeddingProvider: jest.fn().mockResolvedValue({ getDimension: () => 384 }),
    }));
    jest.doMock("pgvector/pg", () => {
      const err = new Error("Cannot find module 'pgvector/pg'");
      (err as any).code = "ERR_REQUIRE_ESM";
      throw err;
    }, { virtual: true });
    jest.doMock("pg", () => ({
      Pool: jest.fn().mockImplementation((config: any) => {
        poolInstance = {
          query: jest.fn(),
          on: jest.fn(),
          end: jest.fn().mockResolvedValue(undefined),
          options: config,
        };
        return poolInstance;
      }),
    }));

    // Dynamic re-import — if the module-scope loader crashes, this throws.
    const mod = await import("../services/pgVectorProvider");
    expect(mod.PgVectorProvider).toBeDefined();

    // Construct a provider — `onConnect` must NOT be in the Pool config
    // (vendor path active because registerTypesFn is null).
    new mod.PgVectorProvider("postgres://test");
    expect(poolInstance.options.onConnect).toBeUndefined();
    expect(poolInstance.options.connectionString).toBe("postgres://test");
  });
});