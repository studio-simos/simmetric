// globalSetup for collector integration tests (Phase 91-04).
//
// Runs ONCE before all test suites, in the jest main process. Env vars set
// here propagate to worker processes (jest workers inherit process.env at
// fork time, and globalSetup runs before any fork).
//
// Responsibilities:
//   1. Pitfall 4 guard (defense-in-depth — setupFiles also checks): refuse
//      to run if `process.env.DATABASE_URL` is set (main DB leak prevention,
//      cf. `integration-harness-maindb-leak` memory). The integration tests
//      must NEVER write to the main dev DB.
//   2. Set `process.env.PGVECTOR_TEST_URL` (port 5433, dedicated `pgvector_test`
//      DB — NEVER 5432, NEVER the main DB).
//   3. Probe PG + pgvector extension availability. Set
//      `process.env.PGVECTOR_AVAILABLE = "true" | "false"` so test files can
//      gate via `(PG_AVAILABLE ? describe : describe.skip)`. When PG or the
//      pgvector extension is unavailable, tests SKIP with a clear message —
//      NOT a false pass, NOT a silent fail.
//   4. If PG is available, drop any residual `chunk_vectors_*` tables from
//      previous runs (idempotent test isolation).
//
// This is a `.cjs` file (CommonJS) because jest's globalSetup is loaded via
// `require()` and is NOT transformed by the jest `transform` config. Using
// `.cjs` ensures Node loads it as CommonJS regardless of the package.json
// `type` field.

const { Pool } = require("pg");

module.exports = async function globalSetup() {
  // 1. Pitfall 4 guard — refuse if DATABASE_URL points at the main DB.
  if (process.env.DATABASE_URL) {
    console.error(
      "[pgvector-integration] REFUSING TO RUN: process.env.DATABASE_URL is set — " +
        "integration tests must NOT use the main DB (Pitfall 4 integration-harness-maindb-leak). " +
        "Unset DATABASE_URL and set PGVECTOR_TEST_URL instead (port 5433, pgvector_test DB).",
    );
    process.exit(1);
  }

  // 2. Set the dedicated test URL. Port 5433 — NEVER 5432 (main dev PG).
  process.env.PGVECTOR_TEST_URL =
    process.env.PGVECTOR_TEST_URL || "postgres://test:test@localhost:5433/pgvector_test";

  const url = process.env.PGVECTOR_TEST_URL;

  // 3. Probe PG + pgvector availability.
  let pool;
  try {
    pool = new Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
    const client = await pool.connect();
    try {
      // Try to create the extension (idempotent). Fails with SQLSTATE 42704
      // if the extension files are not installed in the PG image.
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      } catch (extErr) {
        // Extension not installed or insufficient privilege — fall through
        // to the pg_extension check; if it's not there either, we SKIP.
        console.warn(
          `[pgvector-integration] CREATE EXTENSION vector failed: ${extErr.message}`,
        );
      }
      const extCheck = await client.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
      );
      if (extCheck.rows.length > 0) {
        process.env.PGVECTOR_AVAILABLE = "true";
        console.log(
          "[pgvector-integration] PG + pgvector available on port 5433 — integration tests will run.",
        );
        // 4. Drop residual chunk_vectors_* tables from previous runs.
        for (const dim of [384, 768, 1024, 1536, 3072]) {
          await client
            .query(`DROP TABLE IF EXISTS chunk_vectors_${dim} CASCADE`)
            .catch(() => {});
        }
      } else {
        process.env.PGVECTOR_AVAILABLE = "false";
        console.warn(
          "[pgvector-integration] pgvector extension NOT installed — integration tests will SKIP. " +
            "Install via: docker run -d -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test " +
            "-e POSTGRES_DB=pgvector_test pgvector/pgvector:pg16",
        );
      }
    } finally {
      client.release();
    }
  } catch (err) {
    process.env.PGVECTOR_AVAILABLE = "false";
    console.warn(
      `[pgvector-integration] PG not reachable on port 5433 (${err.message}) — integration tests will SKIP. ` +
        "Start PG: docker run -d -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test " +
        "-e POSTGRES_DB=pgvector_test pgvector/pgvector:pg16",
    );
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch (_) {
        /* ignore */
      }
    }
  }
};