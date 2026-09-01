# Operations Runbook: Chat-Message Retention Reaper

> (SEED-002/003/004) — daily 03:00 two-pass reaper that soft-deletes old messages of active chats and hard-purges tombstoned rows past a 7-day grace window.

## Overview

The chat-message retention reaper is a pg-boss cron job (NOT Bree) that runs once a day at 03:00 UTC. It performs two passes per tick:

| Pass | Action | Selector | Filter |
|------|--------|----------|--------|
| **1 — soft-delete** | `chatMessage.updateMany({ data: { deletedAt: now } })` | `deletedAt: null`, `createdAt < now - retentionDays`, `chat: { deletedAt: null }` | Active-chat **relation filter** is load-bearing — trashed-chat messages are NOT touched. |
| **2 — hard-purge** | `chatMessage.deleteMany()` | `deletedAt IS NOT NULL AND deletedAt < now - 7d` | NO `chat` relation filter — matches tombstoned rows past grace in any chat. |

**Default state: OFF.** `chat_message_retention_days = ""` (empty string) means Pass 1 is a no-op. Pass 2 **always runs regardless of retention config** — a tombstoned row past grace is purged even when retention is OFF, honoring explicit user deletion and preventing PII leakage (T-84-02-T7).

## Configuration

The reaper reads `chat_message_retention_days` from `SystemConfig` **every tick** . The dedicated write route (`routes/chatRetention.ts`) does a direct upsert and does **not** invalidate the Redis config cache, but the cache TTL is 300s (`systemConfigService.ts:56`), so the next 03:00 read is always fresh — admin changes take effect on the next 03:00 run without a server restart.

### Enable retention

```bash
curl -X PUT http://localhost:3000/api/system/chat-retention \
-H "Authorization: Bearer <admin-jwt>" \
-H "Content-Type: application/json" \
-d '{"retentionDays": 30, "confirmDataLoss": true}'
```

`retentionDays` must be a positive integer. `confirmDataLoss: true` is a sibling-field contract enforced at both the Zod schema (`.refine`) and route boundary — omitting it or setting it to `false` rejects the request with 400.

### Disable retention

```bash
curl -X PUT http://localhost:3000/api/system/chat-retention \
-H "Authorization: Bearer <admin-jwt>" \
-H "Content-Type: application/json" \
-d '{"retentionDays": null, "confirmDataLoss": true}'
```

`null` stores `""` (empty string = OFF). Pass 1 becomes a no-op; Pass 2 continues to purge tombstoned rows past grace.

### Accepted values

| Value | Pass 1 behavior | `retentionDays` in audit |
|-------|-----------------|--------------------------|
| `""` (default) | no-op | `null` |
| `null` → stored as `""` | no-op | `null` |
| `"abc"` (non-numeric) | no-op | `null` |
| `"0"` / negative | no-op | `null` |
| `"30"` | soft-deletes messages older than 30 days in active chats | `30` |

## `GRACE_PERIOD_DAYS = 7` (hardcoded — D-01)

The 7-day grace window is a **hardcoded module constant** in `packages/server/src/services/chatMessageReaperJob.ts`. It is **NOT operator-tunable**. Rationale: preventing misconfiguration from shrinking grace below the soft-delete lead time, which would let Pass 2 hard-purge a row in the same tick it was soft-deleted — violating the data-safety invariant.

The value is surfaced in every audit event as `graceDays: 7` for observability.

## Cadence

- **Schedule:** daily 03:00 UTC (pg-boss cron `0 3 * * *`, default `tz='UTC'`).
- **Mechanism:** pg-boss cron job (`createQueue` → `schedule` → `boss.work`); the `0 3 * * *` expression handles the 03:00 UTC alignment natively — the former `setInterval`/`setTimeout(msUntilNext3AM())` timer was removed in (Q-02/Q-03).
- **Init gate:** `initChatMessageReaperScheduler()` is called inside the `NODE_ENV === "production"` block in `packages/server/src/index.ts`. The reaper does **NOT** run in development or test environments.
- **Shutdown:** there is no per-reaper shutdown function — `stopJobQueue()` (pg-boss) is called in the SIGTERM/SIGINT graceful-shutdown sequence, before `prisma.$disconnect()`, and drains all cron workers (no timer handles remain to keep the event loop alive).
- **Concurrency:** pg-boss's native SKIP LOCKED job dedup ensures only one instance runs the cycle on a multi-instance fleet — the former `withDistributedLock("reaper_chat-message", 30 * 60 * 1000)` wrap and the in-process `isRunning` mutex were removed in (D-02 one-way door). When pg-boss is unavailable (`getBoss() === null`), the scheduler logs a warn and stays offline — there is no fallback timer.

