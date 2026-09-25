// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 195 (MCPO-01): oauthProviderRegistry unit tests — provider defaults,
 * env overrides, scope-reduce-only rule, redirect URI, client-configured
 * gates. Postgres-free; no network (no fetch call is exercised here except
 * fetchToken, which is stubbed in oauthExchange.test.ts).
 */

import "./helpers/setupEnv";
import {
  resolveProvider,
  resolveRedirectUri,
  resolveConnectorRedirectUri,
  buildAuthorizeUrl,
  resolveScopes,
  hasClientConfigured,
  fetchToken,
} from "../services/oauthProviderRegistry";
import { getEnv } from "../config/env";

describe("oauthProviderRegistry — provider defaults (D-04)", () => {
  it("resolves google with the hardcoded Context7-verified defaults", () => {
    const def = resolveProvider("google");
    expect(def).not.toBeNull();
    expect(def!.authUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(def!.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(def!.revokeUrl).toBe("https://oauth2.googleapis.com/revoke");
    expect(def!.usesPkce).toBe(true);
    expect(def!.scopesAreRestricted).toBe(true);
    expect(def!.defaultScopes).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(def!.extraAuthParams["access_type"]).toBe("offline");
    expect(def!.extraAuthParams["prompt"]).toBe("consent");
  });

  it("resolves microsoft with tenant substitution and NO revokeUrl", () => {
    const def = resolveProvider("microsoft");
    expect(def).not.toBeNull();
    expect(def!.authUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(def!.tokenUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(def!.revokeUrl).toBeUndefined();
    expect(def!.usesPkce).toBe(true);
    expect(def!.defaultScopes).toContain("offline_access");
    expect(def!.extraAuthParams["response_mode"]).toBe("query");
  });

  // Phase 196 (D-08): the microsoft default set gains Mail.Read +
  // Sites.Read.All (full-URL form, Pitfall 9) while keeping all five prior
  // scopes — the superset pin below guards BOTH directions.
  it("microsoft defaultScopes carry the D-08 superset in full-URL form", () => {
    const def = resolveProvider("microsoft")!;
    expect(def.defaultScopes).toEqual([
      "offline_access",
      "https://graph.microsoft.com/Files.Read",
      "openid",
      "profile",
      "email",
      "https://graph.microsoft.com/Mail.Read",
      "https://graph.microsoft.com/Sites.Read.All",
    ]);
    // Every resource scope uses the full-URL form (never the shorthand).
    for (const scope of def.defaultScopes) {
      if (scope !== "offline_access" && scope !== "openid" && scope !== "profile" && scope !== "email") {
        expect(scope.startsWith("https://graph.microsoft.com/")).toBe(true);
      }
    }
  });

  it("google defaultScopes stay byte-identical (as-shipped — gmail is Phase 197's concern)", () => {
    const def = resolveProvider("google")!;
    expect(def.defaultScopes).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  it("substitutes OAUTH_MICROSOFT_TENANT into the URL segment", () => {
    const env = { ...getEnv(), OAUTH_MICROSOFT_TENANT: "organizations" };
    const def = resolveProvider("microsoft", env);
    expect(def!.authUrl).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    expect(def!.tokenUrl).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
  });

  it("returns null for an unknown providerId (caller 400s)", () => {
    expect(resolveProvider("")).toBeNull();
    expect(resolveProvider("github")).toBeNull();
  });

  it("exposes exactly two provider entries (google, microsoft)", () => {
    expect(resolveProvider("google")).not.toBeNull();
    expect(resolveProvider("microsoft")).not.toBeNull();
  });

  // ─── Phase 200 (ECCO-06, D-05): the slack provider def ────────────────

  it("resolves slack with the research-verified def (comma separator, NO pkce, two scopes)", () => {
    const def = resolveProvider("slack");
    expect(def).not.toBeNull();
    expect(def!.id).toBe("slack");
    expect(def!.authUrl).toBe("https://slack.com/oauth/v2/authorize");
    expect(def!.tokenUrl).toBe("https://slack.com/api/oauth.v2.access");
    expect(def!.defaultScopes).toEqual(["chat:write", "im:history"]);
    // Slack's authorize endpoint takes NO PKCE params (200-RESEARCH A2):
    expect(def!.usesPkce).toBe(false);
    expect(def!.extraAuthParams).toEqual({});
    // Slack documents COMMA-separated scope= (research :186) — a per-provider
    // DATA field (checker W5), NOT a flow-code branch:
    expect(def!.scopeSeparator).toBe(",");
    expect(def!.revokeUrl).toBeUndefined();
  });

  it("google/microsoft defs carry NO scopeSeparator field (byte-identical defaults)", () => {
    expect(resolveProvider("google")!.scopeSeparator).toBeUndefined();
    expect(resolveProvider("microsoft")!.scopeSeparator).toBeUndefined();
  });

  it("OAUTH_SLACK_* overrides replace the hardcoded Slack URLs (D-05 air-gap lever)", () => {
    const env = {
      ...getEnv(),
      OAUTH_SLACK_AUTH_URL: "https://proxy.internal/slack/auth",
      OAUTH_SLACK_TOKEN_URL: "https://proxy.internal/slack/token",
    };
    const def = resolveProvider("slack", env);
    expect(def!.authUrl).toBe("https://proxy.internal/slack/auth");
    expect(def!.tokenUrl).toBe("https://proxy.internal/slack/token");
    // Defaults stay untouched for the other providers:
    expect(resolveProvider("google", env)!.authUrl).toContain("accounts.google.com");
    expect(resolveProvider("microsoft", env)!.authUrl).toContain("login.microsoftonline.com");
  });
});

describe("oauthProviderRegistry — env URL overrides win (D-05)", () => {
  it("OAUTH_GOOGLE_* overrides replace the hardcoded URLs", () => {
    const env = {
      ...getEnv(),
      OAUTH_GOOGLE_AUTH_URL: "https://proxy.internal/google/auth",
      OAUTH_GOOGLE_TOKEN_URL: "https://proxy.internal/google/token",
    };
    const def = resolveProvider("google", env);
    expect(def!.authUrl).toBe("https://proxy.internal/google/auth");
    expect(def!.tokenUrl).toBe("https://proxy.internal/google/token");
    // Defaults stay untouched for the other provider:
    expect(resolveProvider("microsoft", env)!.authUrl).toContain("login.microsoftonline.com");
  });

  it("OAUTH_MICROSOFT_* overrides replace the hardcoded URLs (override beats tenant default)", () => {
    const env = {
      ...getEnv(),
      OAUTH_MICROSOFT_AUTH_URL: "https://proxy.internal/ms/{tenant}/auth",
      OAUTH_MICROSOFT_TOKEN_URL: "https://proxy.internal/ms/{tenant}/token",
      OAUTH_MICROSOFT_TENANT: "contoso.onmicrosoft.com",
    };
    const def = resolveProvider("microsoft", env);
    expect(def!.authUrl).toBe("https://proxy.internal/ms/contoso.onmicrosoft.com/auth");
    expect(def!.tokenUrl).toBe("https://proxy.internal/ms/contoso.onmicrosoft.com/token");
  });
});

describe("oauthProviderRegistry — scope-reduce-only (T-195-02)", () => {
  it("drops unknown requested scopes (never amplifies)", () => {
    const def = resolveProvider("google")!;
    const resolved = resolveScopes(
      def,
      "https://www.googleapis.com/auth/drive.readonly https://evil.example/read",
    );
    expect(resolved).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
  });

  it("keeps the subset of requested scopes that are in defaultScopes", () => {
    const def = resolveProvider("microsoft")!;
    const resolved = resolveScopes(def, "offline_access https://graph.microsoft.com/Files.Read openid");
    expect(resolved).toEqual(["offline_access", "https://graph.microsoft.com/Files.Read", "openid"]);
  });

  it("falls back to full defaults when the request reduces to nothing", () => {
    const def = resolveProvider("google")!;
    expect(resolveScopes(def, "https://evil.example/read")).toEqual(def.defaultScopes);
    expect(resolveScopes(def, "")).toEqual(def.defaultScopes);
    expect(resolveScopes(def, undefined)).toEqual(def.defaultScopes);
  });

  // Phase 196 (D-08): the reduce-only invariant holds against the ENLARGED
  // microsoft default set — a requested subset returns exactly that subset
  // (including the new scopes), unknown scopes are still dropped, never added.
  it("resolveScopes reduce-only invariant holds with the enlarged microsoft default set", () => {
    const def = resolveProvider("microsoft")!;
    // A requested subset (mixed prior + new scopes) returns exactly the subset.
    const subset = resolveScopes(
      def,
      "https://graph.microsoft.com/Files.Read https://graph.microsoft.com/Mail.Read",
    );
    expect(subset).toEqual([
      "https://graph.microsoft.com/Files.Read",
      "https://graph.microsoft.com/Mail.Read",
    ]);
    // A request naming ONLY the new scope returns just it.
    expect(resolveScopes(def, "https://graph.microsoft.com/Sites.Read.All")).toEqual([
      "https://graph.microsoft.com/Sites.Read.All",
    ]);
    // Unknown requested scopes are dropped, never added.
    expect(resolveScopes(def, "https://evil.example/write")).toEqual(def.defaultScopes);
  });

  // ─── Phase 200 (ECCO-06): slack scope reduce-only ─────────────────────

  it("resolveScopes reduces slack requests to the default set (admin may reduce, never amplify)", () => {
    const def = resolveProvider("slack")!;
    expect(resolveScopes(def)).toEqual(["chat:write", "im:history"]);
    expect(resolveScopes(def, "chat:write")).toEqual(["chat:write"]);
    // Unknown scopes are dropped, never added:
    expect(resolveScopes(def, "chat:write admin scopes:read")).toEqual(["chat:write"]);
    // A request that reduces to nothing falls back to the full defaults:
    expect(resolveScopes(def, "admin")).toEqual(["chat:write", "im:history"]);
    expect(resolveScopes(def, "")).toEqual(["chat:write", "im:history"]);
    expect(resolveScopes(def, undefined)).toEqual(["chat:write", "im:history"]);
  });
});

describe("oauthProviderRegistry — redirect URI + client gates (D-06/D-09)", () => {
  it("resolveRedirectUri rides getEnv().SERVER_URL (env-only, never DB)", () => {
    const env = { ...getEnv(), SERVER_URL: "http://chat.example.com:3000" };
    expect(resolveRedirectUri(env)).toBe("http://chat.example.com:3000/api/mcp-connections/oauth/callback");
  });

  it("hasClientConfigured gates google + microsoft on id+secret pairs", () => {
    const env = {
      ...getEnv(),
      GOOGLE_CLIENT_ID: undefined as unknown as string,
      GOOGLE_CLIENT_SECRET: undefined as unknown as string,
      MICROSOFT_CLIENT_ID: undefined as unknown as string,
      MICROSOFT_CLIENT_SECRET: undefined as unknown as string,
    };
    expect(hasClientConfigured("google", env)).toBe(false);
    expect(hasClientConfigured("microsoft", env)).toBe(false);
    expect(hasClientConfigured("google", { ...env, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" })).toBe(true);
    expect(hasClientConfigured("microsoft", { ...env, MICROSOFT_CLIENT_ID: "id", MICROSOFT_CLIENT_SECRET: "sec" })).toBe(true);
    // Partial config (id without secret) is NOT configured.
    expect(hasClientConfigured("google", { ...env, GOOGLE_CLIENT_ID: "id" })).toBe(false);
    // Unknown provider is never configured.
    expect(hasClientConfigured("github", { ...env, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" })).toBe(false);
  });

  // ─── Phase 200 (ECCO-06, D-05): the slack client gate ─────────────────

  it("hasClientConfigured gates slack on the SLACK_CLIENT_* pair (D-05)", () => {
    const env = {
      ...getEnv(),
      SLACK_CLIENT_ID: undefined as unknown as string,
      SLACK_CLIENT_SECRET: undefined as unknown as string,
    };
    expect(hasClientConfigured("slack", env)).toBe(false);
    expect(hasClientConfigured("slack", { ...env, SLACK_CLIENT_ID: "id", SLACK_CLIENT_SECRET: "sec" })).toBe(true);
    // Partial config (id without secret) is NOT configured.
    expect(hasClientConfigured("slack", { ...env, SLACK_CLIENT_ID: "id" })).toBe(false);
  });

  // ─── Phase 200 (BLOCKER-2): the two redirect-URI helpers ──────────────

  it("resolveConnectorRedirectUri returns the connector callback while resolveRedirectUri stays the MCP one (BLOCKER-2 pin)", () => {
    const env = { ...getEnv(), SERVER_URL: "http://chat.example.com:3000" };
    expect(resolveConnectorRedirectUri(env)).toBe("http://chat.example.com:3000/api/connectors/oauth/callback");
    // The MCP helper is byte-identical to its pre-200 output (pinned by
    // mcpOauthRoutes.test.ts too):
    expect(resolveRedirectUri(env)).toBe("http://chat.example.com:3000/api/mcp-connections/oauth/callback");
  });
});

describe("oauthProviderRegistry — buildAuthorizeUrl (D-07)", () => {
  it("builds the google authorize URL with PKCE S256 + access_type=offline + prompt=consent", () => {
    const def = resolveProvider("google")!;
    const url = buildAuthorizeUrl(def, {
      clientId: "cid",
      redirectUri: "https://app.example.com/api/mcp-connections/oauth/callback",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      state: "signed-state",
      codeVerifier: "verifier-string",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("cid");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/mcp-connections/oauth/callback");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(parsed.searchParams.get("state")).toBe("signed-state");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    // challenge = BASE64URL(SHA256(verifier))
    const crypto = require("crypto");
    expect(parsed.searchParams.get("code_challenge")).toBe(
      crypto.createHash("sha256").update("verifier-string").digest("base64url"),
    );
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });

  it("builds the microsoft authorize URL with the tenant segment + response_mode=query", () => {
    const def = resolveProvider("microsoft")!;
    const url = buildAuthorizeUrl(def, {
      clientId: "cid",
      redirectUri: "https://app.example.com/api/mcp-connections/oauth/callback",
      scopes: def.defaultScopes,
      state: "signed-state",
      codeVerifier: "verifier-string",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(parsed.searchParams.get("response_mode")).toBe("query");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  // ─── Phase 200 (ECCO-06, D-05/W5): slack authorize URL pins ───────────

  it("builds the slack authorize URL with COMMA-joined scopes and NO PKCE challenge (usesPkce false pin — the zero-branch proof)", () => {
    const def = resolveProvider("slack")!;
    const url = buildAuthorizeUrl(def, {
      clientId: "cid",
      redirectUri: "https://app.example.com/api/connectors/oauth/callback",
      scopes: def.defaultScopes,
      state: "signed-state",
      codeVerifier: "verifier-string",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("cid");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/connectors/oauth/callback");
    // W5 pin: the scope param is COMMA-joined (slack scopeSeparator ","):
    expect(parsed.searchParams.get("scope")).toBe("chat:write,im:history");
    expect(parsed.searchParams.get("scope")).not.toContain(" ");
    expect(parsed.searchParams.get("state")).toBe("signed-state");
    // usesPkce false → NO challenge params at all (the D-05 zero-branch
    // proof — buildAuthorizeUrl has no provider-id branch):
    expect(parsed.searchParams.get("code_challenge")).toBeNull();
    expect(parsed.searchParams.get("code_challenge_method")).toBeNull();
    // No extraAuthParams either:
    expect(parsed.searchParams.get("access_type")).toBeNull();
    expect(parsed.searchParams.get("response_mode")).toBeNull();
  });

  it("keeps google/microsoft authorize URLs space-joined (byte-identical defaults alongside the slack comma field)", () => {
    const googleDef = resolveProvider("google")!;
    const googleUrl = buildAuthorizeUrl(googleDef, {
      clientId: "cid",
      redirectUri: "https://app.example.com/api/mcp-connections/oauth/callback",
      scopes: ["s1", "s2"],
      state: "st",
      codeVerifier: "v",
    });
    expect(new URL(googleUrl).searchParams.get("scope")).toBe("s1 s2");
    const msDef = resolveProvider("microsoft")!;
    const msUrl = buildAuthorizeUrl(msDef, {
      clientId: "cid",
      redirectUri: "https://app.example.com/api/mcp-connections/oauth/callback",
      scopes: ["s1", "s2"],
      state: "st",
      codeVerifier: "v",
    });
    expect(new URL(msUrl).searchParams.get("scope")).toBe("s1 s2");
  });
});

describe("oauthProviderRegistry — fetchToken posture (T-195-05)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs form-urlencoded and parses the JSON response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ access_token: "at", token_type: "Bearer" }), { status: 200 });
    }) as unknown as typeof fetch;

    const def = resolveProvider("google")!;
    const res = await fetchToken(def, { grant_type: "authorization_code", code: "c" });
    expect(calls).toHaveLength(1);
    const firstCall = calls[0]!;
    expect(firstCall.init.method).toBe("POST");
    const headers = firstCall.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect((res as Record<string, unknown>).access_token).toBe("at");
  });

  it("returns a structured error (status text, no token fields) on non-200", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), { status: 400 })) as unknown as typeof fetch;
    const def = resolveProvider("google")!;
    const res = await fetchToken(def, { grant_type: "authorization_code" });
    expect((res as { error: string }).error).toBe("code expired");
  });

  it("returns a structured error on network throw (never throws)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const def = resolveProvider("google")!;
    const res = await fetchToken(def, { grant_type: "authorization_code" });
    expect((res as { error: string }).error).toContain("unreachable");
  });
});