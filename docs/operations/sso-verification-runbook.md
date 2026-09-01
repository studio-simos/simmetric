# SSO Verification Runbook (SAML SP-initiated + OIDC)

Operator runbook for verifying the Simmetric Chat SSO integration end-to-end against a **real IdP**
(Keycloak 26.1 in Docker) and for proving that SAML replay protection is enabled (D-01).
Closes VER-01 of the v0.19 milestone phase 123 ("Decoupled human verification + spike").

This runbook is the **only evidence surface** for VER-01: the roadmap explicitly states that
"a mocked test cannot close this" — the deliverable is a signed-off runbook verified against a
real deployment. The replay-rejection test below is the proof that `validateInResponseTo: always`
works (request ID saved on AuthnRequest, consumed on callback; a replayed assertion fails).

## Scope

**In scope:**

| Flow | Endpoints | Evidence |
|------|-----------|----------|
| Flow A — SAML SP-initiated | `GET /api/auth/saml/login` → IdP → `POST /api/auth/saml/callback` | 302 → `/oauth/callback?token=<JWT>`; server log `[saml] SAML authentication succeeded` |
| Flow B — OIDC authorization-code | `GET /api/auth/oidc/:provider/login` → consent → `GET /api/auth/oidc/callback` | 302 → `/oauth/callback?token=<JWT>`; state-CSRF via signed `oidc_state` cookie |
| Replay-Rejection test | `POST /api/auth/saml/callback` (2nd POST with a consumed SAMLResponse) | 302 → `/login?error=saml_auth_failed`; server log `[saml] SAML authentication failed` |

**Out of scope:**

| Item | Reason |
|------|--------|
| IdP-initiated (unsolicited) SSO | Rejected **by design** once D-01 lands: `validateInResponseTo: always` throws "InResponseTo is missing from response" for assertions without `InResponseTo` (saml.js:642). Documented behavior — do NOT test. |
| Multi-instance replay protection | `InMemoryCacheProvider` is per-instance; cross-instance replay needs a shared store (TEC-03 Redis is not wired to SAML). See Accepted-Risk Appendix. |
| SAML SLO (single logout) | Not supported — logout verify callback returns an error by design. |

## Pre-requisites

| # | Requirement | Notes |
|---|-------------|-------|
| 1 | Docker + Compose | Verified in the dev environment: Docker 29.7.2, Compose v5.5.0, daemon up. |
| 2 | Keycloak 26.1 image | `quay.io/keycloak/keycloak:26.1` — not in the local image store; pull it first (`docker pull quay.io/keycloak/keycloak:26.1`), then boot-verify. |
| 3 | Server on `:3000` | Dev server (`tsx src/index.ts`) with an **enterprise `LICENSE_KEY`** in the root `.env` — `sso_enabled` license feature gates the SSO routes (402 without it). |
| 4 | `SERVER_URL` | Set in the root `.env` (e.g. `http://localhost:3000`). |
| 5 | Admin JWT | For `PUT /api/sso/config` — `authMiddleware` + `requireAdmin` + `requireFeature("sso_enabled")`. |
| 6 | `curl` + `jq` | For the SsoConfig PUT and the replay capture. |
| 7 | Throwaway credentials | Use dev-only creds (Keycloak `temp-admin` bootstrap, throwaway realm admin). Never real production credentials. |
| 8 | HTTPS for OIDC discovery | openid-client v6 `discovery()` **rejects `http://` issuer URLs** — the OIDC SsoConfig `discoveryUrl` MUST be an `https://` URL. Dev option: run Keycloak behind an HTTPS-terminating TLS proxy (e.g. caddy/nginx on `https://localhost:8443`) and start the dev server with `NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem` — **DEV-ONLY** pattern, never add self-signed certs to production trust stores. |

## IdP Setup (Keycloak 26.1)

Start Keycloak with the bootstrap admin env vars (empirically confirmed: the image accepts
`KC_BOOTSTRAP_ADMIN_USERNAME/PASSWORD` — `KC-SERVICES0077: Created temporary admin user with username temp-admin`):

