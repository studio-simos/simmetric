/**
 * Jest globalSetup — creates the template test database and runs migrations.
 *
 * This script is executed once before any integration test worker starts.
 * It requires the PostgreSQL user to have CREATEDB privilege.
 */

const { Client } = require("pg");
const { execFileSync } = require("child_process");
const path = require("path");

const BASE_DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat";
const TEMPLATE_DB_NAME = "simmetricchat_test_template";

function getAdminUrl() {
  const url = new URL(BASE_DB_URL);
  url.pathname = "/postgres";
  return url.toString();
}

function getTemplateUrl() {
  const url = new URL(BASE_DB_URL);
  url.pathname = `/${TEMPLATE_DB_NAME}`;
  return url.toString();
}

module.exports = async function globalSetup() {
  const adminClient = new Client({ connectionString: getAdminUrl() });
  await adminClient.connect();

  // Drop template if it exists (clean slate)
  await adminClient.query(
    `DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`,
  );

  // Create template database
  await adminClient.query(`CREATE DATABASE "${TEMPLATE_DB_NAME}"`);
  await adminClient.end();

  // Run Prisma migrations on the template database
  const templateUrl = getTemplateUrl();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: path.join(__dirname),
    env: {
      ...process.env,
      DATABASE_URL: templateUrl,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "inherit",
  });

  // Seed the template database so integration tests have roles, permissions, etc.
  execFileSync("npx", ["prisma", "db", "seed"], {
    cwd: path.join(__dirname),
    env: {
      ...process.env,
      DATABASE_URL: templateUrl,
    },
    stdio: "inherit",
  });

  console.log(
    `[jest-global-setup] Template DB ${TEMPLATE_DB_NAME} ready at ${templateUrl}`,
  );
};
