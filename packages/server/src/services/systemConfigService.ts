// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * System Config Service — Manages system settings with ENV variable override.
 *
 * Priority: ENV variable > DB value > Default.
 * If an ENV variable is set for a config key, the DB value is ignored
 * and the setting is marked as readOnly (cannot be changed via UI).
 */

import { configKeySchema, type ConfigKey } from "@simmetric-chat/shared";
import { CONFIG_DEFAULTS } from "@simmetric-chat/shared";
import { Prisma } from "@prisma/client";
import type { SystemConfig } from "@prisma/client";
import { getLicenseInfo } from "./licenseService";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getRedis } from "./redisService";
import type { SettingsEntry, ConfigKeyValidator, LicenseInfo } from "@simmetric-chat/shared";

/**
 * Phase 145 (EPA-05 — D-01): plugin-supplied config-key validators. Empty
 * in a pure community build (no enterprise plugin loaded). The enterprise
 * `register(ctx)` injects its branding validator via
 * `ctx.registerConfigKeyValidator(fn)`, which forwards to
 * `registerConfigKeyValidator(fn)` below (same IoC shape as the Phase 144
 * `setAuditLogDelegate` / `registerAuditLogWriter` pair).
 */
const configKeyValidators: ConfigKeyValidator[] = [];

/**
 * Phase 145 (EPA-05 — D-01): register a config-key validator into the
 * community `updateSettings()` loop. Called by `enterpriseLoader.ts`
 * (via `ctx.registerConfigKeyValidator`, which aliases this function to
 * avoid the name collision — Pitfall 1) when the enterprise plugin boots.
 */
export function registerConfigKeyValidator(fn: ConfigKeyValidator): void {
  configKeyValidators.push(fn);
}

// Keys that are always readOnly because they control infrastructure
const ALWAYS_READONLY: ConfigKey[] = [
  "JWT_SECRET",
  "DATABASE_URL",
  "SERVER_PORT",
  "COLLECTOR_PORT",
  "SERVER_URL",
  "COLLECTOR_URL",
];

// D-07: Redis cache prefix and TTL for SystemConfig values.
// Cross-instance cache makes config changes visible immediately via
// invalidation (DEL) in updateSettings(). 5-minute TTL as secondary expiry.
const CONFIG_CACHE_PREFIX = "config:";
const CONFIG_CACHE_TTL_SECONDS = 300;

/**
 * Phase 183 (SAAS-02 — 183-01): the single write path for SystemConfig rows.
 *
 * Every service-internal SystemConfig write (updateSettings, seedConfigDefaults,
 * ensureSetupWizardMode) routes through this find-first-then-write helper.
 *
 * WHY find-first instead of upsert: after the `@@unique([organizationId, key])`
 * swap (Plan 03, M5 migration) the generated `SystemConfigWhereUniqueInput`
 * loses the scalar-key arm entirely (DlpPattern precedent — that model already
 * carries the composite and only exposes `id` + `organizationId_name`). And the
 * composite CANNOT arbitrate an upsert's ON CONFLICT for NULL members: Postgres
 * treats NULLs as distinct in unique indexes, so a global row (organizationId
 * NULL) would never conflict with the composite target. If Plan 03 adds the
 * partial unique (`WHERE organizationId IS NULL`), a partial index is still
 * 42P10-banned as an ON CONFLICT target ("no unique or exclusion constraint
 * matching the ON CONFLICT specification") — the same reason
 * `ensureDefaultOrgMembership` (organizationService.ts) uses find-first instead
 * of upsert against its partial unique. This shape is therefore safe EITHER way
 * the schema lands (scalar unique today, composite + optional partial tomorrow)
 * — the helper is swap-agnostic by construction.
 *
 * Semantics:
 *  1. find-first on { key, organizationId: organizationId ?? null } — the
 *     explicit null-org filter is what survives the composite swap (a plain
 *     `where: { key }` read would not compile post-swap).
 *  2. Row found + overwrite (default): id-anchored update of the value. The
 *     id-anchored `where: { id: existing.id }` arm survives every unique-shape
 *     change (it never references the unique key).
 *  3. Row found + overwrite === false: return the row UNCHANGED — this
 *     reproduces the old `update: {}` empty-update semantics that
 *     seedConfigDefaults uses to preserve user-set values on re-seed.
 *  4. No row: fresh create. A concurrent caller that raced past its own
 *     find-first loses the create race with P2002 (scalar unique today,
 *     partial unique post-swap) — the catch re-checks and returns the winner
 *     instead of crashing boot/seed/settings flows (the
 *     ensureDefaultOrgMembership tolerance precedent, 182-03).
 *
 * The db param accepts the PrismaClient singleton OR a transaction client
 * (organizationService.ts PrismaDbClient convention) — Plan 02 passes the
 * wizard's Serializable `tx` through this same helper.
 *
 * @param db    Prisma singleton or transaction client.
 * @param opts  key (config key), value, optional organizationId (null/undefined
 *              = global row), optional overwrite flag (default true; false =
 *              create-only-if-missing).
 * @returns the winning SystemConfig row.
 */
