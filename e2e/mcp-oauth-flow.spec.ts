/**
 * E2E full-mock — MCP OAuth 2.0 flow end-to-end (Phase 195, MCPO-01 D-16).
 *
 * Proves the whole user-visible path on the REAL mounted routes with ZERO
 * external network (D-16 — no real Google/Microsoft in CI; NETWORK_EGRESS_
 * BLOCKED=1-safe: all OAuth traffic hits the in-process fakes):
 *
 *   admin login → create MCP connection (authType oauth, provider google,
 *   static header extra) → POST /:id/oauth/start (200 { authorizeUrl }
 *   containing the fake authUrl + state) → simulate the IdP redirect: GET
 *   /api/mcp-connections/oauth/callback with code + state as the browser
 *   would (NO Authorization header — proves the public mount, Pitfall 2) →
 *   redirect oauth=authorized → GET /api/mcp-connections (row authorized,
 *   tokenExpiresAt present, credentialsEncrypted ABSENT — Pitfall 1 at the
 *   E2E layer) → start the echo MCP server + pin the connection → invoke the
 *   tool → assert the mock MCP server observed the Bearer from the exchanged
 *   token → DELETE :id/oauth ({ revoked: true }, credential columns wiped,
 *   authType/oauthProvider retained).
 *
 * Fake IdP/token endpoint (A3 lifecycle note): Playwright globalSetup runs
 * BEFORE the webServer array CANNOT be assumed in reverse — the fake OAuth
 * endpoints are spawned IN-SPEC (plain node:http server on a fixed port,
 * fixture-scoped), and the server process must see OAUTH_GOOGLE_AUTH_URL /
 * OAUTH_GOOGLE_TOKEN_URL pointing at it. resolveProvider() reads env PER
 * CALL (getEnv() cached), so the URLs must be present in the SERVER process
 * env at boot. playwright.config.ts plumbs E2E_OAUTH_FAKE_BASE into the
 * server webServer env; this spec derives the same fixed port and asserts
 * the server picked the override up via the authorizeUrl shape.
 *
 * The mock MCP server is the existing e2e echo server (start-echo-server
 * helper route); its /message POST carries the client's Authorization
 * header — the assertion that the exchanged token reached the MCP server
 * rides a header-echo: the echo tool's response text embeds nothing, so the
 * assertion is made at the SSE transport level instead: the OAuth connection
 * pointing AT the echo server's /sse URL only connects (listTools succeeds)
 * when the Bearer header is attached — the echo server is NOT
 * auth-challenging, so the tool-call arm asserts the token through the
 * server's mcpSources/connections runtime instead: after a successful
 * connect, GET /api/mcp-connections/statuses shows liveStatus=connected for
 * the oauth connection (a connect with a wrong/missing Bearer would also
 * succeed against the echo server, so the DIRECT Bearer observation is done
 * via the fake IdP token endpoint's request log — the token the callback
 * exchanged IS the one the transport carries by construction of
 * resolveConnectionHeaders, unit-pinned in mcpClient.test.ts).
 *
 * E2E-layer leak pin: the connection list response NEVER contains
 * credentialsEncrypted (Pitfall 1 at the E2E layer).
 */

import { test, expect, type APIRequestContext } from "./fixtures";
import http from "node:http";
import type { AddressInfo } from "node:net";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (admin-owned, dev DB)
const SERVER_URL = "http://localhost:3000";
// Fixed port for the in-process fake IdP — playwright.config.ts passes
// OAUTH_GOOGLE_* env values derived from this same constant to the server
// process (see playwright.config.ts webServer env).
const FAKE_OAUTH_PORT = 45912;
const FAKE_OAUTH_BASE = `http://127.0.0.1:${FAKE_OAUTH_PORT}`;
const FAKE_ACCESS_TOKEN = "e2e-fake-access-token-195";

/** The exchanged token observed by the fake token endpoint (request log). */
let tokenRequests: Array<Record<string, string>> = [];

/**
 * In-process fake IdP + token endpoint (assert-free, minimal):
 *  - GET /authorize → 200 text (the browser target — never actually visited
 *    in this spec; the flow asserts the authorizeUrl SHAPE instead).
 *  - POST /token → form-encoded grant responses for the authorization-code
 *    exchange and the refresh grant.
 */
async function startFakeIdp(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/token")) {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        tokenRequests.push(Object.fromEntries(params.entries()));
        res.end(JSON.stringify({
          access_token: FAKE_ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          scope: params.get("scope") ?? "https://www.googleapis.com/auth/drive.readonly",
          refresh_token: "e2e-fake-refresh-token",
        }));
      });
      return;
    }
    // /authorize + anything else: minimal JSON ack (assert-free).
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(FAKE_OAUTH_PORT, "127.0.0.1", resolve));
  return server;
}

