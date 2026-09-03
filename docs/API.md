<!-- generated-by: gsd-doc-writer -->
# API Reference

Simmetric Chat exposes an Express 5 REST API from `packages/server` on port 3000 (configurable via `SERVER_PORT`). All application endpoints live under the `/api` prefix. A live OpenAPI/Swagger UI is served at `/api-docs`, and the raw spec at `/api-docs/json` (see `packages/server/src/config/swagger.ts`).

This page documents the authentication mechanisms, the standard request/response and error shapes, rate limiting, and the endpoint surface grouped by domain. For per-endpoint details (schemas, examples), the route files in `packages/server/src/routes/` are the authoritative source — each handler carries an OpenAPI JSDoc block.

## Authentication

Three credential mechanisms exist. The vast majority of endpoints use JWT Bearer auth.

### JWT Bearer (primary)

Middleware: `authMiddleware` (`packages/server/src/middleware/auth.ts`).

```
Authorization: Bearer <jwt>
```

- Tokens are issued by `POST /api/auth/login` and `POST /api/auth/register`; the response body contains a `token` field.
- Tokens carry a `jti` claim; revoked `jti`s are checked against a blacklist (optionally Redis-backed) and rejected with `401 { "error": "Token revoked" }`.
- Expired or invalid tokens return `401 { "error": "Invalid or expired token" }`; a missing header returns `401 { "error": "Missing or invalid authorization header" }`.
- The middleware resolves the user together with roles and permissions (with a cache) and attaches `req.userId` / `req.user`.

### API key (widget service account)

Middleware: `apiKeyMiddleware` (`packages/server/src/middleware/auth.ts`). Used exclusively by the internal widget surface.

```
X-Api-Key: <api-key>
```

- Keys are HMAC-SHA256 hashed at rest (`API_KEY_HMAC_SECRET`) and looked up in the `api_keys` table; the key maps to the widget service account, which becomes the acting user.
- A missing/invalid key returns `401`; a server-side HMAC misconfiguration returns `500` (fail-loud by design, so misconfiguration is never masked as an auth failure).
- API keys for end users are managed via `/api/api-keys` (see below).

### Collector shared secret (service-to-service)

The collector calls back into the server with a timing-safe compared header:

```
X-Collector-Secret: <COLLECTOR_SECRET>
```

Currently used by `PUT /api/documents/:documentId/status` (ingest status callback). This route intentionally has no JWT auth.

### RBAC permission middleware

Middleware: `packages/server/src/middleware/rbac.ts`. Permission names are defined in `@simmetric-chat/shared` (`PermissionName`).

| Guard | Behavior |
|---|---|
| `requirePermission(p)` | Admins always pass; others must hold every listed permission. `401` if unauthenticated, `403 { "error": "Insufficient permissions" }` otherwise. |
| `requireAdmin` | `403 { "error": "Admin access required" }` for non-admins. |
| `requireProjectAccess` | IDOR check against project ownership / `projectAccess` rows. |
| `requireWorkspaceAccess` | IDOR check against workspace ownership, parent project ownership, or explicit access rows. |

### License gating

Middleware: `packages/server/src/middleware/license.ts`.

- `requireFeature(flag)` blocks the request when the feature flag is off (Community tier or flag disabled):

  ```json
  402 { "error": "This feature requires an Enterprise license", "feature": "widget_enabled", "tier": "community" }
  ```

- `requireFeatureLimit(flag, model)` enforces numeric limits (`max_workspaces`, `max_projects`, `max_widgets`, ...). When the count reaches the limit:

  ```json
  402 { "error": "workspace limit reached. Your plan allows up to 3 workspaces.", "feature": "max_workspaces", "limit": 3, "current": 3, "tier": "community" }
  ```

The public license tier is readable without auth via `GET /api/license/info`.

## Conventions and error shapes

- **Error envelope**: every error is `{ "error": string }`. Validation failures (HTTP 400) add `details` with Zod-flattened field errors:

  ```json
  { "error": "Invalid request body", "details": { "message": ["Required"] } }
  ```