export type PrismaDbClient = typeof prisma | Prisma.TransactionClient;

export async function upsertSystemConfigRow(
  db: PrismaDbClient,
  opts: { key: string; value: string; organizationId?: string | null; overwrite?: boolean },
): Promise<SystemConfig> {
  const { key, value, organizationId, overwrite } = opts;
  const orgFilter = organizationId ?? null;

  // (1) Find-first: the composite-unique-safe lookup (explicit org filter).
  const existing = await db.systemConfig.findFirst({
    where: { key, organizationId: orgFilter },
  });

  // (2) Row exists → id-anchored update (or no-op when overwrite is false).
  if (existing) {
    if (overwrite === false) {
      return existing; // create-only-if-missing semantics (seedConfigDefaults)
    }
    return db.systemConfig.update({
      where: { id: existing.id },
      data: { value },
    });
  }

  // (3) Fresh create with P2002 race tolerance: a concurrent caller that raced
  //     past its own findFirst already created the row — re-check and return
  //     the winner instead of crashing (ensureDefaultOrgMembership precedent).
  try {
    return await db.systemConfig.create({
      data: { key, value, organizationId: orgFilter },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    const winner = await db.systemConfig.findFirst({
      where: { key, organizationId: orgFilter },
    });
    if (winner) return winner;
    throw err;
  }
}

/**
 * Get all system settings with readOnly flags.
 * ENV-defined values override DB values and are marked readOnly.
 *
 * D-08 (Phase 176) boundary: the `envOverridden` flag rides ONLY this
 * function (the settings-UI GET path). getSetting()'s Redis-cached payload
 * intentionally omits it (no cache-format change) and the ALWAYS_READONLY
 * push (ENV-only keys) never carries it — the flag is set exclusively for
 * non-readonly keys whose env value is present and non-empty.
 *
 * Phase 183 (SAAS-02, D-07): optional organizationId switches to the
 * org-scoped view — the existing global computation runs unchanged, then
 * tenant rows for that org overlay the map (each tenant key wins with
 * source "tenant"; keys resolved only from global rows/env/defaults get
 * the corresponding source). The GLOBAL view (undefined) stays
 * byte-identical to the pre-183 output — no source flag ever (Pitfall P2).
 * ALWAYS_READONLY keys ARE included in the org-scoped listing (resolved
 * ENV/default — D-11 forbids only per-tenant DB reads of them). The
 * unscoped readOnlyKeys derivation in updateSettings() intentionally keeps
 * reading the GLOBAL view (P6: tenant rows do not join that computation).
 *
 * Fix Round 1 (CR-01, 183-REVIEW): the base layer is the GLOBAL row set
 * only (findMany where organizationId: null). The org overlay is a
 * separate query filtered to the REQUESTED org — other tenants' rows are
 * unreachable by construction (SC-3's stated intent: no cross-tenant
 * bleed in either direction, and the global view shows only global rows).
 */
export async function getAllSettings(organizationId?: string): Promise<SettingsEntry[]> {
  // CR-01 (183-REVIEW Fix Round 1): the base layer is scoped to GLOBAL rows
  // only (organizationId: null). The pre-fix bare findMany() loaded EVERY
  // org's tenant rows into dbMap keyed only by key — org-A's view fell back
  // to org-B's override value (mislabeled source: "global") and the global
  // view could display an arbitrary tenant row's value (Map last-wins, no
  // ORDER BY). Tenant values enter the view ONLY through the org-scoped
  // tenantMap overlay below (never through dbMap).
  const dbConfigs = await prisma.systemConfig.findMany({
    where: { organizationId: null },
  });
  const dbMap = new Map(dbConfigs.map((c) => [c.key, c.value]));

  // Org-scoped: overlay the tenant rows onto the global map. Tenant wins per
  // key; the SOURCE of each key is tracked so the entry can name its tier.
  const tenantMap = new Map<string, string>();
  if (organizationId !== undefined) {
    const tenantRows = await prisma.systemConfig.findMany({
      where: { organizationId },
    });
    for (const row of tenantRows) {
      tenantMap.set(row.key, row.value);
    }
  }

  // Merge all known config keys (schema keys + any extra DB keys + tenant keys)
  const allKeys = new Set<ConfigKey>([
    ...configKeySchema.options,
    ...dbConfigs.map((c) => c.key as ConfigKey),
    ...Array.from(tenantMap.keys()) as ConfigKey[],
  ]);

  const settings: SettingsEntry[] = [];

  for (const key of allKeys) {
    // By design: read process.env[key] for a dynamic ConfigKey set. This is the
    // ENV-override mechanism for system settings — the key is not known
    // statically, so getEnv() (which exposes a fixed Zod-typed schema) cannot
    // replace this read. Not a validation gap; the configKeySchema + update
    // guards validate keys elsewhere. See .planning/codebase/CONCERNS.md.
    const envValue = process.env[key];
    const isAlwaysReadOnly = ALWAYS_READONLY.includes(key);
    const hasEnvOverride = envValue !== undefined && envValue !== "";
    const dbValue = dbMap.get(key);

    // Org-scoped tier resolution (shared by both branches below): tenant row
    // wins, then global row, then ENV, then CONFIG_DEFAULTS.
    const tenantValue = tenantMap.get(key);
    const tenantWins = tenantValue !== undefined;
    const value = tenantWins
      ? tenantValue!
      : (dbValue as string | undefined) ?? (hasEnvOverride ? envValue! : (CONFIG_DEFAULTS[key] ?? ""));

    if (organizationId !== undefined) {
      // Org-scoped entry: source names the tier that won. ALWAYS_READONLY
      // keys are listed ENV/default (never from any DB row — D-11).
      let source: "tenant" | "global" | "env" | "default";
      if (isAlwaysReadOnly) {
        source = hasEnvOverride ? "env" : "default";
      } else if (tenantWins) {
        source = "tenant";
      } else if (dbValue !== undefined) {
        source = "global";
      } else if (hasEnvOverride) {
        source = "env";
      } else {
        source = "default";
      }
      settings.push({
        key,
        value: isAlwaysReadOnly
          ? (hasEnvOverride ? envValue! : (CONFIG_DEFAULTS[key] ?? ""))
          : value,
        readOnly: isAlwaysReadOnly,
        source,
      });
      continue;
    }

    if (isAlwaysReadOnly) {
      // Infrastructure keys: ENV > Default, always readOnly
      settings.push({
        key,
        value: hasEnvOverride ? envValue! : (CONFIG_DEFAULTS[key] ?? ""),
        readOnly: true,
      });
    } else {
      // All other keys: DB > ENV > Default, always editable from UI
      settings.push({
        key,
        value,
        readOnly: false,
        // D-08 (Phase 176): flag the "env var set but loses to DB" case so
        // the UI can show the muted presence hint instead of letting
        // operators believe the env var is effective. Boolean-only — never
        // carries the env value (T-176-01).
        ...(hasEnvOverride ? { envOverridden: true } : {}),
      });
    }
  }

  return settings;
}

/**
 * Decode a Redis-cached getSetting payload into a SettingsEntry.
 *
 * Two payload formats coexist by design:
 *  - Envelope (WR-01 Fix Round 1, org-scoped fills): `{"v":<value>,"s":<tier>}`
 *    — the cached tier rides the payload so the cache-hit `source` names the
 *    tier that ACTUALLY resolved the value (global-tier fallbacks are no
 *    longer mislabeled "tenant"). Returned only when `s` is a known tier.
 *  - Legacy bare string (pre-183 format, or an in-flight rolling deploy):
 *    decoded by the caller as value-only; org-scoped hits treat the tier as
 *    "tenant" (the only tier the legacy format ever carried under the
 *    namespaced key). The global arm (no organizationId) never carries
 *    `source` (P2) regardless of payload format.
 *
 * Returns null when the payload is not a parseable envelope — the caller
 * falls back to the legacy decode. Never throws (a malformed payload
 * degrades to the fallback arm; Redis read errors are handled upstream).
 */
function getSettingCacheEntry(
  cached: string,
  key: ConfigKey,
  organizationId?: string,
): SettingsEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cached);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { v?: unknown }).v !== "string" ||
    typeof (parsed as { s?: unknown }).s !== "string"
  ) {
    return null;
  }
  const envelope = parsed as { v: string; s: string };
  const tiers = ["tenant", "global", "env", "default"] as const;
  if (!(tiers as readonly string[]).includes(envelope.s)) {
    return null;
  }
  const entry: SettingsEntry = { key, value: envelope.v, readOnly: false };
  if (organizationId !== undefined) {
    entry.source = envelope.s as SettingsEntry["source"];
  }
  return entry;
}

