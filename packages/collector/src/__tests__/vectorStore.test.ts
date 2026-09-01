// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * QdrantProvider search tests — missing collection must degrade to empty
 * results, not a fatal error. Mirrors LanceDBProvider behavior so a workspace
 * with no ingested documents does not trigger 3 wasted retries + a 500.
 */
const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
const mockAxiosPut = jest.fn();
jest.mock("axios", () => ({
  get: (...args: any[]) => mockAxiosGet(...args),
  post: (...args: any[]) => mockAxiosPost(...args),
  put: (...args: any[]) => mockAxiosPut(...args),
}));

// Mock env so the collector doesn't process.exit(1) on missing COLLECTOR_SECRET
// and getVectorStore falls back to the qdrant provider via env vars.
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_PORT: 3210,
    COLLECTOR_URL: "http://localhost:3210",
    SERVER_URL: "http://localhost:3000",
    VECTOR_DB_PROVIDER: "qdrant",
    VECTOR_DB_URL: "http://localhost:6333",
    VECTOR_DB_API_KEY: "",
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    OLLAMA_BASE_URL: "http://localhost:11434",
    STORAGE_PATH: "./storage",
    COLLECTOR_SECRET: "test-secret-for-unit-tests",
  })),
  clearEnvCache: jest.fn(),
}));

