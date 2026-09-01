// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";
import {
  encrypt,
  decrypt,
  maskApiKey,
  resetEncryptionKeyCache,
  getDecryptKeyChain,
} from "../services/encryptionService";

describe("EncryptionService", () => {
  it("encrypts and decrypts a string correctly", () => {
    const original = "sk-test-api-key-12345";
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted.includes(":")).toBe(true);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertexts for the same input (random IV)", () => {
    const original = "same-value";
    const enc1 = encrypt(original);
    const enc2 = encrypt(original);
    expect(enc1).not.toBe(enc2);
    expect(decrypt(enc1)).toBe(original);
    expect(decrypt(enc2)).toBe(original);
  });

  it("masks API keys correctly", () => {
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("sk-1234567890abcdef")).toBe("sk-1***********cdef");
  });

  it("throws on invalid encrypted format", () => {
    expect(() => decrypt("invalid")).toThrow("Invalid encrypted format");
    expect(() => decrypt("no:colon")).toThrow();
  });
});

describe("EncryptionService — ENCRYPTION_KEY override", () => {
  // A deterministic 32-byte key, base64-encoded (openssl rand -base64 32 style).
  const VALID_KEY = Buffer.alloc(32, 0xab).toString("base64");

  afterEach(() => {
    // Restore the legacy fallback path for any test that runs after this block.
    delete process.env.ENCRYPTION_KEY;
    resetEncryptionKeyCache();
  });

  it("uses ENCRYPTION_KEY when set and round-trips ciphertext", () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    resetEncryptionKeyCache();
    const original = "provider-secret-with-explicit-key";
    const encrypted = encrypt(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it("is NOT decryptable with the legacy JWT_SECRET key (keys are decoupled)", () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    resetEncryptionKeyCache();
    const encrypted = encrypt("decouple-check");
    // Switch back to the legacy fallback: the ciphertext must NOT decrypt,
    // proving the override key is distinct from the JWT_SECRET-derived one.
    delete process.env.ENCRYPTION_KEY;
    resetEncryptionKeyCache();
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("falls back to JWT_SECRET derivation when ENCRYPTION_KEY is unset (backward-compat)", () => {
    delete process.env.ENCRYPTION_KEY;
    resetEncryptionKeyCache();
    const original = "legacy-backward-compat-secret";
    const encrypted = encrypt(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it("rejects an ENCRYPTION_KEY that does not decode to 32 bytes", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 0x01).toString("base64"); // 16 bytes
    resetEncryptionKeyCache();
    expect(() => encrypt("short-key-rejected")).toThrow(/ENCRYPTION_KEY must decode to exactly 32 bytes/);
  });
});

describe("EncryptionService — Phase 162 production gate (ENC-01/02)", () => {
  // A deterministic 32-byte key, base64-encoded (openssl rand -base64 32 style).
  const VALID_KEY = Buffer.alloc(32, 0xab).toString("base64");
  // Capture the original NODE_ENV so afterEach can restore it. The setupEnv
  // helper loads .env.test with NODE_ENV=test, so the original is "test".
  // Restoring is CRITICAL (Pitfall 6): a stale NODE_ENV=production would make
  // later tests hit the prod gate instead of the scrypt fallback.
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    // Restore BOTH env vars + clear caches to avoid polluting later tests.
    process.env.NODE_ENV = originalNodeEnv ?? "test";
    delete process.env.ENCRYPTION_KEY;
    resetEncryptionKeyCache();
  });

  it("throws in production when ENCRYPTION_KEY is unset (ENC-01)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ENCRYPTION_KEY;
    resetEncryptionKeyCache();
    expect(() => encrypt("prod-no-key")).toThrow(/ENCRYPTION_KEY is required in production/);
  });

  it("falls back to scrypt in dev/test when ENCRYPTION_KEY is unset (ENC-02)", () => {
    process.env.NODE_ENV = "test";
    delete process.env.ENCRYPTION_KEY;
    resetEncryptionKeyCache();
    const original = "dev-scrypt-fallback-secret";
    const encrypted = encrypt(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it("uses the explicit key in production when ENCRYPTION_KEY is set (ENC-01 positive)", () => {
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = VALID_KEY;
    resetEncryptionKeyCache();
    const original = "prod-explicit-key-secret";
    const encrypted = encrypt(original);
    expect(decrypt(encrypted)).toBe(original);
  });
});

describe("EncryptionService — multi-key decrypt chain (OPS-01)", () => {
  // Deterministic 32-byte keys, base64-encoded (openssl rand -base64 32 style).
  const KEY_A = Buffer.alloc(32, 0xaa).toString("base64");
  const KEY_B = Buffer.alloc(32, 0xbb).toString("base64");
  const KEY_C = Buffer.alloc(32, 0xcc).toString("base64");

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    resetEncryptionKeyCache();
  });

  it("decrypts key-A blob after rotation to key-B", () => {
    // Encrypt with key A (the "old" key).
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    resetEncryptionKeyCache();
    const blob = encrypt("rotation-roundtrip-secret");

    // Rotate: new key B becomes current, A is listed as previous.
    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS = KEY_A;
    resetEncryptionKeyCache();

    expect(decrypt(blob)).toBe("rotation-roundtrip-secret");
  });

  it("fails closed with neither key in chain", () => {
    // Encrypt with key A.
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    resetEncryptionKeyCache();
    const blob = encrypt("fails-closed-secret");

    // Switch to key C with NO previous keys → A is not in the chain.
    process.env.ENCRYPTION_KEY = KEY_C;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    resetEncryptionKeyCache();

    expect(() => decrypt(blob)).toThrow(/Unable to decrypt \(no key in chain matched\)/);
  });

  it("decrypts legacy scrypt blob (pre-override JWT_SECRET-derived ciphertext)", () => {
    // No ENCRYPTION_KEY → legacy scrypt(JWT_SECRET) path (setupEnv sets JWT_SECRET).
    delete process.env.ENCRYPTION_KEY;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    resetEncryptionKeyCache();
    const blob = encrypt("scrypt-legacy-secret");

    // Operator later sets an explicit ENCRYPTION_KEY; the scrypt key must remain
    // in the chain tail so pre-override blobs still decrypt (SEED-001 rollback).
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    resetEncryptionKeyCache();

    expect(decrypt(blob)).toBe("scrypt-legacy-secret");
  });

  it("resetEncryptionKeyCache clears chain cache", () => {
    // Build a chain with only the current key (plus the scrypt tail, since
    // ENCRYPTION_KEY is explicitly set — scrypt is appended per D-01).
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    resetEncryptionKeyCache();
    const chainBefore = getDecryptKeyChain();
    const beforeHasKeyB = chainBefore.some((k) => k.equals(Buffer.from(KEY_B, "base64")));
    expect(beforeHasKeyB).toBe(false);

    // Add a previous key to the env. Without reset, the cached chain would still
    // be the stale chain. After reset, the new chain must include the previous key.
    process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS = KEY_B;
    resetEncryptionKeyCache();
    const chainAfter = getDecryptKeyChain();
    const afterHasKeyB = chainAfter.some((k) => k.equals(Buffer.from(KEY_B, "base64")));
    expect(afterHasKeyB).toBe(true);
    expect(chainAfter.length).toBeGreaterThan(chainBefore.length);
  });

  it("LEGACY_PREVIOUS_ENCRYPTION_KEYS invalid entry throws with openssl hint", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    // A 16-byte entry is invalid (must be 32 bytes).
    process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS = Buffer.alloc(16, 0x01).toString("base64");
    resetEncryptionKeyCache();
    expect(() => getDecryptKeyChain()).toThrow(/openssl rand -base64 32/);
  });
});