/**
 * Get a single setting value with ENV override.
 *
 * For non-ALWAYS_READONLY keys: checks Redis cache (config:{key}) before
 * the DB query. On cache hit, returns the cached value without a DB
 * round-trip. On miss, queries the DB and fills the cache (D-07).
 * For ALWAYS_READONLY keys: skips Redis entirely (ENV-only).
 * When Redis is unavailable, falls through to the existing DB query (D-02).
 *
 * Phase 183 (SAAS-02, D-06): optional organizationId switches to the
 * org-scoped cascade — cacheKey becomes `config:{orgId}:{key}` (D-09; the
 * global arm keeps the legacy `config:{key}`), resolution order is tenant
 * row → global row → ENV → CONFIG_DEFAULTS, and the returned entry carries
 * `source` naming the tier that won. The `source` flag is emitted ONLY when
 * organizationId was passed (Pitfall P2: the global path's entry shape is
 * byte-identical to the pre-183 payload). The ALWAYS_READONLY short-circuit
 * runs FIRST regardless of organizationId (D-11/P5): an org-scoped read of
 * an infra key resolves ENV/default without touching Redis or any DB row —
 * the org arm never shadows it.
 *
 * Fix Round 1 (WR-01, 183-REVIEW): org-scoped DB-tier fills cache the
 * tier-carrying envelope { v, s } under the namespaced key, and a
 * global-tier fill additionally SADDs the org into config:tenants:{key} so
 * the global-write fan-out (SMEMBERS → per-member DEL) can invalidate it —
 * pre-fix those fills were invisible to fan-out and served stale for up to
 * TTL. Cache hits decode the envelope and report the cached tier truthfully;
 * legacy bare-string payloads decode value-only with the pre-fix "tenant"
 * label (rolling-deploy compatibility).
 */
