// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import jwt from "jsonwebtoken";
import { z } from "zod";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import {
  COMMUNITY_FEATURE_DEFAULTS,
  ENTERPRISE_FEATURE_DEFAULTS,
  type FeatureFlag,
  licensePayloadSchema,
  type LicensePayload,
} from "@simmetric-chat/shared";
import type { LicenseInfo } from "@simmetric-chat/shared";
import { LICENSE_PUBLIC_KEY_PEM } from "./license-public-key";

let cachedLicense: LicenseInfo | null = null;

/**
 * Phase 147 (EPA-07 — D-03): module-level override map. The enterprise
 * plugin injects raised numeric limits (e.g. max_workspaces → Infinity) via
 * `ctx.overrideFeatureLimit` → `setLimitOverride` at `register(ctx)` boot.
 * `getFeatureLimit()` consults this map FIRST (D-01), falling back to
 * `info.features[flag]` when the flag is absent. `clearLimitOverrides()`
 * runs at the START of `initLicense()` (D-02) and in `getLicenseInfo()`'s
 * runtime-expiry branch (SC-1) so a Community JWT loaded after an
 * Enterprise one cannot inherit `Infinity` overrides.
 */
const limitOverrides = new Map<string, number>();

/**
 * D-01: Raise a numeric feature limit. Called by `enterpriseLoader`'s
 * `ctx.overrideFeatureLimit` at boot (via the alias import — Phase 145
 * Pitfall 1). Mutates the module-level `limitOverrides` map; subsequent
 * `getFeatureLimit(flag)` reads return the overridden value.
 */
export function setLimitOverride(flag: string, value: number): void {
  limitOverrides.set(flag, value);
}

/**
 * D-02: Revoke all raised numeric limits. Called at the START of
 * `initLicense()` (so a Community JWT loaded after an Enterprise one cannot
 * inherit `Infinity` overrides) and in `getLicenseInfo()`'s runtime-expiry
 * branch (SC-1 reactive revocation covers mid-runtime expiry, not just
 * boot-time downgrade).
 */
export function clearLimitOverrides(): void {
  limitOverrides.clear();
}

/**
 * Closed enum of license verification failure reasons. Exported so Phase 121
 * (LIC-02 diagnose endpoint, LIC-03 license:check CLI) can surface a stable
 * reason vocabulary without re-deriving it. Defined locally in this file per
 * the researcher discretion recommendation (A3) — Phase 121 can lift it to
 * `@simmetric-chat/shared` if cross-package consumers need it.
 */
type LicenseVerifyReason =
  | "missing"
  | "expired"
  | "bad-signature"
  | "malformed"
  | "schema-mismatch";

/**
 * Discriminated verdict returned by `verifyLicenseKey`. The caller
 * (`initLicense`) owns the Community fallback decision — `verifyLicenseKey`
 * itself never falls back.
 *
 * Algorithm: RS256 (asymmetric). The public key is embedded in the source
 * (license-public-key.ts) so customer instances verify licenses without
 * holding any secret. The private key lives only in the separate
 * `Simmetric-license-tool` repo. A customer in possession of the full source code
 * cannot mint their own enterprise license.
 *
 * Security: `algorithms: ["RS256"]` is passed to `jwt.verify` unconditionally —
 * this is the alg:none forgery guard (Pitfall 4) and MUST stay.
 */
export type LicenseVerifyResult =
  | { ok: true; payload: LicensePayload; expiresAt: string }
  | { ok: false; reason: LicenseVerifyReason };

/**
 * The RSA public key used to verify license JWTs. The key is embedded in
 * `license-public-key.ts` and ships with the source — customer instances
 * verify licenses out of the box with NO env config. There is intentionally
 * NO env override: an env override would let anyone with write access to the
 * process env replace the verifier with a key they control and self-sign an
 * enterprise license. Key rotation is done by replacing the embedded PEM in
 * the source and redeploying.
 */
export const LICENSE_PUBLIC_KEY = LICENSE_PUBLIC_KEY_PEM;

/**
 * Verify a license key WITHOUT falling back to Community. Returns a
 * discriminated verdict; the caller (`initLicense`) owns the fallback.
 *
 * Security: `algorithms: ["RS256"]` is passed to `jwt.verify` unconditionally —
 * this is the alg:none forgery guard (Pitfall 4) and MUST stay.
 */
