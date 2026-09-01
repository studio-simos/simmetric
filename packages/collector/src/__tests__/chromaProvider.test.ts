// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ChromaProvider unit tests — mocked chromadb SDK.
 * Verifies the VectorStoreProvider contract without a running Chroma container.
 */

let mockGetOrCreateCollection: jest.Mock;

const mockCollection = {
  name: "test-collection",
  add: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue({
    ids: [["chunk-1", "chunk-2"]],
    distances: [[0.1, 0.2]],
    metadatas: [
      [
        { documentId: "doc1", workspaceId: "ws1", documentName: "test.pdf", chunkIndex: 0 },
        { documentId: "doc1", workspaceId: "ws1", documentName: "test.pdf", chunkIndex: 1 },
      ],
    ],
    documents: [["text1", "text2"]],
  }),
  delete: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue({
    ids: ["chunk-1"],
    metadatas: [{ documentId: "doc1", workspaceId: "ws1", documentName: "test.pdf", chunkIndex: 0 }],
    documents: ["text1"],
  }),
};

jest.mock("chromadb", () => ({
  ChromaClient: jest.fn().mockImplementation(() => ({
    getOrCreateCollection: jest.fn().mockImplementation(() => mockGetOrCreateCollection()),
  })),
}));

const chromaMockAxiosGet = jest.fn();
jest.mock("axios", () => ({
  get: (...args: any[]) => chromaMockAxiosGet(...args),
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_PORT: 3210,
    COLLECTOR_URL: "http://localhost:3210",
    SERVER_URL: "http://localhost:3000",
    VECTOR_DB_PROVIDER: "chroma",
    VECTOR_DB_URL: "http://chroma:8000",
    VECTOR_DB_API_KEY: "",
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    OLLAMA_BASE_URL: "http://localhost:11434",
    STORAGE_PATH: "./storage",
    COLLECTOR_SECRET: "test-secret-for-unit-tests",
  })),
  clearEnvCache: jest.fn(),
}));

