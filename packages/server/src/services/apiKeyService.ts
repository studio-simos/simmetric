// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

/**
 * Phase 163 (SCALE-03): keyed-HMAC API-key verification.
 *
 * Replaces the bcrypt-loop verification (findMany({prefix}) + bcrypt.compare,
 * capped at take:10 by CSW-05/Phase 155) with a deterministic HMAC-SHA256
 * digest + a single indexed findUnique({key_hash}). The digest is a perfect
 * lookup key (deterministic, fixed-length 64 hex chars), so the Postgres
 * unique index is the constant-time compare — no application-side string
 * compare, no per-candidate CPU loop.
 *
 * The signing secret is a dedicated `API_KEY_HMAC_SECRET` (base64 32-byte),
 * decoupled from JWT_SECRET/ENCRYPTION_KEY rotation (D-01). Validated at the
 * consumption site (mirrors encryptionService.ts:24-38 ENCRYPTION_KEY pattern).
 */

/**
 * Read + validate the HMAC signing secret from the process env. Throws a named
 * error (fail-loud) when the secret is unset or decodes to the wrong length —
 * apiKeyMiddleware catches this and returns 500 (NOT 401) so misconfiguration
 * is not hidden as "invalid key" (T-163-02 spoofing vector).
 *
 * ALWAYS returns a Buffer (Buffer.from(secret, "base64")) — never the raw
 * base64 string. A string key vs a Buffer key produce DIFFERENT digests
 * (RESEARCH Pitfall 2); the single getHmacSecret helper enforces DRY.
 */
/**
 * @public — the API_KEY_HMAC_SECRET consumption-site validator, pinned
 * behaviorally by rawEnvReads.test.ts §1 (fail-loud named throws + Buffer
 * return). Phase 180 reviewed-keep.
 */
export function getHmacSecret(): Buffer {
  const raw = process.env.API_KEY_HMAC_SECRET;
  if (!raw) {
    throw new Error(
      "API_KEY_HMAC_SECRET is required when API keys are used. " +
        "Generate a base64 32-byte key with: openssl rand -base64 32, " +
        "set it in the root .env, and restart.",
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `API_KEY_HMAC_SECRET must decode to exactly 32 bytes (got ${decoded.length}). ` +
        "Generate with: openssl rand -base64 32",
    );
  }
  return decoded;
}

/**
 * Compute the HMAC-SHA256 hex digest (64 chars) of a raw API key using the
 * signing secret. Deterministic: same secret + same raw key → same digest, so
 * createApiKey and validateApiKey produce identical digests for the same key.
 */
export function hmacSha256(rawKey: string): string {
  return crypto.createHmac("sha256", getHmacSecret()).update(rawKey).digest("hex");
}

// Generate a new API key with the format: sk-xxxx-xxxx-xxxx-xxxx
//
// Bounded P2002 retry (quick 260830-og8 D-02): api_keys.prefix is @unique
// (display-only leftover, Phase 163 D-03). A fresh random 32-hex-char suffix
// makes an 8-char prefix collision astronomically rare, but a planted/legacy
// row or extreme luck would otherwise surface a 500. On a unique-constraint
// failure the whole key is REGENERATED (fresh uuidv4 → new prefix + new
// key_hash — never reuse the failed attempt's digest) and retried, bounded at
// MAX_ATTEMPTS; non-P2002 errors propagate immediately; exhaustion throws a
// clear error. The "sk-" display convention is unchanged.
const MAX_RETRY_ATTEMPTS = 3;

export async function createApiKey(name: string, createdBy: string, expiresAt?: Date) {
  let rawKey = "";
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    // Generate a raw key — fresh per attempt so prefix AND key_hash differ
    rawKey = `sk-${uuidv4().replace(/-/g, "")}`;
    const prefix = rawKey.substring(0, 8);
    const keyHash = hmacSha256(rawKey);

    try {
      const apiKey = await prisma.apiKey.create({
        data: {
          name,
          prefix,
          key_hash: keyHash,
          createdBy,
          expiresAt: expiresAt || null,
        },
      });

      // Return the raw key only once — it cannot be retrieved later
      return {
        id: apiKey.id,
        name: apiKey.name,
        plainKey: rawKey,
        createdBy: apiKey.createdBy,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      };
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") {
        throw err;
      }
      // Display-prefix collision — regenerate the entire key and retry.
      logger.warn(`API key create hit a prefix collision (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}) — regenerating key`);
    }
  }
  throw new Error(
    `API key creation failed: display-prefix collision on api_keys.prefix after ${MAX_RETRY_ATTEMPTS} attempts — delete/rename the conflicting key's prefix or retry key creation`,
  );
}

// Validate an API key via a single O(1) indexed lookup (used by apiKeyMiddleware).
// Constant-time at the DB index layer — no application-side string compare,
// no bcrypt loop, no findMany, no take cap (CSW-05 backstop removed).
export async function validateApiKey(rawKey: string): Promise<string | null> {
  const keyHash = hmacSha256(rawKey);
  const row = await prisma.apiKey.findUnique({
    where: { key_hash: keyHash },
  });

  if (!row) return null; // invalid key — constant-time at the DB index layer

  // Check expiration
  if (row.expiresAt && row.expiresAt < new Date()) {
    return null; // expired
  }

  // Update lastUsed timestamp
  await prisma.apiKey.update({
    where: { id: row.id },
    data: { lastUsed: new Date() },
  });

  return row.createdBy;
}

// List API keys for a user (never expose digests)
export async function listApiKeys(createdBy: string) {
  return prisma.apiKey.findMany({
    where: { createdBy },
    select: {
      id: true,
      name: true,
      prefix: true,
      createdBy: true,
      lastUsed: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

// Revoke (delete) an API key
export async function revokeApiKey(id: string, createdBy: string) {
  const key = await prisma.apiKey.findFirst({ where: { id, createdBy } });
  if (!key) {
    throw new Error("API key not found");
  }

  await prisma.apiKey.delete({ where: { id } });
  logger.info("API key revoked", { keyId: id, createdBy });
}