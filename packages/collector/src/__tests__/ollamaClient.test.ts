// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 92-01 (D-02): getOllamaClient() Map-keyed lazy singleton factory
 * (collector mirror — duplicated per strict modularity, NOT imported from
 * packages/server and NOT placed in packages/shared).
 *
 * The factory caches `Ollama` instances on a composite `host|timeoutMs|auth`
 * key because ollama-js binds `fetch` and `headers` at construction (no
 * per-call override — Pitfall 1 / Pitfall 4). Tests use jest.resetModules() +
 * dynamic import per test because the cache is module-level state (the
 * embeddings.test.ts:60-72 discipline). The real `ollama` package is
 * deliberately NOT mocked: construction is side-effect-free, and the real
 * import doubles as a jest-runtime (@swc/jest CJS transform) resolution check.
 */
import { Ollama } from "ollama";

// Silence the factory's logger import (module-level winston otherwise writes
// to console + storage/logs during tests).
jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const HOST_A = "http://host-a:11434";
const HOST_B = "http://host-b:11434";

async function loadFactory() {
  jest.resetModules();
  return await import("../services/ollamaClient");
}

describe("getOllamaClient (92-01 D-02, collector)", () => {
  it("returns the identical instance for repeated calls with the same composite key", async () => {
    const { getOllamaClient } = await loadFactory();
    const first = getOllamaClient(HOST_A);
    const second = getOllamaClient(HOST_A);
    expect(second).toBe(first);
  });

  it("keys the cache on timeoutMs (ollama-js binds fetch at construction — Pitfall 1)", async () => {
    const { getOllamaClient } = await loadFactory();
    const noTimeout = getOllamaClient(HOST_A);
    const zeroTimeout = getOllamaClient(HOST_A, { timeoutMs: 0 });
    const withTimeout = getOllamaClient(HOST_A, { timeoutMs: 3000 });
    // omitted and 0 share the key (`timeoutMs ?? 0`)
    expect(zeroTimeout).toBe(noTimeout);
    expect(withTimeout).not.toBe(noTimeout);
  });

  it("keys the cache on auth (headers are constructor-bound — Pitfall 4)", async () => {
    const { getOllamaClient } = await loadFactory();
    const anonymous = getOllamaClient(HOST_A);
    const authed = getOllamaClient(HOST_A, { apiKey: "k" });
    expect(authed).not.toBe(anonymous);
    // the key stores auth-ness, not the credential value
    expect(getOllamaClient(HOST_A, { apiKey: "other" })).toBe(authed);
  });

  it("returns different instances for different hosts", async () => {
    const { getOllamaClient } = await loadFactory();
    expect(getOllamaClient(HOST_B)).not.toBe(getOllamaClient(HOST_A));
  });

  it("returns a real Ollama instance exposing chat/embed/list/generate (no module mock)", async () => {
    const { getOllamaClient } = await loadFactory();
    // Same registry generation as the dynamically imported factory, so the
    // instanceof prototype chain matches (top-level import is pre-reset).
    const { Ollama: FreshOllama } = await import("ollama");
    const client = getOllamaClient(HOST_A);
    expect(typeof Ollama).toBe("function");
    expect(client).toBeInstanceOf(FreshOllama);
    expect(typeof client.chat).toBe("function");
    expect(typeof client.embed).toBe("function");
    expect(typeof client.list).toBe("function");
    expect(typeof client.generate).toBe("function");
  });

  it("passes the unwrapped global fetch when timeoutMs <= 0, a wrapper when > 0", async () => {
    const { getOllamaClient } = await loadFactory();
    const passthrough = getOllamaClient(HOST_A, {
      timeoutMs: 0,
    }) as unknown as { fetch: typeof fetch };
    const wrapped = getOllamaClient(HOST_A, {
      timeoutMs: 1500,
    }) as unknown as { fetch: typeof fetch };
    // LLM_TIMEOUT=0 semantics: the global fetch passes through untouched
    expect(passthrough.fetch).toBe(fetch);
    expect(wrapped.fetch).not.toBe(fetch);
    expect(typeof wrapped.fetch).toBe("function");
  });
});