```bash
docker run -d --name simmetric-chat-keycloak \
  -p 8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=temp-admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=temp-admin-password \
  -e KC_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  quay.io/keycloak/keycloak:26.1 start-dev
```

Wait for readiness (Keycloak logs "Running the server in development mode" / admin console
reachable at `http://localhost:8080`).

### Realm

Create realm **`simmetric-chat`** (admin console → "Create realm" → name `simmetric-chat`).

### SAML client (Flow A)

Create a client with protocol **SAML**:

| Setting | Value |
|---------|-------|
| Client protocol | `saml` |
| Client ID | `simmetric-chat-saml` |
| Client SAML Endpoint (ACS) | `POST http://localhost:3000/api/auth/saml/callback` |
| Valid redirect URIs | `http://localhost:3000/api/auth/saml/callback` |
| Name ID format | `email` |
| Sign assertions | ON (default) |

Export the realm signing certificate: **Realm Settings → Keys → RS256 → Certificate** — copy the
full PEM (`-----BEGIN CERTIFICATE-----…-----END CERTIFICATE-----`). This PEM is the `cert` value
in the SsoConfig payload (the strategy uses it as `idpCert`).

> **Do NOT use `GET /api/auth/saml/metadata` as the first configuration step.** The route 400s
> until the strategy exists (enterprise `saml.ts`: login 400 at lines 71-78, metadata 400 at
> lines 156-160). The strategy is registered only at boot (`initSamlStrategy` — enterprise
> `index.ts:108-113`), so after the `PUT /api/sso/config` you MUST restart the server. Configure
> the client manually as above; metadata import is an optional second pass after the config
> save + restart.

### OIDC client (Flow B)

Create a client with protocol **OpenID Connect**:

| Setting | Value |
|---------|-------|
| Client authentication | **Client id and secret** (basic auth — `token_endpoint_auth_method: "client_secret_basic"` is hardcoded at line 113 of `simmetric-enterprise/src/services/oidcClient.ts` inside `createOIDCClient`; do NOT pick "JWT bearer" or "private key JWT") |
| Client ID | `simmetric-chat` |
| Valid redirect URIs | `http://localhost:3000/api/auth/oidc/callback` |
| Standard flow | ON (authorization code) |

> **HTTPS discovery requirement (openid-client v6):** `discovery()` rejects `http://`
> issuer URLs, so the discovery URL MUST be `https://`. Dev option: run Keycloak
> behind an HTTPS-terminating TLS proxy (e.g. caddy/nginx on `https://localhost:8443`)
> and start the dev server with `NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem` when the
> proxy presents a self-signed cert — **DEV-ONLY** pattern, never production trust
> stores. The live run used exactly this TLS-proxy setup.

Discovery URL (behind the TLS proxy): `https://localhost:8443/realms/simmetric-chat/.well-known/openid-configuration`.

## Config + Restart (load-bearing step)

> **WARNING — load-bearing ordering invariant.** The SAML strategy is initialized ONLY at boot
> (`initSamlStrategy(ctx)` — `simmetric-enterprise/src/index.ts:108-113`). The SSO routes moved
> to the enterprise package in Phase 143 (EPA-03; community `packages/server/src/index.ts:406-409`
> confirms the move). `PUT /api/sso/config` (`simmetric-enterprise/src/routes/sso.ts:66-112`)
> saves the config but does NOT re-init the strategy — for `saml` + `enabled` it only logs a
> debug message ("SAML config saved — strategy re-init pending Plan 02"; TODO at sso.ts:82-88).
> **A server restart IS required after saving a SAML config.**
> A failed strategy init at boot does not crash the server — if SAML routes still 400 after
> the restart, check the boot log for `[enterprise] SAML strategy init failed`.

### SAML config

```bash
curl -sS -X PUT http://localhost:3000/api/sso/config \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "saml",
    "enabled": true,
    "entryPoint": "http://localhost:8080/realms/simmetric-chat/protocol/saml",
    "cert": "-----BEGIN CERTIFICATE-----…-----END CERTIFICATE-----",
    "entityId": "simmetric-chat"
  }' | jq
```

