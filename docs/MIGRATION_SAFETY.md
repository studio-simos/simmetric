# Migration & Restore Safety

Cross-phase reference for destructive operations in Simmetric Chat. This document
is the single source of truth for what "safe" means when migrating data or
restoring from a backup.

## Scope

- **Prisma migrations** — additive vs. destructive, audit requirements (SEED-01..03, )
- **Backup lifecycle** — retention, encryption, integrity (, 54)
- **Restore lifecycle** — safety net, rollback semantics (, this section)

## Migration Safety

> codifies the migration safety pattern. Migrations MUST be additive
> by default. Destructive operations are blocked at PR time by the
> `migration-safety-check` CI job unless explicitly consented via the
> `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` environment variable.

### Additive Patterns (Preferred)

- **Add new table** — `CREATE TABLE` only, no migrations of existing tables' shapes.
- **Add column with default** — two-step pattern required for `NOT NULL` columns:
```sql
-- Step 1: add nullable
ALTER TABLE "users" ADD COLUMN "textSize" TEXT;
-- Step 2 (later migration, after deploy): set NOT NULL
ALTER TABLE "users" ALTER COLUMN "textSize" SET NOT NULL;
```
Verified pattern in `00000000000000_init/migration.sql:33` (`"textSize" TEXT` in `CREATE TABLE "users"`).
- **Add index** — use `CREATE INDEX` (non-concurrent is fine for small tables;
for tables > 1M rows use `CREATE INDEX CONCURRENTLY` via raw migration).
- **Add constraint** — `ADD CONSTRAINT` only, never drop + re-add.
- **Alter default value** — `ALTER COLUMN ... SET DEFAULT ...` (Prisma idiom, safe).

### Anti-Patterns (Require Explicit Consent)

- `DROP TABLE` — data loss is irreversible without a backup.
- `DROP COLUMN` — data loss for that column is irreversible.
- `TRUNCATE` — full-table data wipe, even with `WHERE` not supported.
- `ALTER TABLE ... DROP <not-column-not-constraint-not-default-not-index>` —
catches future PostgreSQL extensions (e.g., `DROP PARTITION`).
- `DELETE FROM <table>` — full-table data wipe via raw DELETE (e.g., backfill
or GDPR-style deletion). Use a `WHERE` clause and audit-log every row-level
delete; never issue a `DELETE FROM` without a filter in a migration.

Safe Prisma idioms that LOOK destructive but are NOT flagged by the audit:
- `ALTER TABLE ... DROP CONSTRAINT ..._fkey` — Prisma drops + re-adds a foreign
key with different `ON DELETE` semantics. Data is unaffected.
- `DROP INDEX` — Prisma re-creates the index with a different definition.
Index metadata only, not data.
- `ALTER COLUMN ... DROP DEFAULT` — removes a default expression. Column
and data are unaffected.
Verified: see `00000000000000_init/migration.sql:791,1176,1179,1182` (the baseline — `"embedding" vector(384) NOT NULL` in `CREATE TABLE "memories"` plus the re-added `memories_*_fkey` constraints; the former `20260728132302_simone` migration was squashed into this baseline) and
`00000000000000_init/migration.sql:33`.

### Worked Example: `ADD COLUMN ... NOT NULL` on a Populated Table

When adding a `NOT NULL` column to a table that already has rows, PostgreSQL
requires the two-step pattern split across two migrations.

Good (two-step, deployable on populated tables):

```sql
-- Migration 1: nullable add + backfill
ALTER TABLE "users" ADD COLUMN "locale" TEXT;
UPDATE "users" SET "locale" = 'en' WHERE "locale" IS NULL;
-- Migration 2 (after first deploy): enforce NOT NULL
ALTER TABLE "users" ALTER COLUMN "locale" SET NOT NULL;
```

Bad (single migration, breaks on populated tables):

```sql
ALTER TABLE "users" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';
```

The bad form fails on populated tables because PostgreSQL applies the new
column to existing rows in the same ALTER and rejects the operation when
the default expression is not literal-safe. The two-step pattern defers
`NOT NULL` to a follow-up migration that runs after the first has been
deployed and backfilled. This is the only safe way to add a required
column to a non-empty table.

## When Destructive is OK

Destructive Prisma migrations are acceptable only in the 4 cases below. All
other cases require an alternative design (additive, two-phase, or shadow table).