- **Partial success**: `PUT /api/system/settings` returns `200 { "updated": [...], "rejected": [...] }` — rejected keys are listed, the rest apply. Refetch settings after saving.
- **404**: unknown routes return `{ "error": "Not found" }`; missing resources return domain-specific messages (e.g. `{ "error": "Project not found" }`).
- **500**: unhandled errors are logged and return `{ "error": "Internal server error" }`.
- **Request validation**: bodies are validated with shared Zod schemas (`packages/shared/src/schemas/`) using `safeParse`.
- **Body size limits**: JSON bodies up to 100 MB (`express.json`), multipart uploads up to 100 MB (multer).
- **CORS**: origins are restricted to the `ALLOWED_ORIGINS` allowlist (no origin echo); requests without an `Origin` header (curl, server-to-server) are allowed. Widget embed routes under `/api/internal/widget` use a dedicated dynamic CORS middleware (`widgetCors`) that validates against the widget's own origin allowlist.

## Rate limits

Defined in `packages/server/src/middleware/rateLimit.ts` (`express-rate-limit`). When `REDIS_URL` is set, counters use a shared Redis store; otherwise each instance keeps an in-process store.

| Limiter | Applies to | Production | Development |
|---|---|---|---|
| `apiRateLimiter` (global) | Every route, per IP | 200 req/min | 2000 req/min |
| `authRateLimiter` | `/api/auth/*` write endpoints | 10 req/min | 100 req/min |
| `widgetLeadLimiter` | `POST /api/internal/widget/lead` | 3 req/hour | 30 req/hour |
| `probeRateLimiter` | `POST /api/system/probe-llm`, `POST /api/system/probe-vector` | 10 req/min | 100 req/min |

Notes:

- Requests carrying an `X-Widget-Id` header skip the global limiter — widget traffic is throttled upstream by the widget service's per-key limiter (30 req/min per hashed API key, `packages/widget`).
- Standard `RateLimit-*` headers are emitted on limited routes.
- There is no dedicated chat rate limiter; the ReAct agent enforces per-user concurrency, token budgets, and wallclock timeouts internally (`services/agentBudgetService.ts`).

## Endpoint overview

Mount wiring lives in `createApp()` in `packages/server/src/index.ts`. Several routers share a mount prefix (chat and archive sub-routers), so paths below are the **effective full paths**.

### System, health, and meta

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | Public | DB, collector, and disk health check |
| GET | `/api/health/rag` | Public | RAG pipeline health |
| GET | `/api/license/info` | Public | Current license tier and feature flags |
| GET | `/api/license/diagnose` | Admin | License diagnostics |
| GET | `/api/system/is-initialized` | Public | Setup wizard state |
| POST | `/api/system/initialize` | Public (wizard-gated) | First-run initialization |
| POST | `/api/system/probe-llm` | Public (wizard-gated, rate limited) | Test LLM connectivity |
| POST | `/api/system/probe-vector` | Public (wizard-gated, rate limited) | Test vector DB connectivity |
| POST | `/api/system/reset-db` | Admin | Reset database |
| POST | `/api/system/reindex-documents` | Admin | Re-run indexing |
| POST | `/api/system/reembed-documents` | Admin | Re-run embedding |
| POST | `/api/system/ocr/prewarm` | Admin | Warm OCR engines |
| GET | `/api/system/settings` | Auth | Read system settings |
| PUT | `/api/system/settings` | Auth (admin validator on write) | Partial-success settings update (`{ updated, rejected }`) |
| GET | `/api/system/settings/embedding-config` | Public (collector service) | Embedding configuration |
| GET | `/api/system/settings/vector-db-config` | Public (collector service) | Vector DB configuration |
| PUT | `/api/system/chat-retention` | Auth (audited) | Chat message retention days (confirm-data-loss contract) |
| GET | `/api/system/dlp/patterns` | Auth (`admin:settings`) | List DLP patterns |
| POST/PUT/DELETE | `/api/system/dlp/patterns[...]` | Auth (`admin:settings`) | DLP pattern CRUD |
| POST | `/api/system/dlp/patterns/:id/test` | Auth (`admin:settings`) | Test a pattern against sample text |
| GET | `/api/system/analytics/tokens` | Admin | Token usage analytics |
| GET | `/api/system/analytics/models` | Admin | Per-model usage |
| GET | `/api/system/analytics/top-users` | Admin | Top users by usage |
| GET | `/api/system/push/vapid-key` | Auth | Web push VAPID public key |
| POST/DELETE | `/api/system/push/subscribe` | Auth | Push subscription management |
| POST | `/api/system/push/test` | Admin | Send a test push |
| GET | `/api/filters` | Auth (`filters:manage`) | Registered filter plugins |
| PATCH | `/api/filters/:name` | Auth (`filters:manage`) | Enable/disable a filter plugin |

