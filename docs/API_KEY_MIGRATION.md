# API Key HMAC Migration Runbook (SCALE-03 / )

Operator runbook for migrating the API-key verification path from the
bcrypt-loop lookup (`api_keys.hashedKey` + `findMany({prefix})` + `bcrypt.compare`,
capped at `take: 10` by CSW-05/) to a keyed-HMAC O(1) digest lookup
(`api_keys.key_hash` + `findUnique({key_hash})`). Closes SCALE-03 of the v1.4
milestone ( — "Keyed-HMAC API Keys").

This is the **only operator surface** for the breaking `api_keys` schema change.
The migration is **destructive** (it `DROP COLUMN "hashedKey"` and deletes
existing rows) — it is the ONE documented additive-only exception (CC-02 in
`.planning/milestones/v1.4-REQUIREMENTS.md`, case #2 from `docs/MIGRATION_SAFETY.md:93` — "Schema
refactor with explicit consent"). `pnpm audit:migrations` flags it as
destructive; CI's `migration-safety-check` job blocks the PR unless
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` is set.

> **Why the migration is breaking (irreversible by design).** Bcrypt hashes
> **cannot** be converted to HMAC-SHA256 digests — they are different
> algorithms (bcrypt is adaptive-cost + salted; HMAC is deterministic + keyed).
> There is nothing to backfill. Existing `api_keys` rows are invalidated and
> must be **re-issued**, not migrated in place. This is cryptographic fact, not
> a tooling limitation (see "Re-issue admin API keys" below).

The migration tooling is CLI-only (`prisma migrate deploy`) and is **NOT
mounted on any HTTP route** — there is no network path to key mutation. The
widget service-account key is re-seeded automatically on the next server boot
(`seedService.seedWidgetApiKey` writes the HMAC digest of the existing
`WIDGET_API_KEY` env value — no operator action for the widget key). Only
admin-created keys require manual re-issue.

## Before upgrading

Complete this checklist **before** deploying the build. The
migration invalidates every existing `api_keys` row; skipping the checklist
leaves integrating clients (widget service, admin API consumers, IDE clients
using `MCP_API_KEY`-style keys) with 401s after the upgrade.

1. **Generate `API_KEY_HMAC_SECRET`** — a base64-encoded 32-byte signing key:
```bash
openssl rand -base64 32
```
Set it in the root `.env`:
```bash
API_KEY_HMAC_SECRET=<output-of-openssl-rand>
```
It is **required** when API keys are used (always — the widget service
account needs one). Validation is at the consumption site
(`packages/server/src/services/apiKeyService.ts`), following the
`ENCRYPTION_KEY` pattern. A missing/invalid secret fails **loud** — the
server returns **500** (not 401) on any API-key request, so the operator
sees the misconfiguration rather than a misleading "invalid key"
(T-163-02 spoofing vector). The error message names `API_KEY_HMAC_SECRET`
and shows the `openssl rand -base64 32` hint.

2. **Record the existing admin-created API keys** so they can be re-issued
after the upgrade. Open the admin UI → **Settings → API Keys** and note
each key's `name` and which integrating client consumes it (the plaintext
key is shown once at creation and cannot be recovered; only the `prefix`
is listed after). These keys will stop working after the upgrade because
their bcrypt hashes are dropped.

3. **Set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`** as a GitHub Actions
**repo Variable** (Settings → Secrets and variables → Actions → Variables)
to `yes` (or `1` / `true`) so CI's `migration-safety-check` job passes the
destructive migration. This is case #2 from `docs/MIGRATION_SAFETY.md:93`
("Schema refactor with explicit consent"). Without this variable the PR's
CI is red with `::error::Destructive Prisma migration(s) detected`.

## Upgrade steps

1. **Apply the migration** — the migration
`20260827120000_api_keys_key_hash_hmac` drops the bcrypt `hashedKey`
column, deletes existing rows (invalidated by design D-02), adds the
`key_hash TEXT NOT NULL` column, and creates the unique index backing
`findUnique({key_hash})`:
```bash
pnpm --filter server db:migrate # dev
# or in prod:
prisma migrate deploy
```
The `DELETE FROM "api_keys"` before `ADD COLUMN ... NOT NULL` is intentional
(the NOT NULL column cannot apply on a populated table without a default;
there is no backfill — see "Why the migration is breaking" above).

2. **Restart the server.** On boot, `seedService.seedWidgetApiKey` runs and
re-seeds the widget service-account `api_keys` row with the HMAC digest of
the existing `WIDGET_API_KEY` env value. **No operator action is needed for
the widget key** — the seed is idempotent (`findUnique({key_hash})` skips if
the row already matches) and transparent across restarts.

3. **Verify the widget key works:**
```bash
curl -H "X-Api-Key: <WIDGET_API_KEY value>" http://localhost:3000/api/internal/widget/<widget-id>/config
```
Expect `200` (not `401`). A `401` means the `WIDGET_API_KEY` env value
does not match the seeded row's digest — confirm `API_KEY_HMAC_SECRET` is
set and consistent across the server and the seed run, and that the
`WIDGET_API_KEY` value is the same one the widget service sends.

## Re-issue admin API keys

For each admin-created key recorded in the pre-upgrade checklist:

1. Log in to the admin UI → **Settings → API Keys**.
2. **Revoke** the old (now-invalid) key — its bcrypt hash is gone, so it
already 401s, but revoking removes the stale row from the list.
3. **Create a new key** — give it the same `name` (or a new one) and an
expiration if applicable. The UI shows the new plaintext `sk-...` key
**once**.
4. **Distribute the new `sk-...` plaintext key** to the integrating client
that consumed the old key (curl script, n8n node, IDE config, etc.). The
plaintext is the only copy — store it securely at the client.

> **Why re-issue, not backfill.** Bcrypt hashes are irreversible and use a
> different algorithm than HMAC-SHA256 — there is no transformation that
> turns a bcrypt hash into the HMAC digest of the same raw key. Re-issuing
> is the only path. The plaintext raw key was shown once at creation and is
> not stored anywhere (by design — the hash is the stored artifact), so the
> operator MUST generate a new key and redistribute it.

## Rollback

This is a **one-way migration** . The bcrypt `hashedKey` column is
dropped; rollback requires authoring a downgrade migration that re-adds
the column and re-seeding bcrypt rows from scratch (the old bcrypt hashes
are gone — they cannot be reconstructed from the raw keys, which were never
stored).

**Recommendation: do not roll back.** The HMAC path is the documented
end-state (SCALE-03 closure). The bcrypt loop was a CPU-bound O(N) scan
with a `take: 10` backstop cap (CSW-05); the HMAC path is an O(1) indexed
lookup that is constant-time at the Postgres unique-index layer. Rolling
back reintroduces the timing side-channel and the backstop cap.

If a rollback is unavoidable (e.g. a critical regression unrelated to the
key model), the procedure is:

1. Restore the pre-Phase-163 code (the `apiKeyService.ts` / `auth.ts` /
`seedService.ts` that use `hashedKey` + bcrypt).
2. Author a new migration: `ALTER TABLE "api_keys" DROP COLUMN "key_hash"`,
`ALTER TABLE "api_keys" ADD COLUMN "hashedKey" TEXT NOT NULL`,
re-create the `hashedKey` unique index.
3. Re-seed every API key from scratch (the widget key via
`seedWidgetApiKey`; admin keys via the re-issue flow above).

## Verification

After the upgrade + re-issue:

```bash
# Widget service key authenticates (200, not 401):
curl -H "X-Api-Key: <WIDGET_API_KEY value>" http://localhost:3000/api/internal/widget/<widget-id>/config

# A newly-issued admin key authenticates against an admin API route:
curl -H "X-Api-Key: <new-admin-sk-key>" http://localhost:3000/api/internal/widget/<widget-id>/config

# The audit reports the migration as destructive (the SCALE-03 exception):
pnpm audit:migrations
grep "api_keys_key_hash_hmac" docs/MIGRATION_AUDIT.md
# → 20260827120000_api_keys_key_hash_hmac | 2026-08-27 | destructive | DROP COLUMN, DELETE
```

## Env Var Reference

| Variable | Required | Purpose | Generation / format |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `API_KEY_HMAC_SECRET` | yes | HMAC-SHA256 signing secret for API-key digests (base64-encoded, exactly 32 raw bytes). | `openssl rand -base64 32` |
| `WIDGET_API_KEY` | yes\* | The raw widget service key (sent as `X-Api-Key`). Unchanged by this migration — only the `api_keys` row's hash column changes. \*Required when the widget is enabled. | Existing value — do NOT rotate it as part of this runbook. |
| `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` | CI only | Unlocks CI's `migration-safety-check` job for the destructive migration. Set as a GitHub repo **Variable** (not a Secret — it must be readable by the workflow). | `yes` / `1` / `true` |

Validation of `API_KEY_HMAC_SECRET` is performed at the consumption site in
`packages/server/src/services/apiKeyService.ts` (NOT in `config/env.ts`),
mirroring the existing `ENCRYPTION_KEY` pattern. An invalid entry (not
exactly 32 bytes after base64 decode) throws with the
`openssl rand -base64 32` hint before any key operation runs; the server
returns 500 (fail-loud, not 401).

## Related documents

- `docs/MIGRATION_SAFETY.md:93` — case #2 ("Schema refactor with explicit
consent"), the precedent this migration cites.
- `docs/MIGRATION_AUDIT.md` — the regenerated audit report; the
`20260827120000_api_keys_key_hash_hmac` migration is listed as
`destructive` (the SCALE-03 exception). CI drift-checks this file.
- `docs/ENCRYPTION_KEY_ROTATION.md` — the sibling operator runbook for
`ENCRYPTION_KEY` rotation; this runbook mirrors its structure (operator
surface, pre-upgrade checklist, step-by-step, rollback note).
- `.planning/milestones/v1.4-phases/163-keyed-hmac-api-keys/163-CONTEXT.md` — the locked
decisions (D-01 secret choice, D-02 drop-and-recreate, D-03 prefix kept,
D-04 widget re-seed) that this runbook operationalizes.