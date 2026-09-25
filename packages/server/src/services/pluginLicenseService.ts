// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-03) — per-plugin license service.
 *
 * The license matrix is the phase's compliance core (spec D4/D6):
 *
 * - `resolvePluginLicense(packageName)` — the closed-enum verdict the loader
 *   gate (managedLoader, 202-02) consults for platform-mode rows.
 *   MODE-AGNOSTIC BY CONTRACT: the service contains NO license-mode
 *   conditional — gating is the CALLER's job (loader for loads, routes for
 *   admin writes). The loader never calls this for none/self rows (P3).
 * - `savePluginLicense(id, jwt)` / `verifyPluginLicense(id, jwt)` — the
 *   202-03 route helpers. Save persists AES-256-GCM ciphertext via the
 *   REUSED encryptionService; verify is probe-only (never persists).
 * - `resolveInstanceLicenseFromDB()` — the enterprise DB→env fallback
 *   (Pitfall 1): an ADDITIVE async boot step between `initLicense()` and
 *   `loadEnterprisePlugin(app)`, never inside sync `initLicense()`. Applies
 *   its override ONLY from a verified enterprise-tier row through the full
 *   RS256 pipeline (T-202-26); a DB hiccup falls back to the env-derived
 *   cached license (fail-open to the SAFER state, never to elevated).
 *
 * Crypto reuse (never reimplemented):
 * - RS256 verify rides `licenseService.verifyLicenseKey` verbatim — the
 *   `algorithms: ["RS256"]` alg:none guard (licenseService.ts:130) is
 *   load-bearing and MUST stay.
 * - At-rest AES-256-GCM rides `encryptionService.encrypt/decrypt` (the same
 *   service enterprise SSO credentials use).
 *
 * Logging discipline (licenseService.ts:190-199 verbatim): the meta object
 * carries ONLY the closed-enum reason (verified|invalid|expired|missing|
 * plugin_mismatch) — never the key, the decrypted plaintext, the decoded
 * token, the payload, or any thrown error's message text (P4, T-202-25).
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { ENTERPRISE_FEATURE_DEFAULTS, type LicenseInfo } from "@simmetric-chat/shared";
import { decrypt, encrypt } from "./encryptionService";
import { verifyLicenseKey, setCachedLicense, LICENSE_PUBLIC_KEY } from "./licenseService";

/** Closed enum of per-plugin license reasons (D-03 observability doctrine). */
type PluginLicenseReason =
  | "verified"
  | "invalid"
  | "expired"
  | "missing"
  | "plugin_mismatch";

export interface PluginLicenseVerdict {
  ok: boolean;
  reason: PluginLicenseReason;
}

/**
 * Map a `verifyLicenseKey` result onto the per-plugin closed enum.
 * `missing` never occurs here (the caller already proved non-empty input),
 * and `malformed` / `bad-signature` / `schema-mismatch` all fold into
 * `invalid` — one reason for every "not a usable license" arm (P-8
 * closed-enum semantics; the free-text error echo stays banned).
 */
function mapVerifyReason(reason: string): PluginLicenseReason {
  if (reason === "expired") return "expired";
  return "invalid";
}

/**
 * Resolve the per-plugin license verdict for a package.
 *
 * Caller contract (P3 — enforced at the loader, 202-02): this is consulted
 * ONLY for platform-mode rows. The service itself is mode-agnostic.
 *
 * Every skip is logged with the reason enum (T-202-28: observable, never
 * silent) — never with key or payload material.
 */
export async function resolvePluginLicense(
  packageName: string,
): Promise<PluginLicenseVerdict> {
  const row = await prisma.pluginInstall.findFirst({
    where: { packageName },
  });

  if (!row || !row.licenseKeyEncrypted) {
    logger.info("[pluginLicense] resolve", { reason: "missing" });
    return { ok: false, reason: "missing" };
  }

  // Decrypt the at-rest blob. Corrupt ciphertext fails CLOSED → "invalid"
  // (the connectors.ts parseConfig idiom — never a 500, never fail-open).
  let plain: string;
  try {
    plain = decrypt(row.licenseKeyEncrypted);
  } catch {
    logger.warn("[pluginLicense] resolve", { reason: "invalid" });
    return { ok: false, reason: "invalid" };
  }

  // REUSED RS256 pipeline — the alg:none guard rides along, never bypassed.
  const result = verifyLicenseKey(plain, LICENSE_PUBLIC_KEY);
  if (!result.ok) {
    const reason = mapVerifyReason(result.reason);
    logger.warn("[pluginLicense] resolve", { reason });
    return { ok: false, reason };
  }

  // Package binding: the JWT's plugin claim must match the installing row.
  // An instance JWT (no plugin claim) does NOT satisfy a per-plugin gate.
  if (result.payload.plugin !== packageName) {
    logger.warn("[pluginLicense] resolve", { reason: "plugin_mismatch" });
    return { ok: false, reason: "plugin_mismatch" };
  }

  logger.info("[pluginLicense] resolve", { reason: "verified" });
  return { ok: true, reason: "verified" };
}

