// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview OAuth state + PKCE service (Phase 195, MCPO-01 D-07/D-08).
 *
 * - signOAuthState: HMAC-signed (HS256) single-use state via jsonwebtoken
 *   keyed by JWT_SECRET, 10-min exp, payload { connectionId, nonce } (+
 *   iat/exp auto-claims). The PKCE code_verifier NEVER enters the JWT payload
 *   (D-08 — an attacker-readable state would defeat PKCE): it lives in a
 *   module-level process-memory Map keyed by connectionId with a TTL ≤ the
 *   state exp. Single-server v1 assumption is acceptable; Redis is optional
 *   and never a dependency here (D-08).
 * - consumeVerifier: single-use Map consumption — get + delete-if-expired.
 * - verifyOAuthState: jwt.verify in try/catch, fail-closed (null on ANY
 *   failure: bad signature OR expiry OR garbage input, D-10).
 */

import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getEnv } from "../config/env";

/** Process-memory PKCE verifier store (D-08) — never persisted. WR-01: keyed
 * by the state's `nonce` (not connectionId) so two concurrent oauth/start
 * calls for the same connection cannot poison the first pairing — each tab's
 * state carries its own nonce, binding it to its own verifier. */
const pkceVerifiers = new Map<string, { verifier: string; exp: number }>();

/** TTL for Map entries — matches the 10-min state JWT expiry (D-08). */
const VERIFIER_TTL_MS = 10 * 60_000;

/** Purpose-separation `aud` claim (WR-03): the state JWT shares the HS256
 * secret with user session tokens; the audience pin prevents claim-namespace
 * cross-use (licenseService algorithms-pin precedent). Default = the MCP
 * audience — every MCP caller stays byte-identical (Phase 200 Option A kept
 * the seam additive: the connector flow passes its own audience explicitly). */
const STATE_AUDIENCE = "mcp-oauth-state";

/** Phase 200 (ECCO-06, Option A): the CONNECTOR-flow state audience. A
 * connector-minted state is rejected by the MCP callback (which verifies with
 * the mcp-oauth-state default) and an MCP state is rejected by the connector
 * callback (WR-03 cross-audience pin in connectorOAuthCallback.test.ts). */
export const CONNECTOR_OAUTH_STATE_AUDIENCE = "connector-oauth-state";

/**
 * Mint a signed OAuth state + PKCE verifier pair for a connection.
 * state = jwt.sign({ connectionId, nonce, aud }, JWT_SECRET,
 * { expiresIn: "10m" }); verifier = crypto.randomBytes(32).toString("base64url")
 * stored ONLY in the process-memory Map keyed by nonce (D-08 + WR-01).
 * `audience` is optional (Phase 200 Option A) and defaults to the MCP
 * audience — existing MCP callers are byte-identical.
 */
export function signOAuthState(
  connectionId: string,
  audience: string = STATE_AUDIENCE,
): { state: string; verifier: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomUUID();
  const state = jwt.sign({ connectionId, nonce, aud: audience }, getEnv().JWT_SECRET, {
    expiresIn: "10m",
  });
  pkceVerifiers.set(nonce, { verifier, exp: Date.now() + VERIFIER_TTL_MS });
  return { state, verifier };
}

/**
 * Single-use PKCE verifier consumption (WR-01): keyed by the state's nonce —
 * the callback passes the nonce it verified out of the signed state, so the
 * verifier pairing is bound to THAT state (a second start issues a new nonce
 * and never invalidates the first pairing). Deletes on read (single-use);
 * expired entries are deleted on read (TTL cleanup rides consumption).
 */
export function consumeVerifier(nonce: string): string | null {
  const entry = pkceVerifiers.get(nonce);
  if (!entry) return null;
  pkceVerifiers.delete(nonce); // single-use: delete on first read
  if (entry.exp <= Date.now()) return null; // expired — fail-closed
  return entry.verifier;
}

/** Test/utility accessor: number of pending verifier entries. */
export function pendingVerifierCount(): number {
  return pkceVerifiers.size;
}

/**
 * Verify a signed OAuth state (fail-closed, D-10): null on ANY failure —
 * bad signature, expired, malformed, or absent. Never throws for invalid
 * state values (a garbage state is an expected input on a public callback).
 * WR-03: algorithms + audience pinned (alg-confusion guard — the license
 * service's RS256-pin precedent, applied to the shared-secret HS256 surface).
 */
export function verifyOAuthState(
  state: string,
  audience: string = STATE_AUDIENCE,
): { connectionId: string; nonce: string } | null {
  try {
    if (typeof state !== "string" || state.length === 0) return null;
    const payload = jwt.verify(state, getEnv().JWT_SECRET, {
      algorithms: ["HS256"],
      audience,
    }) as {
      connectionId?: unknown;
      nonce?: unknown;
    };
    if (typeof payload.connectionId !== "string" || payload.connectionId.length === 0) {
      return null;
    }
    if (typeof payload.nonce !== "string" || payload.nonce.length === 0) {
      return null;
    }
    return { connectionId: payload.connectionId, nonce: payload.nonce };
  } catch {
    // Fail-closed (D-10): bad signature OR exp OR malformed → null.
    return null;
  }
}