// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Ingest route tests — Phase 60-07
 *
 * Task 1 (W3/SC-5): `/api/ingest/query` response includes a `dimension` field
 *   derived from `embeddingProvider.getDimension()`. This unblocks
 *   `inspect-embeddings.ts` Path A (strict dim equality) so SC-5 is fully met
 *   instead of falling back to Path B (non-zero result count).
 *
 * Task 2 (W4/D-06): `POST /api/ingest/reembed` re-embeds chunk text and rewrites
 *   vectors with the shared chunk id `${documentId}-${chunkIndex}`. Idempotent
 *   (deleteByDocumentId before addDocuments), air-gap (local embedding),
 *   HTTP-only (X-Collector-Secret auth).
 *
 * Test strategy: mount the router on a real Express app, listen on an ephemeral
 * port, and use the global `fetch` (Node >= 18) to exercise the HTTP surface.
 * No `supertest` dependency is introduced (T-60-SC: zero new packages).
 */

// Mock env so `getEnv()` doesn't `process.exit(1)` on missing COLLECTOR_SECRET.
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_PORT: 3210,
    COLLECTOR_URL: "http://localhost:3210",
    SERVER_URL: "http://localhost:3000",
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    OLLAMA_BASE_URL: "http://localhost:11434",
    VECTOR_DB_PROVIDER: "lancedb",
    STORAGE_PATH: "./storage",
    COLLECTOR_SECRET: "test-secret-for-unit-tests",
  })),
  clearEnvCache: jest.fn(),
}));

// Mock axios so notifyServerStatus / fetchEmbeddingConfig never hit the network.
jest.mock("axios", () => ({
  get: jest.fn().mockRejectedValue(new Error("test: no server available")),
  put: jest.fn().mockResolvedValue({ status: 200 }),
}));

// Mock embedding provider. `getDimension()` is the source of truth for the
// `dimension` field exposed in /query and /reembed responses.
const mockEmbed = jest.fn();
const mockGetDimension = jest.fn();
const mockGetModelName = jest.fn();
jest.mock("../services/embeddings", () => ({
  getEmbeddingProvider: jest.fn(),
}));

// Mock vector store. `search` returns VectorSearchResult[]; `deleteByDocumentId`
// and `addDocuments` are used by the reembed endpoint.
const mockSearch = jest.fn();
const mockDeleteByDocumentId = jest.fn();
const mockAddDocuments = jest.fn();
const mockGetByDocumentId = jest.fn();
jest.mock("../services/vectorStore", () => ({
  getVectorStore: jest.fn(),
}));

// 260830-ur9: mock the parser so POST /api/ingest runs without real files.
const mockParseFile = jest.fn();
jest.mock("../services/parser", () => ({
  parseFile: (...args: any[]) => mockParseFile(...args),
  parseYoutubeUrl: jest.fn(),
}));
const mockChunkText = jest.fn();
jest.mock("../services/chunker", () => ({
  chunkText: (...args: any[]) => mockChunkText(...args),
}));

import express from "express";
import type { Server } from "http";
import ingestRoutes from "../routes/ingest";
import { getEmbeddingProvider } from "../services/embeddings";
import { getVectorStore } from "../services/vectorStore";

const mockedGetEmbeddingProvider = getEmbeddingProvider as unknown as jest.Mock;
const mockedGetVectorStore = getVectorStore as unknown as jest.Mock;

const TEST_SECRET = "test-secret-for-unit-tests";

