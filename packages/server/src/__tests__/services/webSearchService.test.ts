// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * webSearchService tests — Phase 99, WEB-01 (Plan 99-01 tracer)
 *
 * 19 unit tests covering: env gate, provider selection, bounded fetch,
 * [untrusted] marker, SourceCitation mapping, audit log, timeout, SearXNG URL
 * resolution, skill registration, SearXNG 403, invalid shape, Tavily paths.
 * Phase 140 (EPA-02) removed the license-gate test — web search is always-ON
 * by license when the env hard-gate allows it. All external deps mocked — no
 * real HTTP, no DB, no license server.
 */

// Mock axios BEFORE importing the service so the module-level import picks up
// the mock. Factory lives outside to avoid TDZ under @swc/jest.
jest.mock("axios", () => ({
  get: jest.fn(),
}));
const mockAxiosGet = require("axios").get as jest.Mock;

// Mock @tavily/core — the service lazy-imports it via `await import(...)`.
// In the CJS-compiled server build, SWC transpiles dynamic `import()` down to
// `require()`, so `jest.mock("@tavily/core", factory)` intercepts it. The
// factory returns a mock `tavily` factory function that builds a mock client.
// Per-test overrides via `mockTavilyFactory.mockImplementation(...)` cover the
// happy path, the air-gap no-call assertion, and the import-throws case.
const mockTavilySearch = jest.fn();
const mockTavilyClient = { search: mockTavilySearch };
const mockTavilyFactory = jest.fn(() => mockTavilyClient);
jest.mock("@tavily/core", () => ({
  tavily: mockTavilyFactory,
}));

// Mock env — default ALLOW_WEB_SEARCH=true so gate 1 passes; individual tests
// override as needed.
jest.mock("../../config/env", () => ({
  getEnv: jest.fn(() => ({
    ALLOW_WEB_SEARCH: true,
    SEARXNG_URL: "http://localhost:8888",
    TAVILY_API_KEY: undefined,
  })),
}));
const mockGetEnv = require("../../config/env").getEnv as jest.Mock;

// Mock systemConfigService.getSetting — default provider "searxng", no URL override
jest.mock("../../services/systemConfigService", () => ({
  getSetting: jest.fn(async (key: string) => {
    if (key === "web_search_provider") return { key, value: "searxng", readOnly: false };
    if (key === "searxng_url") return { key, value: "", readOnly: false };
    return { key, value: "", readOnly: false };
  }),
}));
const mockGetSetting = require("../../services/systemConfigService").getSetting as jest.Mock;

// Mock eventLogService.logEvent — fire-and-forget, just capture calls
jest.mock("../../services/eventLogService", () => ({
  logEvent: jest.fn(async () => {}),
}));
const mockLogEvent = require("../../services/eventLogService").logEvent as jest.Mock;

import { searchWeb } from "../../services/webSearchService";
import type { SkillResult } from "../../agent/skills";

function makeSearXNGResult(
  url: string,
  title: string,
  content: string,
  score?: number,
) {
  return { url, title, content, score };
}

function baseParams(overrides: Partial<{ userId: string; chatId: string; workspaceId: string }> = {}) {
  return {
    query: "test query",
    params: {
      userId: "user-1",
      chatId: "chat-1",
      workspaceId: "ws-1",
      ...overrides,
    },
  };
}

