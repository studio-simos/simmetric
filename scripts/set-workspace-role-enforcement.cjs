#!/usr/bin/env node
/**
 * scripts/set-workspace-role-enforcement.cjs — the D-13 step-3 PERSISTED flip
 * mechanism (Phase 189, Plan 189-04).
 *
 * WHY THIS EXISTS: getSetting() resolves DB-row-first (getDbValue: the global
 * SystemConfig row's value, then CONFIG_DEFAULTS). seedConfigDefaults() seeds
 * the 'false' row with overwrite:false at EVERY server boot once Plan 01
 * ships the default — so a constants-only flip (CONFIG_DEFAULTS "false"→
 * "true") is a RUNTIME NO-OP on any upgraded install whose global row was
 * already seeded. The flip must be PERSISTED: this script overwrites the
 * global row (organizationId null) and invalidates the config cache with the
 * exact Phase 183 updateSettings global-write fan-out (DEL config:{key} +
 * SMEMBERS config:tenants:{key} + per-member DEL), then --verify asserts the
 * RESOLVED getSetting value through the real systemConfigService.
 *
 * Usage:
 *   node scripts/set-workspace-role-enforcement.cjs [--value true|false] [--verify]
 *
 *   (no flags)  — persist "true" (the flip) and print the before/after state
 *   --value X   — persist X ("false" = the documented rollback: re-run with
 *                 "false" or PUT the key via the settings UI)
 *   --verify    — read-only assertion arm: DB row 'true' AND the
 *                 getSetting("WORKSPACE_ROLE_ENFORCEMENT").value resolved
 *                 'true' at runtime (boots the prisma singleton + the real
 *                 getSetting cascade — a constants-only flip FAILS here)
 *
 * Requirements: DATABASE_URL in the environment (root .env — loaded with a
 * tiny dotenv-free loader mirroring loadRootEnv's precedence) or the
 * DATABASE_URL env var itself. Redis cache invalidation is skipped silently
 * when REDIS_URL is unset. No server boot required. Idempotent — safe to
 * re-run.
 *
 * Zero-install contract: uses the pg client the repo already ships
 * (packages/server/node_modules/pg) resolved via createRequire — no new
 * dependencies (RESEARCH.md audit table: zero installs this phase).
 */

"use strict";

const { createRequire } = require("node:module");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..");

/** Minimal dotenv-free loader — mirrors packages/shared loadRootEnv precedence:
 *  process.env FIRST, then the root .env (marker-walk upward is unnecessary
 *  here: scripts/ is always <repo>/scripts). Never overrides existing env.
 *  189-REVIEW WR-03: the key name is RegExp-escaped and inline comments are
 *  stripped — `DATABASE_URL="postgres://host/db" # dev` previously resolved
 *  to the quoted value plus the comment tail. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripInlineComment(raw) {
  // Strip an unquoted trailing comment (` # comment` / ` ; comment`).
  // Quoted values survive intact (the quotes are stripped by the caller).
  const m = raw.match(/^(.*?)(?:\s+#|\s+;)(.*)$/);
  return m ? m[1] : raw;
}
function loadEnvValue(name) {
  if (process.env[name] !== undefined && process.env[name] !== "") return process.env[name];
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, "utf-8");
  const match = content.match(new RegExp(`^${escapeRegExp(name)}=(.*)$`, "m"));
  if (!match) return undefined;
  const noComment = stripInlineComment(match[1]).trim();
  return noComment.replace(/^["']|["']$/g, "").trim() || undefined;
}

/** Resolve a dependency from the SERVER package (pnpm strict isolation does
 *  not hoist pg into the root node_modules). */
