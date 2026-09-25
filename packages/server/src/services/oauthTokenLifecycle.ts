// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview OAuth token lifecycle helpers (Phase 195, MCPO-01 D-11..D-14
 * plumbing): authorization-code exchange, refresh, AES-256-GCM blob
 * encrypt/decrypt (via encryptionService — never hand-rolled crypto), and
 * best-effort provider-side revocation.
 *
 * Zero new dependencies (D-04): the token calls ride the registry's
 * fetchToken (global fetch + URLSearchParams form body). NO token material is
 * ever logged (T-195-05): every failure path carries only provider status
 * text / a structural message, and logs carry provider + status only.
 *
 * Blob shape (D-01): { accessToken, refreshToken?, scope, obtainedAt } —
 * obtainedAt is an ISO timestamp. The refresh path keeps the EXISTING
 * refreshToken when the provider omits one (Google may omit on refresh,
 * 195-RESEARCH refresh example).
 */

import { encrypt, decrypt } from "./encryptionService";
import { fetchToken, OAuthProviderDef } from "./oauthProviderRegistry";
import { logger } from "../utils/logger";

/** Decrypted credential-blob shape (D-01 — extensible for per-user later). */
export type OAuthTokenBlob = {
  accessToken: string;
  refreshToken?: string;
  scope: string;
  obtainedAt: string; // ISO timestamp
  /** Provider-issued access-token lifetime in seconds (WR-02: null when the
   * provider omits expires_in — the 1h default applies at the write site). */
  expires_in?: number;
};

/** Structured failure carrying NO token material (T-195-05). */
export type OAuthExchangeFailure = {
  ok: false;
  errorDescription: string;
};

export type OAuthExchangeSuccess = {
  ok: true;
  blob: OAuthTokenBlob;
  /** The provider's raw token-response JSON (Phase 200 Rule 2): carries the
   * fields the normalized blob drops (Slack's team.id/team.name/bot_user_id —
   * the connector callback seeds them into configEncrypted for the echo
   * guard + display). NEVER logged, never echoed (T-195-05 posture). */
  raw: Record<string, unknown>;
};

/**
 * Exchange an authorization code for a token blob (D-04/RESEARCH exchange
 * shape): grant_type=authorization_code, code, client_id, client_secret,
 * redirect_uri, code_verifier — plus scope for microsoft (REQUIRED by the MS
 * v2 platform; harmless for Google). On a provider error the structured
 * failure carries only the provider's error_description text — never a token
 * field.
 */
export async function exchangeAuthorizationCode(
  def: OAuthProviderDef,
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier: string;
    scopes: string[];
  },
): Promise<OAuthExchangeSuccess | OAuthExchangeFailure> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  };
  if (def.id === "microsoft") {
    body.scope = params.scopes.join(" ");
  }
  const res = await fetchToken(def, body);
  if ("error" in res) {
    return { ok: false, errorDescription: String(res.error) };
  }
  const accessToken = res.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // Provider answered 200 without a usable token — treat as failure.
    logger.error("[oauth] token response missing access_token", { provider: def.id });
    return { ok: false, errorDescription: "token response missing access_token" };
  }
  const blob: OAuthTokenBlob = {
    accessToken,
    // Google may omit refresh_token on the exchange when prior consent exists;
    // the field stays optional in the blob.
    ...(typeof res.refresh_token === "string" && res.refresh_token.length > 0
      ? { refreshToken: res.refresh_token }
      : {}),
    scope: typeof res.scope === "string" ? res.scope : params.scopes.join(" "),
    obtainedAt: new Date().toISOString(),
    // WR-02: carry the provider-issued lifetime (null when omitted — the
    // 1h default applies at the tokenExpiresAt write sites).
    ...(typeof res.expires_in === "number" && res.expires_in > 0
      ? { expires_in: res.expires_in }
      : {}),
  };
  return { ok: true, blob, raw: res };
}

/**
 * Refresh a token blob (RESEARCH refresh shape): grant_type=refresh_token +
 * client_id/client_secret (+ scope for microsoft). When the provider omits
 * refresh_token in the response (Google refresh behavior), the EXISTING
 * refreshToken rides into the new blob.
 */