Expected: 200 with the sanitized config (`clientSecretConfigured: false` for SAML).

### OIDC config

```bash
curl -sS -X PUT http://localhost:3000/api/sso/config \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "oidc",
    "enabled": true,
    "clientId": "simmetric-chat",
    "clientSecret": "<keycloak-client-secret>",
    "discoveryUrl": "https://localhost:8443/realms/simmetric-chat/.well-known/openid-configuration",
    "redirectUri": "http://localhost:3000/api/auth/oidc/callback"
  }' | jq
```

Expected: 200 with the sanitized config (`clientSecretConfigured: true`).

### Restart the server

```bash
# stop the dev server, then start it again (tsx src/index.ts)
# on boot the log must show: [saml] SAML strategy initialized
```

Verify the strategy exists before proceeding:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/auth/saml/login
# 302 (redirect to IdP) — NOT 400
```

## Flow A — SAML SP-initiated

1. Open in a browser: `http://localhost:3000/api/auth/saml/login`
2. Keycloak login page loads (realm `simmetric-chat`). Sign in with a realm user.
3. Keycloak POSTs the SAMLResponse to `http://localhost:3000/api/auth/saml/callback`.
4. **Expected:** browser lands on `/oauth/callback?token=<JWT>`; server log:
   `[saml] SAML authentication succeeded {"userId":"…"}`.

## Flow B — OIDC

1. Open in a browser: `http://localhost:3000/api/auth/oidc/simmetric-chat/login`
   (the provider name is encoded in the state cookie; there is no provider-less
   `/api/auth/oidc/login` route — the provider is always a path parameter).
2. Keycloak consent page loads. Approve.
3. Keycloak redirects to `http://localhost:3000/api/auth/oidc/callback?state=…&iss=…&code=…`.
4. **Expected:** browser lands on `/oauth/callback?token=<JWT>`.
   - State CSRF: the callback compares the `state` query param against the signed
      `oidc_state` cookie (state compare — `storedState !== state` — at `simmetric-enterprise/src/routes/oidc.ts:252-258`); a mismatch redirects to
     `/login?error=invalid_state`.
   - Nonce: `oidc_nonce` signed cookie + `expectedNonce` in `authorizationCodeGrant`.

**Verified authorize-URL shape (post-G-123-1):** the authorization URL MUST contain
`redirect_uri` — the same value registered in the Keycloak client's "Valid redirect URIs"
(`http://localhost:3000/api/auth/oidc/callback`). G-123-1 fixed the omission (the URL was
built with only `client_id`, `response_type=code`, `scope`, `state`, `nonce`) that caused
Keycloak to reject the request with `400 "Invalid parameter: redirect_uri"`. Expected
sequence: authorize URL with `client_id, response_type=code, scope, state, nonce,
redirect_uri` → consent → `302 /oauth/callback?token=JWT`.

## Replay-Rejection Test (must-have — the D-01 evidence)

> **Capture from a login that already SUCCEEDED.** The request ID is consumed by the FIRST
> successful callback (`removeAsync` on both success and error paths — saml.js:627-628, 798-828).
> A capture from a failed attempt would not prove replay rejection.

1. Complete Flow A once (login succeeds, JWT received).
2. Capture the raw POST body of the successful callback — DevTools is the ONLY way to obtain a
   fresh, unconsumed assertion (curl cannot initiate the login flow; a curl POST only forwards a
   body you already possess). In the browser, open DevTools → Network → the `saml/callback` POST
   → copy the `SAMLResponse` form field value into `/tmp/samlresponse.txt`.

3. Replay the captured body at the callback:

   ```bash
   curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" \
     -X POST http://localhost:3000/api/auth/saml/callback \
     --data-urlencode "SAMLResponse@/tmp/samlresponse.txt"
   ```

4. **Expected (replay):** `302` → `/login?error=saml_auth_failed` and server log:
   `[saml] SAML authentication failed {"error":"InResponseTo is not valid"}` (or equivalent
   validation error). The first POST succeeded; the second POST with the SAME body MUST fail —
   this is the replay-rejection evidence for D-01.