| # | Case | Required Action |
|---|------|-----------------|
| 1 | **Rollback of an erroneous change** — fix a wrong migration that was just merged | Hotfix PR with a `DROP`/`TRUNCATE` reversing the prior change. Tag both migrations in the PR description. |
| 2 | **Schema refactor with explicit consent** — e.g., rename a column, split a table | PR with at least one maintainer approval AND a runbook published in `docs/` describing the backfill/migration plan. |
| 3 | **Full reset for local/CI setup** — `prisma migrate reset` against a throwaway DB | Requires `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes"` (or `"1"` / `"true"`) in the runtime environment. Never set in production. |
| 4 | **GDPR / right-to-be-forgotten** — delete a user's personal data on request | `DELETE` statement with user-id filter, plus an audit log entry recording the deletion (timestamp, user ID, operator). The audit log is the source of truth that the request was honored. |

For cases 1, 2, and 4, set the consent env var on the CI workflow
(see `## Tooling`) so the `migration-safety-check` job passes. For case 3,
the consent is read at the script invocation time, not at PR time.

## Developer Checklist

Before merging a PR that touches `packages/server/prisma/schema.prisma` or
`packages/server/prisma/migrations/`:

1. [ ] Run `pnpm db:migrate` locally and verify the generated `migration.sql`.
2. [ ] Verify the new SQL is additive: no `DROP TABLE`, no `DROP COLUMN`, no
`TRUNCATE`, no destructive `ALTER TABLE ... DROP`, and no `DELETE FROM`
(without a `WHERE` filter that targets a known row set). If any of these
appear, this checklist triggers a handoff to the cases in
`## When Destructive is OK`.
3. [ ] For `NOT NULL` columns added to a table with existing rows, confirm the
two-step pattern (nullable add → backfill → `SET NOT NULL`) is split across
at least two migrations.
4. [ ] Run `pnpm audit:migrations` and confirm `docs/MIGRATION_AUDIT.md` shows
the new migration as `additive` with `Operations: none`. Commit the updated
markdown in the same PR.
5. [ ] For `CREATE INDEX` on tables with > 1M rows, use
`CREATE INDEX CONCURRENTLY` (Prisma 7 supports this via the `migration.sql`
escape hatch when you need a zero-downtime index build).
6. [ ] For `FOREIGN KEY` changes, prefer `ADD CONSTRAINT` over
`DROP CONSTRAINT + ADD CONSTRAINT` — the latter is a destructive pattern
that requires explicit consent.
7. [ ] Confirm CI passes the `migration-safety-check` job. If the job fails
with a destructive-detection error, set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`
in the workflow env (only after the PR has explicit maintainer approval).
8. [ ] Verified no `TRUNCATE` on user-data tables (`users`, `documents`,
`chat_messages`, `workspaces`, `projects`). `TRUNCATE` is allowed only
for ephemeral/cache tables (e.g., `event_logs` after retention export).

## Tooling

- **Local audit script** — `pnpm audit:migrations` runs
`packages/server/scripts/audit-migrations.ts` and produces
`docs/MIGRATION_AUDIT.md` (committed) and `.migration-audit.json`
(gitignored sidecar, regenerated each run).
- **CI check** — the `migration-safety-check` job in
`.github/workflows/ci.yml` runs the same script on every PR. The job exits
0 when no destructive migrations are detected. When destructive migrations
are detected, the job exits 1 unless the workflow env var
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` is set to one of `yes`, `1`,
or `true` (case-insensitive, whitespace-trimmed). See the CI workflow
comments for the exact bash conditional.
- **Audit report** — `docs/MIGRATION_AUDIT.md` is the human-readable artifact.
Update it as part of the same PR that introduces the migration. The report
includes a per-migration table (Migration | Date | Type | Operations) and
a one-line summary (Total / Additive / Destructive counts).
- **This document** — `docs/MIGRATION_SAFETY.md` is the single source of truth
for what "safe" means. Update it in the same PR as any policy change.

#### Why these 3 consent values (`yes` / `1` / `true`)