describe("ChromaProvider", () => {
  let ChromaProvider: any;

  beforeAll(async () => {
    chromaMockAxiosGet.mockRejectedValue(new Error("test: no server available"));
    const mod = await import("../services/vectorStore");
    ChromaProvider = mod.ChromaProvider;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOrCreateCollection = jest.fn().mockResolvedValue(mockCollection);
  });

  describe("constructor", () => {
    it("stores URL with trailing slash stripped", () => {
      const provider = new ChromaProvider("http://chroma:8000/");
      expect(provider.url).toBe("http://chroma:8000");
    });

    it("stores URL without modification when no trailing slash", () => {
      const provider = new ChromaProvider("http://chroma:8000");
      expect(provider.url).toBe("http://chroma:8000");
    });
  });

  describe("addDocuments", () => {
    it("calls getOrCreateCollection with the table name", async () => {
      const provider = new ChromaProvider("http://chroma:8000");
      const docs = [
        {
          id: "chunk-1",
          values: [0.1, 0.2, 0.3],
          metadata: {
            documentId: "doc1",
            workspaceId: "ws1",
            documentName: "test.pdf",
            chunkIndex: 0,
            chunkText: "text1",
          },
        },
      ];
      await provider.addDocuments("test-collection", docs);
      expect(mockCollection.add).toHaveBeenCalledWith({
        ids: ["chunk-1"],
        embeddings: [[0.1, 0.2, 0.3]],
        metadatas: [
          { documentId: "doc1", workspaceId: "ws1", documentName: "test.pdf", chunkIndex: 0 },
        ],
        documents: ["text1"],
      });
    });

    it("is a no-op for empty documents array", async () => {
      const provider = new ChromaProvider("http://chroma:8000");
      await provider.addDocuments("test-collection", []);
      expect(mockCollection.add).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("returns VectorSearchResult[] mapped from Chroma query response", async () => {
      const provider = new ChromaProvider("http://chroma:8000");
      const results = await provider.search("test-collection", [0.1, 0.2, 0.3], 5, {
        workspaceId: "ws1",
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe("chunk-1");
      // Chroma distance 0.1 → score = Math.max(0, 1 - 0.1) = 0.9
      expect(results[0]!.score).toBeCloseTo(0.9);
      expect(results[0]!.text).toBe("text1");
      expect(results[0]!.metadata.documentId).toBe("doc1");
      expect(results[0]!.metadata.workspaceId).toBe("ws1");
      expect(results[0]!.metadata.chunkIndex).toBe(0);
    });

    it("passes filter as where clause", async () => {
      const provider = new ChromaProvider("http://chroma:8000");
      await provider.search("test-collection", [0.1, 0.2, 0.3], 5, {
        workspaceId: "ws1",
      });

      expect(mockCollection.query).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: "ws1" },
        }),
      );
    });

    // 260830-ur9 / T-260830-06: Chroma's where DSL cannot express arrays
    // (documentTypes would error) and bare date strings would silently become
    // $eq matches returning []. Degrade: strip the new keys before collection.query,
    // keep ONLY allowlisted scalar keys, log one warn. The server-side backstop
    // enforces correctness.
    it("strips documentTypes/dateFrom/dateTo from where — only scalar keys kept — with one warn (T-260830-06)", async () => {
      const { logger } = await import("../utils/logger");
      const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => logger) as never);

      const provider = new ChromaProvider("http://chroma:8000");
      await provider.search("test-collection", [0.1, 0.2, 0.3], 5, {
        workspaceId: "ws1",
        documentTypes: ["pdf", "md"],
        dateFrom: "2025-01-15T00:00:00.000Z",
        dateTo: "2025-06-01T23:59:59.999Z",
        dateFromMs: 1736899200000,
        dateToMs: 1748793599999,
      });

      const where = mockCollection.query.mock.calls[0][0].where;
      // Scalar keys survive.
      expect(where).toEqual({ workspaceId: "ws1" });
      // New keys stripped — NEVER widened into the DSL.
      expect(where).not.toHaveProperty("documentTypes");
      expect(where).not.toHaveProperty("dateFrom");
      expect(where).not.toHaveProperty("dateTo");
      expect(where).not.toHaveProperty("dateFromMs");
      expect(where).not.toHaveProperty("dateToMs");

      // Exactly one degrade warn.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toMatch(/Chroma|metadata filter/i);
      warnSpy.mockRestore();
    });

    it("strips to documentId + workspaceId when both present; where undefined when nothing scalar remains", async () => {
      const { logger } = await import("../utils/logger");
      const warnSpy = jest.spyOn(logger, "warn").mockImplementation((() => logger) as never);

      // With documentId: both scalars survive.
      const provider = new ChromaProvider("http://chroma:8000");
      await provider.search("test-collection", [0.1, 0.2, 0.3], 5, {
        workspaceId: "ws1",
        documentId: "doc1",
        documentTypes: ["pdf"],
      });
      expect(mockCollection.query.mock.calls[0][0].where).toEqual({
        workspaceId: "ws1",
        documentId: "doc1",
      });

      // Only filter keys (no workspaceId) → where becomes undefined (today's shape).
      mockCollection.query.mockClear();
      warnSpy.mockClear();
      await provider.search("test-collection", [0.1, 0.2, 0.3], 5, {
        documentTypes: ["pdf"],
        dateFrom: "2025-01-15",
      });
      expect(mockCollection.query.mock.calls[0][0].where).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  describe("deleteByDocumentId", () => {
    it("calls collection.delete with documentId filter", async () => {
      const provider = new ChromaProvider("http://chroma:8000");
      await provider.deleteByDocumentId("test-collection", "doc1");

      expect(mockCollection.delete).toHaveBeenCalledWith({
        where: { documentId: "doc1" },
      });
    });
  });

  describe("deleteByWorkspaceId", () => {
    it("calls collection.delete with workspaceId filter", async () => {
      const provider = new ChromaProvider("http://chroma:8000");
      await provider.deleteByWorkspaceId("test-collection", "ws1");

      expect(mockCollection.delete).toHaveBeenCalledWith({
        where: { workspaceId: "ws1" },
      });
    });
  });

  describe("getByDocumentId", () => {
    it("calls collection.get with documentId and workspaceId filter", async () => {
      const provider = new ChromaProvider("http://chroma:8000");
      await provider.getByDocumentId("test-collection", "doc1", "ws1");

      expect(mockCollection.get).toHaveBeenCalledWith({
        where: { documentId: "doc1", workspaceId: "ws1" },
      });
    });

    it("returns results with score 0", async () => {
      const provider = new ChromaProvider("http://chroma:8000");
      const results = await provider.getByDocumentId("test-collection", "doc1", "ws1");

      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBe(0);
      expect(results[0]!.id).toBe("chunk-1");
      expect(results[0]!.text).toBe("text1");
    });
  });

  describe("404-as-empty (missing collection)", () => {
    it("returns [] for search when getOrCreateCollection throws", async () => {
      mockGetOrCreateCollection = jest.fn().mockRejectedValue(new Error("Collection not found"));
      const provider = new ChromaProvider("http://chroma:8000");
      const results = await provider.search("missing-collection", [0.1, 0.2, 0.3]);
      expect(results).toEqual([]);
    });

    it("returns [] for getByDocumentId when collection is missing", async () => {
      mockGetOrCreateCollection = jest.fn().mockRejectedValue(new Error("Collection not found"));
      const provider = new ChromaProvider("http://chroma:8000");
      const results = await provider.getByDocumentId("missing", "doc1", "ws1");
      expect(results).toEqual([]);
    });
  });

  describe("getVectorStore wiring", () => {
    it("returns ChromaProvider when VECTOR_DB_PROVIDER=chroma", async () => {
      const { getVectorStore } = await import("../services/vectorStore");
      const store = await getVectorStore();

      expect(store.constructor.name).toBe("ChromaProvider");
    });
  });
});