/**
 * Verify a pasted license JWT against a plugin row WITHOUT persisting
 * (probe-only — the 202-03 verify route contract).
 */
export async function verifyPluginLicense(
  id: string,
  jwt: string,
): Promise<PluginLicenseVerdict> {
  const row = await prisma.pluginInstall.findUnique({ where: { id } });
  if (!row) {
    logger.warn("[pluginLicense] verify", { reason: "missing" });
    return { ok: false, reason: "missing" };
  }

  const result = verifyLicenseKey(jwt, LICENSE_PUBLIC_KEY);
  if (!result.ok) {
    const reason = mapVerifyReason(result.reason);
    logger.warn("[pluginLicense] verify", { reason });
    return { ok: false, reason };
  }

  if (result.payload.plugin !== row.packageName) {
    logger.warn("[pluginLicense] verify", { reason: "plugin_mismatch" });
    return { ok: false, reason: "plugin_mismatch" };
  }

  logger.info("[pluginLicense] verify", { reason: "verified" });
  return { ok: true, reason: "verified" };
}

/**
 * Verify then persist a pasted license JWT as AES-256-GCM ciphertext
 * (the 202-03 license paste route contract). Probe-first: an invalid JWT is
 * never written. Persists `licenseKeyEncrypted` (ciphertext), `licenseStatus`
 * "verified" and `licenseCheckedAt` — mode-agnostic (gating is the loader's
 * job, P3/D6).
 */
export async function savePluginLicense(
  id: string,
  jwt: string,
): Promise<PluginLicenseVerdict> {
  const verdict = await verifyPluginLicense(id, jwt);
  if (!verdict.ok) {
    return verdict;
  }

  const ciphertext = encrypt(jwt);
  await prisma.pluginInstall.update({
    where: { id },
    data: {
      licenseKeyEncrypted: ciphertext,
      licenseStatus: "verified",
      licenseCheckedAt: new Date(),
    },
  });

  return { ok: true, reason: "verified" };
}

/**
 * Enterprise DB→env instance-license fallback (spec D4 / Pitfall 1).
 *
 * Boot step, called BETWEEN `initLicense()` and `loadEnterprisePlugin(app)`
 * (wired by 202-02). When the DB carries a verified enterprise license for a
 * plugin install (self-mode enterprise deployments), it overrides the
 * env-derived cached license via the additive `setCachedLicense` setter.
 * Without one, the cached license is untouched.
 *
 * Accepts ONLY verified enterprise-tier rows through the full RS256 + schema
 * pipeline (T-202-26 — no tier elevation via a planted row). Wrapped in
 * try/catch so a DB hiccup never kills boot (fail-open to the SAFER state:
 * the env fallback, never elevated).
 */
export async function resolveInstanceLicenseFromDB(): Promise<void> {
  try {
    const row = await prisma.pluginInstall.findFirst({
      where: { licenseStatus: "verified" },
    });

    if (!row || !row.licenseKeyEncrypted) {
      return; // cached license untouched
    }

    let plain: string;
    try {
      plain = decrypt(row.licenseKeyEncrypted);
    } catch {
      logger.warn("[pluginLicense] instance fallback", { reason: "invalid" });
      return;
    }

    const result = verifyLicenseKey(plain, LICENSE_PUBLIC_KEY);
    if (!result.ok) {
      const reason = mapVerifyReason(result.reason);
      logger.warn("[pluginLicense] instance fallback", { reason });
      return;
    }

    // T-202-26: a community-tier row does NOT elevate the instance.
    if (result.payload.tier !== "enterprise") {
      logger.warn("[pluginLicense] instance fallback", { reason: "invalid" });
      return;
    }

    const payload = result.payload;
    const tierFeatures: Record<string, boolean | number> = {
      ...ENTERPRISE_FEATURE_DEFAULTS,
    };
    if (payload.features) {
      for (const [key, value] of Object.entries(payload.features)) {
        if (key in tierFeatures) {
          tierFeatures[key] = value;
        }
      }
    }

    const info: LicenseInfo = {
      tier: payload.tier,
      licensee: payload.sub,
      expiresAt: result.expiresAt,
      features: tierFeatures,
      valid: true,
    };

    setCachedLicense(info);
    logger.info("[pluginLicense] instance license overridden from DB", {
      reason: "verified",
    });
  } catch {
    // DB hiccup → env fallback survives; log the reason enum only.
    logger.warn("[pluginLicense] instance fallback skipped", {
      reason: "invalid",
    });
  }
}