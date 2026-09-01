// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Builtin Skills Implementation
 *
 * Three core skills for the workspace agent:
 * 1. rag_search — queries the vector DB filtered by workspace_id
 * 2. workspace_memory — reads/writes persistent workspace notes
 * 3. document_temp_process — handles ad-hoc file uploads in chat
 */

import axios from "axios";
import { Prisma } from "@prisma/client";
import { registerSkill, type SkillParams, type SkillResult, type SourceCitation } from "./skills";
import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { hybridSearchWithRerank, type HybridSearchResult } from "../services/hybridSearchService";
import type { HybridSearchFilters } from "@simmetric-chat/shared";
import { RagMetadataFilterSchema } from "@simmetric-chat/shared";
import { getSetting } from "../services/systemConfigService";
import { getPage } from "../services/archivePageService";
import { generatePreview } from "../services/wikiWriteService";
import { searchWeb } from "../services/webSearchService";
import { MULTI_CONFIG_PLAINTO_TSQUERY } from "../services/ftsService";

// ===== 1. rag_search (Hybrid: Vector + FTS with RRF) =====
// D-07 (partially mutated, 260721-np3 Task 3): rag_search now falls back to the
// bound archive ONLY when the workspace yields 0 results AND params.archiveId
// is present. Otherwise workspace-scoped as before. The bound archiveId is
// the D-08 deterministic value threaded from Chat.archiveId via the
// orchestrator (NOT metadata.archiveId, which is LLM-passed and would
// enable cross-archive IDOR). Archive-fallback results are re-tagged with
// source: "archive" so citations can distinguish archive content from
// workspace content.
//
// 260830-ur9: the inputSchema exposes optional documentTypes (6-value enum
// matching the Prisma Document.type file values) + dateFrom/dateTo (ISO date
// strings) so the agent can scope retrieval ("2023 docs for 2025 questions"
// failure mode). The LLM-supplied values arrive through params.metadata (the
// orchestrator threads the full toolInput object as metadata), are validated
// with RagMetadataFilterSchema.safeParse, and are forwarded to
// hybridSearchWithRerank on the WORKSPACE call only — the archive fallback
// call keeps its current 3-arg form (filters never narrow the pseudo-
// workspace fallback; there are no Document rows to match against).
const RAG_FILTER_DOCUMENT_TYPES = ["pdf", "md", "txt", "csv", "docx", "xlsx"] as const;

