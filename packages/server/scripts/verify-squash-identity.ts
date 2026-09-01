/**
 * @fileoverview Schema-identity verification for the squashed Prisma baseline.
 *
 * Single-DB approach (per 138-RESEARCH.md A4 and 138-VALIDATION.md row 138-01-02):
 * the 25-migration chain is deleted by the squash, so a 2-DB pg_dump diff is
 * infeasible. Instead this script proves schema-identity by comparing the
 * squashed baseline's deployed schema against the schema.prisma declaration.
 */

import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const SERVER_DIR = join(dirname(__filename), "..");
const SCHEMA_PATH = join(SERVER_DIR, "prisma", "schema.prisma");
const CONSENT_ENV = "PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION";

function parseAdminUrl(baseUrl: string): { adminUrl: string; buildDbUrl: (db: string) => string } {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  const adminUrl = url.toString();
  const buildDbUrl = (db: string) => {
    const u = new URL(baseUrl);
    u.pathname = `/${db}`;
    return u.toString();
  };
  return { adminUrl, buildDbUrl };
}

function throwawayDbName(): string {
  return `squash_identity_${process.pid}_${Date.now()}`;
}

function runMigrateDeploy(dbUrl: string): void {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      [CONSENT_ENV]: process.env[CONSENT_ENV] ?? "yes",
    },
    stdio: "inherit",
  });
}

function runSchemaDiff(dbUrl: string): number {
  try {
    execFileSync(
      "npx",
      ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", SCHEMA_PATH, "--exit-code"],
      {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl,
          [CONSENT_ENV]: process.env[CONSENT_ENV] ?? "yes",
        },
        stdio: "inherit",
      },
    );
    return 0;
  } catch (err) {
    const code = (err as { status?: number }).status ?? 1;
    return code;
  }
}

async function createThrowawayDb(adminUrl: string, dbName: string): Promise<string> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${dbName}`;
  return dbUrl.toString();
}

async function dropDb(adminUrl: string, dbName: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    // best-effort
  } finally {
    try { await admin.end(); } catch { /* swallow */ }
  }
}

async function main(): Promise<number> {
  const baseUrl =
    process.env.DATABASE_URL ??
    "postgresql://simmetricchat:simmetricchat@localhost:5434/simmetricchat_test";
  const { adminUrl, buildDbUrl } = parseAdminUrl(baseUrl);
  const dbName = throwawayDbName();

  console.log(`[verify-squash-identity] Creating throwaway DB: ${dbName}`);
  const dbUrl = buildDbUrl(dbName);
  await createThrowawayDb(adminUrl, dbName);

  try {
    console.log(`[verify-squash-identity] Running prisma migrate deploy against ${dbUrl}`);
    runMigrateDeploy(dbUrl);

    console.log(`[verify-squash-identity] Running prisma migrate diff`);
    const diffExit = runSchemaDiff(dbUrl);

    if (diffExit === 0) {
      console.log(`[verify-squash-identity] PASS — squashed baseline is schema-identical to schema.prisma (zero diff).`);
      return 0;
    }
    if (diffExit === 2) {
      console.error(`[verify-squash-identity] FAIL — drift detected (exit code 2). The squashed baseline does NOT match schema.prisma.`);
      return 1;
    }
    console.error(`[verify-squash-identity] ERROR — prisma migrate diff exited with code ${diffExit}.`);
    return 1;
  } finally {
    await dropDb(adminUrl, dbName);
    console.log(`[verify-squash-identity] Dropped throwaway DB: ${dbName}`);
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[verify-squash-identity] FATAL:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

export { parseAdminUrl, throwawayDbName, runMigrateDeploy, runSchemaDiff, createThrowawayDb, dropDb };