export function verifyLicenseKey(
  key: string | undefined,
  publicKey: string = LICENSE_PUBLIC_KEY,
): LicenseVerifyResult {
  // 1. missing — decided BEFORE any jwt.verify call (no LICENSE_KEY at all).
  if (!key) {
    return { ok: false, reason: "missing" };
  }

  // Structural pre-check: `jwt.decode` returns null for a syntactically
  // invalid JWT (no 3-part dot-separated structure, or non-base64url parts).
  // This routes "not-a-jwt" and "a.b.c" to `malformed` (structural) rather
  // than `bad-signature` (crypto), matching the closed-enum semantics. The
  // signature is NOT verified here — that stays on `jwt.verify` below.
  const structurallyDecoded = jwt.decode(key);
  if (
    structurallyDecoded === null ||
    typeof structurallyDecoded !== "object" ||
    Array.isArray(structurallyDecoded)
  ) {
    return { ok: false, reason: "malformed" };
  }

  try {
    // 2. jwt.verify with RS256 — `algorithms` MUST stay (alg:none guard).
    const decoded = jwt.verify(key, publicKey, { algorithms: ["RS256"] });

    // 3. non-object / null / array decoded → malformed (defensive: the
    //    structural pre-check above already filters this, but a verified
    //    payload that decodes to a primitive would still slip through here).
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return { ok: false, reason: "malformed" };
    }

    // 4. schema validation — ZodError → schema-mismatch.
    const payload = licensePayloadSchema.parse(decoded);

    // 5. expiry — deterministic explicit gate alongside jwt.verify's
    //    TokenExpiredError (covers any clock-skew edge where jwt.verify has
    //    not yet fired). Maps to "expired".
    if (payload.exp * 1000 < Date.now()) {
      return { ok: false, reason: "expired" };
    }

    return {
      ok: true,
      payload,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  } catch (err: unknown) {
    // 6. error → closed-enum mapping (D-01). The free-text error-message echo
    //    of the pre-refactor catch is gone; the reason enum replaces it.
    if (err instanceof jwt.TokenExpiredError) {
      return { ok: false, reason: "expired" };
    }
    if (err instanceof jwt.NotBeforeError) {
      // PLANNER ASSUMPTION (A1 / Pitfall 3): `licensePayloadSchema` has no
      // `nbf` field, so a NotBeforeError is effectively unreachable for any
      // token that passes the schema check. Bucket it as `bad-signature`
      // (a verification failure, not an expiry) — documented assumption.
      return { ok: false, reason: "bad-signature" };
    }
    if (err instanceof jwt.JsonWebTokenError) {
      return { ok: false, reason: "bad-signature" };
    }
    if (err instanceof z.ZodError) {
      return { ok: false, reason: "schema-mismatch" };
    }
    // Unknown error — safest bucket is "malformed" (non-object / garbage).
    return { ok: false, reason: "malformed" };
  }
}

/** Load and validate the license. Called once at startup. Single fallback point. */
export function initLicense(): LicenseInfo {
  // D-02 (Pitfall 3): clear overrides FIRST — before `tierFeatures` is
  // rebuilt from COMMUNITY_FEATURE_DEFAULTS. A Community JWT loaded after
  // an Enterprise one cannot inherit the prior Infinity overrides. The
  // enterprise plugin re-injects overrides at register(ctx) boot (which
  // runs AFTER initLicense per bootOrder.test.ts).
  clearLimitOverrides();
  const env = getEnv();
  const result = verifyLicenseKey(env.LICENSE_KEY);

  if (!result.ok) {
    // D-02: canonical winston message-first form. "missing" is info-level
    // (Community is the normal state); expired/bad-signature/malformed/
    // schema-mismatch are warn-level. Log ONLY the reason in the meta object
    // — never the key, secret, decoded token, payload, or the thrown error
    // message text.
    if (result.reason === "missing") {
      logger.info("[license] fallback to Community", { reason: result.reason });
    } else {
      logger.warn("[license] fallback to Community", { reason: result.reason });
    }
    cachedLicense = buildCommunityLicense();
    return cachedLicense;
  }

  const payload = result.payload;
  const tierFeatures =
    payload.tier === "enterprise"
      ? { ...ENTERPRISE_FEATURE_DEFAULTS }
      : { ...COMMUNITY_FEATURE_DEFAULTS };

  // Override defaults with explicit feature flags from JWT
  if (payload.features) {
    for (const [key, value] of Object.entries(payload.features)) {
      if (key in tierFeatures) {
        (tierFeatures as Record<string, boolean | number>)[key] = value;
      }
    }
  }

  cachedLicense = {
    tier: payload.tier,
    licensee: payload.sub,
    expiresAt: result.expiresAt,
    features: tierFeatures,
    valid: true,
  };

  // D-02: message-first winston form. Meta object fields are EXCLUSIVELY
  // tier / licensee / expiresAt on success — never the key, secret, decoded
  // token, full payload object, or the thrown error's message text.
  logger.info("[license] loaded", {
    tier: payload.tier,
    licensee: payload.sub,
    expiresAt: result.expiresAt,
  });
  return cachedLicense;
}

function buildCommunityLicense(): LicenseInfo {
  return {
    tier: "community",
    licensee: "Community Edition",
    expiresAt: null,
    features: { ...COMMUNITY_FEATURE_DEFAULTS },
    valid: true,
  };
}

/** Get the current license info, with runtime expiry check for graceful degradation */
export function getLicenseInfo(): LicenseInfo {
  if (!cachedLicense) {
    return initLicense();
  }

  // Graceful degradation: if the license has expired during runtime, degrade to Community
  if (cachedLicense.expiresAt && new Date(cachedLicense.expiresAt).getTime() < Date.now()) {
    logger.warn("[license] License expired during runtime — degrading to Community Edition");
    // SC-1 reactive revocation: clear overrides BEFORE rebuilding as
    // Community so a mid-runtime expiry cannot leave stale Infinity
    // overrides in the map while tierFeatures shows Community defaults.
    clearLimitOverrides();
    cachedLicense = buildCommunityLicense();
  }

  return cachedLicense;
}

/** Check if a specific feature flag is enabled */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const info = getLicenseInfo();
  const value = info.features[flag];
  return typeof value === "boolean" ? value : false;
}

/**
 * Get a numeric feature limit (e.g. max_workspaces).
 *
 * D-01: the module-level `limitOverrides` map is consulted FIRST — when the
 * enterprise plugin has called `ctx.overrideFeatureLimit(flag, value)` at
 * `register(ctx)` boot, the override wins. When the flag is absent (community
 * build, or a flag the plugin did not raise), fall back to
 * `info.features[flag]` (the existing behavior).
 */
export function getFeatureLimit(flag: FeatureFlag): number {
  if (limitOverrides.has(flag)) {
    return limitOverrides.get(flag) as number;
  }
  const info = getLicenseInfo();
  const value = info.features[flag];
  return typeof value === "number" ? value : 0;
}