### Auth and users

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | Public (rate limited) | Self-registration (gated by `ALLOW_REGISTRATION`) |
| POST | `/api/auth/admin-register` | Admin | Create a user |
| POST | `/api/auth/login` | Public (rate limited) | Returns `{ user, token }`; `user` embeds roles + permissions |
| GET | `/api/auth/sso/status` | Public | Whether SSO login is available (Enterprise) |
| GET | `/api/auth/me` | Auth | Current user profile |
| GET | `/api/auth/users` | Admin | Admin user listing |
| POST | `/api/auth/change-password` | Auth | Change own password |
| POST | `/api/auth/set-initial-password` | Auth | First-login password rotation |
| POST | `/api/auth/admin-reset-password` | Admin | Reset a user's password |
| GET | `/api/users` | Admin | List users |
| GET/PUT/PATCH | `/api/users/:id` | Auth | User profile read/update |
| POST/DELETE | `/api/users/:id/avatar` | Auth | Avatar upload/removal |
| DELETE | `/api/users/:id` | Admin | Delete a user |
| GET | `/api/roles/me/menu-sections` | Auth | Menu sections for current user |
| GET/POST/PUT/DELETE | `/api/roles[...]` | Admin | Role CRUD, assign/revoke (`POST /api/roles/assign`, `POST /api/roles/revoke`), menu sections |
| GET | `/api/api-keys` | Auth | List own API keys |
| POST | `/api/api-keys` | Auth | Create an API key |
| DELETE | `/api/api-keys/:keyId` | Auth | Revoke an API key |