export async function getSetting(key: ConfigKey, organizationId?: string): Promise<SettingsEntry> {
  // By design: dynamic ConfigKey ENV-override read — see getAllSettings() note.
  const envValue = process.env[key];
  const isAlwaysReadOnly = ALWAYS_READONLY.includes(key);
  const hasEnvOverride = envValue !== undefined && envValue !== "";

  // D-11/P5: ALWAYS_READONLY short-circuit stays FIRST — even when an
  // organizationId is passed, infra keys never touch Redis or tenant/global
  // DB rows (ENV-only resolution, org-agnostic).
  if (isAlwaysReadOnly) {
    // Global path: the legacy computation byte-identical (ENV, else the
    // getDbValue global-row read).
    if (organizationId === undefined) {
      return { key, value: hasEnvOverride ? envValue! : await getDbValue(key), readOnly: true };
    }
    // Org-scoped (D-11/P5): ENV/default ONLY — no Redis access, no org read,
    // no DB row of ANY tier. Infra keys are ENV-only by contract; the legacy
    // getDbValue fallback is a global-path quirk the org arm does not inherit.
    return {
      key,
      value: hasEnvOverride ? envValue! : (CONFIG_DEFAULTS[key] ?? ""),
      readOnly: true,
      source: hasEnvOverride ? "env" : "default",
    };
  }

  // D-09: tenant rows cache at config:{orgId}:{key}; global rows keep the
  // legacy config:{key} (zero cache migration).
  const cacheKey = organizationId !== undefined
    ? `${CONFIG_CACHE_PREFIX}${organizationId}:${key}`
    : `${CONFIG_CACHE_PREFIX}${key}`;

  // D-07: Check Redis cache before DB for non-readonly keys
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        // WR-01 (183-REVIEW Fix Round 1): org-scoped fills cache a JSON
        // envelope { v, s } — the value AND the tier that resolved it — so
        // the cache-hit `source` names the actual resolution tier instead
        // of a hardcoded "tenant" (global-tier fallbacks were mislabeled).
        // A bare-string payload is the legacy/pre-183 format (or an
        // in-flight rolling deploy): decode value-only and treat the tier
        // as tenant for org-scoped reads (the only tier the legacy format
        // ever carried under the namespaced key).
        const cachedEntry = getSettingCacheEntry(cached, key, organizationId);
        if (cachedEntry) return cachedEntry;
        // Fallback: legacy bare-string payload.
        const entry: SettingsEntry = { key, value: JSON.parse(cached), readOnly: false };
        if (organizationId !== undefined) entry.source = "tenant";
        return entry;
      }
    } catch (err: unknown) {
      logger.warn("[redis] config cache read failed (non-blocking)", {
        error: err instanceof Error ? err.message : String(err),
        key,
      });
    }
  }

  // Cache miss or Redis unavailable → resolution cascade.
  // Global path (undefined org): the legacy getDbValue + ENV merge,
  // byte-identical to pre-183 behavior (getDbValue returns
  // `entry?.value ?? CONFIG_DEFAULTS[key] ?? ""` and the legacy code merges
  // ENV only when the DB/default chain yields empty).
  if (organizationId === undefined) {
    const dbValue = await getDbValue(key);
    const value = dbValue || (hasEnvOverride ? envValue! : "");
    // D-07: Fill Redis cache on miss (non-blocking) — legacy key only.
    if (redis && dbValue) {
      try {
        await redis.setex(
          `${CONFIG_CACHE_PREFIX}${key}`,
          CONFIG_CACHE_TTL_SECONDS,
          JSON.stringify(dbValue),
        );
      } catch (err: unknown) {
        logger.warn("[redis] config cache write failed (non-blocking)", {
          error: err instanceof Error ? err.message : String(err),
          key,
        });
      }
    }
    return { key, value, readOnly: false };
  }

  // Org-scoped cascade (D-06): tenant row → global row → ENV →
  // CONFIG_DEFAULTS, each tier labeled so `source` names the level that won.
  const tenantRow = await prisma.systemConfig.findFirst({
    where: { key, organizationId },
  });
  if (tenantRow) {
    const value = tenantRow.value;
    // Cache-fill ONLY the tenant tier's namespaced key (D-01 symmetry: a
    // tenant write invalidates only its own key; a tenant read caches only
    // the tenant level). WR-01 Fix Round 1: the payload is the tier-carrying
    // envelope so the cache-hit `source` is truthful. NOTE: no SADD here —
    // the fan-out DEL below invalidates this org's key directly, so set
    // membership is redundant for the tenant tier.
    if (redis && value) {
      try {
        await redis.setex(
          cacheKey,
          CONFIG_CACHE_TTL_SECONDS,
          JSON.stringify({ v: value, s: "tenant" }),
        );
      } catch (err: unknown) {
        logger.warn("[redis] config cache write failed (non-blocking)", {
          error: err instanceof Error ? err.message : String(err),
          key,
        });
      }
    }
    return { key, value, readOnly: false, source: "tenant" };
  }

  // Global row (explicit null-org findFirst — NOT getDbValue, which merges
  // the CONFIG_DEFAULTS fallback and would blur the "global" vs "default"
  // source tiers).
  const globalRow = await prisma.systemConfig.findFirst({
    where: { key, organizationId: null },
  });
  if (globalRow) {
    const value = globalRow.value;
    // Cache-fill the org's namespaced key: the global row backs this org's
    // resolution until a tenant row appears or the global write fan-out
    // invalidates it (D-01). WR-01 (183-REVIEW Fix Round 1): the payload is
    // the tier-carrying envelope { v, s } so a cache hit reports
    // source: "global" (previously the hardcoded "tenant" mislabeled
    // global-resolved values). The org is SADDed into the membership set so
    // the global-write fan-out (SMEMBERS → per-member DEL) can invalidate
    // this cache — pre-fix these fills were invisible to fan-out and served
    // stale for up to CONFIG_CACHE_TTL_SECONDS.
    if (redis && value) {
      try {
        await redis.setex(
          cacheKey,
          CONFIG_CACHE_TTL_SECONDS,
          JSON.stringify({ v: value, s: "global" }),
        );
        // Membership-set registration: the set tracks "orgs with a
        // namespaced cached entry for this key" (previously only tenant-row
        // writes SADDed). Same failure contract as the write paths (SP-2):
        // non-blocking — a Redis error here degrades to the bounded TTL
        // staleness, it never fails the read.
        await redis.sadd(`config:tenants:${key}`, organizationId!);
      } catch (err: unknown) {
        logger.warn("[redis] config cache write failed (non-blocking)", {
          error: err instanceof Error ? err.message : String(err),
          key,
        });
      }
    }
    return { key, value, readOnly: false, source: "global" };
  }

  // ENV tier.
  if (hasEnvOverride) {
    return { key, value: envValue!, readOnly: false, source: "env" };
  }

  // CONFIG_DEFAULTS tier.
  return { key, value: CONFIG_DEFAULTS[key] ?? "", readOnly: false, source: "default" };
}

