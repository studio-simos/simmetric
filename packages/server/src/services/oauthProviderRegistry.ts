// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview OAuth provider registry (Phase 195, MCPO-01 D-04/D-05/D-06).
 *
 * MCP-AGNOSTIC by design (D-04): no key in this module references
 * MCPConnection — the Phase 200 Slack "Add to Slack" install reuses this same
 * registry as the single OAuth stack of the server. Provider endpoints are
 * hardcoded from the Context7-verified defaults (195-RESEARCH "Provider
 * Registry Defaults" table) and overridable per-environment for air-gap/proxy
 * installs (D-05) — every env read goes through getEnv() (rawEnvReads gate;
 * never raw process.env here).
 *
 * Scope policy (T-195-02, scope-reduce-only): `resolveScopes` intersects the
 * admin-requested scope string with the provider's defaultScopes — unknown
 * scopes are DROPPED, never added. No code path can grant a scope outside the
 * provider def's default list.
 *
 * Zero new dependencies (D-04): jsonwebtoken (existing dep), node crypto, and
 * global fetch only. The Microsoft secret is URL-encoded automatically by the
 * URLSearchParams form body in fetchToken (never hand-build the body string —
 * Pitfall: MS client_secret must be form-urlencoded).
 */

import crypto from "crypto";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

/**
 * Provider definition — data-driven per spec §3.3 (D-04).
 * defaultScopes is the MAXIMUM grantable set; admins may only reduce it.
 * usesPkce is true for google/microsoft (S256 challenge on the auth URL).
 * scopesAreRestricted flags providers whose scopes carry a verification
 * burden (gmail.* — surfaced as a UI warning in Phase 196).
 */
export type OAuthProviderDef = {
  id: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  defaultScopes: string[];
  usesPkce: boolean;
  scopesAreRestricted?: boolean;
  extraAuthParams: Record<string, string>;
  /** Scope-join separator for the authorize URL's `scope` param (Phase 200,
   * checker W5 — a per-provider DATA field, NOT a flow-code branch, D-05):
   * Slack's authorize endpoint documents COMMA-separated scopes while
   * Google/Microsoft take space-joined ones. OPTIONAL with NO default on
   * the type — google/microsoft defs carry no field and
   * buildAuthorizeUrl falls back to " " so their output stays byte-identical
   * (pinned by the existing google/microsoft authorize-URL tests). */
  scopeSeparator?: string;
};

/**
 * Hardcoded provider defaults (Context7-verified 2026-09-22 — 195-RESEARCH
 * table). {tenant} segments in microsoft URLs are substituted by
 * resolveProvider() from OAUTH_MICROSOFT_TENANT (default "common").
 *
 * - google: access_type=offline + prompt=consent are MANDATORY on the auth
 *   URL — without them Google never returns a refresh_token (Pitfall 3).
 * - microsoft: offline_access is MANDATORY in defaultScopes (no refresh_token
 *   without it, Pitfall 4); NO revokeUrl — the MS v2 platform has no
 *   RFC-7009 token-revocation endpoint (RESEARCH A1); local blob wipe is the
 *   primary revocation (D-14). response_mode=query matches the documented
 *   code-flow example.
 */
const PROVIDER_DEFAULTS: Record<string, OAuthProviderDef> = {
  google: {
    id: "google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    defaultScopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    usesPkce: true,
    scopesAreRestricted: true,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  microsoft: {
    id: "microsoft",
    authUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    // Phase 196 (D-08): Mail.Read + Sites.Read.All added for
    // graph_mail_search / graph_sharepoint_search (full-URL form — MS v2
    // requires resource-prefixed resource scopes, 196-RESEARCH Pitfall 9).
    // Files.Read already covers OneDrive; offline_access/openid/profile/email
    // stay. The scope-reduce-only invariant (resolveScopes) is untouched.
    defaultScopes: [
      "offline_access",
      "https://graph.microsoft.com/Files.Read",
      "openid",
      "profile",
      "email",
      "https://graph.microsoft.com/Mail.Read",
      "https://graph.microsoft.com/Sites.Read.All",
    ],
    usesPkce: true,
    extraAuthParams: { response_mode: "query" },
  },
  // Phase 200 (ECCO-06, D-05): the Slack "Add to Slack" install rides the
  // SAME registry — the def is the ONLY Slack-shaped data here. Slack's
  // authorize endpoint documents COMMA-separated `scope=` (200-RESEARCH.md
  // :186 — hence scopeSeparator ","), takes NO PKCE params (usesPkce false,
  // research A2), and its token response carries NO refresh_token
  // (tokens do not expire — no refresh arm anywhere).
  slack: {
    id: "slack",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    defaultScopes: ["chat:write", "im:history"],
    usesPkce: false,
    extraAuthParams: {},
    scopeSeparator: ",",
  },
};

/**
 * Resolve a provider def with env overrides applied (D-05): OAUTH_* URL
 * overrides win over the hardcoded defaults, and the microsoft {tenant}
 * segment is substituted from OAUTH_MICROSOFT_TENANT (default "common").
 * Unknown providerId → null (caller turns it into a 400).
 * Env is read ONLY via getEnv() (rawEnvReads gate).
 */
export function resolveProvider(
  providerId: string,
  env = getEnv(),
): OAuthProviderDef | null {
  const base = PROVIDER_DEFAULTS[providerId];
  if (!base) return null;

  let authUrl = base.authUrl;
  let tokenUrl = base.tokenUrl;
  if (base.id === "google") {
    authUrl = env.OAUTH_GOOGLE_AUTH_URL ?? base.authUrl;
    tokenUrl = env.OAUTH_GOOGLE_TOKEN_URL ?? base.tokenUrl;
  } else if (base.id === "microsoft") {
    const tenant = env.OAUTH_MICROSOFT_TENANT || "common";
    authUrl = (env.OAUTH_MICROSOFT_AUTH_URL ?? base.authUrl).replaceAll("{tenant}", tenant);
    tokenUrl = (env.OAUTH_MICROSOFT_TOKEN_URL ?? base.tokenUrl).replaceAll("{tenant}", tenant);
  } else if (base.id === "slack") {
    // Phase 200 (D-05): the Slack air-gap lever — same override posture as
    // the google/microsoft arms (OAUTH_SLACK_* env keys, P9 parity).
    authUrl = env.OAUTH_SLACK_AUTH_URL ?? base.authUrl;
    tokenUrl = env.OAUTH_SLACK_TOKEN_URL ?? base.tokenUrl;
  }

  return { ...base, authUrl, tokenUrl };
}

/**
 * Fixed redirect URI on the env-sourced SERVER_URL (D-09). SERVER_URL is
 * ALWAYS_READONLY infra config (systemConfigService.ts) — never sourced from
 * DB settings (Pitfall 13).
 */
export function resolveRedirectUri(env = getEnv()): string {
  return `${env.SERVER_URL}/api/mcp-connections/oauth/callback`;
}

/**
 * Phase 200 (BLOCKER-2): the CONNECTOR-specific redirect URI on the
 * env-sourced SERVER_URL — the ONE constant used by the connector oauth/start
 * route, the connector OAuth callback's token exchange, and the Slack App
 * registration instruction (Slack validates redirect_uri consistency between
 * the authorize and token calls). SERVER_URL is ALWAYS_READONLY infra config
 * (systemConfigService.ts) — never sourced from DB settings (Pitfall 13).
 * `resolveRedirectUri()` above stays BYTE-IDENTICAL for all MCP callers
 * (pinned by oauthProviderRegistry.test.ts + mcpOauthRoutes.test.ts).
 */
export function resolveConnectorRedirectUri(env = getEnv()): string {
  return `${env.SERVER_URL}/api/connectors/oauth/callback`;
}

/**
 * Build the provider authorize URL (D-07): client_id, response_type=code,
 * redirect_uri, REDUCED scope list joined with the def's scopeSeparator
 * (Phase 200 W5 — per-provider DATA field; " " fallback keeps google/
 * microsoft byte-identical), state, PKCE S256 challenge (ONLY when
 * usesPkce — slack's usesPkce false emits no challenge params), then the
 * def's extraAuthParams (google: access_type=offline&prompt=consent;
 * microsoft: response_mode=query).
 */
export function buildAuthorizeUrl(
  def: OAuthProviderDef,
  params: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    codeVerifier: string;
  },
): string {
  const challenge = crypto.createHash("sha256").update(params.codeVerifier).digest("base64url");
  const url = new URL(def.authUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scopes.join(def.scopeSeparator ?? " "));
  url.searchParams.set("state", params.state);
  if (def.usesPkce) {
    // PKCE S256 (Context7-verified form for both providers).
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(def.extraAuthParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Scope-reduce-only resolution (T-195-02): parse the space-separated
 * requested string, intersect with def.defaultScopes (unknown requested
 * scopes are DROPPED, never added), fall back to the full default list when
 * nothing requested survives. No code path can grant a scope outside
 * defaultScopes.
 */
export function resolveScopes(def: OAuthProviderDef, requested?: string): string[] {
  if (!requested || requested.trim() === "") return [...def.defaultScopes];
  const requestedList = requested
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allowed = new Set(def.defaultScopes);
  const reduced = requestedList.filter((s) => allowed.has(s));
  return reduced.length > 0 ? reduced : [...def.defaultScopes];
}

/**
 * True iff the provider has a client configured in env (D-06). Callers turn
 * false into a clear 400 { error } on the oauth start route.
 */
export function hasClientConfigured(providerId: string, env = getEnv()): boolean {
  if (providerId === "google") {
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  }
  if (providerId === "microsoft") {
    return Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
  }
  // Phase 200 (D-05): Slack rides the same env-only client posture
  // (SLACK_CLIENT_*). False (this default) keeps the Connect button hidden
  // and the static-token create path the only install surface.
  if (providerId === "slack") {
    return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET);
  }
  return false;
}

/**
 * The single low-level token-endpoint client (D-04): POST the (possibly
 * overridden) tokenUrl with an application/x-www-form-urlencoded URLSearchParams
 * body — URLSearchParams auto-encodes the Microsoft client_secret (RESEARCH
 * Microsoft gotcha). NEVER logs the body or any response token field
 * (T-195-05: provider id + HTTP status only). Returns parsed JSON or
 * { error } on non-200/network failure.
 */
export async function fetchToken(
  def: OAuthProviderDef,
  body: Record<string, string>,
): Promise<Record<string, unknown> | { error: string; status: number }> {
  try {
    const res = await fetch(def.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    if (!res.ok) {
      // Pitfall 9: log provider + status only — never the body (it can carry
      // error descriptions with codes, never tokens, but keep the posture).
      logger.error("[oauth] token endpoint failed", {
        provider: def.id,
        status: res.status,
      });
      // error_description text (provider status text) is safe to carry back —
      // it never contains token material; token fields are never echoed.
      let errorDescription = `token endpoint returned ${res.status}`;
      try {
        const parsed = (await res.json()) as Record<string, unknown>;
        if (typeof parsed.error_description === "string") errorDescription = parsed.error_description;
        else if (typeof parsed.error === "string") errorDescription = parsed.error;
      } catch {
        // non-JSON body — keep the generic status text
      }
      return { error: errorDescription, status: res.status };
    }
    const json = (await res.json()) as Record<string, unknown>;
    return json;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[oauth] token endpoint unreachable", { provider: def.id, error: message });
    return { error: `token endpoint unreachable: ${message}`, status: 0 };
  }
}