# Enterprise License Terms — Simmetric Chat

> **Status:** TEMPLATE — the commercial terms below define the *shape* of the
> enterprise offering. Concrete pricing, SLA tiers, and contract specifics are
> negotiated per customer and live outside this repo (in the commercial
> agreement, not in source-controlled docs). This document exists so operators
> and prospects can see what the enterprise license *entitles* and *requires*
> without reading the JWT schema.

This document is the operator-facing commercial layer for the Simmetric Chat
enterprise plugin (`@simmetric-chat/enterprise`). It complements:

- `docs/ENTERPRISE_PLUGIN.md` — the technical plugin architecture, air-gap
 install runbook, and `PluginContext` contract.
- `docs/LICENSE_DECISION.md` — the license-model analysis for the dual
 distribution (community + enterprise).
- `docs/LICENSE_KEY_ROTATION.md` — the license signing key rotation runbook.

---

## 1. What the enterprise license entitles

The enterprise license is a **commercial license** that unlocks the
`@simmetric-chat/enterprise` plugin package. The plugin is delivered as a
private tarball (air-gap compatible — no npm install, no phone-home). When
the server boots and `require.resolve("@simmetric-chat/enterprise")` finds
the package, it calls `plugin.register(ctx)` which mounts the enterprise
routes, registers schedulers, and raises numeric limits via
`ctx.overrideFeatureLimit`.

### 1.1 Feature modules

| Module | What it does | Phase shipped |
|--------|--------------|---------------|
| **SSO** | SAML 2.0 + OIDC + SCIM 2.0 — IdP-initiated and SP-initiated flows, user provisioning/deprovisioning via SCIM | 143 |
| **Audit log** | Immutable `event_log` table + INSERT-only DB role (`simmetric_audit_writer`) + admin viewer UI — tamper-evident compliance audit trail | 144 |
| **White-label branding** | Config-key validator rejects `BRANDING_*` keys in community; enterprise unlocks branding-icon routes + `BRANDING_*` config keys | 145 |
| **Backup** | Local + remote (S3-compatible) backup destinations, daily/weekly/monthly scheduler, point-in-time restore, ~3394 LOC | 146 |

### 1.2 Numeric limit overrides

The community build enforces numeric limits on freemium resources. The
enterprise plugin raises these via `ctx.overrideFeatureLimit` at boot:

| Limit flag | Community | Enterprise |
|------------|-----------|------------|
| `max_workspaces` | 3 | `Infinity` |
| `max_projects` | 3 | `Infinity` |
| `max_widgets` | 1 | `Infinity` |
| `custom_agents` | 3 | `Infinity` |

Reactive revocation: `clearLimitOverrides()` runs at the start of
`initLicense()` and in `getLicenseInfo()`'s runtime-expiry branch — a
Community JWT loaded after an Enterprise one cannot inherit `Infinity`
overrides.

### 1.3 What is NOT in the enterprise license

The following are **commodity features** — always-ON in community (EPA-02,
), not gated by the enterprise license:

- Web search (`web_search`)
- Webhooks
- Web push notifications (VAPID)
- Memory
- Lead export
- Widget analytics
- Auto title generation
- Synthesis rate limit

These were removed from `FEATURE_FLAGS` in v1.1. The enterprise license does
not gate them and never will.

---

## 2. License JWT shape

The enterprise license is an **RS256 JWT** (asymmetric signing — the customer
verifies with the embedded public key, the private key never leaves the
issuer). The JWT payload is defined by `licensePayloadSchema` in
`packages/shared/src/schemas/license.schema.ts`.

**Key fields (summary — the schema is the source of truth):**

| Field | Type | Purpose |
|-------|------|---------|
| `tier` | `"community" \| "enterprise"` | License tier |
| `exp` | `number` | Expiration (Unix timestamp) — `initLicense()` warns on expiry |
| `iat` | `number` | Issued at |
| `iss` | `string` | Issuer (Simmetric Chat) |

**Verification:** `licenseService.initLicense()` validates the JWT signature
against the embedded public key, checks expiration, and builds `tierFeatures`
+ limit maps. The service is **read-only + local-validation only** — zero
outbound HTTP (verified by CI air-gap grep gate).

**No phone-home.** The license is validated entirely on-prem. The server
never contacts a licensing server. This is a hard constraint (air-gap) and is
CI-enforced.

---

## 3. Delivery model

### 3.1 Air-gap install (default for enterprise customers)

1. Build the enterprise package: `cd simmetric-enterprise && pnpm build`
 (produces `dist/`).
2. Tarball: `tar czf enterprise.tgz -C dist .`.
3. On the customer server, extract to
 `packages/server/node_modules/@simmetric-chat/enterprise/`.
4. Set `LICENSE_KEY` in the root `.env` (the RS256 JWT).
5. Restart the server — the loader finds the package via `require.resolve()`
 and the license service validates the JWT.
