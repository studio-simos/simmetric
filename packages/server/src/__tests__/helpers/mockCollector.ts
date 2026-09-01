// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 97 (MEM-02) — test helper for mocking the collector `/api/ingest/query`
 * vector-search endpoint consumed by `memoryRetrieval.retrieveAndInjectMemory`
 * and the `memory_search` builtin skill.
 *
 * The helper installs a typed `axios.post` mock that returns canned collector
 * results keyed by the request body's `workspaceId` (which the retrieval hook
 * uses as the collection namespace `user_memory_<userId>_<workspaceId>`). Tests
 * configure the canned response per-collection so the assertion can verify the
 * collector was called with the exact per-user-per-workspace namespace
 * (Pitfall 3 invariant).
 */
export interface MockMemoryResult {
  id: string;
  content: string;
  score: number;
  metadata: {
    path: string | null;
    type: string;
    sensitivity: string;
  };
}

export interface MockCollectorConfig {
  /** Map of collection namespace → canned results array. */
  responses?: Record<string, MockMemoryResult[]>;
  /** Force the next axios.post to throw (simulates collector down / timeout). */
  throwNext?: boolean;
  /** HTTP status to return (default 200). */
  status?: number;
}

let lastCall: { url: string; body: unknown; headers: Record<string, string> } | null = null;

export function getLastCollectorCall() {
  return lastCall;
}

export function resetLastCollectorCall() {
  lastCall = null;
}

/**
 * Build a jest `axios` mock factory that returns canned collector responses.
 * The mock records the last call so tests can assert on the collection
 * namespace + headers (Pitfall 3 per-user-per-workspace + X-Collector-Secret).
 */
export function buildCollectorAxiosMock(cfg: MockCollectorConfig = {}) {
  lastCall = null;
  return {
    post: jest.fn(async (url: string, body: any, opts?: { headers?: Record<string, string> }) => {
      lastCall = { url, body, headers: opts?.headers ?? {} };
      if (cfg.throwNext) {
        throw new Error("mock collector network error");
      }
      const workspaceId = body?.workspaceId ?? "";
      const results = cfg.responses?.[workspaceId] ?? [];
      return {
        status: cfg.status ?? 200,
        data: { results, dimension: 384 },
      };
    }),
    get: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(() => ({ defaults: { headers: {} } })),
    isAxiosError: jest.fn(() => false),
  };
}