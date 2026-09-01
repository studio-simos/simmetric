// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Web Search Service (Phase 99, WEB-01)
 *
 * SearXNG primary (air-gap, axios GET /search?format=json) + Tavily optional
 * cloud (Plan 02). Double gate: ALLOW_WEB_SEARCH env (deploy-time hard gate,
 * default false) → web_search_provider SystemConfig (admin-editable, default
 * "searxng"). Phase 140 (EPA-02) removed the web_search LICENSE flag — web
 * search is always-ON by license when the env hard-gate allows it.
 *
 * Results map to SourceCitation[] with source: "web" (Phase 90 widened union).
 * Snippets are marked [untrusted] in the tool response data (Pitfall 12
 * prompt-injection defense). Bounded fetch: 10s timeout, max 5 results,
 * 200-char snippet truncation. Audit log web.search.run fires on every call.
 * NO page content fetch — only search results (title + URL + snippet).
 */

import axios from "axios";
import type { SourceCitation } from "@simmetric-chat/shared";
import { getEnv } from "../config/env";
import { getSetting } from "./systemConfigService";
import { logEvent } from "./eventLogService";
import { logger } from "../utils/logger";
import type { SkillResult } from "../agent/skills";

const MAX_RESULTS = 5;
const SNIPPET_MAX_CHARS = 200;
const REQUEST_TIMEOUT_MS = 10_000;

