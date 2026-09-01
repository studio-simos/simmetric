// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

// Security note (2026-07-21): the AES-256-GCM key was previously derived from
// `JWT_SECRET` with a hard-coded salt. That couples credential rotation (JWT)
// to data-at-rest encryption (provider API keys + backup destination configs),
// so rotating JWT_SECRET would silently invalidate every encrypted blob.
//
// Mitigation (additive, backward-compatible): an operator may set
// `ENCRYPTION_KEY` (base64-encoded, exactly 32 raw bytes) to decouple the
// encryption key from JWT_SECRET. When unset, the legacy `scryptSync(JWT_SECRET)`
// derivation is used so existing ciphertexts remain decryptable — no migration
// required to adopt the override. Rotation of an already-set ENCRYPTION_KEY is
// a future operation (decrypt with old key → re-encrypt with new key) and is
// documented in .planning/codebase/CONCERNS.md.
const ENCRYPTION_KEY_SALT = "simmetric-chat-encryption-salt";
const LEGACY_KEYS_ENV = "LEGACY_PREVIOUS_ENCRYPTION_KEYS";
let cachedKey: Buffer | null = null;
let cachedChain: Buffer[] | null = null;

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const explicitKey = process.env.ENCRYPTION_KEY;
  if (explicitKey) {
    // Treat ENCRYPTION_KEY as a base64-encoded 32-byte key. Validate strictly
    // at the consumption site (not in env.ts) so a bad key fails loudly here.
    const decoded = Buffer.from(explicitKey, "base64");
    if (decoded.length !== KEY_LENGTH) {
      throw new Error(
        `ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${decoded.length}). Generate with: openssl rand -base64 32`,
      );
    }
    cachedKey = decoded;
    return cachedKey;
  }

  // Legacy fallback: derive from JWT_SECRET so pre-existing ciphertexts stay
  // decryptable when ENCRYPTION_KEY is not configured.
  // Phase 162 (ENC-01/ENC-02): production requires an explicit ENCRYPTION_KEY.
  // The scrypt(JWT_SECRET) fallback is dev/test convenience ONLY — it couples
  // data-at-rest encryption to JWT_SECRET rotation (rotating JWT_SECRET bricks
  // every encrypted blob). The boot gate in index.ts fails first; this throw
  // is defense-in-depth for CLI callers (rotate-encryption-key/verify-encryption-key
  // run via tsx, bypassing index.ts). Dev/test (NODE_ENV !== "production") keeps
  // the scrypt fallback so local dev needs no ENCRYPTION_KEY.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ENCRYPTION_KEY is required in production (NODE_ENV=production). " +
        "Generate a base64 32-byte key with: openssl rand -base64 32, " +
        "set it in the root .env, and restart. " +
        "See docs/ENCRYPTION_KEY_ROTATION.md (Phase 162 hard-default cutover).",
    );
  }
  cachedKey = getScryptLegacyKey();
  return cachedKey;
}

/**
 * Derive the legacy AES-256 key from `JWT_SECRET` via scrypt. Used both as the
 * current key when `ENCRYPTION_KEY` is unset AND as the chain tail when an
 * explicit `ENCRYPTION_KEY` is set (so pre-override ciphertexts still decrypt
 * after the operator introduces an explicit key — SEED-001 rollback safety).
 */
function getScryptLegacyKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return crypto.scryptSync(secret, ENCRYPTION_KEY_SALT, KEY_LENGTH);
}

/**
 * Parse `LEGACY_PREVIOUS_ENCRYPTION_KEYS` (comma-separated base64 32-byte
 * keys) into an ordered list of Buffer keys. Empty/unset → no previous keys.
 * Each entry MUST decode to exactly KEY_LENGTH bytes; a malformed entry throws
 * with the `openssl rand -base64 32` hint, mirroring the ENCRYPTION_KEY
 * validation-site pattern (D-02 — NOT validated in config/env.ts).
 */
function parseLegacyPreviousKeys(): Buffer[] {
  const raw = process.env[LEGACY_KEYS_ENV];
  if (!raw || raw.trim() === "") return [];
  const out: Buffer[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length !== KEY_LENGTH) {
      throw new Error(
        `LEGACY_PREVIOUS_ENCRYPTION_KEYS entry must decode to exactly ${KEY_LENGTH} bytes (got ${decoded.length}). Generate with: openssl rand -base64 32`,
      );
    }
    out.push(decoded);
  }
  return out;
}

/**
 * Build (and cache) the ordered decrypt key chain per D-01/D-03:
 * `[current, ...previous, scryptDerived?]`.
 *
 * - `current` = `getEncryptionKey()` (explicit `ENCRYPTION_KEY` if set, else
 *   `scrypt(JWT_SECRET)`).
 * - `previous` = parsed `LEGACY_PREVIOUS_ENCRYPTION_KEYS` (in declared order).
 * - The scrypt legacy key is appended to the tail ONLY when an explicit
 *   `ENCRYPTION_KEY` is set, so pre-override scrypt blobs still decrypt. When
 *   `ENCRYPTION_KEY` is unset, `current` is already the scrypt key and would
 *   be duplicated — so the tail is skipped in that case.
 *
 * `encrypt()` uses `chain[0]` (the current key) — see D-03.
 */
export function getDecryptKeyChain(): Buffer[] {
  if (cachedChain) return cachedChain;
  const current = getEncryptionKey();
  const previous = parseLegacyPreviousKeys();
  const chain: Buffer[] = [current, ...previous];
  // Append the scrypt legacy key as the tail when the current key came from an
  // explicit ENCRYPTION_KEY override (and it is not already listed as a
  // previous key) so pre-override scrypt ciphertexts still decrypt.
  if (process.env.ENCRYPTION_KEY && !previous.some((k) => k.equals(current))) {
    chain.push(getScryptLegacyKey());
  }
  cachedChain = chain;
  return chain;
}

/**
 * Reset the cached encryption key AND the cached decrypt chain. Needed when
 * `ENCRYPTION_KEY`, `JWT_SECRET`, or `LEGACY_PREVIOUS_ENCRYPTION_KEYS` changes
 * at runtime — e.g. after a key rotation or in tests that exercise multiple
 * key configurations. The next encrypt/decrypt call re-derives from the
 * current environment. (D-03 — clears both caches.)
 */
export function resetEncryptionKeyCache(): void {
  cachedKey = null;
  cachedChain = null;
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${ciphertext}`;
}

export function decrypt(encoded: string): string {
  const [ivHex, authTagHex, ciphertext] = encoded.split(":");
  if (!ivHex || !authTagHex || !ciphertext) throw new Error("Invalid encrypted format");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const chain = getDecryptKeyChain();
  let lastErr: unknown = null;
  for (const key of chain) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext, "hex", "utf8");
      decrypted += decipher.final("utf8"); // throws on wrong key (GCM auth failure)
      return decrypted;
    } catch (err) {
      lastErr = err;
      // try next key in chain
    }
  }
  throw new Error(
    `Unable to decrypt (no key in chain matched). Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export function maskApiKey(apiKey: string | null): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}${"*".repeat(apiKey.length - 8)}${apiKey.slice(-4)}`;
}