describe("QdrantProvider search on missing collection", () => {
  beforeEach(() => {
    jest.resetModules();
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    // fetchVectorDbConfig calls axios.get — reject so we fall back to env config.
    mockAxiosGet.mockRejectedValue(new Error("test: no server available"));
  });

  it("returns [] when the collection does not exist (404)", async () => {
    // First (and only) POST /points/search → 404, collection absent.
    mockAxiosPost.mockRejectedValue({ response: { status: 404 } });

    const { getVectorStore } = await import("../services/vectorStore");
    const store = await getVectorStore();

    const results = await store.search("workspace_x", [0.1, 0.2, 0.3], 5, {
      workspaceId: "workspace_x",
    });

    expect(results).toEqual([]);
    // The 404 must NOT be retried — a missing collection won't appear on retry.
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it("propagates transient (non-404) errors after retries", async () => {
    // 500 is transient — withRetry will attempt it maxRetries+1 times before throwing.
    mockAxiosPost.mockRejectedValue({ response: { status: 500 } });

    const { getVectorStore } = await import("../services/vectorStore");
    const store = await getVectorStore();

    await expect(
      store.search("workspace_x", [0.1, 0.2, 0.3], 5, { workspaceId: "workspace_x" }),
    ).rejects.toThrow();

    // 1 initial + 3 retries = 4 attempts for a transient error.
    expect(mockAxiosPost).toHaveBeenCalledTimes(4);
  });
});

describe("LanceDB error-string probe", () => {
  // Captures the real error strings thrown by @lancedb/lancedb@0.31.0 for the
  // two race-relevant paths: openTable on a missing table, and createTable on
  // an already-existing table. The captured strings feed the isTableMissing /
  // isAlreadyExists predicates in LanceDBProvider.ensureTable (Task 2).
  //
  // If the native binding cannot be loaded in the test environment, both
  // tests skip and Task 2 falls back to generic substring matching
  // (includes("not found") / includes("already exists")).

  let tmpDir: string;

  beforeAll(() => {
    const os = require("os");
    const path = require("path");
    tmpDir = path.join(os.tmpdir(), "lancedb-probe-" + Date.now());
  });

  afterAll(() => {
    const fs = require("fs");
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("openTable on a nonexistent table throws a catchable error with inspectable properties", async () => {
    let connect: any;
    try {
      const lancedb = await import("@lancedb/lancedb");
      connect = lancedb.connect;
    } catch {
      console.log("openTable probe skipped: @lancedb/lancedb native binding unavailable");
      return; // skip — Task 2 falls back to generic substring matching
    }

    const db = await connect(tmpDir);
    let caught: any = null;
    try {
      await db.openTable("nonexistent_table");
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    // Log the real strings for Task 2 predicate construction.
    console.log("openTable not-found:", caught?.message, caught?.name, caught?.code);
    expect(typeof caught?.message).toBe("string");
    expect(caught.message.length).toBeGreaterThan(0);
  });

  it("createTable on an existing table throws a catchable error with inspectable properties", async () => {
    let connect: any;
    try {
      const lancedb = await import("@lancedb/lancedb");
      connect = lancedb.connect;
    } catch {
      console.log("createTable probe skipped: @lancedb/lancedb native binding unavailable");
      return; // skip — Task 2 falls back to generic substring matching
    }

    const db = await connect(tmpDir);
    // First create succeeds.
    await db.createTable("existing", [{ id: "1", vector: [0.1, 0.2] }]);

    let caught: any = null;
    try {
      // Second create races with the first → "already exists".
      await db.createTable("existing", [{ id: "2", vector: [0.3, 0.4] }]);
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    console.log("createTable already-exists:", caught?.message, caught?.name, caught?.code);
    expect(typeof caught?.message).toBe("string");
    expect(caught.message.length).toBeGreaterThan(0);
  });
});

describe("LanceDBProvider ensureTable", () => {
  // Tests the idempotent ensureTable path in LanceDBProvider.addDocuments.
  // Mirrors QdrantProvider.ensureCollection: openTable → on "not found" →
  // createTable → on "already exists" (409 race) → openTable + add. The loser
  // of a concurrent create race must NOT drop its records.
  //
  // Mocks @lancedb/lancedb (embedded library) — no real disk I/O. The probe
  // test above captured the real error strings; these tests use those strings
  // to verify the isTableMissing / isAlreadyExists predicates match correctly.

  let mockOpenTable: jest.Mock;
  let mockCreateTable: jest.Mock;
  let mockAdd: jest.Mock;
  let mockTable: { add: jest.Mock };

  beforeEach(() => {
    jest.resetModules();

    mockAdd = jest.fn().mockResolvedValue(undefined);
    mockTable = { add: mockAdd };
    mockOpenTable = jest.fn();
    mockCreateTable = jest.fn();

    jest.doMock("@lancedb/lancedb", () => ({
      connect: jest.fn().mockResolvedValue({
        openTable: mockOpenTable,
        createTable: mockCreateTable,
      }),
    }));

    // Env: force LanceDB provider, no server config fetch.
    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => ({
        COLLECTOR_PORT: 3210,
        COLLECTOR_URL: "http://localhost:3210",
        SERVER_URL: "http://localhost:3000",
        VECTOR_DB_PROVIDER: "lancedb",
        VECTOR_DB_URL: "",
        VECTOR_DB_API_KEY: "",
        EMBEDDING_PROVIDER: "local",
        EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
        OLLAMA_BASE_URL: "http://localhost:11434",
        STORAGE_PATH: "./storage",
        COLLECTOR_SECRET: "test-secret-for-unit-tests",
      })),
      clearEnvCache: jest.fn(),
    }));

    // axios.get (fetchVectorDbConfig) → reject so we fall back to env.
    jest.doMock("axios", () => ({
      get: jest.fn().mockRejectedValue(new Error("test: no server available")),
      post: jest.fn(),
      put: jest.fn(),
    }));
  });

  const importStore = async () => {
    const { getVectorStore } = await import("../services/vectorStore");
    return getVectorStore();
  };

  const sampleDocs = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      values: [0.1, 0.2, 0.3],
      metadata: {
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentName: "race.md",
        chunkIndex: 0,
        chunkText: "hello",
      },
    },
  ];

  it("happy path: table exists → openTable + add, no createTable", async () => {
    mockOpenTable.mockResolvedValue(mockTable);

    const store = await importStore();
    await store.addDocuments("ws_1", sampleDocs);

    expect(mockOpenTable).toHaveBeenCalledTimes(1);
    expect(mockCreateTable).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledTimes(1);
    // Records are not dropped — add receives the full record set.
    expect(mockAdd).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: sampleDocs[0]!.id, documentId: "doc-1" }),
      ]),
    );
  });

  it("table missing: openTable throws 'not found' → createTable → records added", async () => {
    // Real LanceDB error string captured by the probe test.
    mockOpenTable.mockRejectedValue(
      Object.assign(new Error("Table 'ws_1' was not found  Caused by: Dataset at path ... was not found"), {
        code: "GenericFailure",
      }),
    );
    mockCreateTable.mockResolvedValue(mockTable);

    const store = await importStore();
    await store.addDocuments("ws_1", sampleDocs);

    expect(mockOpenTable).toHaveBeenCalledTimes(1);
    expect(mockCreateTable).toHaveBeenCalledTimes(1);
    // createTable receives the records (first creator wins, records stored).
    expect(mockCreateTable).toHaveBeenCalledWith(
      "ws_1",
      expect.arrayContaining([expect.objectContaining({ id: sampleDocs[0]!.id })]),
    );
  });

  it("409 race: openTable 'not found' → createTable 'already exists' → openTable + add (records NOT dropped)", async () => {
    // The loser of a concurrent create race: openTable says missing, createTable
    // says already exists (another caller won), must fall back to openTable + add.
    mockOpenTable
      .mockRejectedValueOnce(
        Object.assign(new Error("Table 'ws_1' was not found  Caused by: Dataset ... was not found"), {
          code: "GenericFailure",
        }),
      )
      .mockResolvedValueOnce(mockTable); // second openTable succeeds
    mockCreateTable.mockRejectedValue(
      Object.assign(new Error("Table 'ws_1' already exists"), { code: "GenericFailure" }),
    );

    const store = await importStore();
    await store.addDocuments("ws_1", sampleDocs);

    // openTable called twice (first fails, second succeeds after 409).
    expect(mockOpenTable).toHaveBeenCalledTimes(2);
    expect(mockCreateTable).toHaveBeenCalledTimes(1);
    // CRITICAL: the loser's records are NOT dropped — add is called on the
    // fallback openTable handle.
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: sampleDocs[0]!.id })]),
    );
  });

  it("unrelated error: openTable throws non-'not found' → ensureTable re-throws (not masked)", async () => {
    const unrelated = Object.assign(new Error("Permission denied: cannot read table"), {
      code: "GenericFailure",
    });
    mockOpenTable.mockRejectedValue(unrelated);

    const store = await importStore();
    await expect(store.addDocuments("ws_1", sampleDocs)).rejects.toThrow(/Permission denied/);

    expect(mockCreateTable).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

/**
 * 260830-ur9 — RAG metadata filter pre-filter tests.
 * Three describe blocks below (Qdrant must-clauses, LanceDB degrade).
 * Keep the existing suites untouched (byte-identity spot checks rely on
 * the original shapes).
 */
describe("QdrantProvider search metadata pre-filters (260830-ur9)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => ({
        COLLECTOR_PORT: 3210,
        COLLECTOR_URL: "http://localhost:3210",
        SERVER_URL: "http://localhost:3000",
        VECTOR_DB_PROVIDER: "qdrant",
        VECTOR_DB_URL: "http://localhost:6333",
        VECTOR_DB_API_KEY: "",
        EMBEDDING_PROVIDER: "local",
        EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
        OLLAMA_BASE_URL: "http://localhost:11434",
        STORAGE_PATH: "./storage",
        COLLECTOR_SECRET: "test-secret-for-unit-tests",
      })),
      clearEnvCache: jest.fn(),
    }));
    jest.doMock("axios", () => ({
      get: (...args: any[]) => mockAxiosGet(...args),
      post: (...args: any[]) => mockAxiosPost(...args),
      put: (...args: any[]) => mockAxiosPut(...args),
    }));
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    mockAxiosPut.mockReset();
    mockAxiosGet.mockRejectedValue(new Error("test: no server available"));
  });

  const importQdrantStore = async () => {
    const { getVectorStore } = await import("../services/vectorStore");
    return getVectorStore();
  };

  it("documentTypes -> one must clause with match.any", async () => {
    mockAxiosPost.mockResolvedValue({ data: { result: [] } });

    const store = await importQdrantStore();
    await store.search("ws_x", [0.1, 0.2, 0.3], 5, {
      workspaceId: "ws_x",
      documentTypes: ["pdf", "md"],
      dateFromMs: 1700000000000,
      dateToMs: 1735689600000,
    });

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const body = mockAxiosPost.mock.calls[0][1];
    const must = body.filter.must;
    expect(must).toContainEqual({ key: "workspaceId", match: { value: "ws_x" } });
    expect(must).toContainEqual({ key: "documentType", match: { any: ["pdf", "md"] } });
    // One numeric range clause covering both bounds.
    const rangeClauses = must.filter((c: any) => c.range !== undefined);
    expect(rangeClauses).toHaveLength(1);
    expect(rangeClauses[0].key).toBe("documentCreatedAtMs");
    expect(rangeClauses[0].range).toEqual({ gte: 1700000000000, lte: 1735689600000 });
  });

  it("dateFrom alone -> numeric range with only gte; dateTo alone -> only lte", async () => {
    mockAxiosPost.mockResolvedValue({ data: { result: [] } });

    const store = await importQdrantStore();
    await store.search("ws_x", [0.1, 0.2, 0.3], 5, {
      workspaceId: "ws_x",
      dateFromMs: 1700000000000,
    });

    let body = mockAxiosPost.mock.calls[0][1];
    expect(body.filter.must).toContainEqual({
      key: "documentCreatedAtMs",
      range: { gte: 1700000000000 },
    });

    mockAxiosPost.mockClear();
    await store.search("ws_x", [0.1, 0.2, 0.3], 5, {
      workspaceId: "ws_x",
      dateToMs: 1735689600000,
    });
    body = mockAxiosPost.mock.calls[0][1];
    expect(body.filter.must).toContainEqual({
      key: "documentCreatedAtMs",
      range: { lte: 1735689600000 },
    });
  });

  it("non-finite *Ms values do NOT add range clauses (guard)", async () => {
    mockAxiosPost.mockResolvedValue({ data: { result: [] } });

    const store = await importQdrantStore();
    await store.search("ws_x", [0.1, 0.2, 0.3], 5, {
      workspaceId: "ws_x",
      dateFromMs: Number.NaN,
      dateToMs: undefined,
    });

    const body = mockAxiosPost.mock.calls[0][1];
    const must = body.filter.must;
    expect(must).not.toContainEqual(expect.objectContaining({ range: expect.anything() }));
  });

  it("no filters -> body.filter shape identical to today (workspaceId must only)", async () => {
    mockAxiosPost.mockResolvedValue({ data: { result: [] } });

    const store = await importQdrantStore();
    await store.search("ws_x", [0.1, 0.2, 0.3], 5, { workspaceId: "ws_x" });

    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.filter.must).toEqual([{ key: "workspaceId", match: { value: "ws_x" } }]);
  });
});