function startApp(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: "50mb" }));
    app.use("/api", ingestRoutes);
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function stopApp(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function setupEmbeddingProvider(dim = 384, model = "Xenova/all-MiniLM-L6-v2") {
  mockEmbed.mockReset();
  mockGetDimension.mockReset();
  mockGetModelName.mockReset();
  mockGetDimension.mockReturnValue(dim);
  mockGetModelName.mockReturnValue(model);
  mockEmbed.mockImplementation(async (texts: string[]) =>
    texts.map(() => new Array(dim).fill(0.1)),
  );
  mockedGetEmbeddingProvider.mockResolvedValue({
    embed: mockEmbed,
    getDimension: mockGetDimension,
    getModelName: mockGetModelName,
  });
}

function setupVectorStore(searchResults: unknown[] = []) {
  mockSearch.mockReset();
  mockDeleteByDocumentId.mockReset();
  mockAddDocuments.mockReset();
  mockGetByDocumentId.mockReset();
  mockSearch.mockResolvedValue(searchResults);
  mockDeleteByDocumentId.mockResolvedValue(undefined);
  mockAddDocuments.mockResolvedValue(undefined);
  mockGetByDocumentId.mockResolvedValue([]);
  mockedGetVectorStore.mockResolvedValue({
    search: mockSearch,
    deleteByDocumentId: mockDeleteByDocumentId,
    addDocuments: mockAddDocuments,
    getByDocumentId: mockGetByDocumentId,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupEmbeddingProvider();
  setupVectorStore();
});

describe("/api/ingest/query dimension exposure (W3/SC-5)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const handle = await startApp();
    server = handle.server;
    base = handle.base;
  });

  afterAll(async () => {
    await stopApp(server);
  });

  it("response body includes a numeric `dimension` field", async () => {
    const res = await fetch(`${base}/api/ingest/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hello", workspaceId: "ws-1" }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(typeof body.dimension).toBe("number");
    expect(body.dimension).toBeGreaterThan(0);
  });

  it("`dimension` equals embeddingProvider.getDimension() for the configured model (384)", async () => {
    setupEmbeddingProvider(384, "Xenova/all-MiniLM-L6-v2");
    const res = await fetch(`${base}/api/ingest/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hello", workspaceId: "ws-1" }),
    });
    const body: any = await res.json();
    expect(body.dimension).toBe(384);
    expect(mockGetDimension).toHaveBeenCalled();
  });

  it("`dimension` is present even when vectorStore returns empty results", async () => {
    setupVectorStore([]); // empty results (table not found / no matches)
    const res = await fetch(`${base}/api/ingest/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hello", workspaceId: "ws-1" }),
    });
    const body: any = await res.json();
    expect(body.results).toEqual([]);
    expect(typeof body.dimension).toBe("number");
    expect(body.dimension).toBe(384);
  });
});

describe("POST /api/ingest/reembed (W4/D-06)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const handle = await startApp();
    server = handle.server;
    base = handle.base;
  });

  afterAll(async () => {
    await stopApp(server);
  });

  const DOC_ID = "11111111-1111-4111-8111-111111111111";
  const validBody = {
    documentId: DOC_ID,
    workspaceId: "ws-1",
    chunks: [{ chunkIndex: 0, chunkText: "hello world" }],
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
  };

  it("200 with { documentId, chunkCount, embeddingModel, dimension } for a valid body", async () => {
    const res = await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collector-Secret": TEST_SECRET },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.documentId).toBe(DOC_ID);
    expect(body.chunkCount).toBe(1);
    expect(body.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
    expect(body.dimension).toBe(384);
  });

  it("calls deleteByDocumentId BEFORE addDocuments (idempotency order)", async () => {
    const callOrder: string[] = [];
    mockDeleteByDocumentId.mockReset();
    mockAddDocuments.mockReset();
    mockDeleteByDocumentId.mockImplementation(async () => {
      callOrder.push("delete");
      return undefined;
    });
    mockAddDocuments.mockImplementation(async () => {
      callOrder.push("add");
      return undefined;
    });
    mockedGetVectorStore.mockResolvedValue({
      search: mockSearch,
      deleteByDocumentId: mockDeleteByDocumentId,
      addDocuments: mockAddDocuments,
      getByDocumentId: mockGetByDocumentId,
    });

    const res = await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collector-Secret": TEST_SECRET },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(["delete", "add"]);
  });

  it("new vectors use shared chunk id `${documentId}-${chunkIndex}`", async () => {
    mockAddDocuments.mockReset();
    mockAddDocuments.mockImplementation(async (_table: string, docs: any[]) => {
      expect(docs[0].id).toBe(`${DOC_ID}-0`);
      return undefined;
    });
    mockedGetVectorStore.mockResolvedValue({
      search: mockSearch,
      deleteByDocumentId: mockDeleteByDocumentId,
      addDocuments: mockAddDocuments,
      getByDocumentId: mockGetByDocumentId,
    });

    const res = await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collector-Secret": TEST_SECRET },
      body: JSON.stringify({
        ...validBody,
        chunks: [
          { chunkIndex: 0, chunkText: "first chunk" },
          { chunkIndex: 2, chunkText: "third chunk" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(mockAddDocuments).toHaveBeenCalledTimes(1);
    const passedDocs = (mockAddDocuments as jest.Mock).mock.calls[0][1] as any[];
    expect(passedDocs[0].id).toBe(`${DOC_ID}-0`);
    expect(passedDocs[1].id).toBe(`${DOC_ID}-2`);
  });

  it("400 when body is missing documentId", async () => {
    const { documentId: _omit, ...noDocId } = validBody;
    const res = await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collector-Secret": TEST_SECRET },
      body: JSON.stringify(noDocId),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/invalid reembed request/i);
  });

  it("200 with chunkCount: 0 for empty chunks (no-op idempotent)", async () => {
    const res = await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collector-Secret": TEST_SECRET },
      body: JSON.stringify({ ...validBody, chunks: [] }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.chunkCount).toBe(0);
    expect(body.documentId).toBe(DOC_ID);
    // deleteByDocumentId must NOT be called for a no-op (nothing to delete/rewrite)
    expect(mockDeleteByDocumentId).not.toHaveBeenCalled();
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  it("401 when X-Collector-Secret header is missing (auth boundary)", async () => {
    const res = await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error).toMatch(/collector secret/i);
  });
});

// 260830-ur9 — metadata stamping: /ingest stamps documentType +
// documentCreatedAt (+Ms) into every chunk's VectorMetadata; /ingest/query
// passes filters into the provider filter object; /ingest/reembed re-stamps
// when the body carries documentType/documentCreatedAt.
describe("metadata stamping + query filters (260830-ur9)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const handle = await startApp();
    server = handle.server;
    base = handle.base;
  });

  afterAll(async () => {
    await stopApp(server);
  });

  const DOC_ID = "22222222-2222-4222-8222-222222222222";

  function setupStampingMocks() {
    mockParseFile.mockResolvedValue({ text: "hello world", metadata: {} });
    mockChunkText.mockImplementation(async (text: string, docId: string) => [
      { text: "chunk0", metadata: { paragraph: 0, charStart: 0, charEnd: 6 } },
      { text: "chunk1", metadata: { paragraph: 1, charStart: 6, charEnd: 11 } },
    ]);
    setupEmbeddingProvider();
    setupVectorStore();
    mockAddDocuments.mockResolvedValue(undefined);
  }

  it("/ingest stamps documentType + documentCreatedAt + documentCreatedAtMs into every chunk's metadata", async () => {
    setupStampingMocks();
    const before = Date.now();

    // Build a multipart form body (mirrors the server's upload path).
    const form = new FormData();
    form.append("file", new Blob(["hello world"], { type: "text/markdown" }), "notes.md");
    form.append("documentId", DOC_ID);
    form.append("workspaceId", "ws-1");
    form.append("embeddingModel", "Xenova/all-MiniLM-L6-v2");
    form.append("docType", "md");

    const res = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "X-Collector-Secret": TEST_SECRET },
      body: form,
    });
    expect(res.status).toBe(200);
    expect(mockAddDocuments).toHaveBeenCalledTimes(1);

    const after = Date.now();
    const passedDocs = mockAddDocuments.mock.calls[0][1] as any[];
    expect(passedDocs).toHaveLength(2);
    for (const doc of passedDocs) {
      expect(doc.metadata.documentType).toBe("md");
      // documentCreatedAt is a full ISO string within the request window.
      expect(typeof doc.metadata.documentCreatedAt).toBe("string");
      expect(new Date(doc.metadata.documentCreatedAt).toISOString()).toBe(doc.metadata.documentCreatedAt);
      const stamped = new Date(doc.metadata.documentCreatedAt).getTime();
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
      // documentCreatedAtMs matches documentCreatedAt (epoch ms).
      expect(doc.metadata.documentCreatedAtMs).toBe(stamped);
    }
  });

  it("/ingest/query with filters passes documentTypes/dateFrom/dateTo into the provider filter object", async () => {
    setupStampingMocks();
    const res = await fetch(`${base}/api/ingest/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "hello",
        workspaceId: "ws-1",
        filters: { documentTypes: ["pdf", "md"], dateFrom: "2025-01-15T00:00:00.000Z", dateTo: "2025-06-01T23:59:59.999Z" },
      }),
    });
    expect(res.status).toBe(200);

    const filter = mockSearch.mock.calls[0][3];
    expect(filter.workspaceId).toBe("ws-1");
    expect(filter.documentTypes).toEqual(["pdf", "md"]);
    expect(filter.dateFrom).toBe("2025-01-15T00:00:00.000Z");
    expect(filter.dateTo).toBe("2025-06-01T23:59:59.999Z");
  });

  it("/ingest/query without filters keeps the provider filter object exactly { workspaceId } (byte-identical)", async () => {
    setupStampingMocks();
    const res = await fetch(`${base}/api/ingest/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hello", workspaceId: "ws-1" }),
    });
    expect(res.status).toBe(200);

    const filter = mockSearch.mock.calls[0][3];
    expect(filter).toEqual({ workspaceId: "ws-1" });
    expect(Object.keys(filter)).toEqual(["workspaceId"]);
  });

  it("/reembed re-stamps documentType/documentCreatedAt(+Ms) when the body provides them; omits fields when absent", async () => {
    setupStampingMocks();

    // With stamp fields: re-stamped on all chunks, Ms derived from documentCreatedAt.
    await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collector-Secret": TEST_SECRET },
      body: JSON.stringify({
        documentId: DOC_ID,
        workspaceId: "ws-1",
        documentType: "pdf",
        documentCreatedAt: "2025-03-10T08:00:00.000Z",
        chunks: [{ chunkIndex: 0, chunkText: "hello world" }],
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
      }),
    });
    let passedDocs = mockAddDocuments.mock.calls[0][1] as any[];
    expect(passedDocs[0].metadata.documentType).toBe("pdf");
    expect(passedDocs[0].metadata.documentCreatedAt).toBe("2025-03-10T08:00:00.000Z");
    expect(passedDocs[0].metadata.documentCreatedAtMs).toBe(new Date("2025-03-10T08:00:00.000Z").getTime());

    // Without stamp fields: current metadata shape (fields omitted entirely).
    mockAddDocuments.mockClear();
    await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collector-Secret": TEST_SECRET },
      body: JSON.stringify({
        documentId: DOC_ID,
        workspaceId: "ws-1",
        chunks: [{ chunkIndex: 0, chunkText: "hello world" }],
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
      }),
    });
    passedDocs = mockAddDocuments.mock.calls[0][1] as any[];
    expect(passedDocs[0].metadata).not.toHaveProperty("documentType");
    expect(passedDocs[0].metadata).not.toHaveProperty("documentCreatedAt");
    expect(passedDocs[0].metadata).not.toHaveProperty("documentCreatedAtMs");
  });
});