6. Verify: `curl -H "Authorization: Bearer <admin-jwt>"
 http://localhost:3000/api/enterprise/modules` → 200 with the module
 manifest.

See `docs/ENTERPRISE_PLUGIN.md` § Air-gap install runbook for the full
procedure.

### 3.2 Docker volume mount

For Docker deployments, mount the enterprise tarball as a read-only volume:

```yaml
# docker-compose.yml (customer side)
services:
 server:
 volumes:
 - ../simmetric-enterprise/dist:/app/node_modules/@simmetric-chat/enterprise:ro
 environment:
 LICENSE_KEY: "<rs256-jwt>"
```

### 3.3 No telemetry, no license server

The enterprise license does not phone home. Verification is local (RS256
public key embedded in the binary). Expiration is checked locally. There is
no license revocation server, no usage reporting, no telemetry. This is a
hard product constraint, not a configuration option.

---

## 4. Support tiers (commercial — outside this repo)

The enterprise license is sold with a support tier. The specific SLA
(percentages, response times, channels) is defined in the commercial
agreement, not in source-controlled docs. Typical structure:

| Tier | Response time (critical) | Support channel | Upgrade window |
|------|--------------------------|-----------------|----------------|
| Standard | Next business day | Email | Next minor release |
| Professional | 4 hours | Email + phone | Current + previous minor |
| Enterprise | 1 hour | Dedicated channel | Current + 2 previous minors |

`priority_support` was removed as a runtime feature flag in v1.1 (EPA-08) —
it is a **commercial contract term**, not a software feature. The software
does not gate any behavior on the support tier.

---

## 5. Upgrade cadence

- **Minor releases** (e.g. v1.4 → v1.5): additive, no breaking migrations
 (except documented exceptions like SCALE-03 in v1.4). Enterprise plugin
 compatibility is maintained — the `PluginContext` contract is versioned
 (`apiVersion: 1`) and the loader rejects mismatches.
- **Major releases** (e.g. v1.x → v2.x): may include breaking changes to the
 `PluginContext` contract. Enterprise customers receive advance notice and
 a migration window per their support tier.
- **Security patches**: backported to the current + previous minor (per
 support tier). Published as patch releases.

---

## 6. Compliance & data residency

- **Air-gap:** the entire product (community + enterprise) runs without
 outbound network access. CI proves this with `NETWORK_EGRESS_BLOCKED=1`
 and the air-gap grep gate.
- **Data residency:** all data stays on-prem. No external CDN for core
 functionality. The backup module can push to S3-compatible destinations,
 but that is operator-configured (not default).
- **Audit log:** the enterprise audit log is append-only with an INSERT-only
 DB role — tamper-evident, suitable for compliance evidence (GDPR, HIPAA,
 ISO 27001 context).

---

## 7. License enforcement boundary

The enterprise license is enforced at two layers:

1. **Plugin presence** — the enterprise package must be physically present in
 `node_modules` (`require.resolve` succeeds). Without it, the server runs
 in community mode (graceful degradation — `MODULE_NOT_FOUND` caught and
 logged at info level).
2. **JWT validation** — `initLicense()` validates the RS256 JWT. If the JWT
 is missing, expired, or invalid, the server falls back to Community tier
 (the enterprise plugin, if present, does not call
 `overrideFeatureLimit`).

A broken install (plugin present but `register()` throws) is **fail-LOUD**
(`process.exit(1)`) — never silently degrade a paying customer. This is
enforced by `packages/server/src/services/enterpriseLoader.ts` and tested by
`packages/server/src/__tests__/enterpriseLoader.test.ts`.

---

## 8. Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-27 | Document created — formalize the commercial layer outside the JWT schema | Operators and prospects need to see what the enterprise license entitles without reading `licensePayloadSchema` |
| 2026-08-19 | `priority_support` removed as a runtime flag → commercial contract term (EPA-08) | Support tier is a commercial relationship, not a software feature |
| 2026-08-16 | RS256 asymmetric license confirmed (no change from v1.0) | Customers verify but never mint licenses; private key stays with the issuer |
| 2026-08-16 | Air-gap as a hard product constraint (CI-enforced) | Target buyers (regulated industries, public sector) require no phone-home |

---

## 9. See also

- `docs/ENTERPRISE_PLUGIN.md` — technical plugin architecture + air-gap
 install runbook
- `docs/LICENSE_DECISION.md` — license-model analysis (AGPL-3.0 vs
 Sustainable Use vs SSPL vs Apache-2.0)
- `docs/LICENSE_KEY_ROTATION.md` — license signing key rotation runbook
- `docs/SCALING.md` — multi-instance deployment guide (enterprise customers
 typically run multi-instance)
- `packages/shared/src/schemas/license.schema.ts` — the JWT schema (source of
 truth for the payload shape)
- `packages/server/src/services/licenseService.ts` — the verification logic
 (read-only, local, no outbound HTTP)