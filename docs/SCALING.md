# Multi-Instance Scaling Guide

Operator guide for deploying **Simmetric Chat** in a horizontally scaled
(multi-instance) configuration behind a load balancer. This document closes
the v1.4 milestone "Horizontal Scale — Redis Layer Completion" (,
requirement CC-03) and ties together the six implementation phases 161-166.

> **Single-instance?** This guide focuses on the **multi-instance** (N server
> processes behind a load balancer) topology. For single-container,
> multi-container Docker Compose, and air-gapped deployments, see
> [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md). Everything in this guide that is
> described as "degrades to single-instance" is the single-instance default —
> multi-instance is the opt-in that requires the extras documented here.

This is the **only operator surface** for multi-instance deployment. The
runtime code paths (Redis clients, pg-boss, SSE relay, rate-limit stores,
redlock, ENCRYPTION_KEY, HMAC API keys) are all wired in the server source
and are **not** configurable through this document — this guide tells you
which env vars to set and which behaviours change when you do.

---

## 1. Topology

```
┌────────────────────┐
│ Load Balancer │ (any HTTP LB; sticky sessions
│ (HTTP, TLS term) │ NOT required — see §1.1)
└─────────┬──────────┘
┌──────────────────┼──────────────────┐
▼ ▼ ▼
┌────────────┐ ┌────────────┐ ┌────────────┐
│ Server 1 │ │ Server 2 │ … │ Server N │ (N identical
│ :3000 │ │ :3000 │ │ :3000 │ instances of
└─────┬──────┘ └─────┬──────┘ └─────┬──────┘ packages/server)
│ │ │
│ (each instance runs the same code; state is externalised)
│ │ │
┌──────┴──────────────────┴──────────────────┴──────┐
│ │
▼ ▼
┌──────────────────┐ ┌──────────────────┐
│ Shared Postgres │ (app data + `pgboss` schema │ Shared Redis │
│ + pgvector │ — see §3) │ (optional but │
└──────────────────┘ │ required for │
│ multi-instance │
│ — see §2) │
└──────────────────┘
```

Each server instance is **identical and stateless from the load balancer's
perspective** — any instance can serve any request. State that would
otherwise live in process memory is externalised:

| Concern | Where it lives | Single-instance fallback |
|---------|-----------------|--------------------------|
| JWT sessions | stateless JWT (no server-side session store) | n/a |
| Rate-limit counters | Redis (if `REDIS_URL` set) | per-process `Map` |
| JWT `jti` revocation list | Redis | none — revocation no-ops without Redis (token stays valid until JWT exp) |
| SSE fan-out (cross-instance) | Redis pub/sub relay | in-process only (no relay) |
| Distributed locks (reapers) | Redis `redlock` | `withDistributedLock` is a no-op |
| Auth/config caches | Redis | none — falls through to a DB query per read |
| Background jobs | Postgres `pgboss` schema | none — schedulers offline when pg-boss unavailable (no fallback timer) |

### 1.1 Sticky sessions are NOT required

The server is **stateless** for HTTP/REST: every request is authenticated by
the JWT in the cookie/Authorization header, validated against the
symmetric signing key (`JWT_SECRET`, HS256). There is no server-side session map
that pins a client to one instance.

For **SSE** connections, the client holds a long-lived connection to the
specific instance that accepted it. A client connected to instance B will
still receive events emitted on instance A because the SSE fan-out relays
them through Redis pub/sub ( proved this end-to-end with a
mock-based two-instance simulation). You do **not** need to pin a client to
one instance for SSE to work — but if your load balancer offers
least-connections routing for the SSE path, that is the most efficient choice
(long-lived connections should be balanced by open-connection count, not
round-robin).

### 1.2 Instance count