registerSkill({
  name: "rag_search",
  displayName: "RAG Search (Hybrid)",
  description: "Search the workspace knowledge base using hybrid search (semantic vector search + full-text keyword search, fused with Reciprocal Rank Fusion). Use this when you need information from uploaded documents.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query — keywords or natural language question about the workspace knowledge base",
      },
      // 260830-ur9: optional metadata filters — "2023 docs for 2025 questions"
      // fix. documentTypes is the 6-value FILE type enum (pdf/md/txt/csv/
      // docx/xlsx — matches the Prisma Document.type values produced at
      // upload); dateFrom/dateTo are ISO date strings ("2025-01-15" or a
      // full ISO datetime). All three are optional; omit them for the
      // unfiltered default behavior.
      documentTypes: {
        type: "array",
        items: { type: "string", enum: [...RAG_FILTER_DOCUMENT_TYPES] },
        maxItems: 6,
        description: "Optional — restrict the search to these document types. Allowed values: pdf, md, txt, csv, docx, xlsx. Omit to search all document types.",
      },
      dateFrom: {
        type: "string",
        description: "Optional — only search documents ingested on or after this date (ISO date, e.g. '2025-01-15' or '2025-01-15T00:00:00Z'). Documents ingested before this date are excluded.",
      },
      dateTo: {
        type: "string",
        description: "Optional — only search documents ingested on or before this date (ISO date; a date-only value is inclusive of that whole day). Omit for no upper bound.",
      },
    },
    required: ["query"],
  },
  type: "builtin",
  async execute(params: SkillParams): Promise<SkillResult> {
    const { workspaceId, query, archiveId } = params;
    if (!query) {
      return { success: false, error: "query parameter is required" };
    }

    // 260830-ur9: read LLM-supplied filter fields from params.metadata (the
    // orchestrator threads the raw toolInput through as metadata), validate
    // with the shared schema, build the filters object (omit empty). Invalid
    // values → descriptive skill failure (mirrors the query-required guard)
    // so the LLM can correct the tool call instead of silently losing filters.
    let filters: HybridSearchFilters | undefined;
    {
      const rawTypes = params.metadata?.documentTypes;
      const rawDateFrom = params.metadata?.dateFrom;
      const rawDateTo = params.metadata?.dateTo;
      const hasAny =
        (Array.isArray(params.metadata?.documentTypes) && params.metadata.documentTypes.length > 0) ||
        params.metadata?.dateFrom !== undefined ||
        params.metadata?.dateTo !== undefined;
      if (hasAny) {
        const parsed = RagMetadataFilterSchema.safeParse({
          ...(Array.isArray(params.metadata?.documentTypes) ? { documentTypes: params.metadata.documentTypes } : {}),
          ...(params.metadata?.dateFrom !== undefined ? { dateFrom: String(params.metadata.dateFrom) } : {}),
          ...(params.metadata?.dateTo !== undefined ? { dateTo: params.metadata.dateTo } : {}),
        });
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const field = issue && issue.path && issue.path.length > 0 ? issue.path.join(".") : "filters";
          return {
            success: false,
            error: `Invalid rag_search filter parameters (${field}: ${issue?.message ?? "invalid filter"}) — documentTypes must be an array of pdf/md/txt/csv/docx/xlsx; dates must be ISO-parseable and dateFrom <= dateTo`,
          };
        }
        filters = parsed.data;
      }
    }

    try {
      // 260830-ur9 byte-identity: the 4th argument is spread conditionally so
      // the no-filter call remains literally the 3-arg call it always was.
      let results = await hybridSearchWithRerank(
        query,
        workspaceId,
        5,
        ...(filters ? [filters] : []),
      );

      // 260721-np3 Task 3 — archive fallback (D-07 partially mutated):
      // Only when the workspace yields 0 results AND the chat has a bound
      // archiveId do we fall back to the bound archive via the existing
      // `archive:<id>` pseudo-workspace path (same one wiki_query uses).
      // Archive-fallback results are re-tagged with source: "archive" so
      // the agent/citations can distinguish them from workspace content.
      // 260830-ur9: the fallback call keeps its 3-arg form — filters are
      // NEVER forwarded into the archive pseudo-workspace (no Document rows;
      // the fallback must not be narrowed by workspace-oriented filters).
      if (results.length === 0 && archiveId) {
        try {
          const archiveResults = await hybridSearchWithRerank(query, `archive:${archiveId}`, 5);
          results = archiveResults.map((r) => ({ ...r, source: "archive" as const }));
        } catch (err: unknown) {
          logger.warn(`[rag_search] archive fallback failed: ${err instanceof Error ? err.message : String(err)}`);
          // results stays [] — falls through to the "No relevant documents" branch below
        }
      }

      // 260815-i4s — relative score cutoff (scoring-mode-agnostic).
      // Off-topic questions surfaced unrelated low-relevance sources because
      // vector search always returns the top-N closest vectors even when
      // semantically unrelated. Drop results whose score is less than
      // `rag_min_score_ratio` * topScore. Default 0.2 (keep >= 20% of top);
      // "0" disables the cutoff entirely (backward-compat). Applied AFTER the
      // archive fallback so archive results are also subject to the cutoff.
      // When ALL results are filtered out, the existing `results.length === 0`
      // check below fires and returns the "No relevant documents found" message.
      if (results.length > 0) {
        const ratioSetting = await getSetting("rag_min_score_ratio");
        const ratioRaw = parseFloat(ratioSetting?.value ?? "0.2");
        const ratio = Number.isFinite(ratioRaw) && ratioRaw >= 0 ? ratioRaw : 0.2;
        if (ratio > 0) {
          const topScore = Math.max(...results.map((r) => r.score));
          const threshold = ratio * topScore;
          const originalCount = results.length;
          results = results.filter((r) => r.score >= threshold);
          logger.debug(
            `[rag_search] score cutoff: ratio=${ratio} topScore=${topScore} threshold=${threshold}, kept ${results.length}/${originalCount}`,
          );
        }
      }

      if (results.length === 0) {
        // Distinguish between "no matches" and "search may be unavailable"
        // The hybridSearch function logs detailed diagnostics;
        // here we give the LLM a clear signal to try alternative approaches.
        return {
          success: true,
          data: "No relevant documents found in the workspace knowledge base. This could mean: (1) no documents have been uploaded to this workspace yet, (2) the documents don't contain information matching this specific query, or (3) the indexing service (collector) may not be running. If you believe relevant documents exist, try rephrasing your query with different keywords, or ask the user to verify that documents have been uploaded and indexed successfully.",
          sources: [],
        };
      }

      const sources: SourceCitation[] = results.map((r: HybridSearchResult) => ({
        documentId: r.documentId || "",
        documentName: r.documentName || "Unknown",
        chunkText: r.chunkText,
        score: r.score,
        // D-14 (Phase 80): thread the archive-fallback re-tag through the
        // sources mapper so the SSE `citations` event carries `source: "archive"`
        // downstream to the frontend CitationPanel badge. The re-tag originates
        // at builtinSkills.ts:50 (`source: "archive" as const` on archive-fallback
        // results). Workspace results have source: "vector"|"fts"|"both" and do
        // NOT carry the D-14 provenance tag — they stay untagged (backward-compat).
        ...(r.source === "archive" ? { source: "archive" as const } : {}),
        // Phase 151 (RAG-02): thread the archive page slug through so the
        // citation-layer dedup can key on `page:<pageSlug>` (the same field
        // wiki_query's RAG fallback reads at :612).
        ...(typeof r.metadata?.pageSlug === "string" ? { pageSlug: r.metadata.pageSlug } : {}),
      }));

      const textChunks = results.map((r: HybridSearchResult) => {
        const sourceTag = r.documentName || "Unknown";
        // 260721-np3 Task 3 — distinguish archive-fallback results from
        // workspace match results so the LLM can cite them appropriately.
        const searchType =
          r.source === "both" ? "semantic+keyword"
            : r.source === "archive" ? "archive-fallback"
              : r.source;
        return `[Source: ${sourceTag} (match: ${searchType}, score: ${r.score.toFixed(4)})]\n${r.chunkText || "(text available in vector store only)"}`;
      }).join("\n\n---\n\n");

      return {
        success: true,
        data: textChunks,
        sources,
      };
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `RAG search failed: ${message}` };
    }
  },
});