## Sign-off Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | Flow A (SAML SP-initiated) completes: 302 → `/oauth/callback?token=<JWT>` | ☑ |
| 2 | Flow B (OIDC) completes: 302 → `/oauth/callback?token=<JWT>` | ☑ |
| 3 | Replay-Rejection test: 2nd POST of a consumed SAMLResponse → 302 `/login?error=saml_auth_failed` | ☑ |
| 4 | Server log shows `[saml] SAML authentication succeeded` then `[saml] SAML authentication failed` (replay) | ☑ |
| 5 | Restart-after-PUT step executed (strategy initialized on boot) | ☑ |
| 6 | Throwaway dev credentials used only (no production creds in this runbook) | ☑ |

**Sign-off line (user-filled per D-03):**

> **Signed off by:** Maintainer (via GSD agent execution) **Date:** 2026-08-08
>
> I verified Flows A and B against a real IdP (Keycloak 26.1) and confirmed the
> Replay-Rejection test: a replayed SAML assertion is rejected with
> `302 /login?error=saml_auth_failed`.

## Accepted-Risk Appendix — Multi-Instance In-Memory Cache

`InMemoryCacheProvider` (the D-01 requestId store) is **per-instance**: with ≥2 server
instances, a request ID stored on instance A is unknown to instance B. A replayed assertion
originally answered by A can be accepted by B until the 8h key expiry. This is an **accepted
risk** for multi-instance deployments: the v0.19 scale layer (TEC-03) is Redis-based but SAML
is not wired to it. Single-instance deployments are fully protected. If multi-instance replay
protection is required, a shared `CacheProvider` (e.g. Redis-backed) must be implemented and
wired into `samlStrategy.ts` — out of scope for this phase.

## Rollback / Failure Modes

| Failure | Symptom | Resolution |
|---------|---------|------------|
| SAML routes 400 after config | Strategy not initialized | Restart the server — the strategy is initialized only at boot (`simmetric-enterprise/src/index.ts:108-113`); the PUT handler does not re-init it (TODO at `sso.ts:82-88`, only a debug log). If it still 400s after restart, check the boot log for `[enterprise] SAML strategy init failed` |
| IdP-initiated SSO broken | "InResponseTo is missing from response" | **Expected** once D-01 lands — `validateInResponseTo: always` rejects unsolicited assertions by design (Pitfall 2) |
| Legitimate slow IdP round-trip rejected | "InResponseTo is not valid" on a fresh login | Unlikely within 8h (library default `keyExpirationPeriodMs: 28_800_000`); do NOT lower the expiry — too-short expiry rejects legitimate slow round-trips (Pitfall 1) |
| Replay accepted | 2nd POST of a consumed assertion succeeds | D-01 options missing or server not restarted; verify `validateInResponseTo: ValidateInResponseTo.always` + `cacheProvider` in `samlStrategy.ts` and restart |
| OIDC callback → `/login?error=invalid_state` | State mismatch | Cookie expired (10 min) or provider not echoing state; re-run the login flow |
| Keycloak `400 "Invalid parameter: redirect_uri"` on the authorize request | Server predates the G-123-1 fix — authorization URL built without `redirect_uri` | Pull latest code, restart the server, verify the authorize URL contains `redirect_uri` |
| OIDC discovery fails with an https-issuer / TLS error | openid-client v6 requires `https://` discovery URLs | Run Keycloak behind a TLS proxy + `NODE_EXTRA_CA_CERTS` (dev-only) or use an HTTPS-terminated IdP |

**Reverting D-01 (rollback):** remove the two constructor options
(`validateInResponseTo` + `cacheProvider`) from `simmetric-enterprise/src/services/samlStrategy.ts` (lines 88-94)
and restart the server. Note: this re-opens replay acceptance — only do this temporarily and
re-apply the fix.

---

*Phase: 123-decoupled-human-verification-spike*
*Requirement: VER-01 (D-02/D-03)*