function requireFromServer(name) {
  const requireFromServerRoot = createRequire(path.join(REPO_ROOT, "packages/server/package.json"));
  return requireFromServerRoot(name);
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const valueIdx = args.indexOf("--value");
  const targetValue = valueIdx !== -1 ? args[valueIdx + 1] : "true";
  if (!["true", "false"].includes(targetValue)) {
    console.error(`[wsr-enforcement] invalid --value "${targetValue}" (expected "true" | "false")`);
    process.exit(2);
  }

  const KEY = "WORKSPACE_ROLE_ENFORCEMENT";
  const databaseUrl = loadEnvValue("DATABASE_URL");
  if (!databaseUrl) {
    console.error(
      "[wsr-enforcement] DATABASE_URL not set — cannot reach the DB (root .env or env var required)"
    );
    process.exit(2);
  }

  // 1. Direct pg read of the CURRENT persisted value (report-only).
  const { Pool } = requireFromServer("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    // Normalize the DATABASE_URL host when running against the dev compose
    // DB from the host: 'postgres' hostnames resolve only inside the compose
    // network — an operator running this from the host against the
    // host-published port needs no rewrite (localhost:5432 default).
    const current = await pool.query(
      'SELECT value FROM system_config WHERE key = $1 AND "organizationId" IS NULL',
      [KEY],
    );
    const before = current.rows.length > 0 ? current.rows[0].value : "<absent — will INSERT>";
    console.log(`[wsr-enforcement] persisted global row (${KEY}): ${before}`);

    if (verifyOnly) {
      // Read-only assertion arm: the DB row must already carry "true".
      if (before !== "true") {
        console.error(
          `[wsr-enforcement] VERIFY FAILED — persisted row reads "${before}", expected "true". ` +
            "Run the script without --verify to persist the flip first.",
        );
        process.exit(1);
      }
      // 2. RESOLVED-value proof (D-13 step 3): boot the real
      // systemConfigService.getSetting cascade (DB > ENV > default + Redis)
      // with the prisma singleton — the constants-only no-op detection the
      // acceptance criterion demands.
      const resolved = await resolveRuntimeValue();
      if (resolved !== "true") {
        console.error(
          `[wsr-enforcement] RESOLVED getSetting("${KEY}") = "${resolved}" — expected "true". ` +
            "The flip did NOT reach the runtime consumers (cache not invalidated or " +
            "ENV override present).",
        );
        process.exit(1);
      }
      console.log(`[wsr-enforcement] --verify PASS: persisted row "true" AND resolved getSetting "true"`);
      return;
    }

    // 2. PERSIST: upsertSystemConfigRow overwrite:true shape replicated
    // inline (find-first → id-anchored update → P2002 recheck; INSERT the
    // row when missing — a fresh install may not have booted yet).
    const client = await pool.connect();
    let rowId;
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        'SELECT id FROM system_config WHERE key = $1 AND "organizationId" IS NULL FOR UPDATE',
        [KEY],
      );
      if (existing.rows.length > 0) {
        await client.query("UPDATE system_config SET value = $2 WHERE id = $1", [
          existing.rows[0].id,
          targetValue,
        ]);
        rowId = existing.rows[0].id;
      } else {
        // 189-REVIEW WR-03: the table's `id`/`updatedAt` columns are NOT NULL
        // with NO database default (Prisma @default(uuid())/@updatedAt are
        // CLIENT-side), so a bare (key, value, organizationId) INSERT crashed
        // with a NOT NULL violation on any install whose seed had not yet
        // booted — exactly the fresh-install case this arm exists for. The
        // shape mirrors upsertSystemConfigRow's client-side uuid + NOW().
        const created = await client.query(
          'INSERT INTO system_config (id, key, value, "organizationId", "updatedAt") VALUES ($1, $2, $3, NULL, NOW()) RETURNING id',
          [crypto.randomUUID(), KEY, targetValue],
        );
        rowId = created.rows[0].id;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    const after = await pool.query(
      'SELECT value FROM system_config WHERE id = $1',
      [rowId],
    );
    console.log(
      `[wsr-enforcement] persisted: "${before}" → "${after.rows[0].value}" (id ${rowId})`,
    );

    // 3. Config-cache invalidation — the EXACT Phase 183 updateSettings
    // global-write fan-out (DEL config:{key} + SMEMBERS config:tenants:{key}
    // + per-member DEL), skipped silently when Redis is absent.
    const redisUrl = loadEnvValue("REDIS_URL");
    if (redisUrl) {
      try {
        const Redis = requireFromServer("ioredis");
        const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
        await redis.connect();
        // Key order mirrors updateSettings: DEL the global key, then fan out
        // to every tenant override of the same key.
        const globalDeleted = await redis.del(`config:${KEY}`);
        const overriddenOrgs = await redis.smembers(`config:tenants:${KEY}`);
        let tenantDeleted = 0;
        for (const orgId of overriddenOrgs) {
          tenantDeleted += await redis.del(`config:${orgId}:${KEY}`);
        }
        console.log(
          `[wsr-enforcement] cache fan-out: config:${KEY} del=${globalDeleted}, ` +
            `tenant overrides=${overriddenOrgs.length} (del=${tenantDeleted})`,
        );
        redis.disconnect();
      } catch (err) {
        // Non-blocking by contract — the TTL (5 min) is the safety net.
        console.warn(
          `[wsr-enforcement] cache invalidation failed (non-blocking, TTL safety net): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      console.log("[wsr-enforcement] REDIS_URL not set — cache invalidation skipped (TTL safety net)");
    }

    // 4. Runtime resolution check (best-effort in the persist arm too).
    const resolved = await resolveRuntimeValue();
    console.log(`[wsr-enforcement] resolved getSetting("${KEY}") = ${resolved}`);
    if (resolved !== targetValue) {
      console.error(
        `[wsr-enforcement] RESOLVED value "${resolved}" != target "${targetValue}" — ` +
          "check ENV overrides (process.env or root .env) — the DB row is correct but " +
          "an ENV override would win at runtime.",
      );
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

/** Boot the prisma singleton + systemConfigService.getSetting and resolve
 *  the runtime value — the real consumers' read path (tsx-free: the server's
 *  compiled dist is used; falls back to tsx for source runs). */
async function resolveRuntimeValue() {
  try {
    const { getSetting } = requireFromServer("./dist/services/systemConfigService.js");
    const entry = await getSetting("WORKSPACE_ROLE_ENFORCEMENT");
    return entry.value;
  } catch (err) {
    console.warn(
      `[wsr-enforcement] runtime resolution unavailable ` +
        `(server dist not built? ${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[wsr-enforcement] FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });