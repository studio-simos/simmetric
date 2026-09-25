// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 200 (200-01, ECCO-06, D-03) — the Slack request-verification helper.
//
// Slacks's docs (verifying-requests-from-slack): every Events API POST is
// signed with `X-Slack-Signature: v0=<hex>` where the hex digest is
// HMAC-SHA256(signingSecret, "v0:" + X-Slack-Request-Timestamp + ":" + RAW_BODY).
// The body MUST be the raw bytes BEFORE JSON deserialization (the
// path-filtered parser wrapper in index.ts captures req.rawBody for this).
//
// ANTI-REPLAY (D-03(e)): Slack's docs pin the 5-minute window — reject when
// |now - timestamp| > 300s.
//
// SECRET DISCIPLINE (D-14/T-200-06): every helper here returns a BOOLEAN —
// no error message ever carries config material (signing secret, token, body).

import crypto from "crypto";

/**
 * Timing-safe comparison over the two hex strings (documents.ts /
 * connectors.ts secretEquals pattern, D-14). Length-mismatch short-circuits
 * (timingSafeEqual throws on unequal lengths), then the constant-time
 * compare runs. A local clone — both existing copies stay untouched.
 */
function timingSafeStringEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a Slack signed request (D-03(d)):
 *   expected = "v0=" + hex(HMAC-SHA256(signingSecret, `v0:${timestamp}:${rawBody}`))
 * and compare it timing-safe against the `X-Slack-Signature` header value.
 *
 * Returns false (never throws) when the header is missing/short/malformed,
 * the timestamp is non-numeric, or the digests differ. No config material
 * in any failure path (D-14 — boolean only).
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: Buffer | string,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  if (!timestamp || typeof timestamp !== "string") return false;
  if (!/^-?\d+$/.test(timestamp)) return false;
  if (!signatureHeader.startsWith("v0=")) return false;

  const basestring = `v0:${timestamp}:${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = "v0=" + crypto.createHmac("sha256", signingSecret).update(basestring).digest("hex");
  return timingSafeStringEquals(expected, signatureHeader);
}

/**
 * 5-minute anti-replay window (D-03(e), Slack docs): reject when
 * |nowEpochSeconds - Number(timestamp)| > 300. A non-numeric timestamp is
 * ALWAYS rejected (fail closed).
 */
export function isFreshTimestamp(timestamp: string, nowEpochSeconds: number): boolean {
  if (!timestamp || typeof timestamp !== "string") return false;
  if (!/^-?\d+$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowEpochSeconds - ts) <= 300;
}