Start with 2 instances and scale horizontally as load requires. There is no
hard upper bound; the Postgres connection pools (Prisma's driver-adapter pool plus
pg-boss's own `pg.Pool`, managed separately) are the practical limiter — each instance opens a bounded pool, so
sizing `DATABASE_URL`'s pool and the Postgres `max_connections` against
`N` is the operator's responsibility.

---

## 2. `REDIS_URL` requirement (optional but required for multi-instance)

`REDIS_URL` is **optional** by design — `packages/server/AGENTS.md` states
explicitly: *"don't make Redis required."* The server boots and serves
requests with or without it. **Multi-instance, however, REQUIRES `REDIS_URL`
to be set on every instance**, because five consumers otherwise silently
fall back to a per-process state that diverges across instances.

### The five Redis consumers

| Consumer | What it does with Redis | Multi-instance failure mode if `REDIS_URL` absent |
|----------|-------------------------|---------------------------------------------------|
| **Rate-limit stores** (`rateLimit` middleware) | Stores hit counters in Redis so all instances see the same window | Each instance counts independently → effective rate limit is `N × limit` |
| **JWT `jti` revocation** (`authMiddleware`) | Checks the revocation list in Redis | A token revoked on instance A is still valid on instance B until its JWT exp |
| **SSE pub/sub fan-out** (`publishSSEEvent` + `setupSSESubscriber` in `routes/chat.ts`) | Publishes SSE events to a Redis channel; every instance subscribes and re-emits to its own SSE clients | A client on instance B never sees an event emitted on instance A ( SF-01 regression) |
| **`redlock`** (`withDistributedLock`) | Acquires a cross-instance mutex for the reaper schedulers | The lock is a no-op → reapers double-execute across instances ( DR-01/02/03 was the interim fix; pg-boss dedup in is the permanent fix; the 2 non-migrated pollers dedup via DB-level claim, not a lock wrap) |
| **Auth/config caches** (`getSetting`/`getAllSettings`, user/role caches) | Shares the cached config blob across instances | Without Redis there is no cache — every read is a DB query (Postgres read amplification) |

**Setting `REDIS_URL`:** point every instance at the same Redis instance (or
Redis cluster / sentinel). The clients use `ioredis` and accept any
`redis://` or `rediss://` (TLS) URL.

```bash
# root .env (the single runtime config)
REDIS_URL=redis://redis-host:6379
# TLS:
# REDIS_URL=rediss://redis-host:6379
```

Restart the server after changing env (`pnpm dev` re-reads env on boot; env
vars override DB settings).

### What "degrades to single-instance" means in practice

If you run **one** instance without `REDIS_URL`: the server boots, REST and
SSE both work (SSE just doesn't relay — there's nowhere to relay to), jobs
run in-process, rate-limits are per-process, caches are per-process. This is
the single-instance default and is fully supported. The "degradation" is
only a correctness problem when N > 1.

---

## 3. pg-boss Postgres dependency (-165)

The job queue is **pg-boss**, backed by the **same Postgres** you already run
for app data. pg-boss auto-creates a `pgboss` schema on `start()` and uses
it for job state. **No new database is required** — Postgres is already a
hard dependency of the server.

### What migrated in 

Seven `setInterval`-based schedulers were migrated to pg-boss scheduled jobs:

1. `archiveConsistencyService`
2. `synthesisReaperJob`
3. `vectorCleanupJob`
4. `mcpHealthCheckJob`
5. `mcpReaperJob`
6. `chatMessageReaperJob`
7. `uploadDraftReaperJob`

pg-boss provides **distributed job dedup** — when N instances all reach the
scheduled fire time, exactly one instance picks up the job; the others skip
on contention. This is the permanent replacement for the interim
`withDistributedLock` wrap (the lock-wrap was removed in once
pg-boss dedup superseded it — Q-03).

### Boot + shutdown

- **Boot:** pg-boss is initialized at server boot via the singleton
`jobQueue.ts` with its own `pg.Pool` from `DATABASE_URL`
(separate from the Prisma adapter's pool). `start()`
auto-creates the `pgboss` schema if absent.
- **Shutdown:** pg-boss graceful shutdown (`stopJobQueue()`) is wired into
the server's graceful-shutdown sequence (Q-04) — in-flight jobs are drained
(4.5s pg-boss grace timeout) before `prisma.$disconnect()`, and the entire
shutdown sequence runs under a single 5s outer `Promise.race` cap
(`packages/server/src/index.ts`).

### Graceful degradation (Q-05)

If Postgres is unavailable at boot or goes down mid-run, pg-boss jobs are
**skipped** (the error is logged, the server does **not** crash-loop). The
server still boots and serves any request that does not require the queue.
This is a deliberate design choice (Q-05) — a queue outage must not take
the chat API offline.

---

## 4. SCALE-03: API-key HMAC migration

The API-key verification path was rewritten from a bcrypt-loop lookup
(`api_keys.hashedKey` + `findMany({prefix})` + `bcrypt.compare`, capped at
`take: 10`) to a keyed-HMAC O(1) digest lookup
(`api_keys.key_hash` + `findUnique({key_hash})`).

**This is a breaking, irreversible migration** — it is the ONE documented
additive-only exception (CC-02; case #2 of
[`docs/MIGRATION_SAFETY.md`](./MIGRATION_SAFETY.md): "Schema refactor with
explicit consent"). `pnpm audit:migrations` flags it as destructive; the CI
`migration-safety-check` job blocks the PR unless
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` is set.

**Operator action required:** bcrypt hashes **cannot** be converted to
HMAC-SHA256 digests (different algorithms — bcrypt is adaptive-cost + salted;
HMAC is deterministic + keyed). All existing `api_keys` rows are
invalidated. Operators must **re-issue** all widget and collector API keys
after deploying the migration. The widget service-account key is
re-seeded automatically on the next server boot; only admin-created keys
require manual re-issue.

**Full operator runbook:** [`docs/API_KEY_MIGRATION.md`](./API_KEY_MIGRATION.md)

This is multi-instance relevant because the O(1) lookup is what makes API-key
auth cheap enough to run on every request across every instance without a
shared cache — the constant-time HMAC digest comparison has no
`take`-cap and no per-instance bcrypt CPU cost.

---

## 5. SCALE-02: `ENCRYPTION_KEY` hard-default

The at-rest encryption key (`ENCRYPTION_KEY`, AES-256-GCM, 32 bytes) is
**required in production** (`NODE_ENV=production`). The server now FAILS
LOUD at boot (`logger.error` + `process.exit(1)`) when `ENCRYPTION_KEY` is
unset in production — it no longer boots with the legacy
`scryptSync(JWT_SECRET)` fallback. The failure message names
`ENCRYPTION_KEY`, shows `openssl rand -base64 32`, and points operators to
the rotation runbook.

**Why this matters for multi-instance:** the old `scryptSync(JWT_SECRET)`
fallback silently coupled data-at-rest encryption-key rotation to
JWT_SECRET rotation — rotating `JWT_SECRET` would silently invalidate
every encrypted blob in the database. In a multi-instance deployment, that
is a fleet-wide brick. The hard-default removes that coupling: rotate
`JWT_SECRET` (cheap — just re-issues auth tokens) without touching
`ENCRYPTION_KEY` (expensive — requires the rotation runbook).

**Dev/test preserves the scrypt fallback** (`NODE_ENV !== "production"`)
for convenience — no `ENCRYPTION_KEY` needed locally.

**Full operator runbook (generation, rotation, rollback, pre-upgrade
checklist for the cutover):**
[`docs/ENCRYPTION_KEY_ROTATION.md`](./ENCRYPTION_KEY_ROTATION.md)

```bash
# root .env (the single runtime config)
ENCRYPTION_KEY=$(openssl rand -base64 32)
```

Set the **same** `ENCRYPTION_KEY` on every instance — any instance that
cannot decrypt a blob will fail to read encrypted data (settings, SSO
secrets, etc.). The key is read once at boot and held in memory.

---

## 6. Non-migrated 10s pollers (in-process)

Two latency-sensitive pollers **intentionally stayed on `setInterval`** in
and were NOT migrated to pg-boss:

| Poller | Interval | Why it stayed |
|--------|----------|---------------|
| **OCR pipeline reaper** | 10s | Latency-sensitive — picks up OCR jobs and dispatches them to the collector. pg-boss cron's minimum granularity is 1 minute, which would make OCR pickup 6× slower. |
| **Synthesis pipeline reaper** | 10s | Latency-sensitive — same rationale for the synthesis pipeline. |

Migrating these would require either a 1-minute cron (6× slower pickup) or
a non-cron pg-boss pattern (`send()` with a short defer), neither of which
justified the change in v1.4. Deferred to a future phase if latency
requirements change.

### Multi-instance behaviour of these pollers

These pollers run **per-instance**. Because they are idempotent
reaper-style cycles (claim-pending-job-then-dispatch, not
execute-the-same-job), the absence of cross-instance dedup is acceptable —
if two instances both pick up the same pending OCR job within the same 10s
window, the second dispatch is a no-op at the collector (the job is already
in-flight). This is the documented trade-off: lower latency at the cost of
occasional redundant dispatches, which are cheap to absorb.

Neither poller uses a `withDistributedLock` wrap — the lock-wrap
was removed in . Instead both dedup at the database level: the OCR
poller claims jobs with an atomic `updateMany` PENDING→PROCESSING count
check, and the synthesis poller claims with `SELECT ... FOR UPDATE SKIP
LOCKED` — concurrent instances cannot double-claim the same job, and the
collector dedups any redundant dispatch.

---

## 7. Graceful degradation

The server is designed to boot and serve requests even when its
optional dependencies are unavailable. There are two degradation
scenarios operators should understand.

### 7.1 `REDIS_URL` absent (or Redis unreachable)

| Behaviour | Status |
|-----------|--------|
| Server boots | ✅ normal |
| REST API | ✅ normal |
| SSE (clients on THIS instance) | ✅ normal — events emit to local clients |
| SSE (cross-instance fan-out) | ❌ events emitted on this instance do NOT reach clients on other instances |
| Rate-limiting | ⚠️ per-process (effective limit = N × configured limit) |
| JWT `jti` revocation | ⚠️ per-process (revocation only takes effect on the instance that revoked) |
| Reaper locks | ⚠️ no-op (reapers run per-instance; pg-boss still dedups the 7 migrated jobs) |
| Auth/config caches | ⚠️ no cache — plain DB query per read (higher Postgres read amplification) |

**Recommendation:** for any deployment with N > 1, set `REDIS_URL`. Running
multi-instance without Redis is *possible* but silently degrades several
guarantees (rate-limiting, revocation, cross-instance SSE). The boot log
warns whenever `NODE_ENV=production` + `REDIS_URL` unset (DR-04, ;
no multi-instance detection — a single-instance prod server gets the same
warning) — heed that warning.

### 7.2 Postgres unavailable (or `pgboss` schema inaccessible)

| Behaviour | Status |
|-----------|--------|
| Server boots | ✅ normal (Q-05 — no crash-loop) |
| REST API (requests that don't need the queue) | ✅ normal |
| REST API (requests that need the queue — e.g. enqueue a job) | ❌ error logged, request fails gracefully |
| Background jobs (7 migrated schedulers) | ❌ jobs skipped (error logged, no crash) |
| 2 non-migrated pollers (OCR, synthesis) | ⚠️ run per-instance; dispatch will fail at the collector (Postgres-backed) |

**Recommendation:** Postgres is a hard dependency for app data — you cannot
run the server without it for any meaningful length of time. The graceful
degradation here is about **boot resilience**: a transient Postgres outage
at boot does not crash-loop the server; it comes up and serves what it can,
and the queue heals when Postgres returns.

---

## Environment variable reference

The multi-instance-relevant env vars live in the repo-root `.env` (the
single runtime config per `AGENTS.md`; the per-package `.env` override
layer was removed — the root `.env` is the only runtime env file):

| Variable | Required? | Multi-instance? | Default / behaviour |
|----------|-----------|-----------------|---------------------|
| `REDIS_URL` | optional | **required for N > 1** | absent → all 5 consumers degrade to single-instance |
| `ENCRYPTION_KEY` | required in production (`NODE_ENV=production`) | same value on every instance | absent in prod → fail-loud boot; absent in dev → scrypt fallback |
| `DATABASE_URL` | required | same value on every instance | code default `postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat` |
| `JWT_SECRET` | required (Zod `.min(1)`) | same value on every instance (stateless JWT validation) | n/a |
| `COLLECTOR_SECRET` | required (Zod `.min(1)`) | same value on every instance | shared secret for server↔collector HTTP |
| `NODE_ENV` | `production` triggers the `ENCRYPTION_KEY` hard-default + DR-04 boot warning | — | dev/test preserves the scrypt fallback |
| `LICENSE_KEY` | optional (Enterprise JWT) | same value on every instance | absent → Community tier |

Restart the server after changing any of the 6 infrastructure keys
(`JWT_SECRET`, `DATABASE_URL`, `SERVER_PORT`, `COLLECTOR_PORT`, `SERVER_URL`,
`COLLECTOR_URL`) — they are ENV-only (`ALWAYS_READONLY` in
`systemConfigService.ts`: the env var always wins and the DB is never read).
Every other UI-editable key resolves **DB > ENV > default** (code-verified,
`systemConfigService.ts`): a DB row written by the admin UI wins over any env
var, the env var only acts as the pre-DB default, and UI edits take effect
immediately without restart. The settings UI marks such ineffective env vars
with an `envOverridden` hint.

---

## Failure modes

| Symptom | Likely cause | Runbook |
|---------|--------------|---------|
| Server `process.exit(1)` at boot, message names `ENCRYPTION_KEY` | `NODE_ENV=production` + `ENCRYPTION_KEY` unset ( hard-default) | [`docs/ENCRYPTION_KEY_ROTATION.md`](./ENCRYPTION_KEY_ROTATION.md) §" hard-default cutover" |
| Boot warning "[server] REDIS_URL is unset in production — running in single-instance mode…" | `NODE_ENV=production` + `REDIS_URL` unset (DR-04) | §2 of this document — set `REDIS_URL` |
| API key auth fails after deploy | bcrypt `hashedKey` rows invalidated by SCALE-03 migration | [`docs/API_KEY_MIGRATION.md`](./API_KEY_MIGRATION.md) — re-issue keys |
| SSE client on instance B misses events emitted on instance A | `REDIS_URL` unset, or Redis pub/sub channel mismatch | §2 of this document — set `REDIS_URL` on every instance; verify Redis connectivity |
| Rate limit appears N× too high | `REDIS_URL` unset → per-process counters | §2 of this document — set `REDIS_URL` |
| `pnpm start` fails with stale-`dist/` guard | `check-build-freshness` detected `dist/` older than `src/` | `pnpm --filter server build` before deploy (pre-existing guard, not v1.4-specific) |

---

## Related documents

- [`docs/ENCRYPTION_KEY_ROTATION.md`](./ENCRYPTION_KEY_ROTATION.md) — SCALE-02
`ENCRYPTION_KEY` rotation runbook (generation, rotation, rollback, 
hard-default cutover checklist).
- [`docs/API_KEY_MIGRATION.md`](./API_KEY_MIGRATION.md) — SCALE-03 breaking
API-key HMAC migration runbook (re-issue procedure, irreversibility
rationale, admin key re-issue steps).
- [`docs/MIGRATION_SAFETY.md`](./MIGRATION_SAFETY.md) — additive-only
migration policy + the SCALE-03 exception (case #2: "Schema refactor with
explicit consent"). Required reading before any destructive migration.
- [`docs/MIGRATION_AUDIT.md`](./MIGRATION_AUDIT.md) — current migration
audit (regenerated by `pnpm --filter server audit:migrations`). Shows
8 migrations: 7 additive + 1 destructive (the SCALE-03 exception).
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — single-container, multi-container
Docker Compose, and air-gapped deployment modes. This document is the
multi-instance (horizontal scale) complement to that guide.

---

* — Cross-Cutting Close (milestone v1.4). Ties together 
(distributed reapers lock-wrap + boot warning), (ENCRYPTION_KEY
hard-default), (keyed-HMAC API keys), (pg-boss queue
foundation), (scheduler migration to pg-boss), and (SSE
fan-out cross-instance verification).*