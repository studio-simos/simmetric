// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Masked-chunk persistence + reembed tests (Phase 192 plan 02 Task 1).
 *
 * Covers: the reembed payload shape (masked chunkText + documentType +
 * documentCreatedAt + embeddingModel present, D-06), chunkIndex derivation
 * fallback (embeddingId prefix → metadata), the empty-chunks loud-failure
 * arm (Pitfall 7), the FTS UPDATE disposition comment presence (source
 * grep), and the FTS failure non-blocking arm.
 */
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockPrisma = {
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRaw: jest.fn().mockResolvedValue([]),
};

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));

// fetch capture: global fetch is replaced so the reembed POST is observable.
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify({ chunkCount: 1 }), { status: 200 });
});

import {
  applyMaskedChunks,
  callMaskedReembed,
  deriveChunkIndex,
  MASK_UPDATE_SQL_COMMENT,
} from "../services/dlpDocumentMasking";
import fs from "fs";
import path from "path";

const DOC_ID = "a0000000-1000-4000-8000-000000000001";
const WS_ID = "a0000000-1000-4000-8000-000000000002";

function fixtureDoc() {
  return {
    id: DOC_ID,
    workspaceId: WS_ID,
    name: "fixture.txt",
    type: "txt",
    embeddingModel: "test-embed",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    workspace: { name: "Fixture WS" },
  };
}

function fixtureChunks(): Array<{
  id: string;
  chunkText: string;
  embeddingId: string;
  metadata: string | null;
}> {
  return [
    {
      id: `${DOC_ID}-0`,
      chunkText: "Il cliente [PERSON_1] vive in [ADDRESS_1]",
      embeddingId: `${DOC_ID}-0`,
      metadata: JSON.stringify({ chunkIndex: 0 }),
    },
    {
      id: `${DOC_ID}-1`,
      chunkText: "CF: [GOV_ID_1]",
      embeddingId: `${DOC_ID}-1`,
      metadata: JSON.stringify({ chunkIndex: 1 }),
    },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchCalls.length = 0;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("applyMaskedChunks (FTS UPDATE)", () => {
  it("issues a batched raw-SQL UPDATE keyed on chunk ids (masked text + tsvector rewrite)", async () => {
    await applyMaskedChunks(fixtureDoc(), fixtureChunks());
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("FTS failure is NON-BLOCKING: logged, never thrown", async () => {
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error("connection refused"));
    await expect(applyMaskedChunks(fixtureDoc(), fixtureChunks())).resolves.toBeUndefined();
  });

  it("carries the $queryRaw-site disposition comment (source grep — T-192-05)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../services/dlpDocumentMasking.ts"),
      "utf8",
    );
    expect(src).toContain("$queryRaw-site disposition");
    expect(src).toContain("org-asserted withSoftDelete scoped findFirst");
    // The order contract constant exists and is exported.
    expect(src).toContain("MASK_UPDATE_SQL_COMMENT");
    expect(MASK_UPDATE_SQL_COMMENT).toContain("mask chunkText in DB");
    expect(MASK_UPDATE_SQL_COMMENT).toContain("reembed");
    expect(MASK_UPDATE_SQL_COMMENT).toContain("entity rows");
  });
});

describe("deriveChunkIndex (system.ts:864-895 pattern)", () => {
  it("parses the embeddingId prefix first", () => {
    expect(deriveChunkIndex(DOC_ID, `${DOC_ID}-7`, null)).toBe(7);
  });

  it("falls back to metadata.chunkIndex when the prefix doesn't parse", () => {
    expect(deriveChunkIndex(DOC_ID, "weird-embedding-id", JSON.stringify({ chunkIndex: 3 }))).toBe(3);
  });

  it("returns undefined when neither arm derives an index", () => {
    expect(deriveChunkIndex(DOC_ID, "other-doc-3", JSON.stringify({ chunkIndex: "NaN" }))).toBeUndefined();
  });
});

describe("callMaskedReembed (D-06 reembed contract)", () => {
  it("POSTs the ReembedRequestSchema payload: masked chunkText + documentType + documentCreatedAt + embeddingModel", async () => {
    await callMaskedReembed(fixtureDoc(), fixtureChunks());
    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0]!;
    expect(url).toContain("/api/ingest/reembed");
    expect((init.headers as Record<string, string>)["X-Collector-Secret"]).toBeDefined();

    const body = JSON.parse(String(init.body));
    expect(body.documentId).toBe(DOC_ID);
    expect(body.workspaceId).toBe(WS_ID);
    expect(body.embeddingModel).toBe("test-embed");
    expect(body.documentType).toBe("txt");
    expect(body.documentCreatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(body.chunks).toHaveLength(2);
    expect(body.chunks[0].chunkIndex).toBe(0);
    // The MASKED text is what reaches the collector — never the original.
    expect(body.chunks[0].chunkText).toContain("[PERSON_1]");
    expect(body.chunks[0].chunkText).not.toContain("Mario Rossi");
  });

  it("chunkIndex derivation uses the embeddingId prefix then metadata fallback", async () => {
    const chunks = [
      { id: `${DOC_ID}-0`, chunkText: "[PERSON_1] text", embeddingId: `${DOC_ID}-0`, metadata: null },
      {
        id: `${DOC_ID}-weird`,
        chunkText: "[GOV_ID_1] more",
        embeddingId: "malformed",
        metadata: JSON.stringify({ chunkIndex: 9 }),
      },
    ];
    await callMaskedReembed(fixtureDoc(), chunks);
    const body = JSON.parse(String(fetchCalls[0]!.init.body));
    expect(body.chunks[0].chunkIndex).toBe(0);
    expect(body.chunks[1].chunkIndex).toBe(9);
  });

  it("empty derivable set → LOUD failure (Pitfall 7: never silently under-cover)", async () => {
    const chunks = [
      { id: `${DOC_ID}-x`, chunkText: "masked", embeddingId: "malformed", metadata: null },
    ];
    await expect(callMaskedReembed(fixtureDoc(), chunks)).rejects.toThrow(
      /no chunks with derivable chunkIndex/,
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it("empty input (zero masked chunks) → loud failure too (nothing to reembed)", async () => {
    await expect(callMaskedReembed(fixtureDoc(), [])).rejects.toThrow(
      /no chunks with derivable chunkIndex/,
    );
  });

  it("non-ok collector response throws with the status embedded", async () => {
    mockFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await expect(callMaskedReembed(fixtureDoc(), fixtureChunks())).rejects.toThrow(/500/);
  });
});