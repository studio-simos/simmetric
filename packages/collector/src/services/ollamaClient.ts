// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * getOllamaClient() — Map-keyed lazy singleton factory for the official
 * `ollama` (ollama-js) client (Phase 92-01, D-02). Collector mirror.
 *
 * Prohibitions (phase-locked):
 *  - NEVER call `client.abort()` on the shared singleton — it aborts ALL
 *    in-flight streams process-wide (Pitfall 2). Per-request abort is
 *    `AbortableAsyncIterator.abort()` at the call site (migration plans 92-02+).
 *  - Headers/auth are constructor-bound in ollama-js (Pitfall 4), so auth is
 *    part of the cache key — never mutate a cached client's config.
 *
 * Cache key: `${host}|${timeoutMs ?? 0}|${apiKey ? "auth" : ""}`. The keyspace
 * stays tiny (~5 variants: per-site timeouts + optional Bearer auth), so the
 * Map grows unbounded only in pathological cases.
 *
 * Pitfall 6: this module is DUPLICATED in
 * packages/server/src/services/ollamaClient.ts (strict modularity —
 * packages/shared is types/schemas only, and server/collector never
 * cross-import). Update BOTH.
 */
import { Ollama } from "ollama";
import { logger } from "../utils/logger";

const clients = new Map<string, Ollama>();

/**
 * ollama-js has NO timeout option (Pitfall 1) — a timeout must be injected as
 * a wrapped fetch at construction. timeoutMs <= 0 preserves the existing
 * LLM_TIMEOUT=0 "no timeout" semantics by passing the global fetch through
 * untouched. AbortSignal.any needs Node >= 20 (project runs Node 24).
 */
function fetchWithTimeout(timeoutMs: number): typeof fetch {
  if (timeoutMs <= 0) return fetch;
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any(
        [init?.signal, AbortSignal.timeout(timeoutMs)].filter(
          Boolean,
        ) as AbortSignal[],
      ),
    });
}

export function getOllamaClient(
  host: string,
  opts: { timeoutMs?: number; apiKey?: string } = {},
): Ollama {
  const key = `${host}|${opts.timeoutMs ?? 0}|${opts.apiKey ? "auth" : ""}`;
  let client = clients.get(key);
  if (!client) {
    client = new Ollama({
      host, // formatHost() strips trailing slash, defaults :11434
      fetch: fetchWithTimeout(opts.timeoutMs ?? 0),
      headers: opts.apiKey
        ? { Authorization: `Bearer ${opts.apiKey}` }
        : undefined,
    });
    clients.set(key, client);
    logger.info(
      `[ollama-client] Created client for ${host} ` +
        `(timeoutMs=${opts.timeoutMs ?? 0}, auth=${opts.apiKey ? "yes" : "no"})`,
    );
  }
  return client;
}
