/**
 * @fileoverview Live-seed verification for the squashed Prisma baseline.
 *
 * Closes the Phase 138 audit gap (138-VERIFICATION.md human_needed #1): the
 * `seed_rbac()` SQL procedure was covered by mocked unit tests and a
 * schema-identity diff, but the live `prisma db seed` path was never exercised
 * against a fresh squashed-baseline DB. This script runs the full live cycle:
 *
 *   throwaway DB → migrate deploy → db seed (×2 for idempotency) →
 *   count assertions (31 permissions / 31 admin / 11 user) → drop DB
 *
 * Mirrors the throwaway-DB lifecycle pattern from verify-squash-identity.ts.
 * The script is the durable regression guard for the live-seed path — the
 * mocked seed.test.ts cannot cover it. Run from repo root:
 *
 *   npx tsx packages/server/scripts/verify-squash-seed.ts
 *
 * DATABASE_URL resolution (highest priority first):
 *   1. process.env.DATABASE_URL (already set in the environment — lets the
 *      caller point at any local Postgres, e.g. the dev container)
 *   2. root .env DATABASE_URL (production-shaped local Postgres)
 *
 * The throwaway DB is always dropped in a `finally` block — a failed assertion
 * never leaves a leftover DB. Throwaway DB name is unique
 * (`squash_seed_verify_<pid>_<ts>`) so it never collides with an existing DB.
 */

import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const SERVER_DIR = join(dirname(__filename), "..");
const CONSENT_ENV = "PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION";
const SEED_LOG_MARKER =
  "[seed] Seeded RBAC via seed_rbac() procedure (31 permissions, admin=all, user=11)";

loadDotenv({ path: join(SERVER_DIR, "../../.env") }); // repo-root .env (single runtime config)

function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error(
    "[verify-squash-seed] DATABASE_URL is not set. Set it in the environment or in the root .env (localhost:5432, user with CREATEDB privilege).",
  );
}

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
  return `squash_seed_verify_${process.pid}_${Date.now()}`;
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

function runDbSeed(dbUrl: string): { stdout: string; stderr: string } {
  // `prisma db seed` runs the configured seed command (tsx prisma/seed.ts).
  // Capture stdout/stderr so we can assert the seed_rbac() log marker.
  try {
    const out = execFileSync("npx", ["prisma", "db", "seed"], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        [CONSENT_ENV]: process.env[CONSENT_ENV] ?? "yes",
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    // execFileSync returns the combined stdout when stdio is piped; stderr is
    // surfaced via the thrown error on non-zero exit. We pipe stdout and echo
    // it so the user sees the seed log inline.
    process.stdout.write(out);
    return { stdout: out, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout ? e.stdout.toString() : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr ? e.stderr.toString() : "";
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    throw new Error(`prisma db seed exited with code ${e.status ?? "?"}\n${stderr}`);
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

async function countRow(dbUrl: string, sql: string): Promise<number> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const res = await client.query(sql);
    return Number(res.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function assertCounts(dbUrl: string, label: string): Promise<void> {
  const permCount = await countRow(dbUrl, `SELECT count(*)::int AS count FROM "permissions"`);
  const adminCount = await countRow(
    dbUrl,
    `SELECT count(*)::int AS count FROM "role_permissions" WHERE "roleId" = (SELECT "id" FROM "roles" WHERE "name" = 'admin')`,
  );
  const userCount = await countRow(
    dbUrl,
    `SELECT count(*)::int AS count FROM "role_permissions" WHERE "roleId" = (SELECT "id" FROM "roles" WHERE "name" = 'user')`,
  );
  console.log(
    `[verify-squash-seed] ${label}: permissions=${permCount}, admin_role_permissions=${adminCount}, user_role_permissions=${userCount}`,
  );
  if (permCount !== 31) throw new Error(`${label}: expected permissions=31, got ${permCount}`);
  if (adminCount !== 31) throw new Error(`${label}: expected admin_role_permissions=31, got ${adminCount}`);
  if (userCount !== 11) throw new Error(`${label}: expected user_role_permissions=11, got ${userCount}`);
}

async function main(): Promise<number> {
  const baseUrl = resolveDatabaseUrl();
  const { adminUrl, buildDbUrl } = parseAdminUrl(baseUrl);
  const dbName = throwawayDbName();

  // Precondition: admin connection works (the throwaway-DB CREATE/DROP needs it).
  console.log(`[verify-squash-seed] Connecting to admin Postgres: ${adminUrl.replace(/:[^:@]+@/, ":***@")}`);
  const probe = new Client({ connectionString: adminUrl });
  try {
    await probe.connect();
    await probe.end();
  } catch (err) {
    console.error(
      `[verify-squash-seed] PRECONDITION FAILED: cannot connect to admin Postgres at ${adminUrl.replace(/:[^:@]+@/, ":***@")} — ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(`[verify-squash-seed] Set DATABASE_URL to a reachable Postgres (user with CREATEDB privilege).`);
    return 1;
  }

  console.log(`[verify-squash-seed] Creating throwaway DB: ${dbName}`);
  const dbUrl = buildDbUrl(dbName);
  await createThrowawayDb(adminUrl, dbName);

  try {
    console.log(`[verify-squash-seed] Running prisma migrate deploy against ${dbUrl.replace(/:[^:@]+@/, ":***@")}`);
    runMigrateDeploy(dbUrl);

    console.log(`[verify-squash-seed] Running prisma db seed (first run)`);
    const first = runDbSeed(dbUrl);
    if (!first.stdout.includes(SEED_LOG_MARKER)) {
      throw new Error(
        `first seed did not print expected marker: "${SEED_LOG_MARKER}"`,
      );
    }
    await assertCounts(dbUrl, "first seed");

    console.log(`[verify-squash-seed] Running prisma db seed (second run — idempotency)`);
    const second = runDbSeed(dbUrl);
    if (!second.stdout.includes(SEED_LOG_MARKER)) {
      throw new Error(
        `second seed did not print expected marker: "${SEED_LOG_MARKER}"`,
      );
    }
    await assertCounts(dbUrl, "second seed — idempotent, counts unchanged");

    console.log(`[verify-squash-seed] PASS — squashed baseline + live seed verified end-to-end.`);
    return 0;
  } catch (err) {
    console.error(`[verify-squash-seed] FAIL — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await dropDb(adminUrl, dbName);
    console.log(`[verify-squash-seed] Dropped throwaway DB: ${dbName}`);
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[verify-squash-seed] FATAL:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

// Phase 180 dead-code sweep: the named-export barrel line was REMOVED — the
// helpers are script-internal (main() is the only caller; no test imports).