interface SearXNGResult {
  url: string;
  title: string;
  content?: string;
  score?: number;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilySearchResponse {
  results?: TavilyResult[];
}

/**
 * Search the web via SearXNG (air-gap primary) or Tavily (Plan 02).
 * Triple-gated: env + license + SystemConfig provider. Returns SkillResult with
 * SourceCitation[] (source: "web") and [untrusted]-marked snippets.
 */
export async function searchWeb(
  query: string,
  params: { userId: string; chatId?: string; workspaceId?: string },
): Promise<SkillResult> {
  const startTime = Date.now();
  const { userId, chatId } = params;

  // Gate 1: env hard gate (D-06 — default OFF)
  if (!getEnv().ALLOW_WEB_SEARCH) {
    return { success: false, error: "Web search disabled" };
  }

  // Phase 140 (EPA-02): the web_search LICENSE flag gate is removed — web
  // search is always-ON by license when the env hard-gate allows it. The
  // env gate above is the deploy-time control; the SystemConfig provider
  // selection below is the admin runtime control.

  // Gate 2: SystemConfig provider selection (D-07 — default "searxng")
  const providerSetting = await getSetting("web_search_provider");
  const provider = providerSetting.value || "searxng";

  let result: SkillResult;

  if (provider === "searxng") {
    result = await searchSearXNG(query);
  } else if (provider === "tavily") {
    result = await searchTavily(query, params);
  } else {
    result = { success: false, error: `Unknown web search provider: ${provider}` };
  }

  // Audit log (D-05) — fires on every call regardless of success/failure
  const durationMs = Date.now() - startTime;
  const resultCount =
    result.success && Array.isArray(result.sources) ? result.sources.length : 0;
  await logEvent("chat", chatId || "", "web.search.run", userId || null, {
    query,
    provider,
    resultCount,
    durationMs,
    ...(result.error ? { error: result.error } : {}),
  });

  return result;
}

/**
 * SearXNG search via axios GET /search?format=json.
 * Bounded fetch: 10s timeout, max 5 results, 200-char snippet truncation.
 * [untrusted] marker on all snippets (Pitfall 12 prompt-injection defense).
 */
async function searchSearXNG(query: string): Promise<SkillResult> {
  // Resolve SearXNG URL: SystemConfig > ENV > Default (D-06)
  const searxngUrlSetting = await getSetting("searxng_url");
  const searxngUrl = searxngUrlSetting.value || getEnv().SEARXNG_URL;

  try {
    const resp = await axios.get<SearXNGResponse>(searxngUrl, {
      params: { q: query, format: "json", pageno: 1 },
      timeout: REQUEST_TIMEOUT_MS,
      // Accept only 200 — SearXNG returns 403 when JSON format is not enabled
      // in settings.yml search.formats; validateStatus: s < 500 would silently
      // accept it leaving resp.data.results undefined (RESEARCH Open Question 1).
      validateStatus: (s: number) => s === 200,
    });

    // Defensive shape check (must_truther)
    if (!resp.data?.results) {
      return { success: false, error: "Web search failed: invalid response from SearXNG" };
    }

    const allResults = resp.data.results;
    const boundedResults = allResults.slice(0, MAX_RESULTS);

    // SourceCitation[] mapping with source: "web" (Phase 90)
    const sources: SourceCitation[] = boundedResults.map((r: SearXNGResult) => {
      const snippet = (r.content || "").slice(0, SNIPPET_MAX_CHARS);
      return {
        documentId: r.url || "",
        documentName: r.title || "Untitled",
        chunkText: snippet,
        score: typeof r.score === "number" ? r.score : 0,
        source: "web" as const,
      };
    });

    // Tool response data with [untrusted] marker (Pitfall 12 — LLM sees as data,
    // not instructions; marker prevents prompt-injection from search results)
    const textChunks = boundedResults
      .map((r: SearXNGResult, i: number) => {
        const snippet = (r.content || "").slice(0, SNIPPET_MAX_CHARS);
        return `[untrusted] [Web Result ${i + 1}: ${r.title || "Untitled"} (${r.url || "no URL"})]\n[untrusted] ${snippet}`;
      })
      .join("\n\n---\n\n");

    return { success: true, data: textChunks, sources };
  } catch (err: unknown) {
    // 403 — SearXNG JSON format not enabled
    if (err && typeof err === "object" && "response" in err) {
      const axiosErr = err as { response?: { status?: number } };
      if (axiosErr.response?.status === 403) {
        return {
          success: false,
          error: "SearXNG JSON format not enabled — check settings.yml search.formats",
        };
      }
    }
    // Timeout (D-04 — non-blocking, fire-and-forget)
    if (err && typeof err === "object" && "code" in err) {
      const axiosErr = err as { code?: string };
      if (axiosErr.code === "ETIMEDOUT" || axiosErr.code === "ECONNABORTED") {
        return { success: false, error: "Web search timeout" };
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Web search failed: ${message}` };
  }
}

/**
 * Tavily search via lazy `await import("@tavily/core")`.
 * Air-gap enforcement (D-06): API key check BEFORE any import/HTTP call —
 * if TAVILY_API_KEY is unset, returns error with zero network calls (no DNS
 * leak). The SDK import is lazy (only when Tavily is selected), so air-gap
 * deployments never load the module. Bounded fetch: max 5 results, 200-char
 * snippet truncation, [untrusted] marker (same as SearXNG path).
 */
async function searchTavily(
  query: string,
  _params: { userId: string; chatId?: string },
): Promise<SkillResult> {
  // D-06 — air-gap: key check BEFORE any HTTP/import (no DNS leak)
  const tavilyKey = getEnv().TAVILY_API_KEY;
  if (!tavilyKey) {
    return { success: false, error: "Tavily API key not configured" };
  }

  // Pitfall 5 — ESM in CJS server: lazy import only when Tavily selected.
  // If the SDK is not installed, the import throws — caught and returned as
  // a graceful error (no crash). SWC transpiles `await import()` to
  // `require()` in CommonJS, so this works in the server's CJS build.
  let client: { search: (q: string, opts: { maxResults: number }) => Promise<TavilySearchResponse> };
  try {
    const mod = await import("@tavily/core");
    client = mod.tavily({ apiKey: tavilyKey });
  } catch (importErr) {
    logger.warn("[web_search] Tavily SDK not installed", {
      error: importErr instanceof Error ? importErr.message : String(importErr),
    });
    return { success: false, error: "Tavily SDK not installed" };
  }

  try {
    const response = await client.search(query, { maxResults: MAX_RESULTS });

    if (!response?.results) {
      return { success: false, error: "Web search failed: invalid response from Tavily" };
    }

    const boundedResults = response.results.slice(0, MAX_RESULTS);

    const sources: SourceCitation[] = boundedResults.map((r: TavilyResult) => {
      const snippet = (r.content || "").slice(0, SNIPPET_MAX_CHARS);
      return {
        documentId: r.url || "",
        documentName: r.title || "Untitled",
        chunkText: snippet,
        score: typeof r.score === "number" ? r.score : 0,
        source: "web" as const,
      };
    });

    const textChunks = boundedResults
      .map((r: TavilyResult, i: number) => {
        const snippet = (r.content || "").slice(0, SNIPPET_MAX_CHARS);
        return `[untrusted] [Web Result ${i + 1}: ${r.title || "Untitled"} (${r.url || "no URL"})]\n[untrusted] ${snippet}`;
      })
      .join("\n\n---\n\n");

    return { success: true, data: textChunks, sources };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const axiosErr = err as { code?: string };
      if (axiosErr.code === "ETIMEDOUT" || axiosErr.code === "ECONNABORTED") {
        return { success: false, error: "Web search timeout" };
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Web search failed: ${message}` };
  }
}