describe("webSearchService (Phase 99, WEB-01)", () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
    mockGetEnv.mockReset();
    mockGetSetting.mockReset();
    mockLogEvent.mockReset();
    mockTavilySearch.mockReset();
    mockTavilyFactory.mockReset();
    mockTavilyFactory.mockReturnValue(mockTavilyClient);

    // Re-establish defaults after reset
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: undefined,
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "searxng", readOnly: false };
      if (key === "searxng_url") return { key, value: "", readOnly: false };
      return { key, value: "", readOnly: false };
    });
  });

  // (1) env gate — ALLOW_WEB_SEARCH=false → returns error, no axios call
  it("env gate: ALLOW_WEB_SEARCH=false returns { success: false, error: 'Web search disabled' } with no axios call", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: false,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: undefined,
    });
    const { query, params } = baseParams();
    const result = await searchWeb(query, params);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Web search disabled");
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  // (2) provider selection — getSetting returns "searxng" → axios.get called with SEARXNG_URL/search
  it("provider selection: searxng provider calls axios.get with correct URL and params", async () => {
    const searxngResults = [
      makeSearXNGResult("http://example.com/1", "Result 1", "Snippet 1", 0.9),
    ];
    mockAxiosGet.mockResolvedValue({ data: { results: searxngResults } });

    const { query, params } = baseParams();
    await searchWeb(query, params);

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      "http://localhost:8888",
      expect.objectContaining({
        params: expect.objectContaining({ q: "test query", format: "json", pageno: 1 }),
      }),
    );
  });

  // (4) bounded fetch — timeout 10s, max 5 results, 200-char snippets
  it("bounded fetch: axios called with timeout 10000, results truncated to 5, snippets truncated to 200 chars", async () => {
    const longSnippet = "x".repeat(500);
    const sixResults = Array.from({ length: 6 }, (_, i) =>
      makeSearXNGResult(`http://example.com/${i}`, `Result ${i}`, longSnippet, 0.5),
    );
    mockAxiosGet.mockResolvedValue({ data: { results: sixResults } });

    const { query, params } = baseParams();
    const result = (await searchWeb(query, params)) as SkillResult;

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(5);
    // Each snippet truncated to 200 chars
    for (const src of result.sources!) {
      expect((src.chunkText || "").length).toBeLessThanOrEqual(200);
    }
  });

  // (5) [untrusted] marker — tool response data contains [untrusted] prefix
  it("[untrusted] marker: tool response data contains [untrusted] prefix on each snippet", async () => {
    const results = [
      makeSearXNGResult("http://example.com/1", "Result 1", "Some snippet", 0.8),
    ];
    mockAxiosGet.mockResolvedValue({ data: { results } });

    const { query, params } = baseParams();
    const result = (await searchWeb(query, params)) as SkillResult;

    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
    expect(result.data as string).toContain("[untrusted]");
  });

  // (6) SourceCitation mapping — source: "web" on every entry
  it("SourceCitation mapping: sources array has source: 'web' on every entry", async () => {
    const results = [
      makeSearXNGResult("http://example.com/1", "Title 1", "Snippet 1", 0.9),
      makeSearXNGResult("http://example.com/2", "Title 2", "Snippet 2", 0.7),
    ];
    mockAxiosGet.mockResolvedValue({ data: { results } });

    const { query, params } = baseParams();
    const result = (await searchWeb(query, params)) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.sources![0]!.source).toBe("web");
    expect(result.sources![1]!.source).toBe("web");
    expect(result.sources![0]!.documentId).toBe("http://example.com/1");
    expect(result.sources![0]!.documentName).toBe("Title 1");
  });

  // (7) audit log — logEvent called with entityType "chat", action "web.search.run"
  it("audit log: logEvent called with entityType 'chat', action 'web.search.run', metadata with query/provider/resultCount/durationMs", async () => {
    const results = [
      makeSearXNGResult("http://example.com/1", "Result 1", "Snippet", 0.5),
    ];
    mockAxiosGet.mockResolvedValue({ data: { results } });

    const { query, params } = baseParams();
    await searchWeb(query, params);

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const callArgs = mockLogEvent.mock.calls[0];
    expect(callArgs[0]).toBe("chat");
    expect(callArgs[2]).toBe("web.search.run");
    const metadata = callArgs[4] as Record<string, unknown>;
    expect(metadata.query).toBe("test query");
    expect(metadata.provider).toBe("searxng");
    expect(metadata.resultCount).toBe(1);
    expect(metadata.durationMs).toBeDefined();
  });

  // (8) timeout — axios rejects with ETIMEDOUT → { success: false, error: 'Web search timeout' }
  it("timeout: axios rejects with ETIMEDOUT returns { success: false, error: 'Web search timeout' }", async () => {
    const timeoutErr = new Error("timeout");
    (timeoutErr as any).code = "ETIMEDOUT";
    mockAxiosGet.mockRejectedValue(timeoutErr);

    const { query, params } = baseParams();
    const result = await searchWeb(query, params);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Web search timeout");
  });

  // (9) SearXNG URL resolution — SystemConfig searxng_url set → uses it
  it("SearXNG URL resolution: SystemConfig searxng_url set → uses it; unset → falls back to SEARXNG_URL env", async () => {
    // Test SystemConfig override
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "searxng", readOnly: false };
      if (key === "searxng_url") return { key, value: "http://searxng.override:9999", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });

    const { query, params } = baseParams();
    await searchWeb(query, params);

    expect(mockAxiosGet).toHaveBeenCalledWith(
      "http://searxng.override:9999",
      expect.anything(),
    );

    // Test ENV fallback
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "searxng", readOnly: false };
      if (key === "searxng_url") return { key, value: "", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    mockAxiosGet.mockClear();
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });

    await searchWeb(query, params);

    expect(mockAxiosGet).toHaveBeenCalledWith(
      "http://localhost:8888",
      expect.anything(),
    );
  });

  // (10) skill registration — getSkill("web_search") returns the definition
  it("skill registration: getSkill('web_search') returns definition with inputSchema.properties.query and required: ['query']", async () => {
    // Reset module registry to get a clean state
    jest.resetModules();

    // Re-mock dependencies for the re-import
    jest.doMock("axios", () => ({ get: jest.fn() }));
    jest.doMock("../../services/hybridSearchService", () => ({
      hybridSearchWithRerank: jest.fn(),
    }));
    jest.doMock("../../services/archivePageService", () => ({ getPage: jest.fn() }));
    jest.doMock("../../services/wikiWriteService", () => ({ generatePreview: jest.fn() }));
    jest.doMock("../../services/webSearchService", () => ({
      searchWeb: jest.fn(),
    }));
    jest.doMock("../../utils/prisma", () => ({
      __esModule: true,
      default: {
        workspace: { findUnique: jest.fn() },
        document: { findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { upsert: jest.fn(), findUnique: jest.fn() },
        user: { findUnique: jest.fn() },
        archivePage: { findFirst: jest.fn() },
      },
    }));
    jest.doMock("../../config/env", () => ({
      getEnv: jest.fn(() => ({
        JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
        NODE_ENV: "test",
        SERVER_PORT: 3000,
        COLLECTOR_URL: "http://localhost:3210",
        COLLECTOR_SECRET: "test-secret",
      })),
    }));
    jest.doMock("../../utils/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));

    const { _clearAllSkills, getSkill } = require("../../agent/skills");
    _clearAllSkills();
    // Import builtinSkills to trigger registration (side-effect import)
    require("../../agent/builtinSkills");

    const skill = getSkill("web_search");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("web_search");
    expect(skill!.inputSchema).toBeDefined();
    const schema = skill!.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect((props.query as Record<string, unknown>).type).toBe("string");
    expect(schema.required).toEqual(["query"]);
  });

  // (11) SearXNG 403 — axios rejects with response.status === 403 → clear error
  it("SearXNG 403: returns { success: false, error: 'SearXNG JSON format not enabled — check settings.yml search.formats' }", async () => {
    const err403 = new Error("Request failed with status code 403");
    (err403 as any).response = { status: 403 };
    mockAxiosGet.mockRejectedValue(err403);

    const { query, params } = baseParams();
    const result = await searchWeb(query, params);

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "SearXNG JSON format not enabled — check settings.yml search.formats",
    );
  });

  // (12) SearXNG invalid shape — resp.data missing results → clear error
  it("SearXNG invalid shape: resp.data missing 'results' returns { success: false, error: 'invalid response from SearXNG' }", async () => {
    mockAxiosGet.mockResolvedValue({ data: { unexpected: "shape" } });

    const { query, params } = baseParams();
    const result = await searchWeb(query, params);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Web search failed: invalid response from SearXNG");
  });

  // ── Tavily provider (Plan 02) ──

  // (13) Tavily happy path — key set, provider tavily → TavilyClient.search called
  //      with maxResults:5 → SourceCitation[] with source:"web"
  it("Tavily happy path: key set + provider tavily → search called with maxResults:5, returns sources with source:'web'", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: "test-key",
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "tavily", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    mockTavilySearch.mockResolvedValue({
      results: [
        { title: "Test", url: "https://example.com", content: "Snippet", score: 0.95 },
      ],
    });

    const { query, params } = baseParams();
    const result = (await searchWeb(query, params)) as SkillResult;

    expect(result.success).toBe(true);
    expect(mockTavilyFactory).toHaveBeenCalledWith({ apiKey: "test-key" });
    expect(mockTavilySearch).toHaveBeenCalledWith("test query", expect.objectContaining({ maxResults: 5 }));
    expect(result.sources).toHaveLength(1);
    expect(result.sources![0]!.source).toBe("web");
    expect(result.sources![0]!.documentId).toBe("https://example.com");
    expect(result.sources![0]!.documentName).toBe("Test");
  });

  // (14) Tavily air-gap — key unset + provider tavily → error, zero HTTP calls
  //      (TavilyClient NOT instantiated — no DNS leak)
  it("Tavily air-gap: key unset + provider tavily → error 'Tavily API key not configured', TavilyClient NOT called", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: undefined,
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "tavily", readOnly: false };
      return { key, value: "", readOnly: false };
    });

    const { query, params } = baseParams();
    const result = await searchWeb(query, params);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tavily API key not configured");
    // Air-gap enforcement: TavilyClient factory NOT called (no import, no HTTP)
    expect(mockTavilyFactory).not.toHaveBeenCalled();
    expect(mockTavilySearch).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  // (15) Tavily SDK not installed — import throws → graceful error
  it("Tavily SDK not installed: import throws → { success: false, error: 'Tavily SDK not installed' }", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: "test-key",
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "tavily", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    // Make the tavily factory throw when accessed — simulates the SDK not
    // being installed. The service's `mod.tavily` access is inside a
    // try/catch, so the throw is caught and returned as a graceful error.
    mockTavilyFactory.mockImplementation(() => {
      throw new Error("Cannot find module '@tavily/core'");
    });

    const { query, params } = baseParams();
    const result = await searchWeb(query, params);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tavily SDK not installed");
  });

  // (16) Tavily [untrusted] marker — tool response data contains [untrusted]
  it("Tavily [untrusted]: tool response data contains [untrusted] marker on each snippet", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: "test-key",
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "tavily", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    mockTavilySearch.mockResolvedValue({
      results: [
        { title: "Result 1", url: "https://example.com/1", content: "Some snippet", score: 0.9 },
      ],
    });

    const { query, params } = baseParams();
    const result = (await searchWeb(query, params)) as SkillResult;

    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
    expect(result.data as string).toContain("[untrusted]");
  });

  // (17) Tavily audit — logEvent called with provider:"tavily" in metadata
  it("Tavily audit: logEvent called with provider 'tavily' in metadata", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: "test-key",
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "tavily", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    mockTavilySearch.mockResolvedValue({
      results: [
        { title: "Result 1", url: "https://example.com/1", content: "Snippet", score: 0.5 },
      ],
    });

    const { query, params } = baseParams();
    await searchWeb(query, params);

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const callArgs = mockLogEvent.mock.calls[0];
    expect(callArgs[0]).toBe("chat");
    expect(callArgs[2]).toBe("web.search.run");
    const metadata = callArgs[4] as Record<string, unknown>;
    expect(metadata.provider).toBe("tavily");
    expect(metadata.resultCount).toBe(1);
  });

  // (18) Tavily snippet truncation — content > 200 chars → chunkText is 200 chars
  it("Tavily snippet truncation: content > 200 chars → chunkText truncated to 200 chars", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: "test-key",
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "tavily", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    const longContent = "x".repeat(500);
    mockTavilySearch.mockResolvedValue({
      results: [
        { title: "Long", url: "https://example.com/long", content: longContent, score: 0.7 },
      ],
    });

    const { query, params } = baseParams();
    const result = (await searchWeb(query, params)) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect((result.sources![0]!.chunkText || "").length).toBeLessThanOrEqual(200);
  });

  // (19) SearXNG offline (air-gap, Phase 99 WEB-01 SC3) — provider "searxng",
  //      axios fully mocked (no real HTTP), TAVILY_API_KEY unset. Verifies the
  //      SearXNG path works with only the mocked axios call and returns results
  //      successfully with no real network dependency. The Tavily factory must
  //      NOT be touched (proves the code path never branches to the cloud SDK).
  it("SearXNG offline (air-gap): provider searxng + mocked axios + no TAVILY_API_KEY → success via mocked axios only, Tavily untouched", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: undefined,
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "searxng", readOnly: false };
      if (key === "searxng_url") return { key, value: "", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    const searxngResults = [
      makeSearXNGResult("http://example.com/offline-1", "Offline Result", "Air-gap snippet", 0.8),
    ];
    mockAxiosGet.mockResolvedValue({ data: { results: searxngResults } });

    const { query, params } = baseParams();
    const result = (await searchWeb(query, params)) as SkillResult;

    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources![0]!.source).toBe("web");
    expect(result.sources![0]!.documentName).toBe("Offline Result");
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      "http://localhost:8888",
      expect.objectContaining({
        params: expect.objectContaining({ q: "test query", format: "json" }),
        timeout: 10_000,
      }),
    );
    expect(mockTavilyFactory).not.toHaveBeenCalled();
    expect(mockTavilySearch).not.toHaveBeenCalled();
  });

  // (20) SearXNG offline with SystemConfig URL override — proves the offline
  //      path honors the DB-configured searxng_url, not just the ENV fallback.
  it("SearXNG offline (air-gap): SystemConfig searxng_url override is used by the mocked axios call", async () => {
    mockGetEnv.mockReturnValue({
      ALLOW_WEB_SEARCH: true,
      SEARXNG_URL: "http://localhost:8888",
      TAVILY_API_KEY: undefined,
    });
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "web_search_provider") return { key, value: "searxng", readOnly: false };
      if (key === "searxng_url") return { key, value: "http://searxng.internal:7777", readOnly: false };
      return { key, value: "", readOnly: false };
    });
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });

    const { query, params } = baseParams();
    const result = await searchWeb(query, params);

    expect(result.success).toBe(true);
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      "http://searxng.internal:7777",
      expect.objectContaining({ params: expect.objectContaining({ format: "json" }) }),
    );
    expect(mockTavilyFactory).not.toHaveBeenCalled();
  });
});