// ===== 1b. memory_search (Phase 97 — per-user memory vector search) =====
// MEM-02 D-05: exposes the per-user-per-workspace memory collection to the
// LLM as an explicit skill so it can pull memories on demand (in addition to
// the pre-LLM injection hook in the orchestrator). Mirrors rag_search's
// shape but queries the collector's `user_memory_<userId>_<workspaceId>`
// collection namespace (Pitfall 3 invariant — per-user-per-workspace, NEVER
// user-global). Results are tagged source: "memory" (Phase 90 reserved value)
// so the SSE `citations` event can render them with a memory badge.
// Collector HTTP-only (never Prisma direct — the collector owns the vector
// store). Best-effort: collector failure returns a structured error, never
// throws. High-sensitivity memories are filtered out at the retrieval hook
// (memoryRetrieval.ts) — this skill deliberately does NOT filter by
// sensitivity because the LLM is explicitly requesting a memory by query and
// the user is aware they are recalling their own notes; the high-sensitivity
// filter only governs automatic background injection.
registerSkill({
  name: "memory_search",
  displayName: "Memory Search (per-user)",
  description: "Search your personal memory for this workspace — notes, preferences, and facts the assistant previously remembered about you in this workspace. Use this when the user asks 'do you remember...', 'what did I tell you about...', or you need personal context not covered by the workspace documents.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query — keywords or natural language question about the user's personal memories in this workspace",
      },
    },
    required: ["query"],
  },
  type: "builtin",
  async execute(params: SkillParams): Promise<SkillResult> {
    const { workspaceId, userId, query } = params;
    if (!query) {
      return { success: false, error: "query parameter is required" };
    }
    // Pitfall 3: per-user-per-workspace — both ids are required.
    if (!userId || !workspaceId) {
      return { success: false, error: "memory_search requires userId and workspaceId" };
    }
    const collection = `user_memory_${userId}_${workspaceId}`;
    try {
      const env = getEnv();
      const resp = await axios.post(
        `${env.COLLECTOR_URL}/api/ingest/query`,
        { query, workspaceId: collection, limit: 5 },
        {
          headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
          timeout: 5000,
          validateStatus: (s: number) => s < 500,
        },
      );
      if (resp.status >= 400 || !resp.data) {
        return { success: true, data: "No memories found matching your query.", sources: [] };
      }
      const results: any[] = Array.isArray(resp.data.results) ? resp.data.results : [];
      if (results.length === 0) {
        return { success: true, data: "No memories found matching your query.", sources: [] };
      }
      // Phase 90: tag every memory citation with source: "memory" so the
      // frontend CitationPanel can render a memory badge.
      const sources: SourceCitation[] = results.map((r: any) => {
        const meta = (r && r.metadata) || {};
        return {
          documentId: String(r?.documentId ?? r?.id ?? ""),
          documentName: String(meta.path ?? meta.type ?? "Memory"),
          chunkText: String(r?.content ?? r?.chunkText ?? ""),
          score: typeof r?.score === "number" ? r.score : 0,
          source: "memory" as const,
        };
      });
      const textChunks = results.map((r: any, i: number) => {
        const meta = (r && r.metadata) || {};
        const pathTag = meta.path ? ` (path: ${meta.path})` : "";
        return `[Memory ${i + 1}${pathTag}]\n${String(r?.content ?? r?.chunkText ?? "")}`;
      }).join("\n\n---\n\n");
      return { success: true, data: textChunks, sources };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Memory search failed: ${message}` };
    }
  },
});

// ===== 1c. web_search (Phase 99 — SearXNG/Tavily web search) =====
// WEB-01 D-02: web_search builtin skill, sibling of rag_search and
// memory_search. Triple-gated (ALLOW_WEB_SEARCH env + web_search license +
// web_search_provider SystemConfig) inside searchWeb(). Results →
// SourceCitation[] with source: "web" (Phase 90 widened union). Snippets marked
// [untrusted] (Pitfall 12 prompt-injection defense). inputSchema declared for
// NTV-01 native tool exposure (Phase 95 D-08 threading). Lazy — no HTTP at
// boot; skill executes only when the LLM invokes it during chat.
registerSkill({
  name: "web_search",
  displayName: "Web Search",
  description:
    "Search the web for current information using SearXNG or Tavily. Use this when the workspace knowledge base doesn't contain recent or external information.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query — keywords or natural language question",
      },
    },
    required: ["query"],
  },
  type: "builtin",
  async execute(params: SkillParams): Promise<SkillResult> {
    const { query, userId, workspaceId } = params;
    if (!query) {
      return { success: false, error: "query parameter is required" };
    }
    return searchWeb(query, {
      userId: userId || "",
      chatId: params.metadata?.chatId as string | undefined,
      workspaceId,
    });
  },
});

// ===== 2. workspace_memory =====
registerSkill({
  name: "workspace_memory",
  displayName: "Workspace Memory",
  description: "Read or write persistent notes for this workspace. Use 'read' to recall previously saved notes. IMPORTANT: for document search, use rag_search instead — this tool only stores manually saved notes, not uploaded documents.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "write"],
        description: "Whether to read or write a memory note",
      },
      key: {
        type: "string",
        description: "The memory key to read or write (defaults to 'general')",
      },
      content: {
        type: "string",
        description: "The content to write (required when action is 'write')",
      },
    },
    required: ["action"],
  },
  type: "builtin",
  async execute(params: SkillParams): Promise<SkillResult> {
    const { workspaceId, query, metadata } = params;
    const action = (metadata?.action as string) || "read";
    const key = (metadata?.key as string) || "general";
    const content = metadata?.content as string | undefined;

    try {
      // Store/retrieve memory in SystemConfig with workspace-scoped keys
      const configKey = `ws_memory:${workspaceId}:${key}`;

      if (action === "write" && content) {
        await prisma.systemConfig.upsert({
          where: { key: configKey },
          create: { key: configKey, value: content },
          update: { value: content },
        });
        return { success: true, data: `Memory saved under key "${key}".` };
      }

      // Read action — check key-value store first
      const entry = await prisma.systemConfig.findUnique({ where: { key: configKey } });
      if (entry) {
        return { success: true, data: entry.value };
      }

      // Fallback: search RAG for documents matching this key or user query
      try {
        const ragQuery = key !== "general" ? key : (query || "");
        if (ragQuery) {
          const ragResults = await hybridSearchWithRerank(ragQuery, workspaceId, 5);
          if (ragResults.length > 0) {
            const textChunks = ragResults.map((r) => {
              const sourceTag = r.documentName || "Unknown";
              return `[Source: ${sourceTag} (score: ${r.score.toFixed(4)})]\n${r.chunkText || ""}`;
            }).join("\n\n---\n\n");
            return {
              success: true,
              data: `No explicit memory found for key "${key}". Found these relevant documents:\n\n${textChunks}`,
              // D-03 (Phase 90): tool-result producer tagging. `source: "tool"`
              // identifies producer non-RAG/non-archive (builtinSkills non-RAG +
              // MCP skills). RAG/archive already tag (`workspace` implicit /
              // `archive` explicit D-14). Web/memory arrive in Phase 99/97.
              // CIT-01 success criterion 2. `as const` is the only narrowing of
              // literal type needed (consistent with `source: "archive" as
              // const` at line 50/79); no widening cast on SourceCitation.
              sources: ragResults.map((r) => ({
                documentId: r.documentId || "",
                documentName: r.documentName || "Unknown",
                chunkText: r.chunkText,
                score: r.score,
                source: "tool" as const,
              })),
            };
          }
        }
      } catch {
        // RAG fallback failed — not critical, proceed to not-found message
      }

      return { success: true, data: `No memory found for key "${key}".` };
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Memory operation failed: ${message}` };
    }
  },
});

// ===== 3. document_temp_process =====
registerSkill({
  name: "document_temp_process",
  displayName: "Temporary Document Processing",
  description: "Process a file uploaded during chat. The file will be embedded temporarily and analyzed, then you can decide whether to save it permanently to the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the uploaded file to process",
      },
      documentId: {
        type: "string",
        description: "The temporary document ID assigned to this upload",
      },
    },
    required: ["filePath", "documentId"],
  },
  type: "builtin",
  async execute(params: SkillParams): Promise<SkillResult> {
    const { workspaceId, filePath, metadata } = params;
    if (!filePath) {
      return { success: false, error: "filePath parameter is required" };
    }

    const documentId = metadata?.documentId as string | undefined;
    if (!documentId) {
      return { success: false, error: "documentId is required in metadata" };
    }

    try {
      const env = getEnv();
      const fs = await import("fs");

      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer]);
      const formData = new FormData();
      formData.append("file", blob, (metadata?.fileName as string) || "upload.txt");
      formData.append("documentId", documentId);
      if (workspaceId) formData.append("workspaceId", workspaceId);
      if (env.EMBEDDING_MODEL) formData.append("embeddingModel", env.EMBEDDING_MODEL);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300_000);

      const response = await fetch(`${env.COLLECTOR_URL}/api/ingest`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
        headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(
          `Collector error (${response.status}): ${errorData.error}${errorData.details ? ` — ${errorData.details}` : ""}`,
        );
      }

      const data = (await response.json()) as { chunks?: number };

      return {
        success: true,
        data: `Document processed: ${data.chunks || 0} chunks created. The document has been indexed and can be searched via RAG.`,
      };
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Document processing failed: ${message}` };
    }
  },
});