describe("LanceDBProvider metadata-filter degrade (260830-ur9)", () => {
  let mockWhere: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    // Chainable query mock: tbl.search(v).limit(n).where(sql).toArray().
    mockWhere = jest.fn().mockImplementation(function (this: any) { return this; });
    const toArray = jest.fn().mockResolvedValue([]);
    const makeChain = () => ({
      limit: jest.fn().mockReturnThis(),
      where: mockWhere,
      toArray,
    });
    const mockTbl = { search: jest.fn(() => makeChain()) };

    jest.doMock("@lancedb/lancedb", () => ({
      connect: jest.fn().mockResolvedValue({
        openTable: jest.fn().mockResolvedValue(mockTbl),
        createTable: jest.fn(),
      }),
    }));

    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => ({
        COLLECTOR_PORT: 3210,
        COLLECTOR_URL: "http://localhost:3210",
        SERVER_URL: "http://localhost:3000",
        VECTOR_DB_PROVIDER: "lancedb",
        VECTOR_DB_URL: "",
        VECTOR_DB_API_KEY: "",
        EMBEDDING_PROVIDER: "local",
        EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
        OLLAMA_BASE_URL: "http://localhost:11434",
        STORAGE_PATH: "./storage",
        COLLECTOR_SECRET: "test-secret-for-unit-tests",
      })),
      clearEnvCache: jest.fn(),
    }));

    jest.doMock("axios", () => ({
      get: jest.fn().mockRejectedValue(new Error("test: no server available")),
      post: jest.fn(),
      put: jest.fn(),
    }));
  });

  it("filter with new keys: no error, where NOT called with new keys, workspace where preserved", async () => {
    const { logger } = await import("../utils/logger");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => logger) as never);
    warnSpy.mockClear();

    const { getVectorStore } = await import("../services/vectorStore");
    const store = await getVectorStore();

    await expect(
      store.search("ws_x", [0.1, 0.2, 0.3], 5, {
        workspaceId: "ws_x",
        documentTypes: ["pdf"],
        dateFrom: "2025-01-15",
        dateTo: "2025-06-01",
      }),
    ).resolves.toEqual([]);

    // Only the workspaceId where-clause, exactly as today; the new keys are ignored.
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(String(mockWhere.mock.calls[0][0])).toContain("workspaceId = 'ws_x'");
    expect(String(mockWhere.mock.calls[0][0])).not.toContain("documentTypes");
    expect(String(mockWhere.mock.calls[0][0])).not.toContain("dateFrom");

    // Exactly one degrade warn signals the design (unrelated warns from
    // fetchVectorDbConfig/registerTypes may also fire — count only ours).
    const degradeWarns = warnSpy.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("LanceDB does not support metadata filters"),
    );
    expect(degradeWarns).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

