// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Test-only RSA keypair + helpers for license tests (RS256).
 *
 * The keypair is generated at module load with generateKeyPairSync and
 * memoized — NO private key is ever committed to the repo. This file is safe
 * to ship in the public source distribution: it contains no secrets, only
 * code that mints ephemeral test keys when imported by a test.
 *
 * Tests that exercise `verifyLicenseKey` directly pass `getTestPublicKey()` as
 * the `publicKey` argument. Tests that exercise `initLicense` mock the
 * `license-public-key` module (via jest.mock in license.test.ts) to return
 * `getTestPublicKey()` so the production code path verifies against the test
 * keypair. Use `signTestLicense()` to mint a token signed with the test
 * private key.
 *
 * This keypair is COMPLETELY UNRELATED to the production keypair embedded in
 * license-public-key.ts.
 */

import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";

interface TestKeypair {
  privateKey: string;
  publicKey: string;
}

let cachedKeypair: TestKeypair | null = null;
let cachedOtherPublic: string | null = null;

/** Lazily generate the test keypair once per test process. */
function getTestKeypair(): TestKeypair {
  if (cachedKeypair) return cachedKeypair;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  cachedKeypair = { privateKey, publicKey };
  return cachedKeypair;
}

/** Lazily generate a second unrelated keypair (for "wrong key" tests). */
function getOtherKeypair(): { privateKey: string; publicKey: string } {
  if (cachedOtherPublic) {
    // We cached only the public previously; regenerate both lazily — cheap.
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

/** The test private key (PEM, RS256-compatible). Generated lazily. */
export function getTestPrivateKey(): string {
  return getTestKeypair().privateKey;
}

/** The test public key matching getTestPrivateKey(). Generated lazily. */
export function getTestPublicKey(): string {
  return getTestKeypair().publicKey;
}

/** A second, unrelated public key — used to test "wrong key" → bad-signature. */
export function getOtherPublicKey(): string {
  if (!cachedOtherPublic) cachedOtherPublic = getOtherKeypair().publicKey;
  return cachedOtherPublic;
}

/** A second, unrelated private key — used to sign tokens that must be rejected. */
export function getOtherPrivateKey(): string {
  return getOtherKeypair().privateKey;
}

/**
 * Sign a license payload with the test private key (RS256). Convenience helper
 * so test code stays terse: `signTestLicense({ tier: "enterprise", sub: "X" })`.
 */
export function signTestLicense(
  payload: Record<string, unknown>,
  options: { expiresIn?: number } = {},
): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (options.expiresIn ?? 365 * 24 * 3600);
  return jwt.sign(
    { iat, exp, iss: "simmetric-chat", ...payload },
    getTestPrivateKey(),
    { algorithm: "RS256" },
  );
}