The accepted values mirror the conventions used by Prisma's own tooling
(verified: `packages/server/jest.globalSetup.js:44-49` sets `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes"` for `prisma migrate deploy` on the template test DB). Adding `1` and `true` covers the common boolean idioms operators paste into CI variable UIs.
The check is case-insensitive and whitespace-trimmed so accidental
leading/trailing spaces from the GitHub UI do not silently fail the gate.
Anything outside this set (including empty string and `"y"`) is treated as "consent not granted" and the job fails with a clear `::error::` annotation. Note that `"YES "` with a trailing space IS granted — `isConsentGranted()` in `packages/server/scripts/migrate-guard.ts:86` and `packages/server/scripts/migrate-reset-guard.ts:41` apply `.trim().toLowerCase()`, and the CI gate (`ci.yml:197`) trims via `xargs`, so `"YES "` becomes `"yes"`.

## Wrapper Scripts

Local pre-deploy guards that complement the CI gate — operators get a pre-apply
safety net before `prisma migrate deploy` and a consent gate before
`prisma migrate reset`. The wrappers are **additive** : the underlying
Prisma commands can still be called directly. The wrappers are guardrails, not
hard blocks — an operator who understands the risk can bypass them via the
override path documented below.

### db:migrate:guard

- **Command:** `pnpm db:migrate:guard` (or `pnpm --filter server db:migrate:guard`)
- **What it does:** Queries the `_prisma_migrations` table for the applied
migration set, diffs against the on-disk migration directories, classifies
each *pending* migration's `migration.sql` via the existing
`classifyMigration()` engine from `audit-migrations.ts` (5-pattern regex:
`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER TABLE ... DROP`, `DELETE FROM`),
and refuses to delegate if any pending migration is destructive (exit 1).
When all pending migrations are additive, it delegates to
`prisma migrate deploy` via `execFileSync` (array args, no shell).
- **Override path :** Set
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes` (or `1` / `true`,
case-insensitive, trimmed) in the environment. The guard logs a warning
(`[migrate-guard] CONSENT GRANTED — proceeding with N destructive
migration(s). Data loss possible.`) and proceeds to `prisma migrate deploy`.
This is the **same** env var used by the CI gate and `jest.globalSetup.js` —
no new consent mechanism.
- **When to use:** Before any `prisma migrate deploy` in production or shared
environments. Replaces direct `prisma migrate deploy` for safety. The
existing `pnpm db:migrate` (`prisma migrate dev`, interactive) is unchanged
and remains the dev-loop command.

### db:migrate:reset:guard

- **Command:** `pnpm db:migrate:reset:guard` (or
`pnpm db:migrate:reset:guard --force-accept-data-loss`)
- **What it does:** Checks for the `PRISMA_MIGRATE_RESET_CONFIRM` env var OR
the `--force-accept-data-loss` CLI flag (parsed via `commander`). Without
either, it refuses with exit 1 and a data-loss warning. With either, it
delegates to `prisma migrate reset` (passing
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes` in the child env so Prisma's
own prompt doesn't block).
- **Env var:** `PRISMA_MIGRATE_RESET_CONFIRM=yes` (or `1` / `true`,
case-insensitive, trimmed). This is a **separate** env var from the deploy
guard override — see [Env Var Reference](#env-var-reference) below. `migrate
reset` drops the entire database, which is a different level of danger than a
single destructive migration.
- **CLI flag:** `--force-accept-data-loss` (via `commander`, same effect as the
env var).
- **When to use:** Instead of direct `prisma migrate reset`. **Never in
production.** The reset guard is for local/CI throwaway databases (case 3
below).

### Override Runbook for Genuinely-Needed Destructive Migrations

The 4 acceptable cases for destructive migrations are defined in
[`## When Destructive is OK`](#when-destructive-is-ok) above. This section
gives the exact command sequence for each case using the wrappers.

| # | Case | Command |
|---|------|---------|
| 1 | **Rollback of an erroneous change** — hotfix reversing a just-merged wrong migration | `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes pnpm db:migrate:guard` |
| 2 | **Schema refactor with explicit consent** — rename a column, split a table | `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes pnpm db:migrate:guard` (requires ≥1 maintainer approval AND a runbook published in `docs/`) |
| 3 | **Full reset for local/CI setup** — throwaway DB | `PRISMA_MIGRATE_RESET_CONFIRM=yes pnpm db:migrate:reset:guard` (or `pnpm db:migrate:reset:guard --force-accept-data-loss`) |
| 4 | **GDPR / right-to-be-forgotten** — delete a user's personal data | `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes pnpm db:migrate:guard` (the `DELETE FROM <table> WHERE <filter>` is classified destructive by the 5-pattern regex — use the deploy guard override) |

> **Note (D-01, T-102-04):** The wrapper is additive. `prisma migrate deploy`
> and `prisma migrate reset` can still be called directly. The wrapper is a
> guardrail, not a hard block. Operators who bypass the wrapper entirely are
> responsible for the consequences — the CI gate (`migration-safety-check`
> job) remains the PR-time backstop.

### Env Var Reference

Two distinct consent env vars exist. Setting one does **not** satisfy the
other (Pitfall 5 — operator confusion from similar names).

| Env Var | Used By | Purpose | Accepted Values |
|---------|---------|---------|-----------------|
| `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` | `db:migrate:guard` (override) + CI gate (`migration-safety-check` job) + `jest.globalSetup.js` | Allow destructive migrations through the deploy guard / CI gate / test reset | `yes` / `1` / `true` (case-insensitive, whitespace-trimmed) |
| `PRISMA_MIGRATE_RESET_CONFIRM` | `db:migrate:reset:guard` only | Allow `prisma migrate reset` through the reset guard | `yes` / `1` / `true` (case-insensitive, whitespace-trimmed) |

Common mistake: setting `PRISMA_MIGRATE_RESET_CONFIRM=yes` and expecting
`db:migrate:guard` to allow a destructive migration through — it won't. That
requires `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes`. The two gates are
intentionally separate (D-02 vs D-03): `migrate reset` drops the entire
database, while a destructive migration drops specific tables/columns.


## Re-baseline Runbook

> When the 25-migration chain was squashed into a single
> `00000000000000_init` baseline, already-deployed databases
> (production, staging, shared dev) still carry the 25 old rows in their
> `_prisma_migrations` table. This runbook reconciles those DBs to the
> squashed baseline **without data loss**. Fresh DBs are unaffected — they
> get the squashed baseline directly via `prisma migrate deploy`.

### Pre-flight (mandatory)

Back up the deployed DB before any reconciliation. The data backup is the
rollback path if the squash is rejected.

```bash
pg_dump --schema-only --no-owner <DATABASE_URL> > /tmp/schema-backup.sql
pg_dump --data-only --no-owner <DATABASE_URL> > /tmp/data-backup.sql
```

### Step 1 — Mark the squashed baseline as applied

```bash
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes \
npx prisma migrate resolve --applied 00000000000000_init
```

This inserts a row into `_prisma_migrations` with the correct checksum
(computed by Prisma from `migration.sql` content) **WITHOUT running the
migration SQL** (the schema is already there). Per Prisma's design,
`migrate resolve` is metadata-only — it does NOT execute migration SQL.

**D-02 AMENDMENT NOTE (REQUIRED manual step follows):** because
`migrate resolve --applied` by design does NOT execute migration SQL, the
backfill UPDATE in the baseline `migration.sql`
(`UPDATE "archive_pages" SET "searchVector" = ... WHERE ...`) does NOT run
on the deployed DB via this path. The operator MUST perform the manual
backfill step (Step 3 below). This is an explicit deviation from D-02's
"gets the backfill in the same migration" wording — surfaced and
re-acknowledged before execution.

### Step 2 — Clean up old _prisma_migrations rows

`migrate resolve` does NOT delete old rows. Remove the 24 old
`_prisma_migrations` rows manually:

```bash
psql <DATABASE_URL> -c "DELETE FROM _prisma_migrations WHERE migration_name != '00000000000000_init';"
```

After this, `_prisma_migrations` has exactly 1 row.

### Step 3 — Backfill searchVector on existing rows (REQUIRED manual step — D-02 amendment)

The squashed baseline's backfill UPDATE only runs on `migrate deploy`
(fresh DBs — no-op on zero rows). For deployed DBs where
`migrate resolve --applied` skipped the SQL, run the backfill manually:

```bash
psql <DATABASE_URL> -c 'UPDATE "archive_pages" SET "searchVector" = to_tsvector(\'english\', "bodyText") WHERE "deletedAt" IS NULL AND "searchVector" IS NULL;'
```

This is idempotent (the `WHERE "searchVector" IS NULL` guard skips rows
already backfilled) — safe to run multiple times. **Skipping this step
leaves `archive_pages.searchVector` NULL on pre-existing rows — full-text
search will not find them. This step is REQUIRED, not optional.**

### Step 4 — Verify

```bash
npx prisma migrate status
```

Reports no pending migrations and no drift. Confirm:

```bash
psql <DATABASE_URL> -c 'SELECT count(*) FROM _prisma_migrations;'
```

Returns `1`.

### Data-preservation guarantee

The squash produces the same schema as the 25-migration chain (verified via
`prisma migrate diff --from-config-datasource --to-schema` in —
zero diff). No columns or tables are added/removed/renamed. Business data
(users, chats, documents, workspaces, etc.) is untouched — only the
`_prisma_migrations` metadata table is reconciled.

### Rollback path (if the squash is rejected)

Restore from the pre-flight backup:

```bash
psql --single-transaction -f /tmp/schema-backup.sql <DATABASE_URL>
psql -f /tmp/data-backup.sql <DATABASE_URL>
```

Then revert the code to the pre-squash commit (the 25 old migration folders
are restored via `git revert`). The `_prisma_migrations` table is restored
to its 24-row state from the schema backup.

### When to use

Any deployed DB (production, staging, shared dev) that has the 25-migration
history and needs to be reconciled to the squashed baseline. Not needed for
fresh DBs (they get the squashed baseline directly via `migrate deploy`).


## Restore Safety

> introduces the restore flow. The safety semantics below are
> non-negotiable: every restore either succeeds in full, or rolls back in
> full (within the limits of the rollback capability).

### Safety Backup

Before any restore is applied, a safety backup of the current state is created
automatically. The safety backup is a full backup (DB dump + file copy) using
the same pipeline as a regular backup.

- **Location:** `storage/backups/pre-restore-safety/{safetyId}.zip`
- **Retention:** local only, manual cleanup. Cleanup automation is a TODO.
- **Mandatory:** if the safety backup fails, the restore is aborted and
`executeRestore` returns `{ status: "failed", error }` with the underlying
error message . The failure is caught inside `executeRestore`
(`restoreService.ts:523-562`), so the route returns the result body as-is
(`restore.ts:220`) rather than HTTP 500; `restoreService.ts:559` returns
`status: "failed"`.

### Rollback

If the restore fails AFTER the safety backup has been created, the restore
service attempts automatic rollback:

1. The DB is restored from the safety backup's `dbdump.sql` via `psql --single-transaction`.
2. Files are NOT rolled back automatically (would require additional
cross-volume copy). A warning is logged. The operator must restore files
manually if the partial state is unacceptable.

If the rollback itself fails, the error is logged at `[restore] Rollback FAILED`
and no email notification is sent — the failure log entry is the only signal,
so the operator must check the logs for manual intervention (the backup-failure
email notification, BACK-06, is not wired into the restore rollback path).

### Atomicity Guarantees

- **DB restore** uses `psql --single-transaction --set ON_ERROR_STOP=on`.
Either every statement in the dump applies, or none of them do.
- **File restore** is not atomic. A failure mid-copy leaves a partial state
on disk. Operators should treat file restore as "best effort" and verify
the result before resuming operations.

### Path Traversal Defense

Every entry extracted from a restore ZIP is validated against the staging
directory using:

```ts
const resolved = path.resolve(stagingDir, entryPath);
const stagingNorm = path.resolve(stagingDir) + path.sep;
if (!resolved.startsWith(stagingNorm) && resolved !== path.resolve(stagingDir)) {
throw new Error(`Path traversal detected: ${entryPath}`);
}
```

A restore ZIP that contains a `../` entry aborts the extraction promise with
this error . Because extraction is streaming (`yauzl` `lazyEntries` mode)
with per-entry validation, entries processed before the offending one are
already written to disk — the ZIP is partially extracted, not untouched.

### Restore from Email

The Email destination's `download()` method is intentionally a
`NotImplementedError` . The restore routes return:

```
400 { error: "Restore from email destination is not supported. Use a different destination for restore." }
```

Operators who need to restore from an email backup must download the
attachment manually, place it in a `local` or `s3` destination, and run
the restore from there.

## Decisions Reference

| Decision | Description |
|----------|-------------|
| D-17 | Safety backup is automatic and mandatory before every restore |
| D-18 | Safety backup stays local (not uploaded to remote destination) |
| D-19 | If safety backup fails, the restore is aborted |
| D-20 | Automatic rollback from safety backup on post-safety restore failure |
| D-22 | Path-traversal validation on every ZIP entry before extraction |