### Workspaces, projects, uploads, and documents

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/projects` | Auth | List accessible projects |
| POST | `/api/projects` | Auth (`project:create`, `max_projects` limit) | Create project |
| GET/PUT/DELETE | `/api/projects/:projectId` | Auth (`requireProjectAccess`) | Project CRUD, usage, export, access grants |
| GET | `/api/workspaces` | Auth | List accessible workspaces |
| POST | `/api/workspaces` | Auth (`workspace:create`, `max_workspaces` limit) | Create workspace |
| GET/PUT/DELETE | `/api/workspaces/:workspaceId` | Auth (`requireWorkspaceAccess`) | Workspace CRUD, restore, access grants |
| DELETE | `/api/workspaces/permanent` | Admin | Hard-delete a soft-deleted workspace |
| GET/POST/PUT/DELETE | `/api/workspaces/:workspaceId/folders[...]` | Auth (`requireWorkspaceAccess`) | Folder CRUD + restore |
| POST | `/api/uploads` | Auth | Stage an upload |
| POST | `/api/uploads/:id/assign` | Auth | Assign staged upload to a target |
| POST | `/api/uploads/:id/retry` | Auth | Retry a failed upload |
| GET | `/api/uploads/pending` | Auth | List pending staged uploads |
| PATCH/DELETE | `/api/uploads/:id` | Auth (`document:write`) | Update/remove staged upload |
| GET | `/api/documents` | Auth | List documents |
| POST | `/api/documents/upload` | Auth (`document:write`) | Multipart document upload |
| GET | `/api/documents/:documentId` | Auth | Document metadata |
| GET | `/api/documents/:documentId/text` | Auth | Extracted text |
| PUT | `/api/documents/:documentId/status` | Collector secret (`X-Collector-Secret`) | Ingest status callback |
| POST | `/api/documents/bulk-delete` | Auth (`document:delete`) | Bulk delete |
| DELETE | `/api/documents/:documentId` | Auth (`document:delete`) | Delete document |

### Chat

All chat routes are mounted under `/api/workspaces` (the chat routers and the workspace router share the prefix) and require workspace access (`requireWorkspaceAccess`) except where noted. Source: `chat.ts`, `chatList.ts`, `chatCrud.ts`, `chatAgentConfig.ts`, `chatExport.ts`, `chatImport.ts`, `chatTokens.ts`.

| Method | Path | Description |
|---|---|---|
| POST | `/api/workspaces/:workspaceId/chat` | Non-streaming agent chat |
| POST | `/api/workspaces/:workspaceId/chat/stream` | SSE streaming agent chat (see protocol below) |
| GET | `/api/workspaces/:workspaceId/chats` | List chats (with pin + message counts) |
| GET | `/api/workspaces/:workspaceId/chats/:chatId/messages` | List messages of a chat |
| PUT | `/api/workspaces/:workspaceId/chats/:chatId` | Rename chat |
| PATCH | `/api/workspaces/:workspaceId/chats/:chatId/model` | Change chat model |
| PATCH | `/api/workspaces/:workspaceId/chats/:chatId/archive` | Link/unlink an archive |
| PUT | `/api/workspaces/:workspaceId/chats/:chatId/move` | Move chat between folders |
| POST | `/api/workspaces/:workspaceId/chats/:chatId/pin` | Pin/unpin chat |
| PUT/DELETE | `/api/workspaces/:workspaceId/chats/:chatId/messages/:messageId` | Edit/delete a message |
| DELETE | `/api/workspaces/:workspaceId/chats/:chatId` | Delete chat |
| GET | `/api/workspaces/:workspaceId/chats/export` | Export all chats as JSON |
| GET | `/api/workspaces/:workspaceId/chats/:chatId/export` | Export one chat as JSON |
| POST | `/api/workspaces/:workspaceId/chats/import/preview` | Validate a chat JSON import |
| POST | `/api/workspaces/:workspaceId/chats/import/confirm` | Apply a chat JSON import |
| GET | `/api/workspaces/:workspaceId/agent-config` | Workspace agent configuration |
| PUT | `/api/workspaces/:workspaceId/agent-config` | Update agent configuration + enabled skills |
| GET | `/api/workspaces/:workspaceId/chats/:chatId/tokens` | Per-message token usage for a chat |
| GET | `/api/workspaces/:workspaceId/tokens/today` | Today's token usage for a workspace |

### Archives (wiki), OCR, and synthesis

Archive domain routes are spread over multiple routers all mounted at `/api/archives` (plus `/api/archive-schema-templates` and the `/api/ocr` catalog). Permissions use `archive:read` / `archive:write` / `archive:delete`.

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/archives` | List/create archives |
| GET/PUT/DELETE | `/api/archives/:archiveId` | Archive detail, update, delete |
| POST | `/api/archives/from-template` | Create archive from workspace template |
| POST | `/api/archives/:archiveId/reindex` | Re-index archive |
| GET/POST | `/api/archives/:archiveId/pages` | List/create wiki pages |
| GET/PUT/DELETE | `/api/archives/:archiveId/pages/:slug` | Page read/update/delete |
| GET/PUT/DELETE | `/api/archives/:archiveId/config` | Archive config (RAG settings, `localLLMOnly`, ...) |
| GET | `/api/archives/:archiveId/search` | Hybrid search within an archive |
| GET | `/api/archives/:archiveId/graph` | Wiki graph data |
| GET | `/api/archives/:archiveId/export` | Archive export bundle |
| POST | `/api/archives/:archiveId/index` | Incremental indexing |
| POST | `/api/archives/:archiveId/copy-from-doc` | Create pages from documents |
| GET | `/api/archives/import/:jobId` | Import job status |
| PUT | `/api/archives/import/:jobId/callback` | Collector import callback |
| GET | `/api/archive-schema-templates` | List schema templates |
| POST | `/api/archive-schema-templates` | Create schema template (Admin) |
| POST | `/api/archive-schema-templates/:id/apply` | Apply template to an archive |
| GET | `/api/ocr/models` | Auth (`archive:read`) | OCR catalog (available models/engines) |
| POST | `/api/ocr/preview` | Auth (`archive:read`) | Preview OCR output before ingest |
| GET | `/api/archives/:id/jobs` | List OCR/URL jobs for an archive |
| GET | `/api/archives/:id/jobs/:jobId` | Job detail |
| POST | `/api/archives/:id/jobs/:jobId/approve` | Approve OCR results |
| POST | `/api/archives/:id/jobs/:jobId/reject` | Reject OCR results |
| DELETE | `/api/archives/:id/jobs/:jobId` | Delete a job |
| GET | `/api/synthesis/status` | Synthesis pipeline status |
| GET | `/api/synthesis/pending/count` | Pending synthesis runs |
| POST | `/api/synthesis/trigger` | Trigger synthesis for an archive |
| POST | `/api/synthesis/trigger-graph-wiki` | Trigger graph-wiki synthesis |
| GET | `/api/synthesis/:runId` | Synthesis run detail |
| POST | `/api/synthesis/:runId/approve` | Approve run output |
| POST | `/api/synthesis/:runId/reject` | Reject run output |
| PATCH | `/api/synthesis/:runId/rename` | Rename a run |
| DELETE | `/api/synthesis/:runId` | Delete a run |
| POST | `/api/wiki-write/preview` | Preview an AI wiki edit |
| POST | `/api/wiki-write/:runId/approve` | Approve wiki edit |
| POST | `/api/wiki-write/:runId/reject` | Reject wiki edit |
| POST | `/api/wiki-write/:runId/undo` | Undo an applied edit |
| GET | `/api/wiki-write/history/:archiveId` | Wiki edit history |
| POST | `/api/wiki-write/distill` | Distill pages into a summary |
| GET | `/api/wikilinks/maintenance/:archiveId` | Wikilink maintenance report |
| POST | `/api/wikilinks/maintenance/:archiveId/merge` | Merge duplicate pages |
| GET | `/api/wikilinks/:archiveId` | Wikilink index for an archive |
| GET | `/api/wikilinks/:archiveId/:pageSlug` | Backlinks for a page |
| POST | `/api/wikilinks/resolve` | Resolve `[[wikilink]]` slugs |

