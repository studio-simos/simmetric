// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Setup file for collector integration tests (Phase 91-04).
 *
 * Loaded via `setupFiles` in `jest.config.integration.cjs`. Runs in each
 * test worker BEFORE the test framework (jest globals) is installed — so
 * it can only use `process.env`, `console.*`, and `process.exit`. It CANNOT
 * use `beforeAll`/`afterEach` (those are jest globals, not yet available).
 *
 * Responsibilities (Pitfall 4 integration-harness-maindb-leak defense):
 *   1. Hard guard: refuse to run if `process.env.DATABASE_URL` is set. The
 *      integration tests must NEVER write to the main dev DB. The globalSetup
 *      also checks this, but this is a per-worker defense-in-depth guard —
 *      if a worker somehow inherits a stray DATABASE_URL, we exit before
 *      any test file loads.
 *   2. Set `process.env.PGVECTOR_TEST_URL` (port 5433, dedicated
 *      `pgvector_test` DB — NEVER 5432, NEVER the main DB).
 *   3. Pin `process.env.EMBEDDING_MODEL` to the default 384-dim model so the
 *      provider's `getDimension()` returns 384 even if the operator's `.env`
 *      has a different model. (The test file additionally mocks
 *      `getEmbeddingProvider` to avoid loading the heavy Xenova pipeline —
 *      this env pin is a belt-and-suspenders guard for any code path that
 *      reads the env directly.)
 */

// 1. Pitfall 4 guard — refuse if DATABASE_URL is set (main DB leak prevention).
if (process.env.DATABASE_URL) {
  console.error(
    "[pgvector-integration] REFUSING TO RUN: process.env.DATABASE_URL is set — " +
      "integration tests must NOT use the main DB (Pitfall 4 integration-harness-maindb-leak). " +
      "Unset DATABASE_URL and set PGVECTOR_TEST_URL instead (port 5433, pgvector_test DB).",
  );
  process.exit(1);
}

// 2. Dedicated test URL. Port 5433 — NEVER 5432 (main dev PG).
//    Operator must start pgvector on port 5433 before running:
//      docker run -d -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
//        -e POSTGRES_DB=pgvector_test pgvector/pgvector:pg16
process.env.PGVECTOR_TEST_URL =
  process.env.PGVECTOR_TEST_URL || "postgres://test:test@localhost:5433/pgvector_test";

// 3. Pin embedding model to 384-dim default (belt-and-suspenders for any
//    code path that reads EMBEDDING_MODEL directly; the test file also
//    mocks getEmbeddingProvider to avoid loading Xenova).
process.env.EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
process.env.EMBEDDING_PROVIDER = "local";