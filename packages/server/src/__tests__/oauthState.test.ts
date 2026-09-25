// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 195 (MCPO-01 D-07/D-08/D-10): oauthStateService unit tests — sign →
 * verify roundtrip, tamper fail-closed, expiry fail-closed, single-use PKCE
 * verifier consumption, and the verifier-never-in-JWT invariant (D-08).
 * Postgres-free, no network.
 */

import "./helpers/setupEnv";
import jwt from "jsonwebtoken";
import {
  signOAuthState,
  consumeVerifier,
  verifyOAuthState,
  pendingVerifierCount,
  CONNECTOR_OAUTH_STATE_AUDIENCE,
} from "../services/oauthStateService";
import { getEnv } from "../config/env";

const CONNECTION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("oauthStateService — sign → verify roundtrip (D-07)", () => {
  it("signs a state that verifies to the original connectionId within the exp window", () => {
    const { state } = signOAuthState(CONNECTION_ID);
    expect(typeof state).toBe("string");
    expect(state.split(".")).toHaveLength(3); // HS256 JWT

    const payload = verifyOAuthState(state);
    expect(payload).not.toBeNull();
    expect(payload!.connectionId).toBe(CONNECTION_ID);
  });

  it("decodes the claim set to exactly connectionId + nonce (+ iat/exp auto-claims) — no verifier key (D-08)", () => {
    const { state } = signOAuthState(CONNECTION_ID);
    const decoded = jwt.decode(state) as Record<string, unknown>;
    const claimKeys = Object.keys(decoded).sort();
    // WR-03: purpose-separation aud claim added (mcp-oauth-state).
    expect(claimKeys).toEqual(["aud", "connectionId", "exp", "iat", "nonce"]);
    expect(typeof decoded.nonce).toBe("string");
    expect(decoded.aud).toBe("mcp-oauth-state");
    expect(decoded.connectionId).toBe(CONNECTION_ID);
    // 10-minute expiry:
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(600);
  });
});

describe("oauthStateService — fail-closed verification (D-10)", () => {
  it("returns null on a tampered payload (signature failure)", () => {
    const { state } = signOAuthState(CONNECTION_ID);
    const [header, , signature] = state.split(".");
    const payload = Buffer.from(JSON.stringify({ connectionId: "evil", nonce: "n", aud: "mcp-oauth-state" })).toString("base64url");
    const tampered = `${header}.${payload}.${signature}`;
    expect(verifyOAuthState(tampered)).toBeNull();
  });

  it("returns null on an expired state (negative expiresIn)", () => {
    const expired = jwt.sign(
      { connectionId: CONNECTION_ID, nonce: "n", aud: "mcp-oauth-state" },
      getEnv().JWT_SECRET,
      { expiresIn: "-1s" },
    );
    expect(verifyOAuthState(expired)).toBeNull();
  });

  it("returns null for garbage input without throwing", () => {
    expect(verifyOAuthState("not-a-jwt")).toBeNull();
    expect(verifyOAuthState("")).toBeNull();
    expect(verifyOAuthState("a.b.c")).toBeNull();
  });

  it("is null-safe for non-string inputs (public callback hardening)", () => {
    expect(verifyOAuthState(undefined as unknown as string)).toBeNull();
    expect(verifyOAuthState(null as unknown as string)).toBeNull();
  });

  // ─── Phase 200 (Option A audience seam — WR-03 cross-audience pins) ───

  it("signs with the CONNECTOR audience when the audience param is passed (Phase 200 Option A)", () => {
    const { state } = signOAuthState(CONNECTION_ID, CONNECTOR_OAUTH_STATE_AUDIENCE);
    const decoded = jwt.decode(state) as Record<string, unknown>;
    expect(decoded.aud).toBe("connector-oauth-state");
    // The connector audience verifies through the explicit audience param:
    const payload = verifyOAuthState(state, CONNECTOR_OAUTH_STATE_AUDIENCE);
    expect(payload).not.toBeNull();
    expect(payload!.connectionId).toBe(CONNECTION_ID);
  });

  it("REJECTS a connector-audience state at the MCP default (cross-audience, WR-03)", () => {
    const { state } = signOAuthState(CONNECTION_ID, CONNECTOR_OAUTH_STATE_AUDIENCE);
    expect(verifyOAuthState(state)).toBeNull();
  });

  it("REJECTS an MCP-audience state at the connector audience (cross-audience, WR-03)", () => {
    const { state } = signOAuthState(CONNECTION_ID); // default mcp audience
    expect(verifyOAuthState(state, CONNECTOR_OAUTH_STATE_AUDIENCE)).toBeNull();
  });

  it("keeps the PKCE pairing working across audiences (the verifier Map is audience-agnostic, keyed by nonce)", () => {
    const { state, verifier } = signOAuthState(CONNECTION_ID, CONNECTOR_OAUTH_STATE_AUDIENCE);
    const nonce = (jwt.decode(state) as { nonce: string }).nonce;
    expect(consumeVerifier(nonce)).toBe(verifier);
    expect(consumeVerifier(nonce)).toBeNull();
  });
});

describe("oauthStateService — PKCE verifier Map (D-08)", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("consumeVerifier returns the verifier once, then null (single-use) — keyed by the state NONCE (WR-01)", () => {
    const { state, verifier } = signOAuthState("660e8400-e29b-41d4-a716-446655440001");
    const nonce = (jwt.decode(state) as { nonce: string }).nonce;
    expect(consumeVerifier(nonce)).toBe(verifier);
    expect(consumeVerifier(nonce)).toBeNull();
    // A second start for the SAME connection issues a NEW nonce — its pairing
    // is independent (the old nonce's consumption can't poison it, WR-01).
    const second = signOAuthState("660e8400-e29b-41d4-a716-446655440001");
    const nonce2 = (jwt.decode(second.state) as { nonce: string }).nonce;
    expect(nonce2).not.toBe(nonce);
    expect(consumeVerifier(nonce2)).toBe(second.verifier);
  });

  it("returns null for a nonce that never signed (WR-01 keying)", () => {
    expect(consumeVerifier("nonexistent-nonce")).toBeNull();
  });

  it("drops expired entries on read (TTL cleanup)", () => {
    const { state } = signOAuthState("880e8400-e29b-41d4-a716-446655440003");
    const nonce = (jwt.decode(state) as { nonce: string }).nonce;
    const before = pendingVerifierCount();
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 11 * 60_000); // past the 10-min TTL
    expect(consumeVerifier(nonce)).toBeNull();
    jest.useRealTimers();
    expect(pendingVerifierCount()).toBe(before - 1);
  });

  it("stores the verifier OUTSIDE the signed state (D-08 — never in the JWT payload)", () => {
    const { state, verifier } = signOAuthState("990e8400-e29b-41d4-a716-446655440004");
    // The raw verifier string must not appear in the token (even encoded):
    expect(state.includes(verifier)).toBe(false);
    const decoded = jwt.decode(state) as Record<string, unknown>;
    expect(Object.values(decoded)).not.toContain(verifier);
  });
});