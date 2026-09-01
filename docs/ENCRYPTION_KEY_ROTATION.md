# ENCRYPTION_KEY Rotation Runbook

Operator runbook for rotating the at-rest encryption key (AES-256-GCM, 32-byte)
on a running Simmetric Chat deployment **without bricking any encrypted blob** and
**with a documented rollback**. Closes OPS-04 of v0.14 milestone phase 83
("ENCRYPTION_KEY rotation tooling — HEADLINE").

> **Boot hard-default (, 2026-08-27):** The server now FAILS LOUD at boot (`logger.error` + `process.exit(1)`) when `ENCRYPTION_KEY` is unset in production (`NODE_ENV=production`). It no longer boots with the legacy `scryptSync(JWT_SECRET)` fallback in production — that fallback couples data-at-rest encryption key rotation to JWT_SECRET rotation (rotating JWT_SECRET would silently invalidate every encrypted blob). The failure message names `ENCRYPTION_KEY`, shows `openssl rand -base64 32`, and points operators to this runbook. Dev/test (`NODE_ENV !== "production"`) preserves the scrypt fallback for convenience. This escalates the advisory `logger.warn` (2026-08-26) to a hard failure — see the " hard-default cutover" section below for the pre-upgrade checklist.

This runbook is the **only operator surface** for key rotation. The rotation
and verification tools are CLI-only (`tsx`-run from the operator's shell) and
are deliberately **NOT mounted on any HTTP route** — there is no network path
to key material mutation. Verified by
`grep -rn "rotate-encryption-key\|verify-encryption-key" packages/server/src/index.ts packages/server/src/routes`
returning 0 matches.

## hard-default cutover

**Before upgrading to the build**, an operator running production
without `ENCRYPTION_KEY` set MUST complete the following pre-upgrade checklist.
The build refuses to boot in production (`NODE_ENV=production`)
without `ENCRYPTION_KEY` — there is **no grace-period flag** (a flag would
silently fail-open, defeating the security contract; see D-04). If you skip
this checklist, the server will `process.exit(1)` at boot with an actionable
message naming `ENCRYPTION_KEY` and pointing here.

1. **Generate a new key:**
```bash
openssl rand -base64 32
```
The output is a base64-encoded 32-byte key — the exact format the server
validates at the consumption site (`encryptionService.ts`).

2. **Set `ENCRYPTION_KEY` and (if rotating from a previous explicit key)
`LEGACY_PREVIOUS_ENCRYPTION_KEYS` in the root `.env`:**
```bash
ENCRYPTION_KEY=<new-key-from-step-1>
LEGACY_PREVIOUS_ENCRYPTION_KEYS=<old-explicit-key> # only if you had one
```
If this is your first time setting `ENCRYPTION_KEY` (you were on the scrypt
fallback), you do NOT need `LEGACY_PREVIOUS_ENCRYPTION_KEYS` — the decrypt
chain keeps the scrypt tail so pre-override ciphertexts stay decryptable
.

3. **Run the rotation CLI to re-encrypt existing blobs** (providers.apiKey,
backup_destinations.config, sso_configs.clientSecretEncrypted) to the new
key:
```bash
pnpm --filter server rotate-encryption-key
```
The CLI is idempotent + resumable (`--resume` after an interruption). It
walks the sweep registry and re-encrypts every row with the current
`ENCRYPTION_KEY`, keeping the old key(s) in the decrypt chain via
`LEGACY_PREVIOUS_ENCRYPTION_KEYS`.

4. **Run the verification CLI until the output shows
`below_active = 0` AND `undecryptable = 0`:**
```bash
pnpm --filter server verify-encryption-key
```
Exit code 0 means all blobs are on the new key and none are undecryptable.
If `below_active > 0`, re-run `rotate-encryption-key --resume` (the sweep
was likely interrupted). If `undecryptable > 0`, inspect the reported
`{table, id, error}` rows and resolve the root cause before retrying. Do
NOT proceed to step 5 until both are 0.

5. **Upgrade to the build.** The server will refuse to boot in
production without `ENCRYPTION_KEY` set — there is no grace-period flag
(D-04: a flag would silently fail-open, defeating the security contract).
With `ENCRYPTION_KEY` set and the rotation complete, the server boots
normally using the explicit key.

**Mixed-key state during rotation is supported:** after step 3 (before
`below_active = 0`), the database contains a mix of old-key and new-key
ciphertexts. The decrypt chain (`getDecryptKeyChain()`) includes the current
key + previous keys + the scrypt tail, so all blobs decrypt regardless of
which key encrypted them. This is the documented, supported state — NOT a
failure.

**Docker / Compose deployments.** Fresh Compose deployments can skip
steps 1–3 and let the server entrypoint auto-generate + persist the key:
when `ENCRYPTION_KEY` is unset, the entrypoint provisions it once on
production boot and stores it at `/app/storage/.encryption-key` inside the
`server-storage` volume (reused on every restart/rebuild; the first boot
logs a loud warning to back the file up — back it up with
`docker cp simmetric-chat-server:/app/storage/.encryption-key .`). To
pre-seed an explicit key instead, add `ENCRYPTION_KEY` to the repo-root
`.env` — Compose injects it into the server container via `env_file`. Do
NOT add a compose `environment:` passthrough like
`- ENCRYPTION_KEY=${ENCRYPTION_KEY:-}`: shell interpolation resolves to
`""` and overrides `env_file` (same trap documented for `LICENSE_KEY` in
`docker/docker-compose.yml`). Existing pre-162 Compose deployments follow
the standard checklist above — their scrypt-era blobs stay decryptable via
the decrypt-chain tail after the cutover . One more caveat: let
provisioning complete once before scaling the `server` service beyond one
replica (concurrent first-boot replicas could each generate a divergent
key).

## Scope

**In scope (the 2-column sweep registry — `providers.apiKey` and
`backup_destinations.config`). These are NOT the only encrypted columns in
the schema: `sso_configs.clientSecretEncrypted` is also encrypted via
`ctx.encrypt()` — delegated to the core `encryptionService` via the PluginContext (`simmetric-enterprise/src/services/ssoService.ts:175`)
and decrypted in `simmetric-enterprise/src/routes/oidc.ts` and
`simmetric-enterprise/src/services/samlStrategy.ts`, but it is excluded from the
sweep registry:**

| Table | Column | Soft-deletable? | Sweep behavior |
| ---------------------- | ---------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `providers` | `apiKey` | NO (no `deletedAt` field) | All rows visited. |
| `backup_destinations` | `config` | YES (`deletedAt DateTime?`) | All rows visited, **including `deletedAt IS NOT NULL`** (soft-deleted tombstones still brick a restore if the old key is removed). |

`backup_destinations.config` is encrypted via
`simmetric-enterprise/src/services/backup/backupEncryption.ts` (`encryptConfig` /
`decryptConfig`), which wraps `encryptionService.encrypt` / `decrypt`.

**Out of scope (NOT encrypted — do NOT attempt to re-encrypt):**

- `system_config` — all values are stored as plaintext strings; no
`encrypt()` / `decrypt()` call touches any `SystemConfig` row.
- `mcp_connections.headers` — plaintext `JSON.stringify` output, read via
`JSON.parse`. No `encrypt()`.

Claiming or sweeping either of the above would call `decrypt()` on plaintext
and abort fail-closed on every row (see Pitfall 2 in the static-registry
comments of `packages/server/scripts/rotate-encryption-key.ts` and
`packages/server/scripts/verify-encryption-key.ts`). The rotation and
verification CLIs hard-code the 2-column
registry above; they do NOT runtime-`grep encrypt(`.

## Pre-requisites

- Node.js >= 24, pnpm 11.x, a running PostgreSQL 16 instance.
- Operator shell access on the server host (the CLIs are not exposed over HTTP).
- A freshly generated **new** `ENCRYPTION_KEY`:

```bash
openssl rand -base64 32
```

This emits a base64 string that decodes to exactly 32 bytes — the only
accepted shape (validated at the consumption site in
`encryptionService.ts`).

- The **current** `ENCRYPTION_KEY` value (the one already in
the root `.env`). After rotation this becomes the first entry in
`LEGACY_PREVIOUS_ENCRYPTION_KEYS` so the multi-key decrypt chain can still
read any blob that has not yet been re-encrypted (or that you rolled back
to).

- `JWT_SECRET` must remain set throughout v0.14 — it is the scrypt fallback
key for the oldest pre-override ciphertexts (see "Post-verification
(deferred)" below; scrypt removal is a SEPARATE post-v0.14 release, NOT
this milestone).

## Strict Deploy Order

> **WARNING — load-bearing ordering invariant (Pitfall 1, HIGHEST RISK).**
> Skipping or reordering step 2 relative to step 4 bricks encrypted blobs
> mid-sweep: a row re-encrypted with the new key cannot be decrypted by a
> server that has not been restarted with the new key chain. Follow the
> numbered order exactly.

1. **Deploy the multi-key v2 layer (Plan 01 code change).**
Ship / pull the build that contains the `getDecryptKeyChain()` extension
to `packages/server/src/services/encryptionService.ts`. No env change
yet — the server continues to run on the current single key.

2. **Restart the server with `LEGACY_PREVIOUS_ENCRYPTION_KEYS` set.**
In the root `.env`:
- set `ENCRYPTION_KEY=<new key base64>`,
- set `LEGACY_PREVIOUS_ENCRYPTION_KEYS=<old key base64>` (the previous
current key; comma-separated if there is more than one historical key
you want the chain to recognise),
- keep `JWT_SECRET` as-is (scrypt fallback stays available).

Restart the server process. Confirm in the logs that:

- the server boots cleanly (no `Unable to decrypt` errors),
- existing Provider API keys still resolve (`/api/providers` returns the
configured providers with their keys intact),
- existing `BackupDestination` configs still decrypt (the Backup
admin page loads without errors).

At this point the running server can read ciphertexts encrypted with
either the new key or any previous key in the chain. **No rows have been
re-encrypted yet** — `LEGACY_PREVIOUS_ENCRYPTION_KEYS` is the safety net
that makes the next steps reversible.

3. **Run a dry-run of the rotation CLI (no writes).**
```bash
pnpm --filter server rotate-encryption-key -- --dry-run
```
This walks the 2-column sweep registry, decrypts each row with the chain,
and reports what would change. No rows are written. Review the summary
(`visited` / `skipped` / `reEncrypted` / `legacyDetected` counts per
column). Active rows are folded into `skipped`; in dry-run mode
`legacyDetected` is the count of rows that would be re-encrypted and
`reEncrypted` stays 0. There is no `undecryptable` count: the CLI
aborts fail-closed on the first row it cannot decrypt with the full
chain (see "Failure modes").

4. **Run the rotation CLI (full sweep).**
```bash
pnpm --filter server rotate-encryption-key
```
For each row: decrypt with the chain → if the row is already `active`
(decrypts with the new key only) skip it (idempotent) → otherwise
re-encrypt with `chain[0]` (the new key) inside a per-row
`prisma.$transaction` so a mid-row crash leaves the row either fully old
or fully new. Progress is checkpointed to `system_config` under the key
`encryption_key_rotation_progress` (a JSON marker with
`fromKeyFingerprint` / `toKeyFingerprint` / `lastTable` / `lastId` /
`status`). Fingerprints are the first 8 hex chars of `sha256(key)` — the
marker never stores the key itself.

**On interruption:** re-run with `--resume`:
```bash
pnpm --filter server rotate-encryption-key -- --resume
```
The CLI reads the marker and continues from `lastTable` / `lastId`. A
marker whose `toKeyFingerprint` does not match the current
`ENCRYPTION_KEY` is ignored (it belongs to a different rotation).

5. **Run the verification pass. Gate: `below_active = 0`.**
```bash
pnpm --filter server verify-encryption-key
```
The pass is read-only (`findMany` + in-process classify; no
`$transaction`, no `update`). It reports, per column and in total:
`active` (decrypts with the new key only), `legacy` (needs a
previous / scrypt key), and `undecryptable`. The acceptance gate is:

- **`below_active = 0`** (i.e. `legacy === 0`), AND
- `undecryptable === 0`.

The script exits `0` on pass and `1` on failure (CI / operator
scriptable). For machine-readable output:
```bash
pnpm --filter server verify-encryption-key -- --json
```

**If `below_active > 0` or `undecryptable > 0`: do NOT remove the old
key from `LEGACY_PREVIOUS_ENCRYPTION_KEYS`.** Investigate: re-run the
rotation with `--resume` (a row may have been missed because the sweep
was interrupted), or inspect the `{table, id, error}` reported by the
fail-closed abort. The old key in the chain is what keeps `legacy` rows
readable — removing it before `below_active = 0` would brick them.

The verify pass also doubles as a **pre-rotation audit**: running it
before step 3 classifies the fleet as it stands today (all rows will be
`legacy` or `active` relative to the current chain) and surfaces any
pre-existing `undecryptable` row that would block the sweep.

## Rollback

If the rotation fails, is aborted, or needs to be undone for any reason
before the old key is removed from `LEGACY_PREVIOUS_ENCRYPTION_KEYS`:

1. Restore the **old** `ENCRYPTION_KEY` value in the root `.env`
(the value that was current before step 2).
2. Keep `LEGACY_PREVIOUS_ENCRYPTION_KEYS` as-is (or clear it — both are
safe; see rationale below).
3. Restart the server.

The multi-key decrypt layer tries keys in order: **current → previous →
scrypt**. Restoring the old key as `current` makes every blob decryptable
again, because:

- rows the sweep already re-encrypted with the new key decrypt via the
previous-key entries in `LEGACY_PREVIOUS_ENCRYPTION_KEYS` (the new key is
now in the chain tail),
- rows the sweep never reached still decrypt with the restored current key
directly,
- pre-override scrypt blobs still decrypt via the `JWT_SECRET` fallback.

**No data loss occurs as long as rollback is performed before removing the
old key from `LEGACY_PREVIOUS_ENCRYPTION_KEYS`.** This is why the old key
MUST stay in the chain until `below_active = 0` is sustained (see below).

## Post-verification (deferred — NOT part of v0.14)

The following two removals are **deliberately deferred to a SEPARATE
post-v0.14 release** and MUST NOT be performed as part of this milestone:

1. **Removing the old key from `LEGACY_PREVIOUS_ENCRYPTION_KEYS`.**
2. **Removing the scrypt (`JWT_SECRET`) fallback.**

Both are gated on: **`below_active = 0` sustained across verification
passes + >= 1 week of clean prod logs** with no `Unable to decrypt` errors.

> ** cross-reference:** removed scrypt from the ENCRYPT
> path — production `getEncryptionKey()` throws before reaching
> `scryptSync(JWT_SECRET)` . Removing scrypt from the DECRYPT chain
> (`getDecryptKeyChain()` tail) remains deferred per the same gate below.
> Scrypt stays as the decrypt tail so pre-override ciphertexts remain
> decryptable until the rotation CLI re-encrypts them AND `below_active = 0`
> is sustained.

Scrypt removal is a SEPARATE post-v0.14 release, NOT this milestone.
Performing either removal prematurely bricks any `legacy` or scrypt-only
blob that the verification pass missed (e.g. a tombstoned
`backup_destinations` row, a row written by a concurrent process during
the sweep, or a pre-override blob on a legacy install).

v0.14 ships the rotation tooling + the runbook + the `below_active = 0`
gate. The removal is a follow-up release that depends on the gate holding
in production.

## Failure Modes

**Fail-closed on an undecryptable row.** If the rotation CLI encounters a
row whose ciphertext cannot be decrypted with any key in the chain
(current + previous + scrypt), it aborts the sweep immediately with a
structured error:

```
Fail-closed: cannot decrypt <table>.id=<id> with any key in chain
{ table, id, error }
```

No silent skip, no partial corruption. Rows already re-encrypted in
previous transactions stay re-encrypted — this is safe because the
multi-key chain still has the old key (via
`LEGACY_PREVIOUS_ENCRYPTION_KEYS`) and can read both old and new
ciphertexts.

**Resume procedure.** After addressing the undecryptable row (e.g. by
adding the missing historical key to `LEGACY_PREVIOUS_ENCRYPTION_KEYS` and
restarting, or by deleting the corrupt row if it is genuinely garbage),
re-run:

```bash
pnpm --filter server rotate-encryption-key -- --resume
```

The CLI reads the `encryption_key_rotation_progress` marker from
`system_config` and skips the already-completed tables / rows. A marker
whose `toKeyFingerprint` does not match the current `ENCRYPTION_KEY` is
ignored — it belongs to a different rotation attempt.

**Interrupted sweep.** A crash or `SIGINT` mid-sweep leaves each
in-flight row either fully-old or fully-new (per-row
`prisma.$transaction`). Re-run with `--resume` to continue from the
marker.

**`below_active > 0` after a full sweep.** The verification pass reports
`legacy > 0`. Do NOT remove the old key. Re-run the rotation with
`--resume` (the sweep was likely interrupted); if `undecryptable > 0`,
inspect the reported `{table, id, error}` and resolve the root cause
before retrying.

## Env Var Reference

| Variable | Required | Purpose | Generation / format |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ENCRYPTION_KEY` | yes | Current / new at-rest encryption key (base64-encoded, exactly 32 raw bytes). | `openssl rand -base64 32` |
| `LEGACY_PREVIOUS_ENCRYPTION_KEYS` | no\* | Previous keys, comma-separated, that the multi-key decrypt chain will try after the current key. \*Required for rotation. | One or more base64 32-byte values, each generated with `openssl rand -base64 32`, joined by `,`. |
| `JWT_SECRET` | yes | Auth token secret + scrypt fallback key for pre-override ciphertexts. Kept through v0.14. | Existing value — do NOT rotate it as part of this runbook. |

Validation is performed at the consumption site in
`packages/server/src/services/encryptionService.ts` (NOT in
`config/env.ts`), mirroring the existing `ENCRYPTION_KEY` pattern. An
invalid entry (not exactly 32 bytes after base64 decode) throws with the
`openssl rand -base64 32` hint before any sweep runs.

## CLI Quick Reference

```bash
# 1. Dry-run (no writes) — reports what would change
pnpm --filter server rotate-encryption-key -- --dry-run

# 2. Full sweep — re-encrypts every legacy row, idempotent + resumable
pnpm --filter server rotate-encryption-key

# 3. Resume from the progress marker after an interruption / fail-closed abort
pnpm --filter server rotate-encryption-key -- --resume

# 4. Verify — gate: below_active = 0 && undecryptable = 0 (exit 0 on pass, 1 on fail)
pnpm --filter server verify-encryption-key

# 5. Verify, machine-readable (single-line JSON to stdout)
pnpm --filter server verify-encryption-key -- --json
```

Both CLIs are tsx-run from `packages/server/scripts/` and are NOT mounted
on any Express route. There is no HTTP surface for key rotation.