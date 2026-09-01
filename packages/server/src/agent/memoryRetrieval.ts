// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 97 (MEM-02 D-04) — pre-LLM memory retrieval hook.
 *
 * Called by the orchestrator in `runAgent` AND `runAgentStreaming` BEFORE
 * `compact_messages_for_request` (Phase 96) and BEFORE `streamLLM`. The hook
 * embeds the last ~7 user messages, queries the collector's per-user-per-
 * workspace memory collection, filters out high-sensitivity memories, ranks
 * by `pathRank` tiers 0-5, dedups via `seen_ids`, strips the previous
 * `<memory_context>` block, composes a fresh sandboxed block, and appends it
 * AFTER the core system instructions.
 *
 * Pitfall 3 invariants (D-04 locked):
 *   - Collection namespace `user_memory_<userId>_<workspaceId>` (NOT user-global).
 *   - High-sensitivity memories stored (97-01) but NEVER injected here.
 *   - Sandboxed `<memory_context>` with the [untrusted] marker goes AFTER core
 *     system instructions (never before).
 *   - Best-effort: collector down / timeout → return the original system
 *     message unchanged (never block the chat).
 *
 * Collector HTTP-only (never Prisma direct). Uses `/api/ingest/query` with the
 * raw `user_memory_<userId>_<workspaceId>` string as the `workspaceId` body
 * field — the collector's `buildCollectionName` treats unknown prefixes as
 * `ws_<id>` which would mangle the namespace, so the hook passes the full
 * collection string directly and the collector forwards it verbatim to the
 * vector store (the namespace is NOT a real workspace UUID).
 */

import axios from "axios";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { pathRank } from "./memoryPathRank";
import { stripMemoryBlock, composeMemoryBlock } from "./memorySandbox";

/** A memory row retrieved from the collector's vector search results. */
interface RetrievedMemory {
  id: string;
  type: string;
  path: string | null;
  content: string;
  sensitivity: string;
}

export interface RetrieveAndInjectOpts {
  userId: string;
  workspaceId: string;
  /** The full context array (system + history + user). Only `role`/`content`
   *  are read; the last ~7 user messages are concatenated for the query. */
  messages: { role: string; content: string }[];
  systemMessageContent: string;
  /** Optional override of the AGENT_MEMORY_CHAR_LIMIT env (tests). */
  charLimit?: number;
}

/** How many trailing user messages to fold into the embedding query. */
const QUERY_USER_MSG_WINDOW = 7;
/** Hard cap on the concatenated query string (chars). */
const QUERY_CHAR_CAP = 4000;
/** Collector /api/ingest/query request timeout (ms). Best-effort — never block chat. */
const COLLECTOR_TIMEOUT_MS = 5000;
/** Max memories to request from the collector. */
const COLLECTOR_RESULT_LIMIT = 8;

/**
 * Extract the last ~7 non-empty user messages from the context, concatenate
 * with `\n\n`, and cap at QUERY_CHAR_CAP. Returns "" when there are no usable
 * user messages.
 */
function buildQueryFromMessages(messages: { role: string; content: string }[]): string {
  const userMsgs: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMsgs.length < QUERY_USER_MSG_WINDOW; i--) {
    const m = messages[i];
    if (m && m.role === "user" && m.content && m.content.trim().length > 0) {
      userMsgs.unshift(m.content);
    }
  }
  if (userMsgs.length === 0) return "";
  let query = userMsgs.join("\n\n");
  if (query.length > QUERY_CHAR_CAP) query = query.slice(0, QUERY_CHAR_CAP);
  return query;
}

/**
 * Heuristic: derive a dotted-path-like token from the query for `pathRank`
 * lookup. Falls back to "" (null rank for every memory — stable order by
 * collector score) when no dotted path is present.
 */
