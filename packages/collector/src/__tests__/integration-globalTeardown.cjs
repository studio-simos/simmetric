// globalTeardown for collector integration tests (Phase 91-04).
//
// Runs ONCE after all test suites, in the jest main process. Cleans up
// residual `chunk_vectors_*` tables so the `pgvector_test` DB is left clean
// for the next run. Idempotent — safe to run even if PG is unavailable or
// the tables were already dropped by per-test afterAll hooks.

const { Pool } = require("pg");

module.exports = async function globalTeardown() {
  // Skip cleanup if PG was never available (globalSetup sets this).
  if (process.env.PGVECTOR_AVAILABLE !== "true") return;
  const url = process.env.PGVECTOR_TEST_URL;
  if (!url) return;

  let pool;
  try {
    pool = new Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
    const client = await pool.connect();
    try {
      for (const dim of [384, 768, 1024, 1536, 3072]) {
        await client
          .query(`DROP TABLE IF EXISTS chunk_vectors_${dim} CASCADE`)
          .catch(() => {});
      }
      console.log("[pgvector-integration] globalTeardown: dropped chunk_vectors_* tables.");
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn(`[pgvector-integration] globalTeardown cleanup failed: ${err.message}`);
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