// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Route tests for POST /api/ingest/rerank — Phase 93-01 / RER-01 Task 2.
 *
 * D-02 (critical): /ingest/rerank mirrors /ingest/query (read-only pure
 * function, NO requireCollectorSecret). The server's rerankCandidates does
 * NOT send X-Collector-Secret; a no-secret request MUST return 200 (NOT 401).
 * This is the critical D-02 gate — contrast with /ingest/reembed which 401s
 * without the secret.
 *
 * Strategy: mount the router on a real Express app, listen on an ephemeral
 * port, and use the global `fetch` (Node >= 18) to exercise the HTTP surface.
 * No `supertest` dependency (T-60-SC parity with ingest.test.ts). Mock
 * ../services/reranker (getReranker) so the route never loads the real ONNX
 * runtime. Mock env + axios for harness isolation.
 *
 * The 4 tests:
 *   1. D-02 no-secret 200: POST without X-Collector-Secret → 200 (NOT 401)
 *   2. Zod 400: missing query or empty candidates → 400 with details
 *   3. rerank 200 sorted: valid body → 200 with results sorted DESC by score,
 *      each score in [0,1]; getReranker() called exactly once (lazy singleton)
 *   4. 500 on reranker failure: getReranker().rerank rejects → 500 with
 *      { error: 'Rerank failed', details }
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
    OLLAMA_KEEP_ALIVE: "10m",
    VECTOR_DB_PROVIDER: "lancedb",
    STORAGE_PATH: "./storage",
    COLLECTOR_SECRET: "test-secret-for-unit-tests",
    RERANKER_MODEL: "Xenova/bge-reranker-base",
    RERANKER_CACHE_DIR: undefined,
  })),
  clearEnvCache: jest.fn(),
}));

// Mock axios so notifyServerStatus / fetchEmbeddingConfig never hit the network.
jest.mock("axios", () => ({
  get: jest.fn().mockRejectedValue(new Error("test: no server available")),
  put: jest.fn().mockResolvedValue({ status: 200 }),
}));

// Mock the reranker service. getReranker() returns a controllable reranker
// whose rerank() yields deterministic scores. The route must call getReranker()
// exactly once per request (lazy singleton). Use jest.fn() inline in the
// factory (jest.mock is hoisted; const refs would hit the TDZ) and access the
// mock via the imported binding cast to jest.Mock (mirror ingest.test.ts).
jest.mock("../services/reranker", () => ({
  getReranker: jest.fn(),
}));

// Mock embedding + vector store so the shared ingest router module loads
// cleanly (the rerank route does not call them, but the module imports them
// at the top level).
jest.mock("../services/embeddings", () => ({
  getEmbeddingProvider: jest.fn(),
  checkEmbeddingModelAvailability: jest.fn(),
}));
jest.mock("../services/vectorStore", () => ({
  getVectorStore: jest.fn(),
}));

import express from "express";
import type { Server } from "http";
import ingestRoutes from "../routes/ingest";
import { getReranker } from "../services/reranker";

const mockGetReranker = getReranker as unknown as jest.Mock;
const mockRerank = jest.fn();

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

const validBody = {
  query: "what is RAG?",
  candidates: [
    { chunkId: "c1", documentId: "d1", chunkText: "RAG retrieves documents.", score: 0.9 },
    { chunkId: "c2", documentId: "d2", chunkText: "RRF fuses rankings.", score: 0.8 },
    { chunkId: "c3", documentId: "d3", chunkText: "CrossEncoder reranks.", score: 0.7 },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: getReranker returns a reranker whose rerank() yields scores in
  // candidate order (the route sorts DESC). sigmoid-ish values.
  mockRerank.mockReset();
  mockGetReranker.mockReset();
  mockRerank.mockResolvedValue([
    { score: 0.5 },
    { score: 0.9 },
    { score: 0.7 },
  ]);
  mockGetReranker.mockResolvedValue({
    rerank: mockRerank,
    getModelName: () => "Xenova/bge-reranker-base",
  });
});

describe("POST /api/ingest/rerank (D-02 read-only, no secret)", () => {
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

  it("1. D-02: POST WITHOUT X-Collector-Secret → 200 (NOT 401)", async () => {
    const res = await fetch(`${base}/api/ingest/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    // Critical D-02 assertion: read-only route, no secret required.
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("1b. Contrast: /ingest/reembed WITHOUT secret → 401 (proves the no-secret 200 is not a global auth bypass)", async () => {
    const res = await fetch(`${base}/api/ingest/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: "11111111-1111-4111-8111-111111111111", workspaceId: "ws-1", chunks: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("2. Zod 400: missing query → 400 with details", async () => {
    const res = await fetch(`${base}/api/ingest/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidates: validBody.candidates }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/invalid rerank request/i);
    expect(body.details).toBeDefined();
  });

  it("2b. Zod 400: empty candidates → 400 with details", async () => {
    const res = await fetch(`${base}/api/ingest/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "q", candidates: [] }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.details).toBeDefined();
  });

  it("3. rerank 200 sorted DESC by score; getReranker() called once", async () => {
    const res = await fetch(`${base}/api/ingest/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBe(3);
    // Each score in [0, 1].
    for (const r of body.results) {
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // Sorted DESC by score: [0.9, 0.7, 0.5].
    expect(body.results[0].score).toBeGreaterThanOrEqual(body.results[1].score);
    expect(body.results[1].score).toBeGreaterThanOrEqual(body.results[2].score);
    expect(body.results[0].score).toBeCloseTo(0.9, 5);
    // Lazy singleton: getReranker() called exactly once per request.
    expect(mockGetReranker).toHaveBeenCalledTimes(1);
    // rerank() received the query + candidates.
    expect(mockRerank).toHaveBeenCalledTimes(1);
    const rerankCall = mockRerank.mock.calls[0];
    expect(rerankCall[0]).toBe("what is RAG?");
    expect(Array.isArray(rerankCall[1])).toBe(true);
    expect(rerankCall[1].length).toBe(3);
  });

  it("4. 500 on reranker failure → { error: 'Rerank failed', details }", async () => {
    mockRerank.mockReset();
    mockRerank.mockRejectedValue(new Error("ONNX inference failed: model corrupt"));
    const res = await fetch(`${base}/api/ingest/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.error).toMatch(/rerank failed/i);
    expect(body.details).toMatch(/ONNX inference failed/);
  });
});