## Audit events

Every tick emits exactly one `reaper.run` `EventLog` row (entityType `"chat"`); when Pass 2 cascades Memory rows, an additional `memory.reaper.purge` row is emitted:

| Field | Value |
|-------|-------|
| `entityType` | `"chat"` |
| `entityId` | `"system"` |
| `action` | `"reaper.run"` |
| `userId` | `null` (system job) |
| `metadata` (JSON) | `{ softDeleted, hardPurged, memoryPurged, retentionDays, graceDays: 7 }` |

Config writes via `PUT /api/system/chat-retention` emit a separate audit event: `action = "retention.updated"` with `{ retentionDays, previousRetentionDays }`.

Query the audit trail:

```sql
SELECT "createdAt", "metadata"
FROM event_logs
WHERE "action" = 'reaper.run' AND "entityType" = 'chat'
ORDER BY "createdAt" DESC
LIMIT 20;
```

## Data-safety invariant

**A non-explicitly-deleted message of an active chat is NEVER hard-purged.**

It must first be soft-deleted by Pass 1 (retention cutoff) AND survive the 7-day grace window before Pass 2 can touch it. The load-bearing guard is the `chat: { deletedAt: null }` relation filter on Pass 1 — it ensures only messages of **active** chats are soft-deleted, so a trashed chat's non-explicitly-deleted messages never reach the tombstoned state that Pass 2 matches.

Verified by integration test (b): an active-chat message 2 days old with `retentionDays=1` is soft-deleted (`deletedAt != null`) but the row **still exists** after the tick (grace not elapsed).

## D-07 edge case: individually-deleted messages in trashed chats

A user may explicitly delete a single message (setting its `deletedAt`) in a chat that is later trashed (`Chat.deletedAt != null`). Such a tombstoned message **IS** hard-purged by Pass 2 after the 7-day grace window, because Pass 2 has no `chat` relation filter — it matches any row where `deletedAt < now - 7d`.

This is **acceptable and intended**: the user explicitly deleted the message, so honoring that deletion (and removing the PII) is correct. Non-individually-deleted messages of trashed chats are NOT touched by either pass (verified by integration test (c) / SEED-004c).

## Deferred (out of scope for v0.14)

The following are explicitly deferred to v0.15+ and documented here for operator awareness:

- **Per-workspace retention override** — currently global only.
- **Trashed-chat cascade cleanup** — trashed chats' non-deleted messages are not auto-purged; operators must hard-delete trashed chats explicitly if full PII removal is required.
- **Settings UI field** — the config is writable only via the API route today; a UI toggle in Settings is deferred.
- **`msUntilNext3AM()` extraction** — the function was removed entirely in (Q-02/Q-03); the pg-boss cron expression handles alignment natively, so no shared util is needed.

## Troubleshooting

### Reaper not running

1. Confirm `NODE_ENV=production` — the init is gated on this env var.
2. Check logs for `[chat-message-reaper] Reaper scheduler registered (pg-boss cron: 0 3 * * *)`.
3. Verify the `chat_message_retention_days` row exists in `system_config` (seeded by `seedConfigDefaults`).

### Messages not being soft-deleted

1. Check the audit metadata: `retentionDays: null` means retention is OFF (Pass 1 no-op).
2. Confirm the chat is **active** (`Chat.deletedAt IS NULL`) — trashed chats are excluded by the relation filter.
3. Confirm the message `createdAt` is older than `retentionDays` ago.

### Messages not being hard-purged

1. Pass 2 only matches rows where `deletedAt IS NOT NULL AND deletedAt < now - 7d`. A freshly soft-deleted row (same-day `deletedAt`) is within grace and will not be purged for 7 days.
2. Check the audit metadata `hardPurged` count.