/**
 * Update multiple settings. Rejects readOnly keys.
 * Returns updated settings and list of rejected keys.
 *
 * Phase 183 (SAAS-02, D-04): each item may carry an optional organizationId —
 * present = tenant-row write for that org, absent = global-row write
 * (pre-183 behavior, byte-identical). D-11: the existing readOnlyKeys.has()
 * reject covers org-scoped items too (it rejects by KEY regardless of org —
 * no new branch, P6). Invalidation derives from the WRITTEN ROW's org (D-02):
 * the item's organizationId, never request context.
 */
export async function updateSettings(
  configs: { key: ConfigKey; value: string; organizationId?: string }[],
): Promise<{ updated: SettingsEntry[]; rejected: string[] }> {
  const current = await getAllSettings();
  const readOnlyKeys = new Set(current.filter((s) => s.readOnly).map((s) => s.key));
  const rejected: string[] = [];
  const updated: SettingsEntry[] = [];
  const licenseInfo: LicenseInfo = getLicenseInfo();

  for (const config of configs) {
    // Validate key against schema
    const parsed = configKeySchema.safeParse(config.key);
    if (!parsed.success) {
      rejected.push(config.key);
      continue;
    }

    // D-11: rejects ALWAYS_READONLY keys for GLOBAL and ORG-SCOPED items
    // alike (rejects by key — the org arm rides the same branch, no new
    // gate per D-04/P6).
    if (readOnlyKeys.has(config.key)) {
      rejected.push(config.key);
      continue;
    }

    // D-09: chat_message_retention_days has a dedicated write route
    // (PUT /api/system/chat-retention) enforcing confirmDataLoss.
    // Bulk path MUST reject so the dedicated route is the sole write path.
    if (config.key === "chat_message_retention_days") {
      rejected.push(config.key);
      continue;
    }

    // Phase 145 (EPA-05 — D-01): plugin-supplied validator loop. Replaces the
    // old hardcoded BRANDING_* + feature-flag license check. The
    // enterprise branding validator returns `{allowed:true}` for
    // `BRANDING_*` when white_label is on, `{allowed:false, reason}` when off,
    // and `null` for non-`BRANDING_*` keys (no opinion). The first validator
    // with a non-null opinion wins.
    let validatorDecision: "reject" | "allow" | "none" = "none";
    for (const validator of configKeyValidators) {
      const result = validator(config.key, licenseInfo);
      if (result === null) continue; // validator has no opinion on this key
      if (!result.allowed) {
        rejected.push(config.key);
        logger.warn("[config] Config key rejected by validator", {
          key: config.key,
          reason: result.reason ?? "rejected by plugin validator",
        });
        validatorDecision = "reject";
      } else {
        validatorDecision = "allow";
      }
      break; // first validator with an opinion wins
    }
    if (validatorDecision === "reject") continue;

    // Phase 145 (EPA-05 — D-02): community fallback — no validators
    // registered (no enterprise plugin loaded) + `BRANDING_*` key → reject.
    // Defense-in-depth for pure community builds. When the enterprise plugin
    // IS loaded, its validator runs first and this branch is unreachable
    // (configKeyValidators.length > 0).
    if (config.key.startsWith("BRANDING_") && configKeyValidators.length === 0) {
      rejected.push(config.key);
      logger.warn("[config] BRANDING_* key rejected (no enterprise plugin loaded)", {
        key: config.key,
      });
      continue;
    }

    // Phase 183 (SAAS-02, D-04): write through the race-tolerant helper —
    // item.organizationId present → tenant row; absent → global row
    // (pre-183 behavior). Single write helper invariant held for both arms.
    await upsertSystemConfigRow(prisma, {
      key: config.key,
      value: config.value,
      organizationId: config.organizationId,
    });

    // D-01/D-02/D-03: membership-set invalidation, derived from the WRITTEN
    // ROW's org (the item's organizationId — never request context).
    //  - Tenant write: SADD config:tenants:{key} {orgId} + DEL ONLY the
    //    namespaced key config:{orgId}:{key}.
    //  - Global write: DEL the legacy key config:{key} (D-09) + SMEMBERS
    //    config:tenants:{key} + DEL config:{orgId}:{key} per member —
    //    O(override-count) fan-out, NO redis.keys/scan.
    // Every op inside the null-guarded try/catch-warn shape (SP-2); Redis
    // absent → skip silently (degradation byte-identical); an error
    // mid-fan-out → warn + continue (the DB write already succeeded).
    const redis = getRedis();
    if (redis) {
      try {
        if (config.organizationId) {
          await redis.sadd(`config:tenants:${config.key}`, config.organizationId);
          await redis.del(`${CONFIG_CACHE_PREFIX}${config.organizationId}:${config.key}`);
        } else {
          await redis.del(`${CONFIG_CACHE_PREFIX}${config.key}`);
          const overriddenOrgs = await redis.smembers(`config:tenants:${config.key}`);
          for (const orgId of overriddenOrgs) {
            await redis.del(`${CONFIG_CACHE_PREFIX}${orgId}:${config.key}`);
          }
        }
      } catch (err: unknown) {
        logger.warn("[redis] config cache invalidation failed (non-blocking)", {
          error: err instanceof Error ? err.message : String(err),
          key: config.key,
        });
      }
    }

    updated.push({ key: config.key, value: config.value, readOnly: false });
  }

  return { updated, rejected };
}