The `/api/wiki-edits` prefix is an alias of the same wikilinks router.

### AI configuration (providers, MCP, skills)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/providers` | Auth (`provider:read`) | List LLM/embedding providers |
| POST/PUT/DELETE | `/api/providers[...]` | Auth (`provider:write`) | Provider CRUD |
| GET | `/api/providers/models/available` | Auth (`provider:read`) | Models available for configuration |
| GET | `/api/providers/:id/models` | Auth (`provider:read`) | Models of a provider |
| PUT | `/api/providers/:id/set-default` | Auth (`provider:read`) | Set default provider |
| GET | `/api/provider-presets` | Auth (`provider:read`) | Curated provider presets |
| POST | `/api/provider-presets/:presetId/install` | Auth (`provider:write`) | Install a preset |
| GET/POST/PUT/DELETE | `/api/mcp-connections[...]` | Admin | MCP server connections CRUD |
| POST | `/api/mcp-connections/:connectionId/toggle` | Admin | Enable/disable a connection |
| POST | `/api/mcp-connections/:connectionId/test` | Admin | Probe a connection |
| GET | `/api/mcp-connections/statuses` | Admin | Live connection statuses |
| GET | `/api/mcp-marketplace` | Auth | Marketplace catalog |
| POST | `/api/mcp-marketplace/:entryId/install` | Admin | Install a marketplace entry |
| POST | `/api/mcp-marketplace/:entryId/uninstall` | Admin | Uninstall |
| GET | `/api/agent/skills` | Auth | Built-in agent skills |
| GET/POST/DELETE | `/api/chats/:chatId/pins[...]` | Auth | MCP tool pins per chat |

An MCP server (for external MCP clients) is mounted at `GET /api/mcp/sse` and `POST /api/mcp/message` (`packages/server/src/agent/mcpServer.ts`).

### Memories

Per-user, per-workspace memory CRUD with GDPR export/erase (`memory:read` / `memory:write` permissions; export/erase are self-service for any authenticated user).

| Method | Path | Description |
|---|---|---|
| GET | `/api/memories` | List memories for current user/workspace |
| POST | `/api/memories` | Create memory |
| GET/PATCH/DELETE | `/api/memories/:id` | Memory detail, update, delete |
| GET | `/api/memories/export` | GDPR export of own memories |
| DELETE | `/api/memories` | GDPR erase of own memories |

### Widgets

