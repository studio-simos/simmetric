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
 * Get all system settings with readOnly flags.
 * ENV-defined values override DB values and are marked readOnly.
 *
 * D-08 (Phase 176) boundary: the `envOverridden` flag rides ONLY this
 * function (the settings-UI GET path). getSetting()'s Redis-cached payload
 * intentionally omits it (no cache-format change) and the ALWAYS_READONLY
 * push (ENV-only keys) never carries it — the flag is set exclusively for
 * non-readonly keys whose env value is present and non-empty.
 */
export async function getAllSettings(): Promise<SettingsEntry[]> {
  const dbConfigs = await prisma.systemConfig.findMany();
  const dbMap = new Map(dbConfigs.map((c) => [c.key, c.value]));

  // Merge all known config keys (schema keys + any extra DB keys)
  const allKeys = new Set<ConfigKey>([
    ...configKeySchema.options,
    ...dbConfigs.map((c) => c.key as ConfigKey),
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

    if (isAlwaysReadOnly) {
      // Infrastructure keys: ENV > Default, always readOnly
      settings.push({
        key,
        value: hasEnvOverride ? envValue! : (CONFIG_DEFAULTS[key] ?? ""),
        readOnly: true,
      });
    } else {
      // All other keys: DB > ENV > Default, always editable from UI
      const value: string = (dbValue as string | undefined) ?? (hasEnvOverride ? envValue! : (CONFIG_DEFAULTS[key] ?? ""));
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
 * Get a single setting value with ENV override.
 *
 * For non-ALWAYS_READONLY keys: checks Redis cache (config:{key}) before
 * the DB query. On cache hit, returns the cached value without a DB
 * round-trip. On miss, queries the DB and fills the cache (D-07).
 * For ALWAYS_READONLY keys: skips Redis entirely (ENV-only).
 * When Redis is unavailable, falls through to the existing DB query (D-02).
 */
export async function getSetting(key: ConfigKey): Promise<SettingsEntry> {
  // By design: dynamic ConfigKey ENV-override read — see getAllSettings() note.
  const envValue = process.env[key];
  const isAlwaysReadOnly = ALWAYS_READONLY.includes(key);
  const hasEnvOverride = envValue !== undefined && envValue !== "";

  if (isAlwaysReadOnly) {
    return { key, value: hasEnvOverride ? envValue! : await getDbValue(key), readOnly: true };
  }

  // D-07: Check Redis cache before DB for non-readonly keys
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(`${CONFIG_CACHE_PREFIX}${key}`);
      if (cached !== null) {
        return { key, value: JSON.parse(cached), readOnly: false };
      }
    } catch (err: unknown) {
      logger.warn("[redis] config cache read failed (non-blocking)", {
        error: err instanceof Error ? err.message : String(err),
        key,
      });
    }
  }

  // Cache miss or Redis unavailable → DB query
  const dbValue = await getDbValue(key);
  const value = dbValue || (hasEnvOverride ? envValue! : "");

  // D-07: Fill Redis cache on miss (non-blocking)
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

/**
 * Update multiple settings. Rejects readOnly keys.
 * Returns updated settings and list of rejected keys.
 */
export async function updateSettings(
  configs: { key: ConfigKey; value: string }[],
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

    await prisma.systemConfig.upsert({
      where: { key: config.key },
      create: { key: config.key, value: config.value },
      update: { value: config.value },
    });

    // D-07: Invalidate Redis cache for the changed key (non-blocking).
    // Ensures other instances see the new value on their next getSetting()
    // call (cache miss → DB read → fresh cache fill).
    const redis = getRedis();
    if (redis) {
      try {
        await redis.del(`${CONFIG_CACHE_PREFIX}${config.key}`);
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
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    await prisma.systemConfig.upsert({
      where: { key },
      create: { key, value },
      update: {}, // Don't overwrite user-set values
    });
  }

  // Seed branding defaults if missing
  await prisma.systemConfig.upsert({
    where: { key: "BRANDING_APP_NAME" },
    create: { key: "BRANDING_APP_NAME", value: "Simmetric Chat" },
    update: {},
  });
  await prisma.systemConfig.upsert({
    where: { key: "BRANDING_PRIMARY_COLOR" },
    create: { key: "BRANDING_PRIMARY_COLOR", value: "#973C00" },
    update: {},
  });
  await prisma.systemConfig.upsert({
    where: { key: "BRANDING_APP_SUBTITLE" },
    create: { key: "BRANDING_APP_SUBTITLE", value: "" },
    update: {},
  });
  await prisma.systemConfig.upsert({
    where: { key: "BRANDING_APP_ICON_URL" },
    create: { key: "BRANDING_APP_ICON_URL", value: "" },
    update: {},
  });

  // Phase 68 — UploadDraft retention + non-admin upload toggle defaults
  // (already covered by the CONFIG_DEFAULTS loop above, but made explicit
  // for documentation; update: {} preserves user-set values per idempotency).
  await prisma.systemConfig.upsert({
    where: { key: "upload_draft_retention_days" },
    create: { key: "upload_draft_retention_days", value: "30" },
    update: {},
  });
  await prisma.systemConfig.upsert({
    where: { key: "ALLOW_NON_ADMIN_UPLOAD" },
    create: { key: "ALLOW_NON_ADMIN_UPLOAD", value: "true" },
    update: {},
  });

  // Phase 84 — Chat message retention default OFF (null represented as "").
  // Idempotent: update: {} so user-set values are NOT overwritten.
  await prisma.systemConfig.upsert({
    where: { key: "chat_message_retention_days" },
    create: { key: "chat_message_retention_days", value: "" },
    update: {},
  });

  // Phase 152 (WIZ-02, D-04) — setup_wizard_mode row seeded idempotently with
  // an empty default. The boot-time derivation (ensureSetupWizardMode below)
  // owns the active/completed value; this upsert only guarantees the row
  // exists so the derivation + getSetting never see a missing-key miss.
  // update: {} preserves a user-/boot-set value (the Phase 84 precedent).
  await prisma.systemConfig.upsert({
    where: { key: "setup_wizard_mode" },
    create: { key: "setup_wizard_mode", value: "" },
    update: {},
  });

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
  // pre-152 installs also creates it via the upsert below as a safety net).
  const existing = await prisma.systemConfig.findUnique({
    where: { key: "setup_wizard_mode" },
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

  await prisma.systemConfig.upsert({
    where: { key: "setup_wizard_mode" },
    create: { key: "setup_wizard_mode", value: derived },
    // Only set the value when it was previously "" / unset — never overwrite
    // a value a concurrent boot or the initialize flow has just written.
    update: { value: derived },
  });

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
  const entry = await prisma.systemConfig.findUnique({ where: { key } });
  return entry?.value ?? CONFIG_DEFAULTS[key] ?? "";
}