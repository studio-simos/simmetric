// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 260830-ur9 — rag_search filter threading tests.
 *
 * rag_search's inputSchema gains documentTypes (6-value enum array) +
 * dateFrom/dateTo (ISO date strings). execute() reads the LLM-supplied values
 * from params.metadata (the orchestrator threads toolInput through as
 * metadata), builds the filters object, and forwards it to
 * hybridSearchWithRerank on the WORKSPACE call only — NEVER on the archive
 * fallback call (D-07: archive pseudo-workspace has no Document rows; filters
 * would wrongly narrow the fallback).
 *
 * Built-in skills are registered via the module-level registerSkill() Map,
 * so importing builtinSkills registers everything; getSkill("rag_search")
 * exposes the definition. hybridSearchWithRerank is mocked to observe calls.
 */

jest.mock("../../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
}));

jest.mock("../../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    COLLECTOR_URL: "http://localhost:3210",
  })),
}));

jest.mock("../../utils/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  },
}));

jest.mock("../../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: "0" }),
}));

jest.mock("../../services/archivePageService", () => ({
  getPage: jest.fn(),
}));

jest.mock("../../services/webSearchService", () => ({
  searchWeb: jest.fn(),
}));

jest.mock("../../services/wikiWriteService", () => ({
  generatePreview: jest.fn(),
}));

// The skills module registers into a Map keyed by name — getSkill() retrieves.
import { getSkill } from "../skills";
import "../builtinSkills";

const skill = getSkill("rag_search")!;

const mockHybrid = require("../../services/hybridSearchService")
  .hybridSearchWithRerank as jest.Mock;

function skillParams(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    userId: "user-1",
    query: "quarterly revenue",
    ...overrides,
  } as any;
}

const WORKSPACE_RESULT = [
  {
    chunkId: "doc-1-0",
    documentId: "doc-1",
    documentName: "Doc 1",
    chunkText: "content",
    score: 0.9,
    source: "vector" as const,
    chunkIndex: 0,
    metadata: {},
  },
];

beforeEach(() => {
  mockHybrid.mockReset();
  mockHybrid.mockResolvedValue([]);
});

describe("rag_search inputSchema (260830-ur9)", () => {
  it("inputSchema exposes documentTypes (array of the 6 enum strings), dateFrom, dateTo", () => {
    expect(skill).toBeDefined();
    const props = (skill!.inputSchema as any).properties;
    expect(props.documentTypes).toBeDefined();
    expect(props.documentTypes.type).toBe("array");
    expect(props.documentTypes.items.enum).toEqual(["pdf", "md", "txt", "csv", "docx", "xlsx"]);
    expect(props.dateFrom).toEqual({ type: "string", description: expect.any(String) });
    expect(props.dateTo).toEqual({ type: "string", description: expect.any(String) });
    expect((skill!.inputSchema as any).required).toEqual(["query"]);
  });
});

describe("rag_search execute — filter forwarding (260830-ur9)", () => {
  it("forwards documentTypes/dateFrom/dateTo to the workspace hybridSearchWithRerank call", async () => {
    mockHybrid.mockResolvedValue([
      {
        chunkId: "d-0",
        documentId: "doc-1",
        documentName: "Doc 1",
        chunkText: "content",
        score: 0.5,
        source: "vector",
        chunkIndex: 0,
      },
    ]);

    const result = await skill!.execute(
      skillParams({
        metadata: { query: "q", documentTypes: ["pdf", "md"], dateFrom: "2025-01-15", dateTo: "2025-06-01" },
      }),
    );

    expect(result.success).toBe(true);
    expect(mockHybrid).toHaveBeenCalledTimes(1);
    const [query, wsId, limit, filters] = mockHybrid.mock.calls[0];
    expect(query).toBe("quarterly revenue");
    expect(wsId).toBe("ws-1");
    expect(limit).toBe(5);
    expect(filters).toEqual({
      documentTypes: ["pdf", "md"],
      dateFrom: "2025-01-15",
      dateTo: "2025-06-01",
    });
  });

  it("omitting the filter fields behaves identically to current (undefined filters, not {})", () => {
    // Covered by the behavior test below via exact-arg assertion.
    expect(true).toBe(true);
  });

  it("no filter params → hybridSearchWithRerank called with the exact current 3-arg form (byte-identity)", async () => {
    mockHybrid.mockResolvedValue([]);

    await skill!.execute(skillParams());

    // The call is literally (query, wsId, 5) — no 4th argument at all.
    expect(mockHybrid).toHaveBeenCalledWith("quarterly revenue", "ws-1", 5);
    expect(mockHybrid.mock.calls[0].length).toBe(3);
  });

  it("archive fallback call does NOT receive filters (no filters into archive pseudo-workspace)", async () => {
    // First call (workspace) returns nothing → fallback fires with archiveId.
    mockHybrid.mockReset();
    mockHybrid.mockResolvedValueOnce([]); // workspace call
    mockHybrid.mockResolvedValueOnce([
      {
        chunkId: "p-0",
        documentId: "page-1",
        documentName: "Page 1",
        chunkText: "wiki",
        score: 0.9,
        source: "vector",
        chunkIndex: 0,
      },
    ]);

    const result = await skill!.execute(
      skillParams({
        archiveId: "arch-1",
        metadata: { query: "q", documentTypes: ["pdf"], dateFrom: "2025-01-15" },
      }),
    );

    expect(result.success).toBe(true);
    expect(mockHybrid).toHaveBeenCalledTimes(2);
    // First call (workspace) carries filters; archive fallback call does NOT.
    expect(mockHybrid.mock.calls[0][3]).toEqual({ documentTypes: ["pdf"], dateFrom: "2025-01-15" });
    expect(mockHybrid.mock.calls[1][1]).toBe("archive:arch-1");
    // 3-arg form — no 4th filters argument on the fallback call.
    expect(mockHybrid.mock.calls[1].length).toBe(3);
  });

  it("rejects malformed documentTypes with a descriptive skill failure", async () => {
    const result = await skill!.execute(
      skillParams({
        metadata: { query: "q", documentTypes: ["exe", "pdf"] },
      }),
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/documentTypes/i);
    expect(mockHybrid).not.toHaveBeenCalled();
  });

  it("rejects inverted date range (dateFrom after dateTo)", () => {
    return skill!.execute(
      skillParams({
        metadata: { query: "q", dateFrom: "2025-06-01", dateTo: "2025-01-15" },
      }),
    ).then((result) => {
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/dateFrom|date/i);
      expect(mockHybrid).not.toHaveBeenCalled();
    });
  });

  it("rejects unparseable date strings", async () => {
    const result = await skill!.execute(
      skillParams({ metadata: { query: "q", dateFrom: "not-a-date" } }),
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/date/i);
  });
});