Admin-side management (`/api/widgets`, Admin + `widget_enabled` feature) and the widget-service-facing internal API (`/api/internal/widget`, API-key auth + `widget_enabled` feature; the whole router returns 402 when the feature is off).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/widgets` | Admin | List widgets |
| POST | `/api/widgets` | Admin (`widget_enabled`, `max_widgets` limit) | Create widget |
| GET/PUT/DELETE | `/api/widgets/:id` | Admin | Widget detail, config update, delete |
| PUT/GET | `/api/widgets/:id/workspaces` | Admin | Assign/list workspaces for a widget |
| GET | `/api/widgets/:id/leads` | Admin | Leads captured by a widget |
| GET | `/api/widgets/:id/leads/export` | Admin | Export leads (CSV) |
| GET | `/api/widgets/:id/leads/:leadId` | Admin | Lead detail |
| GET | `/api/widgets/analytics/daily` | Admin | Daily widget analytics |
| GET | `/api/widgets/analytics/topics` | Admin | Topic analytics |
| GET | `/api/widgets/analytics/summary` | Admin | Aggregate analytics |
| POST | `/api/internal/widget/chat/stream` | API key | SSE chat stream for the widget proxy |
| POST | `/api/internal/widget/search` | API key | RAG search for the widget |
| POST | `/api/internal/widget/lead` | API key (rate limited) | Lead capture |
| GET | `/api/internal/widget/:id/config` | API key | Widget embed configuration |
| POST | `/api/internal/widget/session` | API key | Create a widget session |
| GET | `/api/internal/widget/session/:token` | API key | Read session |
| PATCH | `/api/internal/widget/session/:token/increment` | API key | Increment message counters |
| PATCH | `/api/internal/widget/session/:token/chat/archive` | API key | Link/unlink a chat to an archive |

### Misc

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/templates` | Auth | Workspace templates |
| POST | `/api/templates` | Auth | Create template |
| PUT/DELETE | `/api/templates/:templateId` | Admin | Update/delete template |
| GET | `/api/webhooks` | Admin | Outgoing webhooks |
| POST/PUT/DELETE | `/api/webhooks[...]` | Admin | Webhook CRUD |
| POST | `/api/webhooks/:webhookId/test` | Admin | Send a test event |
| GET | `/api/__tests__/*` | None (dev only) | E2E helpers — mounted only when `NODE_ENV !== "production"`; production boots 404 |

### Enterprise plugin routes

When the `@simmetric-chat/enterprise` package is installed and a valid `LICENSE_KEY` is present, the enterprise plugin mounts additional routers via the plugin loader (`packages/server/src/services/enterpriseLoader.ts`): `/api/enterprise` (protected), `/api/sso` (protected), SAML/OIDC callbacks under `/api/auth` (public), and SCIM under `/scim/v2` (public, Bearer token). In a community build these paths 404. Enterprise features are additionally gated per-route with the `402 { error, feature, tier }` shape. See `docs/ENTERPRISE_PLUGIN.md` for the plugin contract.

## SSE chat streaming protocol

`POST /api/workspaces/:workspaceId/chat/stream` (and the widget proxy `POST /api/internal/widget/chat/stream`) respond with `text/event-stream`. Events use the standard `event: <type>\ndata: <json>\n\n` framing. Source of truth: `handleChatStream` in `packages/server/src/routes/chat.ts`; the widget service proxies the same event format.

| Event | Data | Purpose |
|---|---|---|
| `status` | `{ "message": string }` | Pipeline stage updates (retrieval, tools, ...) |
| `plan` | Agent plan object | ReAct plan announcement |
| `thinking` | `{ "content": string }` | Streaming model reasoning prefix |
| `token` | `string` | Incremental answer token |
| `wiki_edit` | Edit payload | Proposed wiki page edit (wiki-chat flows) |
| `citations` | `{ "sources": [...] }` | RAG citations for the final answer |
| `done` | Metadata object (below) | Terminal success event |
| `error` | `{ "error": string }` | Terminal failure event |

The `done` payload includes: `chatId`, `messageId`, `iterations`, `tokenUsage`, `model`, `providerType`, `mcpSources`, `resolvedWikilinks`, optional `dlp_matches` (only when DLP is enabled and matches were found), optional `doneReason`, and `pipeline` (which tools were called and whether sources were found).

Scaling note: when `REDIS_URL` is configured, each SSE event is also published to `sse:chat:{chatId}` so clients connected to other server instances behind a load balancer receive the stream; without Redis, SSE is single-instance.

## Discovering the API live

- Swagger UI: `http://localhost:3000/api-docs`
- OpenAPI JSON: `http://localhost:3000/api-docs/json`

The Swagger spec is generated from JSDoc annotations in the route files (`packages/server/src/config/swagger.ts`). Route files are the authoritative reference when this page and the code disagree.