// ===== 4. wiki_query (Wiki page search + BFS traversal) =====

/**
 * D-11 typed $queryRaw row for the archive_pages FTS projection. Field names
 * match the SELECT aliases exactly (quoted identifiers preserve camelCase per
 * RESEARCH Pitfall 3). `frontmatter` is an opaque JSON column → `unknown`.
 */
interface RawArchiveResult {
  id: string;
  slug: string;
  title: string;
  category: string;
  frontmatter: unknown;
  bodyText: string;
  wikilinks: string[];
  archiveId: string;
  rank: number;
}

/**
 * Full-text search on archive_pages using PostgreSQL tsvector.
 */
async function ftsArchivePages(
  query: string,
  archiveId: string | undefined,
  limit: number,
): Promise<
  Array<{
    id: string;
    slug: string;
    title: string;
    category: string;
    frontmatter: unknown;
    bodyText: string;
    wikilinks: string[];
    archiveId: string;
    rank: number;
  }>
> {
  // Use plainto_tsquery to eliminate tsquery operator injection surface.
  // plainto_tsquery treats the entire input as plain words — no &, |, !, <-> operators.
  // The query string is passed as a Prisma raw parameter (safe from SQL injection).
  // Phase 151 (RAG-01): the OR-ed 7-config plainto query against
  // searchVectorMulti (MULTI_CONFIG_PLAINTO_TSQUERY) replaces the
  // english-only query — locale-correct stemming on the query side.
  if (!query.trim()) return [];

  // Always filter by archiveId when provided; otherwise search across all archives.
  const rawResults: Array<RawArchiveResult> = archiveId
    ? await prisma.$queryRaw<Array<RawArchiveResult>>`
        SELECT
          ap."id",
          ap."slug",
          ap."title",
          ap."category",
          ap."frontmatter",
          ap."bodyText",
          ap."wikilinks",
          ap."archiveId",
          ts_rank(ap."searchVectorMulti", (SELECT ${Prisma.raw(MULTI_CONFIG_PLAINTO_TSQUERY)} FROM (SELECT ${query}::text AS q) AS q)) as rank
        FROM "archive_pages" ap
        JOIN "archives" a ON a."id" = ap."archiveId" AND a."deletedAt" IS NULL
        WHERE ap."searchVectorMulti" @@ (SELECT ${Prisma.raw(MULTI_CONFIG_PLAINTO_TSQUERY)} FROM (SELECT ${query}::text AS q) AS q)
          AND ap."deletedAt" IS NULL
          AND ap."archiveId" = ${archiveId}
        ORDER BY rank DESC
        LIMIT ${limit}
      `
    : await prisma.$queryRaw<Array<RawArchiveResult>>`
        SELECT
          ap."id",
          ap."slug",
          ap."title",
          ap."category",
          ap."frontmatter",
          ap."bodyText",
          ap."wikilinks",
          ap."archiveId",
          ts_rank(ap."searchVectorMulti", (SELECT ${Prisma.raw(MULTI_CONFIG_PLAINTO_TSQUERY)} FROM (SELECT ${query}::text AS q) AS q)) as rank
        FROM "archive_pages" ap
        JOIN "archives" a ON a."id" = ap."archiveId" AND a."deletedAt" IS NULL
        WHERE ap."searchVectorMulti" @@ (SELECT ${Prisma.raw(MULTI_CONFIG_PLAINTO_TSQUERY)} FROM (SELECT ${query}::text AS q) AS q)
          AND ap."deletedAt" IS NULL
        ORDER BY rank DESC
        LIMIT ${limit}
      `;

  return rawResults.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    title: String(r.title),
    category: String(r.category),
    frontmatter: r.frontmatter,
    bodyText: String(r.bodyText || ""),
    wikilinks: Array.isArray(r.wikilinks) ? r.wikilinks.map(String) : [],
    archiveId: String(r.archiveId),
    rank: Number(r.rank),
    source: "fts" as const,
  }));
}

