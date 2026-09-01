// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ChromaProvider integration tests — require a running Chroma container.
 *
 * Usage:
 *   docker compose -f docker/docker-compose.yml up -d chroma
 *   CHROMA_AVAILABLE=true VECTOR_DB_URL=http://localhost:8000 \
 *     pnpm --filter collector test -- --config jest.config.integration.cjs --testPathPattern="chromaProvider"
 *
 * Gated behind CHROMA_AVAILABLE env var (mirrors pgVectorProvider integration pattern).
 */

const CHROMA_AVAILABLE = process.env.CHROMA_AVAILABLE === "true";
const VECTOR_DB_URL = process.env.VECTOR_DB_URL ?? "http://localhost:8000";

(CHROMA_AVAILABLE ? describe : describe.skip)(
  "ChromaProvider integration (real Chroma container)",
  () => {
    let ChromaProvider: typeof import("../services/vectorStore").ChromaProvider;
    let ChromaClient: typeof import("chromadb").ChromaClient;
    let provider: InstanceType<typeof import("../services/vectorStore").ChromaProvider>;
    const uniqueSuffix = Date.now().toString(36);
    const testCollection = `test_col_${uniqueSuffix}`;
    const deleteCollection = `test_del_${uniqueSuffix}`;
    const wsFilterCollection = `test_ws_${uniqueSuffix}`;
    const getCollection = `test_get_${uniqueSuffix}`;
    const missingCollection = `test_missing_${uniqueSuffix}`;

    beforeAll(async () => {
      const chromadb = await import("chromadb");
      ChromaClient = chromadb.ChromaClient;
      const vs = await import("../services/vectorStore");
      ChromaProvider = vs.ChromaProvider;
      provider = new ChromaProvider(VECTOR_DB_URL);
    });

    afterAll(async () => {
      const client = new ChromaClient({ path: VECTOR_DB_URL });
      for (const name of [testCollection, deleteCollection, wsFilterCollection, getCollection]) {
        try {
          await client.deleteCollection({ name });
        } catch {
          // already cleaned up
        }
      }
    });

    function makeDoc(
      id: string,
      workspaceId: string,
      documentId: string,
      chunkIndex: number,
      text: string,
    ) {
      return {
        id,
        values: new Array(384).fill(0).map(() => Math.random() * 2 - 1),
        metadata: {
          documentId,
          workspaceId,
          documentName: "test.pdf",
          chunkIndex,
          chunkText: text,
        },
      };
    }

    describe("addDocuments + search round-trip", () => {
      it("stores vectors and retrieves them via search", async () => {
        const docs = [
          makeDoc("chunk-a", "ws1", "doc1", 0, "Chroma is a vector database."),
          makeDoc("chunk-b", "ws1", "doc1", 1, "It stores embeddings and metadata."),
          makeDoc("chunk-c", "ws1", "doc1", 2, "Search returns nearest neighbors."),
        ];

        await provider.addDocuments(testCollection, docs);
        const queryVector = docs[0]!.values;
        const results = await provider.search(testCollection, queryVector, 5, {
          workspaceId: "ws1",
        });

        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.metadata.documentId).toBe("doc1");
        expect(results[0]!.metadata.workspaceId).toBe("ws1");
        expect(results[0]!.metadata.documentName).toBe("test.pdf");
        expect(typeof results[0]!.score).toBe("number");
      });
    });

    describe("search with workspaceId filter", () => {
      it("only returns documents matching the workspace filter", async () => {
        const ws1docs = [
          makeDoc("ws1-a", "ws1_filter", "doc_ws1", 0, "Workspace 1 content."),
          makeDoc("ws1-b", "ws1_filter", "doc_ws1", 1, "More workspace 1 content."),
        ];
        const ws2docs = [
          makeDoc("ws2-a", "ws2_filter", "doc_ws2", 0, "Workspace 2 content."),
        ];

        await provider.addDocuments(wsFilterCollection, [...ws1docs, ...ws2docs]);
        const queryVector = ws1docs[0]!.values;

        const results = await provider.search(wsFilterCollection, queryVector, 5, {
          workspaceId: "ws1_filter",
        });

        expect(results.length).toBeGreaterThanOrEqual(1);
        for (const r of results) {
          expect(r.metadata.workspaceId).toBe("ws1_filter");
        }
      });
    });

    describe("deleteByDocumentId", () => {
      it("deletes vectors and allows idempotent re-delete", async () => {
        const docs = [
          makeDoc("del-a", "ws_del", "doc_del", 0, "To be deleted."),
          makeDoc("del-b", "ws_del", "doc_del", 1, "Also to be deleted."),
        ];

        await provider.addDocuments(deleteCollection, docs);
        let results = await provider.search(deleteCollection, docs[0]!.values, 5, {
          workspaceId: "ws_del",
        });
        expect(results.length).toBeGreaterThanOrEqual(1);

        await provider.deleteByDocumentId(deleteCollection, "doc_del");
        results = await provider.search(deleteCollection, docs[0]!.values, 5, {
          workspaceId: "ws_del",
        });
        expect(results).toEqual([]);

        // Idempotent delete must not throw
        await provider.deleteByDocumentId(deleteCollection, "doc_del");
      });
    });

    describe("getByDocumentId", () => {
      it("returns all chunks with score 0", async () => {
        const docs = [
          makeDoc("get-a", "ws_get", "doc_get", 0, "First chunk."),
          makeDoc("get-b", "ws_get", "doc_get", 1, "Second chunk."),
        ];

        await provider.addDocuments(getCollection, docs);
        const results = await provider.getByDocumentId(getCollection, "doc_get", "ws_get");

        expect(results.length).toBe(2);
        for (const r of results) {
          expect(r.score).toBe(0);
          expect(r.metadata.documentId).toBe("doc_get");
          expect(r.metadata.workspaceId).toBe("ws_get");
        }
      });
    });

    describe("404-as-empty (missing collection)", () => {
      it("search returns [] for non-existent collection without throwing", async () => {
        const results = await provider.search(missingCollection, [0.1, 0.2, 0.3]);
        expect(results).toEqual([]);
      });

      it("getByDocumentId returns [] for non-existent collection without throwing", async () => {
        const results = await provider.getByDocumentId(missingCollection, "ghost", "ghost_ws");
        expect(results).toEqual([]);
      });

      it("deleteByDocumentId does not throw on non-existent collection", async () => {
        await expect(
          provider.deleteByDocumentId(missingCollection, "ghost"),
        ).resolves.toBeUndefined();
      });
    });
  },
);
