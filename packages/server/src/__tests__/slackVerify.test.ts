// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 200 (200-01 Task 1) — slackVerify.ts: the HMAC v0-basestring
 * recomputation, the timing-safe compare, and the 5-min anti-replay window
 * (D-03). Pure crypto — Postgres-free, no network, no prisma.
 */
// @ts-nocheck
import "./helpers/setupEnv";

import crypto from "crypto";
import { verifySlackSignature, isFreshTimestamp } from "../services/connectors/slackVerify";

const SECRET = "test-signing-secret-not-a-real-secret";
const TIMESTAMP = "1531420618";
const BODY = '{"type":"event_callback","event":{"type":"message"}}';

/** Compute the expected header value the way Slack does. */
function expectedSignature(secret: string, ts: string, body: string): string {
  const basestring = `v0:${ts}:${body}`;
  return "v0=" + crypto.createHmac("sha256", secret).update(basestring).digest("hex");
}

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request (known vector: secret+ts+body → expected hex)", () => {
    const sig = expectedSignature(SECRET, TIMESTAMP, BODY);
    expect(sig).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(verifySlackSignature(SECRET, TIMESTAMP, BODY, sig)).toBe(true);
  });

  it("accepts a Buffer rawBody identically to a string (the parser capture path)", () => {
    const sig = expectedSignature(SECRET, TIMESTAMP, BODY);
    expect(verifySlackSignature(SECRET, TIMESTAMP, Buffer.from(BODY, "utf8"), sig)).toBe(true);
  });

  it("rejects a tampered body (HMAC recomputes over the GIVEN bytes)", () => {
    const sig = expectedSignature(SECRET, TIMESTAMP, BODY);
    expect(verifySlackSignature(SECRET, TIMESTAMP, BODY + " tampered", sig)).toBe(false);
  });

  it("rejects a wrong signing secret", () => {
    const sig = expectedSignature("other-secret", TIMESTAMP, BODY);
    expect(verifySlackSignature(SECRET, TIMESTAMP, BODY, sig)).toBe(false);
  });

  it("rejects a missing header (undefined)", () => {
    expect(verifySlackSignature(SECRET, TIMESTAMP, BODY, undefined)).toBe(false);
  });

  it("rejects a short/malformed header (missing v0= prefix, truncated hex)", () => {
    const sig = expectedSignature(SECRET, TIMESTAMP, BODY);
    expect(verifySlackSignature(SECRET, TIMESTAMP, BODY, sig.slice(6))).toBe(false); // truncated hex
    expect(verifySlackSignature(SECRET, TIMESTAMP, BODY, sig.replace("v0=", ""))).toBe(false); // no prefix
    expect(verifySlackSignature(SECRET, TIMESTAMP, BODY, "")).toBe(false);
  });

  it("rejects a non-numeric timestamp (fail closed)", () => {
    const sig = expectedSignature(SECRET, TIMESTAMP, BODY);
    expect(verifySlackSignature(SECRET, "not-a-number", BODY, sig)).toBe(false);
    expect(verifySlackSignature(SECRET, "", BODY, sig)).toBe(false);
  });

  it("the recomputed digest matches an independently computed HMAC (algorithm pin)", () => {
    const body = "payload=xyz";
    const ts = "9999999";
    const recomputed =
      "v0=" +
      crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
    expect(verifySlackSignature(SECRET, ts, body, recomputed)).toBe(true);
    // An off-by-one basestring (missing the last colon segment) MUST fail —
    // pins that the helper signs `v0:ts:body`, not `v0:ts body` etc.
    const wrongFormat =
      "v0=" +
      crypto.createHmac("sha256", SECRET).update(`v0:${ts} ${body}`).digest("hex");
    expect(verifySlackSignature(SECRET, ts, body, wrongFormat)).toBe(false);
  });
});

describe("isFreshTimestamp (D-03(e) — 5-min anti-replay)", () => {
  const NOW = 1_700_000_000;

  it("accepts a fresh timestamp (within 300s)", () => {
    expect(isFreshTimestamp(String(NOW - 10), NOW)).toBe(true);
    expect(isFreshTimestamp(String(NOW), NOW)).toBe(true);
    expect(isFreshTimestamp(String(NOW + 299), NOW)).toBe(true);
    // Boundary: exactly 300s is still fresh (<=).
    expect(isFreshTimestamp(String(NOW - 300), NOW)).toBe(true);
  });

  it("rejects a stale timestamp (>300s old) — replay window", () => {
    expect(isFreshTimestamp(String(NOW - 301), NOW)).toBe(false);
    expect(isFreshTimestamp(String(NOW - 60000), NOW)).toBe(false);
  });

  it("accepts a slightly-future timestamp within the window (clock skew tolerance)", () => {
    expect(isFreshTimestamp(String(NOW + 300), NOW)).toBe(true);
    expect(isFreshTimestamp(String(NOW + 301), NOW)).toBe(false);
  });

  it("rejects non-numeric timestamps (fail closed)", () => {
    expect(isFreshTimestamp("abc", NOW)).toBe(false);
    expect(isFreshTimestamp("", NOW)).toBe(false);
    expect(isFreshTimestamp("12.5.3", NOW)).toBe(false);
  });
});