/**
 * Seed missing config defaults into the database.
 * Does not overwrite existing values.
 */
export async function seedConfigDefaults(): Promise<void> {
  // Phase 183 (SAAS-02): every row write routes through upsertSystemConfigRow
  // with overwrite:false — the create-only-if-missing semantics that the old
  // `update: {}` empty-update upserts provided (a re-seed never clobbers a
  // user-set value).
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    await upsertSystemConfigRow(prisma, { key, value, overwrite: false });
  }

  // Seed branding defaults if missing
  await upsertSystemConfigRow(prisma, { key: "BRANDING_APP_NAME", value: "Simmetric Chat", overwrite: false });
  await upsertSystemConfigRow(prisma, { key: "BRANDING_PRIMARY_COLOR", value: "#973C00", overwrite: false });
  await upsertSystemConfigRow(prisma, { key: "BRANDING_APP_SUBTITLE", value: "", overwrite: false });
  await upsertSystemConfigRow(prisma, { key: "BRANDING_APP_ICON_URL", value: "", overwrite: false });

  // Phase 68 — UploadDraft retention + non-admin upload toggle defaults
  // (already covered by the CONFIG_DEFAULTS loop above, but made explicit
  // for documentation; overwrite:false preserves user-set values per idempotency).
  await upsertSystemConfigRow(prisma, { key: "upload_draft_retention_days", value: "30", overwrite: false });
  await upsertSystemConfigRow(prisma, { key: "ALLOW_NON_ADMIN_UPLOAD", value: "true", overwrite: false });

  // Phase 84 — Chat message retention default OFF (null represented as "").
  // Idempotent: overwrite:false so user-set values are NOT overwritten.
  await upsertSystemConfigRow(prisma, { key: "chat_message_retention_days", value: "", overwrite: false });

  // Phase 152 (WIZ-02, D-04) — setup_wizard_mode row seeded idempotently with
  // an empty default. The boot-time derivation (ensureSetupWizardMode below)
  // owns the active/completed value; this seeding only guarantees the row
  // exists so the derivation + getSetting never see a missing-key miss.
  // overwrite:false preserves a user-/boot-set value (the Phase 84 precedent).
  await upsertSystemConfigRow(prisma, { key: "setup_wizard_mode", value: "", overwrite: false });

  logger.info("[config] Seeded system config defaults");
}