describe("QdrantProvider addDocuments on concurrent create", () => {
  beforeEach(() => {
    jest.resetModules();
    // Restore the file-level hoisted mocks (the LanceDBProvider ensureTable
    // describe above uses jest.doMock to override axios/env/lancedb; those
    // overrides persist across describe blocks, so re-establish the Qdrant
    // env + axios mock wiring here).
    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => ({
        COLLECTOR_PORT: 3210,
        COLLECTOR_URL: "http://localhost:3210",
        SERVER_URL: "http://localhost:3000",
        VECTOR_DB_PROVIDER: "qdrant",
        VECTOR_DB_URL: "http://localhost:6333",
        VECTOR_DB_API_KEY: "",
        EMBEDDING_PROVIDER: "local",
        EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
        OLLAMA_BASE_URL: "http://localhost:11434",
        STORAGE_PATH: "./storage",
        COLLECTOR_SECRET: "test-secret-for-unit-tests",
      })),
      clearEnvCache: jest.fn(),
    }));
    jest.doMock("axios", () => ({
      get: (...args: any[]) => mockAxiosGet(...args),
      post: (...args: any[]) => mockAxiosPost(...args),
      put: (...args: any[]) => mockAxiosPut(...args),
    }));
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    mockAxiosPut.mockReset();
    // fetchVectorDbConfig calls axios.get — reject so we fall back to env config.
    mockAxiosGet.mockRejectedValue(new Error("test: no server available"));
  });

  it("treats a 409 on collection create as idempotent success (concurrent upload race)", async () => {
    // Reproduces the real failure: several .md uploads hit the same workspace
    // concurrently. Each ensureCollection() GET sees 404, then all race to PUT
    // /collections/{table}; the losers get 409 "already exists". That 409 must
    // NOT be retried forever — the collection exists, so we proceed to upsert.
    const table = "ws_elegregio_9a334821";
    const qdrantError = (status: number) =>
      Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status },
      });

    // GET /collections/{table} → 404 (collection not yet created from this
    // caller's viewpoint; the winner created it between our GET and our PUT).
    mockAxiosGet.mockRejectedValue(qdrantError(404));

    // PUT /collections/{table} (create) → always 409: a concurrent caller
    // already created it. PUT /collections/{table}/points (upsert) → success.
    mockAxiosPut.mockImplementation(async (url: string) => {
      if (url === `${"http://localhost:6333"}/collections/${table}`) {
        throw qdrantError(409);
      }
      return { data: { result: { operation_id: 0, status: "completed" } } };
    });

    const { getVectorStore } = await import("../services/vectorStore");
    const store = await getVectorStore();

    await expect(
      store.addDocuments(table, [
        {
          id: "00000000-0000-0000-0000-000000000001",
          values: [0.1, 0.2, 0.3],
          metadata: {
            documentId: "doc-1",
            workspaceId: table,
            documentName: "race.md",
            chunkIndex: 0,
            chunkText: "hello",
          },
        },
      ]),
    ).resolves.toBeUndefined();

    // The create-collection PUT must be attempted exactly once (no retries on
    // an idempotent 409), and the points upsert must follow → 2 PUTs total.
    expect(mockAxiosPut).toHaveBeenCalledTimes(2);
  });
});