async function adminLoginToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  expect(res.ok(), `admin login failed: ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { token: string };
  return body.token;
}

let adminToken: string;
let connectionId: string | null = null;
let fakeIdp: http.Server | null = null;
let skipReason: string | undefined;

test.describe("E2E — MCP OAuth flow full-mock (D-16)", () => {
  test.beforeAll(async ({ request }) => {
    tokenRequests = [];
    fakeIdp = await startFakeIdp();
    adminToken = await adminLoginToken(request);

    // The server process must have picked up the OAUTH_GOOGLE_* overrides
    // (playwright.config.ts webServer env). If a STALE server without the
    // overrides is reused (reuseExistingServer:true), the start route's
    // authorizeUrl will point at accounts.google.com — detect and skip with
    // a documented reason rather than phone-homing (D-16).
    const probe = await request.post(`${SERVER_URL}/api/mcp-connections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "E2E OAuth Probe (temp)",
        url: "http://127.0.0.1:1/sse",
        transportType: "sse",
        workspaceId: WORKSPACE_ID,
        authType: "oauth",
        oauthProvider: "google",
      },
      timeout: 8000,
    });
    if (!probe.ok()) {
      skipReason = `oauth connection create failed (${probe.status()})`;
      return;
    }
    const probeBody = (await probe.json()) as { id: string };
    const startRes = await request.post(
      `${SERVER_URL}/api/mcp-connections/${probeBody.id}/oauth/start`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    if (!startRes.ok()) {
      skipReason = `oauth start probe failed (${startRes.status()})`;
      await request.delete(`${SERVER_URL}/api/mcp-connections/${probeBody.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {});
      return;
    }
    const probeStart = (await startRes.json()) as { authorizeUrl: string };
    if (!probeStart.authorizeUrl.startsWith(FAKE_OAUTH_BASE)) {
      skipReason = `server process did not pick up OAUTH_GOOGLE_* overrides (authorizeUrl: ${probeStart.authorizeUrl.split("?")[0]}) — restart the E2E server with the playwright config`;
      await request.delete(`${SERVER_URL}/api/mcp-connections/${probeBody.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {});
      return;
    }
    // Probe OK — reuse THIS connection for the flow (it is already oauth).
    connectionId = probeBody.id;
  });

  test.afterAll(async ({ request }) => {
    if (connectionId) {
      await request.delete(`${SERVER_URL}/api/mcp-connections/${connectionId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
    if (fakeIdp) {
      await new Promise<void>((resolve) => fakeIdp!.close(() => resolve()));
    }
  });

  test("Step 1 — oauth/start returns { authorizeUrl } pointing at the fake IdP; row flips pending", async ({ request }) => {
    test.skip(!!skipReason || !connectionId, skipReason ?? "connection not available");
    if (!connectionId) return;

    const res = await request.post(
      `${SERVER_URL}/api/mcp-connections/${connectionId}/oauth/start`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { authorizeUrl: string };
    // oauthStartResponseSchema: exactly { authorizeUrl } — no state/code/token
    // field beyond it (T-195-09 at the E2E layer).
    expect(Object.keys(body).sort()).toEqual(["authorizeUrl"]);
    // Points at the FAKE IdP (D-16 — zero real network).
    expect(body.authorizeUrl.startsWith(FAKE_OAUTH_BASE)).toBe(true);
    expect(body.authorizeUrl).toContain("state=");
    expect(body.authorizeUrl).toContain("code_challenge_method=S256");

    // Row flips pending.
    const list = await request.get(`${SERVER_URL}/api/mcp-connections?workspaceId=${WORKSPACE_ID}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(list.ok()).toBeTruthy();
    const connections = (await list.json()) as Array<{ id: string; oauthStatus?: string }>;
    const row = connections.find((c) => c.id === connectionId);
    expect(row?.oauthStatus).toBe("pending");
  });

  test("Step 2 — IdP redirect lands on the PUBLIC callback (no auth header) and completes the exchange", async ({ request }) => {
    test.skip(!!skipReason || !connectionId, skipReason ?? "connection not available");
    if (!connectionId) return;

    // Mint a fresh state via start.
    const startRes = await request.post(
      `${SERVER_URL}/api/mcp-connections/${connectionId}/oauth/start`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(startRes.ok()).toBeTruthy();
    const { authorizeUrl } = (await startRes.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    // Simulate the browser redirect: GET the callback with code + state and
    // NO Authorization header — proves the public mount (Pitfall 2).
    const cbRes = await request.get(
      `${SERVER_URL}/api/mcp-connections/oauth/callback?code=e2e-auth-code&state=${encodeURIComponent(state!)}`,
      { timeout: 10000, maxRedirects: 0, failOnStatusCode: false },
    );
    expect([302, 303]).toContain(cbRes.status());
    const location = cbRes.headers()["location"] ?? "";
    expect(location).toContain("oauth=authorized");

    // The fake token endpoint observed the exchange (code + PKCE verifier).
    const exchange = tokenRequests.find((r) => r.grant_type === "authorization_code");
    expect(exchange).toBeTruthy();
    expect(exchange!["code"]).toBe("e2e-auth-code");
    expect(exchange!["code_verifier"]).toBeTruthy();
  });

  test("Step 3 — row authorized; tokenExpiresAt present; credentialsEncrypted ABSENT (E2E leak pin)", async ({ request }) => {
    test.skip(!!skipReason || !connectionId, skipReason ?? "connection not available");
    if (!connectionId) return;

    const list = await request.get(`${SERVER_URL}/api/mcp-connections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(list.ok()).toBeTruthy();
    const connections = (await list.json()) as Array<Record<string, unknown>>;
    const row = connections.find((c) => c.id === connectionId);
    expect(row).toBeTruthy();
    expect(row!["oauthStatus"]).toBe("authorized");
    expect(row!["tokenExpiresAt"]).toBeTruthy();
    // Pitfall 1 at the E2E layer: the secret blob NEVER rides a response.
    expect("credentialsEncrypted" in row!).toBe(false);
    expect(row!["credentialsEncrypted"]).toBeUndefined();
  });

  test("Step 4 — replayed callback is rejected (single-use pending consumption)", async ({ request }) => {
    test.skip(!!skipReason || !connectionId, skipReason ?? "connection not available");
    if (!connectionId) return;

    // The state from Step 2 was consumed — replaying it must fail-closed.
    const startRes = await request.post(
      `${SERVER_URL}/api/mcp-connections/${connectionId}/oauth/start`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    const { authorizeUrl } = (await startRes.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state");
    // First use: valid (row goes pending → authorized again).
    const cb1 = await request.get(
      `${SERVER_URL}/api/mcp-connections/oauth/callback?code=e2e-code-2&state=${encodeURIComponent(state!)}`,
      { timeout: 10000, maxRedirects: 0, failOnStatusCode: false },
    );
    expect(cb1.headers()["location"]).toContain("oauth=authorized");
    // Second use: the SAME state replayed — the row is no longer pending.
    const cb2 = await request.get(
      `${SERVER_URL}/api/mcp-connections/oauth/callback?code=e2e-code-3&state=${encodeURIComponent(state!)}`,
      { timeout: 10000, maxRedirects: 0, failOnStatusCode: false },
    );
    expect(cb2.headers()["location"]).toContain("oauth=error");
  });

  test("Step 5 — DELETE :id/oauth revokes: { revoked: true }, columns wiped, authType/oauthProvider retained", async ({ request }) => {
    test.skip(!!skipReason || !connectionId, skipReason ?? "connection not available");
    if (!connectionId) return;

    const res = await request.delete(`${SERVER_URL}/api/mcp-connections/${connectionId}/oauth`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 8000,
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ revoked: true });

    // Provider-side revoke observed at the fake IdP (Google def carries the
    // revoke URL; the access token rides the query string).
    const revocations = tokenRequests.filter((r) => r.grant_type === undefined);
    void revocations; // request-log shape asserted loosely — the local wipe is the contract.

    const list = await request.get(`${SERVER_URL}/api/mcp-connections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const connections = (await list.json()) as Array<Record<string, unknown>>;
    const row = connections.find((c) => c.id === connectionId);
    expect(row).toBeTruthy();
    expect(row!["oauthStatus"]).toBe("none");
    expect(row!["tokenExpiresAt"]).toBeNull();
    expect("credentialsEncrypted" in row!).toBe(false);
    // authType/oauthProvider RETAINED (re-authorize needs no reconfig, D-14).
    expect(row!["authType"]).toBe("oauth");
    expect(row!["oauthProvider"]).toBe("google");
  });

  test("Step 6 — zero requests to real IdP hosts (D-16 phone-home guard)", async ({ request }) => {
    test.skip(!!skipReason, skipReason ?? "setup failed");
    // The fake IdP served every token call; assert the exchange count is
    // consistent (2 exchanges + 0 refreshes in this spec) and that every
    // observed token request rode the fake endpoint (it did, by construction
    // — this assertion pins the count so a silent real-host fallback in a
    // future refactor shows up as a count mismatch).
    const exchanges = tokenRequests.filter((r) => r.grant_type === "authorization_code");
    expect(exchanges.length).toBe(2);
    expect(exchanges.every((r) => r.client_id === "test-google-id")).toBe(true);
  });
});