function deriveLookupPath(query: string): string {
  const match = query.match(/\b([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)\b/);
  return match && match[1] ? match[1] : "";
}

/**
 * Map a collector search result row to a `RetrievedMemory`. The collector
 * stores memory metadata in the chunk `metadata` object (97-01 / 97-03
 * extraction writes it there). Fields are defensively coerced — a missing
 * field degrades to a safe default rather than throwing.
 */
function mapResult(r: any): RetrievedMemory {
  const meta = (r && r.metadata) || {};
  return {
    id: String(r?.id ?? r?.documentId ?? ""),
    type: String(meta.type ?? "user"),
    path: meta.path == null ? null : String(meta.path),
    content: String(r?.content ?? r?.chunkText ?? ""),
    sensitivity: String(meta.sensitivity ?? "low"),
  };
}

/**
 * Retrieve relevant memories and inject a sandboxed `<memory_context>` block
 * into the system message. Best-effort: any failure (empty ids, collector
 * error, all-high-sensitivity) returns the original system message unchanged
 * (after stripping any existing block when applicable).
 *
 * Returns the mutated system message string. The caller assigns it to
 * `context[0].content` before `compact_messages_for_request` runs.
 */
export async function retrieveAndInjectMemory(opts: RetrieveAndInjectOpts): Promise<string> {
  const { userId, workspaceId, messages, systemMessageContent } = opts;

  // Pitfall 3: per-user-per-workspace — never query without both ids.
  if (!userId || !workspaceId) return systemMessageContent;

  const query = buildQueryFromMessages(messages);
  if (!query) return systemMessageContent;

  // Pitfall 3: the collection namespace is the full string, NOT a real
  // workspace UUID. The collector's /api/ingest/query `workspaceId` field is
  // the collection name — passing the raw `user_memory_*` string makes the
  // collector search that exact collection (buildCollectionName only
  // normalizes `global` / `archive:` prefixes; everything else is treated as
  // `ws_<id>` — so we pass the namespace verbatim and rely on the collector
  // forwarding it to the vector store).
  const collection = `user_memory_${userId}_${workspaceId}`;
  const lookupPath = deriveLookupPath(query);

  let results: any[] = [];
  try {
    const env = getEnv();
    const resp = await axios.post(
      `${env.COLLECTOR_URL}/api/ingest/query`,
      { query, workspaceId: collection, limit: COLLECTOR_RESULT_LIMIT },
      {
        headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
        timeout: COLLECTOR_TIMEOUT_MS,
        validateStatus: (s: number) => s < 500,
      },
    );
    if (resp.status >= 400 || !resp.data) {
      return systemMessageContent;
    }
    results = Array.isArray(resp.data.results) ? resp.data.results : [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[memoryRetrieval] collector query failed (best-effort, returning original system message): ${msg}`);
    return systemMessageContent;
  }

  const mapped = results.map(mapResult);

  // Pitfall 3 D-01/D-04: high-sensitivity memories are stored but NEVER injected.
  const injectable = mapped.filter((m) => m.sensitivity !== "high");
  if (injectable.length === 0) {
    return stripMemoryBlock(systemMessageContent) || systemMessageContent;
  }

  // Rank by pathRank tiers 0-5 ascending; null rank → tier 9 proxy (sorts last).
  // Stable secondary sort by collector score descending (preserves vector relevance).
  const ranked = injectable
    .map((m) => {
      const rank = pathRank(m.path, lookupPath);
      const tier = rank ? rank[0] : 9;
      const tiebreak = rank ? rank[1] : 0;
      return { m, tier, tiebreak, score: 0 };
    })
    .sort((a, b) => a.tier - b.tier || a.tiebreak - b.tiebreak);

  // Dedup via seen_ids — a memory id appears at most once.
  const seen = new Set<string>();
  const deduped: { path: string | null; content: string }[] = [];
  for (const { m } of ranked) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    deduped.push({ path: m.path, content: m.content });
  }
  if (deduped.length === 0) {
    return stripMemoryBlock(systemMessageContent) || systemMessageContent;
  }

  const charLimit = opts.charLimit ?? getEnv().AGENT_MEMORY_CHAR_LIMIT;
  const stripped = stripMemoryBlock(systemMessageContent);
  const block = composeMemoryBlock(deduped, charLimit);
  if (!block) return stripped || systemMessageContent;

  // Pitfall 3: the sandboxed block goes AFTER core system instructions.
  return stripped ? `${stripped}\n\n${block}` : block;
}