export async function refreshAccessToken(
  def: OAuthProviderDef,
  params: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
  },
): Promise<OAuthExchangeSuccess | OAuthExchangeFailure> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
  };
  if (def.id === "microsoft") {
    body.scope = params.scopes.join(" ");
  }
  const res = await fetchToken(def, body);
  if ("error" in res) {
    return { ok: false, errorDescription: String(res.error) };
  }
  const accessToken = res.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    logger.error("[oauth] refresh response missing access_token", { provider: def.id });
    return { ok: false, errorDescription: "refresh response missing access_token" };
  }
  const blob: OAuthTokenBlob = {
    accessToken,
    // Provider may omit refresh_token on refresh — keep the existing one.
    ...(typeof res.refresh_token === "string" && res.refresh_token.length > 0
      ? { refreshToken: res.refresh_token }
      : params.refreshToken
        ? { refreshToken: params.refreshToken }
        : {}),
    scope: typeof res.scope === "string" ? res.scope : params.scopes.join(" "),
    obtainedAt: new Date().toISOString(),
    // WR-02: carry the provider-issued lifetime (null when omitted — the
    // 1h default applies at the tokenExpiresAt write sites).
    ...(typeof res.expires_in === "number" && res.expires_in > 0
      ? { expires_in: res.expires_in }
      : {}),
  };
  return { ok: true, blob, raw: res };
}

/**
 * Encrypt the token blob for at-rest storage (T-195-01): JSON.stringify
 * through encryptionService.encrypt (AES-256-GCM; the rotation chain rides
 * decrypt). Never logs the plaintext blob.
 */
export function encryptTokenBlob(blob: OAuthTokenBlob): string {
  return encrypt(JSON.stringify(blob));
}

/**
 * Decrypt the stored blob (rotation chain: decrypt rides
 * LEGACY_PREVIOUS_ENCRYPTION_KEYS). On failure, return a structured error
 * disclosing ONLY that decryption failed (the raw encryption error text is
 * dropped — it can reference ciphertext/chain internals; T-195-01 posture).
 */
export function decryptTokenBlob(
  encoded: string,
): { ok: true; blob: OAuthTokenBlob } | { ok: false; errorDescription: string } {
  try {
    const parsed: unknown = JSON.parse(decrypt(encoded));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { accessToken?: unknown }).accessToken === "string" &&
      (parsed as { accessToken: string }).accessToken.length > 0
    ) {
      const obj = parsed as Partial<OAuthTokenBlob>;
      const accessToken = (parsed as { accessToken: string }).accessToken;
      return {
        ok: true,
        blob: {
          accessToken,
          ...(typeof obj.refreshToken === "string" ? { refreshToken: obj.refreshToken } : {}),
          scope: typeof obj.scope === "string" ? obj.scope : "",
          obtainedAt: typeof obj.obtainedAt === "string" ? obj.obtainedAt : new Date().toISOString(),
        },
      };
    }
    return { ok: false, errorDescription: "stored OAuth blob is malformed (missing accessToken)" };
  } catch {
    // Spec §9-5: a decrypt failure surfaces as a refresh-time re-encrypt
    // trigger upstream; here it discloses only that decryption failed.
    return { ok: false, errorDescription: "OAuth credential blob could not be decrypted" };
  }
}

/**
 * Best-effort provider-side revocation (D-14): POST
 * <def.revokeUrl>?token=<encoded> when the provider def has one (Google only
 * — revoking an access token also revokes its paired refresh token). For
 * microsoft (no RFC-7009 revoke endpoint, RESEARCH A1) return
 * { ok: true, skipped: true } — the local blob wipe is the primary
 * revocation. Failures log provider + status only, never token material
 * (T-195-05), and never throw (revoke is best-effort by contract).
 */
export async function revokeProviderToken(
  def: OAuthProviderDef,
  token: string,
): Promise<{ ok: boolean; skipped?: boolean; errorDescription?: string }> {
  if (!def.revokeUrl) {
    return { ok: true, skipped: true };
  }
  try {
    const res = await fetch(`${def.revokeUrl}?token=${encodeURIComponent(token)}`, {
      method: "POST",
    });
    if (!res.ok) {
      // Google returns 400 for an already-revoked/invalid token — the local
      // wipe still stands, so a non-200 revoke is a warn, not a hard failure.
      logger.warn("[oauth] provider revoke returned non-200", {
        provider: def.id,
        status: res.status,
      });
      return { ok: true, errorDescription: `provider revoke returned ${res.status}` };
    }
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[oauth] provider revoke unreachable", { provider: def.id, error: message });
    return { ok: true, errorDescription: `provider revoke unreachable: ${message}` };
  }
}