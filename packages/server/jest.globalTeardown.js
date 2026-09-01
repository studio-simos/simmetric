/**
 * Jest globalTeardown — drops the template test database and any worker databases.
 */

const { Client } = require("pg");

const BASE_DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat";
const TEMPLATE_DB_NAME = "simmetricchat_test_template";

function getAdminUrl() {
  const url = new URL(BASE_DB_URL);
  url.pathname = "/postgres";
  return url.toString();
}

module.exports = async function globalTeardown() {
  const adminClient = new Client({ connectionString: getAdminUrl() });
  await adminClient.connect();

  // Drop the template database
  await adminClient.query(
    `DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`,
  );

  // Drop any residual worker databases from previous interrupted runs
  const result = await adminClient.query(`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'simmetricchat_test_worker_%'
  `);

  for (const row of result.rows) {
    await adminClient.query(
      `DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`,
    );
  }

  await adminClient.end();
  console.log("[jest-global-teardown] Cleanup complete");
};
