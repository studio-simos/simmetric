// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * memory_search skill tests — Phase 97 (MEM-02 SC2)
 *
 * Verifies the memory_search builtin skill:
 *   - Queries the collector /api/ingest/query with the per-user-per-workspace
 *     collection namespace `user_memory_<userId>_<workspaceId>` (Pitfall 3).
 *   - Tags every returned SourceCitation with `source: "memory"` (Phase 90).
 *   - Returns a structured "No memories found" message on empty results.
 *   - Returns a structured error on collector failure (best-effort, never throws).
 *   - Rejects calls missing query / userId / workspaceId.
 *
 * The skill is registered on import of `../agent/builtinSkills`, so this suite
 * imports that module first to populate the registry, then retrieves the
 * `memory_search` skill via `getSkill`.
 */
jest.mock("../../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
}));
jest.mock("../../services/archivePageService", () => ({ getPage: jest.fn() }));
jest.mock("../../services/wikiWriteService", () => ({ generatePreview: jest.fn() }));
jest.mock("../../utils/prisma", () => ({
  __esModule: true,
  default: {
    workspace: { findUnique: jest.fn() },
    document: { findMany: jest.fn().mockResolvedValue([]) },
    systemConfig: { upsert: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    archivePage: { findFirst: jest.fn() },
  },
}));
jest.mock("../../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-secret",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  })),
}));
jest.mock("../../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock axios at the module level — the skill uses the axios default export.
// The mock fn lives INSIDE the factory to avoid TDZ under @swc/jest.
jest.mock("axios", () => {
  const post = jest.fn();
  return { __esModule: true, default: { post } };
});
const axiosModule = require("axios");
const mockAxiosPost = axiosModule.default.post as jest.Mock;

import "../../agent/builtinSkills";
import { getSkill } from "../../agent/skills";
import type { SkillParams, SkillResult } from "../../agent/skills";

const memorySearch = getSkill("memory_search");

function baseParams(overrides: Partial<SkillParams> = {}): SkillParams {
  return {
    workspaceId: "ws-1",
    userId: "user-1",
    query: "what did I say about dark mode",
    ...overrides,
  };
}

function makeMemoryResult(id: string, content: string, path: string | null = null, sensitivity = "low") {
  return {
    id,
    documentId: id,
    content,
    chunkText: content,
    score: 0.42,
    metadata: { type: "preference", path, sensitivity },
  };
}

describe("memory_search skill (Phase 97 MEM-02 SC2)", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  it("is registered as a builtin skill", () => {
    expect(memorySearch).toBeDefined();
    expect(memorySearch!.name).toBe("memory_search");
    expect(memorySearch!.type).toBe("builtin");
    expect(memorySearch!.inputSchema).toBeDefined();
    expect((memorySearch!.inputSchema as any).required).toEqual(["query"]);
  });

  it("queries the per-user-per-workspace collection namespace (Pitfall 3)", async () => {
    mockAxiosPost.mockResolvedValueOnce({
      status: 200,
      data: { results: [makeMemoryResult("m1", "User prefers dark mode")] },
    });

    const result = (await memorySearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    // The collector /api/ingest/query `workspaceId` body field MUST be the
    // full `user_memory_<userId>_<workspaceId>` string (Pitfall 3 — per-user-
    // per-workspace, NEVER user-global).
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [, body] = mockAxiosPost.mock.calls[0]!;
    expect(body.workspaceId).toBe("user_memory_user-1_ws-1");
    expect(body.query).toBe("what did I say about dark mode");
  });

  it("tags every returned citation with source: 'memory' (Phase 90)", async () => {
    mockAxiosPost.mockResolvedValueOnce({
      status: 200,
      data: {
        results: [
          makeMemoryResult("m1", "Prefers dark mode", "ui.theme"),
          makeMemoryResult("m2", "Likes terse answers", "style.tone"),
        ],
      },
    });

    const result = (await memorySearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(2);
    for (const s of result.sources!) {
      expect(s.source).toBe("memory");
    }
    expect(result.sources![0]!.documentName).toBe("ui.theme");
    expect(result.sources![1]!.documentName).toBe("style.tone");
  });

  it("returns a structured 'No memories found' message on empty results", async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    const result = (await memorySearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toEqual([]);
    expect(typeof result.data).toBe("string");
    expect(result.data as string).toContain("No memories found");
  });

  it("returns a structured 'No memories found' message on collector 4xx", async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 404, data: null });

    const result = (await memorySearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.data as string).toContain("No memories found");
  });

  it("returns a structured error on collector exception (best-effort, never throws)", async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = (await memorySearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Memory search failed");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("rejects calls missing the query parameter", async () => {
    const result = (await memorySearch!.execute(baseParams({ query: undefined }))) as SkillResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain("query parameter is required");
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it("rejects calls missing userId or workspaceId (Pitfall 3 guard)", async () => {
    const noUser = (await memorySearch!.execute(baseParams({ userId: "" }))) as SkillResult;
    expect(noUser.success).toBe(false);
    expect(noUser.error).toContain("requires userId and workspaceId");

    const noWs = (await memorySearch!.execute(baseParams({ workspaceId: "" }))) as SkillResult;
    expect(noWs.success).toBe(false);
    expect(noWs.error).toContain("requires userId and workspaceId");

    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it("formats memory text chunks with the path tag when present", async () => {
    mockAxiosPost.mockResolvedValueOnce({
      status: 200,
      data: {
        results: [
          makeMemoryResult("m1", "User prefers dark mode", "ui.theme"),
          makeMemoryResult("m2", "Likes concise answers", null),
        ],
      },
    });

    const result = (await memorySearch!.execute(baseParams())) as SkillResult;

    expect(result.success).toBe(true);
    const data = result.data as string;
    expect(data).toContain("path: ui.theme");
    expect(data).toContain("Memory 1");
    expect(data).toContain("Memory 2");
  });
});