/**
 * Phase 152 (WIZ-02, D-04) — Boot-time derivation of the setup_wizard_mode
 * SystemConfig key. Called once per boot in `index.ts` AFTER
 * `seedConfigDefaults()` (the row must exist) and BEFORE
 * `seedBootstrapAdmin()` (the skip guard reads the derived value —
 * RESEARCH Pitfall 1: reordering reopens the seed-vs-wizard race).
 *
 * Idempotent: if the value is already non-empty (a prior boot derived it, or
 * the initialize flow flipped it to "completed"), this is a no-op. Only an
 * empty/unset value is derived: "active" when no admin user exists yet
 * (fresh install — the wizard owns admin creation), "completed" when an
 * admin already exists (existing install — wizard is not re-shown).
 *
 * This function owns the setup_wizard_mode key's full lifecycle (seed, read,
 * write, derive), so it is co-located with the rest of the key's logic here
 * rather than in seedService.ts (RESEARCH Open Question 3 — D-04).
 */
export async function ensureSetupWizardMode(): Promise<void> {
  // Reuse the existing row (seedConfigDefaults creates it; migration path for
  // pre-152 installs also creates it via the helper below as a safety net).
  // Phase 183 (SAAS-02): the keyed unique read becomes an explicit null-org
  // findFirst — the read shape that survives the Plan-03 composite swap.
  const existing = await prisma.systemConfig.findFirst({
    where: { key: "setup_wizard_mode", organizationId: null },
  });

  // Idempotent — a non-empty value is left untouched (boot-derived or
  // initialize-flipped). Only "" / null / missing is derived.
  if (existing && existing.value !== "") {
    return;
  }

  // Derive from admin presence: hasAdmin ? "completed" : "active".
  // Mirrors isInitialized() in routes/system.ts (admin role + userRole count).
  const adminRole = await prisma.role.findFirst({ where: { name: "admin" } });
  const hasAdmin = adminRole
    ? (await prisma.userRole.count({ where: { roleId: adminRole.id } })) > 0
    : false;
  const derived = hasAdmin ? "completed" : "active";

  // Phase 183 (SAAS-02): write through the helper. Note this write is
  // OVERWRITE (default true), NOT create-only-if-missing: the only way this
  // line runs is when the row is missing or its value is "" — the helper's
  // overwrite arm writes the derived value onto that row. The old upsert's
  // `update: { value: derived }` had the same effect (the row existed with ""
  // or was absent; a concurrent boot racing in between is tolerated by the
  // helper's P2002 catch + re-check).
  await upsertSystemConfigRow(prisma, { key: "setup_wizard_mode", value: derived, overwrite: true });

  // Phase 152 gap G-152-1: invalidate the Redis config cache for this key so
  // getSetting()'s cache-first read does not serve a stale "completed" after
  // the DB row is re-derived to "active" on a fresh install. Mirrors the
  // invalidation pattern in updateSettings() (lines 239-245) exactly —
  // non-blocking on Redis error (the DB write already succeeded). Skipped on
  // the idempotent early-return path above (value unchanged → cache valid).
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`${CONFIG_CACHE_PREFIX}setup_wizard_mode`);
    } catch (err: unknown) {
      logger.warn("[redis] config cache invalidation failed (non-blocking)", {
        error: err instanceof Error ? err.message : String(err),
        key: "setup_wizard_mode",
      });
    }
  }

  logger.info(
    `[config] setup_wizard_mode derived="${derived}" (hasAdmin=${hasAdmin})`,
  );
}

async function getDbValue(key: ConfigKey): Promise<string> {
  // Phase 183 (SAAS-02): the keyed unique read becomes an explicit null-org
  // findFirst — the global-row read that survives the Plan-03 composite-unique
  // swap (a plain `where: { key }` unique read would not compile post-swap).
  // No organizationId parameter in this plan: ALWAYS_READONLY resolution stays
  // global-only per D-11 (Plan 04 owns read-path signature work).
  const entry = await prisma.systemConfig.findFirst({
    where: { key, organizationId: null },
  });
  return entry?.value ?? CONFIG_DEFAULTS[key] ?? "";
}