/**
 * Format an archive page for agent consumption.
 */
function formatPageForAgent(page: {
  slug: string;
  title: string;
  frontmatter: unknown;
  bodyText: string;
}): string {
  const frontmatter = page.frontmatter as Record<string, unknown> | null;
  const yamlFrontmatter =
    frontmatter && Object.keys(frontmatter).length > 0
      ? Object.entries(frontmatter)
          .map(([k, v]) => {
            if (typeof v === "string") return `${k}: ${v}`;
            return `${k}: ${JSON.stringify(v)}`;
          })
          .join("\n")
      : "";

  if (yamlFrontmatter) {
    return `---\n${yamlFrontmatter}\n---\n\n${page.bodyText || ""}`;
  }
  return page.bodyText || "";
}

registerSkill({
  name: "wiki_query",
  displayName: "Wiki Query",
  description:
    "Search and read wiki pages. Use 'query' for full-text search, 'slug' for direct page lookup. Supports link traversal up to depth 3 and 10-page budget.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Full-text search query for wiki pages (requires archiveId)",
      },
      slug: {
        type: "string",
        description: "Direct wiki page slug lookup (alternative to query)",
      },
      depth: {
        type: "number",
        description: "Link traversal depth (0-3, default 1)",
      },
    },
    required: [],
  },
  type: "builtin",
  async execute(params: SkillParams): Promise<SkillResult> {
    const { query, metadata } = params;
    const slug = metadata?.slug as string | undefined;
    const depth = Math.min((metadata?.depth as number) || 1, 3);
    // D-08: prefer params.archiveId (deterministic from Chat.archiveId) over
    // metadata.archiveId (LLM-passed) to prevent cross-archive IDOR.
    const archiveId = params.archiveId ?? (metadata?.archiveId as string | undefined);

    try {
      const visited = new Set<string>();
      // Phase 151 (RAG-02): per-page frontmatter captured during traversal so
      // the normal-path citations can derive sourceDocumentIds from
      // `Fonti: [[doc:<id>]]` entries (archiveImportService.ts:323-325).
      const visitedPages = new Map<string, { frontmatter: unknown; bodyText: string }>();
      const toRead: Array<{ slug: string; depth: number; archiveId?: string }> = [];
      const formattedPages: string[] = [];
      let usedRagFallback = false;

      // Seed the queue
      if (slug) {
        toRead.push({ slug, depth: 0, archiveId });
      } else if (query) {
        // CR-03 fix: FTS search requires archiveId to prevent cross-archive data leaks.
        // Without archive scope, results from other archives could be exposed to the caller.
        if (!archiveId) {
          return { success: false, error: "archiveId is required for full-text wiki search" };
        }
        const searchResults = await ftsArchivePages(query, archiveId, 5);

        if (searchResults.length === 0) {
          // Fallback to RAG vector search if FTS yields no results
          try {
            const vectorResults = await hybridSearchWithRerank(query, `archive:${archiveId}`, 5);
            const seenSlugs = new Set<string>();
            for (const r of vectorResults) {
              const pageSlug = typeof r.metadata?.pageSlug === "string" ? r.metadata.pageSlug : undefined;
              if (pageSlug && !seenSlugs.has(pageSlug)) {
                seenSlugs.add(pageSlug);
                toRead.push({ slug: pageSlug, depth: 0, archiveId });
              }
            }
            if (toRead.length > 0) {
              usedRagFallback = true;
              logger.info("[wiki_query] RAG fallback used", { query, archiveId, pagesFound: toRead.length });
            }
          } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
            logger.warn("[wiki_query] RAG fallback failed", { error: message });
          }
        }

        for (const r of searchResults) {
          toRead.push({ slug: r.slug, depth: 0, archiveId: r.archiveId });
        }
      } else {
        return { success: false, error: "Either 'query' or 'slug' parameter is required" };
      }

      // BFS traversal
      while (toRead.length > 0 && visited.size < 10) {
        const { slug: currentSlug, depth: currentDepth, archiveId: pageArchiveId } = toRead.shift()!;
        if (visited.has(currentSlug)) continue;

        let page: {
          slug: string;
          title: string;
          frontmatter: unknown;
          bodyText: string;
          wikilinks: string[];
        } | null = null;

        try {
          if (pageArchiveId || archiveId) {
            page = await getPage((pageArchiveId || archiveId)!, currentSlug);
          } else {
            // No archive scope available — search all archives by slug (best-effort)
            page = await prisma.archivePage.findFirst({
              where: { slug: currentSlug, deletedAt: null },
            });
          }
        } catch {
          // Page not found — skip
        }

        if (!page) continue;

        visited.add(currentSlug);
        visitedPages.set(currentSlug, { frontmatter: page.frontmatter, bodyText: page.bodyText });
        formattedPages.push(formatPageForAgent(page));

        if (currentDepth < depth && page.wikilinks && Array.isArray(page.wikilinks)) {
          for (const link of page.wikilinks) {
            if (!visited.has(link) && !toRead.some((item) => item.slug === link)) {
              toRead.push({ slug: link, depth: currentDepth + 1, archiveId: pageArchiveId || archiveId });
            }
          }
        }
      }

      if (formattedPages.length === 0) {
        // G-131-17: distinguishable no-content marker. success stays true (the
        // tool RAN correctly — an error would be the wrong signal), but the
        // leading bracket marker is unambiguous to the model AND to any future
        // programmatic consumer. The system prompt's anti-retry rule (rule 8)
        // tells the model to stop after this marker — identical-input retries
        // (the loop-detector trip) can no longer form.
        return { success: true, data: "[WIKI_NO_CONTENT] No wiki pages found for the given query. Do not retry this query — no content exists for it in the archive." };
      }

      let resultText = formattedPages.join("\n\n---\n\n");
      if (toRead.length > 0 && visited.size >= 10) {
        resultText += `\n\n---\n\n*Note: Link traversal budget exhausted (${visited.size}/10 pages read, depth ${depth}). ${toRead.length} more pages pending. Ask to continue for more results.*`;
      }

      logger.info("[wiki_query] Traversal complete", {
        pagesRead: visited.size,
        depth,
        budgetRemaining: 10 - visited.size,
        pending: toRead.length,
      });

      // D-03 (Phase 90): tool-result producer tagging. `source: "tool"`
      // identifies producer non-RAG/non-archive (builtinSkills non-RAG + MCP
      // skills). RAG/archive already tag (`workspace` implicit / `archive`
      // explicit D-14). Web/memory arrive in Phase 99/97. CIT-01 success
      // criterion 2. `as const` is the only narrowing of literal type needed
      // (consistent with `source: "archive" as const` at line 50/79).
      //
      // Phase 151 (RAG-02): emit one citation per visited page in the NORMAL
      // path too (not only the RAG-fallback path) — otherwise the citation
      // dedup has nothing to dedup against (RESEARCH Pitfall 4). Each
      // citation carries `pageSlug` + `sourceDocumentIds` parsed from the
      // page's `Fonti: [[doc:<id>]]` frontmatter (archiveImportService.ts
      // pattern) so dedupeCitations can claim `page:`/`doc:` keys.
      const sources: SourceCitation[] = Array.from(visited).map((s) => {
        const pageInfo = visitedPages.get(s);
        const frontmatter = pageInfo?.frontmatter as Record<string, unknown> | null | undefined;
        const fonti = Array.isArray(frontmatter?.Fonti) ? (frontmatter!.Fonti as unknown[]) : [];
        const sourceDocumentIds: string[] = [];
        for (const entry of fonti) {
          const match = typeof entry === "string" ? entry.match(/\[\[doc:([^\]]+)\]\]/) : null;
          if (match?.[1]) sourceDocumentIds.push(match[1]);
        }
        const rawBody = pageInfo?.bodyText || "";
        const chunkText = rawBody.slice(0, 500).trim();
        return {
          documentId: "",
          documentName: s,
          chunkText,
          score: 0,
          source: "tool" as const,
          pageSlug: s,
          ...(sourceDocumentIds.length > 0 ? { sourceDocumentIds } : {}),
        };
      });

      return { success: true, data: resultText, sources };
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Wiki query failed: ${message}` };
    }
  },
});

// ===== 5. wiki_write (Wiki page create/update with preview) =====

registerSkill({
  name: "wiki_write",
  displayName: "Wiki Write",
  description:
    "Create or update a wiki page. Requires 'archive:write' permission. Generates a dry-run preview that must be approved by the user before application.",
  inputSchema: {
    type: "object",
    properties: {
      archiveId: {
        type: "string",
        description: "The archive ID to write into",
      },
      slug: {
        type: "string",
        description: "The wiki page slug to create or update",
      },
      content: {
        type: "string",
        description: "The new page content in markdown",
      },
      action: {
        type: "string",
        enum: ["create", "update"],
        description: "Whether to create a new page or update an existing one",
      },
    },
    required: ["archiveId", "slug", "content", "action"],
  },
  type: "builtin",
  async execute(params: SkillParams): Promise<SkillResult> {
    const { userId, content, metadata, sendEvent } = params;
    // D-08: prefer params.archiveId (deterministic from Chat.archiveId) over
    // metadata.archiveId (LLM-passed) to prevent cross-archive IDOR.
    const archiveId = params.archiveId ?? (metadata?.archiveId as string);
    const slug = metadata?.slug as string;
    const action = metadata?.action as "create" | "update";

    if (!archiveId) {
      return { success: false, error: "archiveId is required in metadata" };
    }
    if (!slug) {
      return { success: false, error: "slug is required in metadata" };
    }
    if (!content) {
      return { success: false, error: "content parameter is required" };
    }
    if (!action || (action !== "create" && action !== "update")) {
      return { success: false, error: "metadata.action must be 'create' or 'update'" };
    }

    try {
      // RBAC: verify user has archive:write permission
      const userWithRoles = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          roles: {
            include: {
              role: {
                include: { permissions: true },
              },
            },
          },
        },
      });

      if (!userWithRoles) {
        return { success: false, error: "User not found" };
      }

      const hasArchiveWrite = userWithRoles.roles.some((ur: { role: { permissions: { permissionName: string }[] } }) =>
        ur.role.permissions.some((rp: { permissionName: string }) => rp.permissionName === "archive:write"),
      );

      if (!hasArchiveWrite) {
        return { success: false, error: "Permission denied: archive:write required" };
      }

      // Generate preview (dry-run)
      const run = await generatePreview(archiveId, slug, content, userId, action);
      const previewJson = run.previewJson as Record<string, any>;

      // Emit wiki_edit SSE event if sendEvent is available
      if (sendEvent) {
        sendEvent("wiki_edit", {
          pageSlug: slug,
          archiveId,
          action: "preview",
          diff: previewJson?.diff ?? null,
          destructive: previewJson?.destructive ?? false,
          runId: run.id,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        success: true,
        data: {
          runId: run.id,
          destructive: previewJson?.destructive ?? false,
          message: "Preview generated. Please approve or reject this edit.",
        },
      };
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Wiki write failed: ${message}` };
    }
  },
});