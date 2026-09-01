
# API Reference

Simmetric Chat exposes a RESTful HTTP API from the server package (`packages/server`) on port `3000`. The API supports JSON request/response bodies, multipart file uploads, and Server-Sent Events (SSE) for streaming chat responses. All endpoints share a consistent error envelope and are documented via Swagger/OpenAPI 3.0. The server also hosts an **MCP server** (`/api/mcp/sse`) exposing RAG search over the Model Context Protocol, and optionally mounts **enterprise plugin** routers (`/api/enterprise`, `/api/sso`, `/scim/v2`, backups) when `@simmetric-chat/enterprise` is installed at boot.

Two additional services expose their own HTTP surfaces:
- **Collector** (`packages/collector`, port `3210`) — parse/chunk/embed/store pipeline. HTTP-only, no database access, gated by `COLLECTOR_SECRET`. Called by the server; not intended for end users.
- **Widget service** (`packages/widget`, port `3211`) — embeddable chat widget. Serves the Preact IIFE bundle and proxies chat/session/lead traffic to the server's internal widget API.

The API is designed for three audiences:

- **Frontend** — authenticated users interacting via the React SPA.
- **External integrations** — API key-based access for scripts and third-party tools.
- **Embeddable widgets** — anonymous visitor chat via the widget service, authenticated via API keys and session tokens.

## Base URL

```text
http://localhost:3000/api
```

<!-- VERIFY: Production base URL depends on deployment (Docker, Nginx, etc.) -->

Collector: `http://localhost:3210/api` · Widget service: `http://localhost:3211`

## Authentication

The API supports two authentication schemes. Both populate `req.userId` and `req.user` for downstream middleware.

### JWT Bearer Tokens

Obtained from `POST /api/auth/login`. Include the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer <jwt_token>" http://localhost:3000/api/auth/me
```

- Tokens are signed with `JWT_SECRET` and carry a `jti` (UUID) claim for Redis-backed revocation when `REDIS_URL` is configured.
- Default expiry is 24 hours (`SESSION_EXPIRY`, Zod-validated default `86400000` ms).
- Refresh is not implemented; users must re-login after expiry.

### API Keys

API keys are generated via `POST /api/api-keys` and have a `sk-` prefix. Include the key in the `X-Api-Key` header:

```bash
curl -H "X-Api-Key: sk-xxxxxxxx" http://localhost:3000/api/workspaces/:id/chat
```

- Keys are verified via keyed **HMAC-SHA256** (`API_KEY_HMAC_SECRET`, base64 32-byte): the lookup is a single indexed `findUnique({ key_hash })` — constant-time at the DB index layer ( SCALE-03). The raw key is shown only once at creation.
- An 8-character display `prefix` is stored for the UI list view; a wrong-length or missing `API_KEY_HMAC_SECRET` fails loud with a `500` (misconfiguration is never reported as `401 invalid key`).
- The `lastUsed` timestamp is updated on every successful request.

### Collector Secret

Server ↔ collector callbacks use a shared secret passed in the `X-Collector-Secret` header. The secret is validated against `COLLECTOR_SECRET` (Zod-validated, min 1 char) in `packages/server/src/config/env.ts` and `packages/collector/src/config/env.ts`. Only the server and the collector are legitimate callers of secret-gated endpoints.

## Response Format Conventions

### Success

| Method | Pattern | Status | Example Response |
|--------|---------|--------|------------------|
| GET | Return entity or array | `200 OK` | `res.json(data)` |
| POST create | Return created resource | `201 Created` | `res.status(201).json(result)` |
| POST action | Return success message | `200 OK` | `res.json({ message: "Success" })` |
| PUT | Return updated resource | `200 OK` | `res.json({ updated: [...], rejected: [...] })` for settings |
| DELETE | Return confirmation | `200 OK` | `res.json({ message: "Deleted successfully" })` |

Asynchronous dispatch endpoints (e.g. archive import, OCR) return `202 Accepted` with a job descriptor and require polling a status endpoint.

### Errors

All errors return a JSON envelope:

```json
{ "error": "Human-readable message" }
```

Validation errors include a `details` field:

```json
{
"error": "Invalid request body",
"details": {
"fieldName": ["Expected string, received number"]
}
}
```

## Error Codes

| Status | Meaning | Typical Triggers |
|--------|---------|------------------|
| `400` | Bad Request | Zod validation failure, missing required fields, malformed JSON |
| `401` | Unauthorized | Missing or invalid JWT, missing API key, expired session, invalid `X-Collector-Secret` |
| `402` | Payment Required | License feature gate blocked (`requireFeature` or `requireFeatureLimit`) |
| `403` | Forbidden | Insufficient RBAC permissions, admin-only endpoint, origin not allowed (widget CORS), `set-initial-password` used outside forced rotation |
| `404` | Not Found | Entity not found (Prisma `P2025`), invalid UUID param |
| `409` | Conflict | Duplicate resource (Prisma `P2002`), already installed marketplace entry, system already initialized, draft already finalized |
| `422` | Unprocessable Entity | OAuth provider preset install attempted via the one-click path (manual configuration required) |
| `429` | Too Many Requests | Rate limit exceeded; standard `RateLimit-*` headers emitted, widget limiters add a `retryAfter` field |
| `500` | Internal Server Error | Unhandled exception, agent execution failure, database error |
| `502` | Bad Gateway | Upstream service failure (e.g., OCR model pre-warm failed) |

Feature-gated errors (`402`) include additional fields:

```json
{
"error": "This feature requires an Enterprise license",
"feature": "webhooks",
"tier": "community"
}
```

Numeric limit errors (`402`) also include `limit` and `current`:

```json
{
"error": "widget limit reached. Your plan allows up to 1 widgets.",
"feature": "max_widgets",
"limit": 1,
"current": 1,
"tier": "community"
}
```

## Rate Limiting

Rate limits are enforced by `express-rate-limit` (v8, `standardHeaders` on) with Redis stores when `REDIS_URL` is configured (`rate-limit-redis`, per-limiter prefixes) and in-memory fallback otherwise.

| Group | Window | Max (Production) | Max (Development) | Key |
|-------|--------|------------------|-------------------|-----|
| General API (server `apiRateLimiter`) | 1 minute | 200 req/min | 2,000 req/min | Client IP |
| Auth endpoints (server `authRateLimiter`) | 1 minute | 10 req/min | 100 req/min | Client IP |
| Wizard probes (server `probeRateLimiter`) | 1 minute | 10 req/min | 100 req/min | Client IP |
| Widget lead submission (server `widgetLeadLimiter`) | 1 hour | 3 req/hour | 30 req/hour | Client IP |
| Widget service chat burst (widget `widgetChatLimiter`) | 1 minute | 30 req/min (per-widget config override via Redis cache) | 200 req/min | widgetId (from URL) |
| Widget daily message budget (widget `widgetDailyMessageLimiter`) | 24 hours | 5/day (per-widget config override) | 50/day | widgetId + IP |
| Widget session create (widget `widgetSessionLimiter`) | 24 hours | 50 req/day | 500 req/day | Client IP |
| Widget service lead (widget `widgetLeadLimiter`) | 1 hour | 3 req/hour | 30 req/hour | Client IP |

Skip rules (code-verified in `packages/server/src/middleware/rateLimit.ts`):

- **`authRateLimiter`** skips requests when `E2E_RUN=1` (set by `playwright.config.ts` on the spawned server only — never in `pnpm dev`, `pnpm start`, or production). It also skips GET requests in development (e.g. `GET /auth/me` polling).
- **`apiRateLimiter`** (general API) skips any request carrying an `X-Widget-Id` header — all widget→server upstream calls include it (`packages/widget/src/routes/chat.ts`), because every widget shares the widget service's IP and would otherwise exhaust the shared per-IP bucket before the per-widget limiter does. The widget service's own `widgetChatLimiter` is the authoritative throttle for that traffic.
- The general limiter still serves as the coarse global safety net; the removed `chatRateLimiter` was replaced by the agent's own budget enforcement (`AgentBudgetTracker`: per-user concurrency, token budget, wallclock timeout).
- Development limits are 10× the production values.
- The collector has **no upload rate limiter** — it is an internal microservice and every mutating route is already gated by `requireCollectorSecret`; the old 10/min per-IP cap throttled legitimate bulk archive imports (all server traffic shares one IP).
- Widget chat limiter is keyed on the widget id derived from the URL path (`req.originalUrl`), not the inbound `X-Api-Key` header (which is an outbound proxy header the widget service adds upstream).
- Widget `429` bodies include a `retryAfter` hint; server limiters emit standard `RateLimit-*` headers.

## SSE Streaming Protocol

The streaming chat endpoint (`POST /api/workspaces/:workspaceId/chat/stream`) returns `text/event-stream`. Each event follows the format:

```text
event: <type>
data: <json_or_string>

```

### Event Types

| Event | Data Shape | Description |
|-------|------------|-------------|
| `token` | `string` | A single LLM output token (or the full DLP-redacted response in one event) |
| `status` | `{ message: string }` | Tool execution status update (e.g., "Searching documents...") |
| `citations` | `{ sources: SourceCitation[] }` | RAG source citations with relevance scores |
| `done` | `{ chatId, messageId, iterations, tokenUsage, model, providerType, mcpSources, resolvedWikilinks, dlp_matches?, doneReason?, pipeline? }` | Stream complete; includes metadata about the model used, MCP sources, optional DLP matches, per-provider termination reason, and pipeline info |
| `error` | `{ error: string }` | Agent execution error delivered inline |
| `wiki_edit` | `{ pageId, slug, title, content }` | Wiki page edit event forwarded from skills |

### Headers

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

The server handles client disconnect via `req.on("close")` and aborts the LLM stream using an `AbortController`.

## Swagger / OpenAPI

Interactive API documentation is served at:

- **Swagger UI**: `GET /api-docs`
- **Raw OpenAPI JSON**: `GET /api-docs/json`

The spec is auto-generated from JSDoc `@openapi` annotations in `packages/server/src/routes/*.ts`. The swagger config (`src/config/swagger.ts`) defines security schemes for Bearer JWT (`bearerAuth`) and API Key (`apiKeyAuth` via `X-Api-Key`), plus `Error` and `FeatureRequired` schema components. The stack is `swagger-jsdoc` 6.x + `swagger-ui-express` 5.x ( DEP-04 kept the stack on 6.x, audit-only). Both endpoints are mounted unconditionally in `createApp()`; there is no env gate in code.

<!-- VERIFY: In production deployments behind a reverse proxy, operators may choose to block /api-docs at the proxy layer — there is no in-app gate -->

## Endpoints Overview

### Auth (`/api/auth`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| POST | `/auth/register` | No (open if `ALLOW_REGISTRATION=true`; otherwise `admin:settings` Bearer) | Register a new user. Self-service registration is disabled by default; admin token required when `ALLOW_REGISTRATION=false`. |
| POST | `/auth/admin-register` | Bearer + Admin | Admin-only user creation with optional role assignment |
| POST | `/auth/login` | No | Login and obtain JWT token |
| GET | `/auth/sso/status` | No | Public SSO availability status for the login page (booleans/enums only — never secrets) |
| GET | `/auth/me` | Bearer | Get current user with roles, permissions, and `mustChangePassword` flag |
| GET | `/auth/users` | Bearer + Admin | List all users (admin only) |
| POST | `/auth/change-password` | Bearer | Change own password (requires current password) |
| POST | `/auth/set-initial-password` | Bearer | Set a new password during the forced first-login rotation. Only usable when `mustChangePassword=true`; clears the flag atomically. Returns 403 when the flag is already cleared. |
| POST | `/auth/admin-reset-password` | Bearer + Admin | Admin resets a user's password |

### Users (`/api/users`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/users` | Bearer + Admin | List all users |
| GET | `/users/:id` | Bearer (self or admin) | Get a single user profile |
| PUT | `/users/:id` | Bearer (self or admin) | Update user profile |
| PATCH | `/users/:id` | Bearer (self or admin) | Partial update user profile |
| POST | `/users/:id/avatar` | Bearer (self or admin) | Upload avatar image |
| DELETE | `/users/:id/avatar` | Bearer (self or admin) | Remove avatar |
| DELETE | `/users/:id` | Bearer + Admin | Delete user (cannot delete self) |

### Roles (`/api/roles`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/roles/me/menu-sections` | Bearer | Get visible menu sections for current user |
| GET | `/roles` | Bearer + Admin | List all roles with permissions |
| POST | `/roles` | Bearer + Admin | Create a new role |
| PUT | `/roles/:roleId` | Bearer + Admin | Update role permissions and metadata |
| PUT | `/roles/:roleId/menu-sections` | Bearer + Admin | Replace menu sections for a role |
| DELETE | `/roles/:roleId` | Bearer + Admin | Delete a non-default role |
| POST | `/roles/assign` | Bearer + Admin | Assign a role to a user |
| POST | `/roles/revoke` | Bearer + Admin | Revoke a role from a user |

### Projects (`/api/projects`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/projects` | Bearer | List accessible projects |
| POST | `/projects` | Bearer + `project:create` | Create a project (gated by `max_projects` limit) |
| GET | `/projects/:projectId` | Bearer + Project Access | Get project details |
| GET | `/projects/:projectId/usage` | Bearer + Project Access | Get project resource usage counts (IDOR-safe) |
| PUT | `/projects/:projectId` | Bearer + Project Access | Update a project |
| DELETE | `/projects/:projectId` | Bearer + Project Access | Soft-delete a project |
| POST | `/projects/:projectId/access` | Bearer + Project Access | Grant user access to project |
| DELETE | `/projects/:projectId/access` | Bearer + Project Access | Revoke user access from project |
| GET | `/projects/:projectId/export` | Bearer + Project Access | Export project metadata (no file contents) |

### Workspaces (`/api/workspaces`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/workspaces` | Bearer | List accessible workspaces |
| POST | `/workspaces` | Bearer + `workspace:create` | Create a workspace (gated by `max_workspaces` limit) |
| GET | `/workspaces/:workspaceId` | Bearer + Workspace Access | Get workspace details |
| PUT | `/workspaces/:workspaceId` | Bearer + Workspace Access | Update a workspace |
| DELETE | `/workspaces/:workspaceId` | Bearer + Workspace Access | Soft-delete a workspace |
| PUT | `/workspaces/:workspaceId/restore` | Bearer + Workspace Access | Restore a soft-deleted workspace |
| POST | `/workspaces/:workspaceId/access` | Bearer + Workspace Access | Grant workspace access |
| GET | `/workspaces/:workspaceId/folders` | Bearer + Workspace Access | List chat folders |
| POST | `/workspaces/:workspaceId/folders` | Bearer + Workspace Access | Create a chat folder |
| PUT | `/workspaces/:workspaceId/folders/:folderId` | Bearer + Workspace Access | Rename a folder |
| DELETE | `/workspaces/:workspaceId/folders/:folderId` | Bearer + Workspace Access | Soft-delete a folder (with optional cascade) |
| PUT | `/workspaces/:workspaceId/folders/:folderId/restore` | Bearer + Workspace Access | Restore a deleted folder |

### Documents (`/api/documents`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/documents` | Bearer | List accessible documents (filter by `?workspaceId=`) |
| POST | `/documents/upload` | Bearer + `document:write` | Legacy direct upload (multipart, max 100MB). Prefer the unified `/api/uploads` flow. |
| GET | `/documents/:documentId` | Bearer | Get document details with chunks |
| PUT | `/documents/:documentId/status` | `X-Collector-Secret` | Update processing status (collector callback; constant-time secret comparison, `401` on mismatch) |
| DELETE | `/documents/:documentId` | Bearer + `document:delete` | Soft-delete a document |

### Uploads (`/api/uploads`)

unified upload backend. Files are staged as `UploadDraft` rows (with on-disk file or URL sentinel) and dispatched to one or both legs (RAG + Knowledge Base) via the assign route.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| POST | `/uploads` | Bearer + `document:write` | Stage a draft. Multipart (`file`) for binary uploads, JSON body for `sourceType: "url"` URL drafts. Validates workspace access and (for URL drafts) archive ownership. Returns the draft descriptor without `filePath`. |
| POST | `/uploads/:id/assign` | Bearer + `document:write` + `archive:write` | Dispatch a staged draft to the RAG leg, the KB leg (requires `archiveId`), or both. Enforces image-vs-RAG and KB MIME eligibility before dispatch. Returns per-leg settle status. |
| GET | `/uploads/pending` | Bearer + `document:read` | List all caller-owned drafts in a workspace across the full lifecycle (`?workspaceId=`). Frontend splits by `parseStatus` client-side. |
| PATCH | `/uploads/:id` | Bearer + `document:write` | Rename a draft (display name only; non-destructive; allowed in any `parseStatus`). Owner-only IDOR (404 hides existence). |
| DELETE | `/uploads/:id` | Bearer + `document:write` | Soft-delete a draft. Owner-only IDOR (404 hides existence). Rejects in-flight drafts with 409. Best-effort on-disk unlink under a prefix guard. |

### Chat & Agent (`/api/workspaces`, `/api/agent`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| POST | `/workspaces/:workspaceId/chat` | Bearer + Workspace Access | Non-streaming chat message |
| POST | `/workspaces/:workspaceId/chat/stream` | Bearer + Workspace Access | SSE streaming chat message |
| GET | `/workspaces/:workspaceId/chats` | Bearer + Workspace Access | List chats in workspace |
| GET | `/workspaces/:workspaceId/chats/export` | Bearer + Workspace Access | Export all workspace chats as JSON |
| GET | `/workspaces/:workspaceId/chats/:chatId/messages` | Bearer + Workspace Access | Get chat messages |
| PUT | `/workspaces/:workspaceId/chats/:chatId` | Bearer + Workspace Access | Rename a chat |
| PATCH | `/workspaces/:workspaceId/chats/:chatId/model` | Bearer + Workspace Access | Update per-chat model selection |
| PUT | `/workspaces/:workspaceId/chats/:chatId/move` | Bearer + Workspace Access | Move chat to a folder |
| DELETE | `/workspaces/:workspaceId/chats/:chatId` | Bearer + Workspace Access | Soft-delete a chat |
| DELETE | `/workspaces/:workspaceId/chats/:chatId/messages/:messageId` | Bearer + Workspace Access | Delete a single message |
| PUT | `/workspaces/:workspaceId/chats/:chatId/messages/:messageId` | Bearer + Workspace Access | Edit a single message |
| POST | `/workspaces/:workspaceId/chats/:chatId/pin` | Bearer + Workspace Access | Pin a chat |
| DELETE | `/workspaces/:workspaceId/chats/:chatId/pin` | Bearer + Workspace Access | Unpin a chat |
| GET | `/workspaces/:workspaceId/chats/:chatId/export` | Bearer + Workspace Access | Export single chat as JSON |
| POST | `/workspaces/:workspaceId/chats/import/preview` | Bearer + Workspace Access | Preview chat import from JSON (multipart file) |
| POST | `/workspaces/:workspaceId/chats/import/confirm` | Bearer + Workspace Access | Confirm and import chats (multipart file) |
| GET | `/workspaces/:workspaceId/chats/:chatId/tokens` | Bearer + Workspace Access | Token usage for a single chat |
| GET | `/workspaces/:workspaceId/tokens/today` | Bearer + Workspace Access | Today's token usage for the workspace |
| GET | `/workspaces/:workspaceId/agent-config` | Bearer + Workspace Access | Get workspace agent config |
| PUT | `/workspaces/:workspaceId/agent-config` | Bearer + Workspace Access | Update workspace agent config (no server-side license gate on this route; `custom_agents` is a numeric limit, Community default 3 — enforced frontend-side via `useFeatureLimit`) |
| GET | `/agent/skills` | Bearer | List all available skills |

### API Keys (`/api/api-keys`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/api-keys` | Bearer | List current user's API keys (id, name, display prefix, `lastUsed`, `expiresAt`, `createdAt` — digests never exposed; ordered `createdAt desc`) |
| POST | `/api-keys` | Bearer | Generate a new API key. Body: `name` (required), optional `expiresInDays` (number) or `expiresAt` (ISO date string). Returns the raw key **once** in the `key` field. Creation is guarded by a bounded P2002 retry: on a display-prefix unique-constraint collision the whole key is regenerated and retried, up to **3 attempts**; after exhaustion a clear error is returned ("display-prefix collision on api_keys.prefix after 3 attempts — delete/rename the conflicting key's prefix or retry key creation"). |
| DELETE | `/api-keys/:keyId` | Bearer | Revoke (hard-delete) an API key. Owner-scoped lookup: another user's key id (or an unknown id) returns `404 { "error": "API key not found" }`; other failures return the standard `500 { error }` shape. Success: `{ "message": "API key revoked" }`. |

### Providers (`/api/providers`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/providers/models/available` | Bearer + `provider:read` | List available models for chat selector |
| GET | `/providers` | Bearer + `provider:read` | List all providers |
| GET | `/providers/:id` | Bearer + `provider:read` | Get single provider |
| POST | `/providers` | Bearer + `provider:write` | Create a provider |
| PUT | `/providers/:id` | Bearer + `provider:write` | Update a provider |
| DELETE | `/providers/:id` | Bearer + `provider:write` | Delete a provider |
| PUT | `/providers/:id/set-default` | Bearer + `provider:read` | Set default provider |
| GET | `/providers/:id/models` | Bearer + `provider:read` | List models for a provider |
| POST | `/providers/:id/models/refresh` | Bearer + `provider:write` | Refresh model list from provider API |
| POST | `/providers/:providerId/models/pull` | Bearer + `provider:write` | Pull/download an Ollama model (SSE progress) |
| PUT | `/providers/:providerId/models/:modelId` | Bearer + `provider:write` | Update model settings |
| PUT | `/providers/:providerId/models/:modelId/set-default` | Bearer + `provider:read` | Set a model as the provider's default |
| DELETE | `/providers/:providerId/models/:modelId` | Bearer + `provider:write` | Delete a model |

### Provider Presets (`/api/provider-presets`)

One-click install catalog of OpenAI-compatible providers. OAuth presets are manual-only and return `422` on the install path.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/provider-presets` | Bearer + `provider:read` | List all presets, augmented with `isInstalled` (Provider with the same name exists) |
| GET | `/provider-presets/:presetId` | Bearer + `provider:read` | Get a single preset detail |
| POST | `/provider-presets/:presetId/install` | Bearer + `provider:write` | Install a preset as a Provider. `baseUrl` comes from the seeded preset (not the request body). API key (optional) is encrypted at rest. Returns `409` if a provider with the resolved name already exists, `422` for OAuth presets. |

### MCP Connections (`/api/mcp-connections`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/mcp-connections` | Bearer + Admin | List all MCP connections |
| GET | `/mcp-connections/statuses` | Bearer + Admin | Live runtime connection statuses |
| POST | `/mcp-connections` | Bearer + Admin | Create an MCP connection |
| PUT | `/mcp-connections/:connectionId` | Bearer + Admin | Update an MCP connection (auto-reconnects if enabled) |
| DELETE | `/mcp-connections/:connectionId` | Bearer + Admin | Delete an MCP connection |
| POST | `/mcp-connections/:connectionId/toggle` | Bearer + Admin | Enable/disable a connection |
| POST | `/mcp-connections/:connectionId/test` | Bearer + Admin | Test connection (10s timeout) |

### MCP Marketplace (`/api/mcp-marketplace`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/mcp-marketplace` | Bearer | List catalog entries (`?search=`, `?category=`, `?workspaceId=`) |
| GET | `/mcp-marketplace/:entryId` | Bearer | Get catalog entry detail |
| POST | `/mcp-marketplace` | Bearer + Admin | Create a catalog entry (admin/seed) |
| POST | `/mcp-marketplace/:entryId/install` | Bearer + Admin | Install to workspace |
| POST | `/mcp-marketplace/:entryId/uninstall` | Bearer + Admin | Uninstall from workspace |

### MCP Pins (`/api/chats`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/chats/:chatId/pins` | Bearer + Workspace Member | List pinned MCP connections for a chat |
| POST | `/chats/:chatId/pins` | Bearer + Workspace Member | Pin an MCP connection to a chat |
| DELETE | `/chats/:chatId/pins/:pinId` | Bearer + Workspace Member | Remove an MCP pin |

### Templates (`/api/templates`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/templates` | Bearer | List all workspace templates |
| GET | `/templates/:templateId` | Bearer | Get a single template |
| POST | `/templates` | Bearer | Create a custom template (any authenticated user; requires `slug`, `name`, `systemPrompt`) |
| PUT | `/templates/:templateId` | Bearer + Admin | Update a custom template |
| DELETE | `/templates/:templateId` | Bearer + Admin | Delete a custom template |

### Widgets (`/api/widgets`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/widgets` | Bearer + Admin | List all widgets |
| POST | `/widgets` | Bearer + Admin + `widget_enabled` feature + `max_widgets` limit | Create a widget |
| GET | `/widgets/:id` | Bearer + Admin | Get widget details |
| PUT | `/widgets/:id` | Bearer + Admin | Update a widget |
| DELETE | `/widgets/:id` | Bearer + Admin | Soft-delete a widget |
| PUT | `/widgets/:id/workspaces` | Bearer + Admin | Set workspace whitelist |
| GET | `/widgets/:id/workspaces` | Bearer + Admin | List linked workspaces |
| GET | `/widgets/:id/leads` | Bearer + Admin | List widget leads (paginated) |
| GET | `/widgets/:id/leads/export` | Bearer + Admin | Export leads as CSV (the `lead_export` commodity flag was removed in — always-ON) |
| GET | `/widgets/:id/leads/:leadId` | Bearer + Admin | Get single lead with transcript |
| GET | `/widgets/analytics/daily` | Bearer + Admin | Daily conversation counts |
| GET | `/widgets/analytics/topics` | Bearer + Admin | Topic distribution |
| GET | `/widgets/analytics/summary` | Bearer + Admin | Aggregate metrics |

### Internal Widget API (`/api/internal/widget`)

All internal widget endpoints require `X-Api-Key` header (API key auth) and are protected by dynamic CORS (`widgetCors` middleware) which validates the `Origin` header against the widget's `allowedOrigins` allowlist.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/internal/widget/:id/config` | API Key | Get widget config (branding, workspaces, lead capture) |
| POST | `/internal/widget/session` | API Key | Create anonymous session (256-bit hex token, 24h expiry) |
| GET | `/internal/widget/session/:token` | API Key | Validate session and return rate limit status |
| PATCH | `/internal/widget/session/:token/increment` | API Key | Increment message/conversation counters |
| PATCH | `/internal/widget/session/:token/chat/archive` | API Key | Archive a chat for the session (D-10 widget API-key path) |
| POST | `/internal/widget/search` | API Key | Multi-workspace hybrid RAG search |
| POST | `/internal/widget/lead` | API Key | Submit a lead (rate-limited: 3/hour/IP) |

Widget sessions enforce anonymous visitor rate limits:
- **Hourly**: 20 messages per session (`hourlyRemaining` is returned in the session status response)
- **Daily**: 5 conversations per session (`conversationCount` capped at 5)
- **Daily messages (visitor-level)**: enforced by the widget service's `widgetDailyMessageLimiter` (per-widget + per-IP, default 5/day prod; per-widget override via `sessionLimitPerDay`)

### Enterprise plugin mounts

Community route files own the routers below; the enterprise package (`@simmetric-chat/enterprise`, a separate private repo) registers additional routers at boot through the plugin loader (`packages/server/src/services/enterpriseLoader.ts`). When the plugin is absent (community build), these paths return `404` — the server logs "Community build — no enterprise package found" at info level and continues. **Every** `mountProtected` path is gated by the community `authMiddleware`: a missing or invalid `Authorization: Bearer <jwt>` returns `401`.

| Mount | Auth | Description |
|-------|------|-------------|
| `/api/enterprise` | Bearer JWT (via `mountProtected`) | Plugin health check (`{ status: "ok", enterprise: true }`) |
| `/api/enterprise/modules` | Bearer JWT | JSON manifest of the loaded enterprise modules (SSO, audit log, branding, backup). `402` when the license JWT is missing/invalid. |
| `/api/sso` | Bearer JWT + Admin + `sso_enabled` feature | SSO configuration CRUD + connection test (moved from community in ) |
| `/api/auth/*` (SAML/OIDC callbacks) | **Public** (via `mountPublic` — IdP-initiated, no community authMiddleware) | SAML/OIDC assertion/callback endpoints; issue a core JWT via `ctx.generateToken` on success |
| `/scim/v2` | Public mount, **own** `scimAuth` Bearer token | SCIM 2.0 user provisioning (applies its own token middleware, not the community JWT) |
| `/api/event-logs` | Bearer + Admin + `audit_log_immutable` feature | Query audit event logs (`?entityType=`, `?entityId=`, `?userId=`, `?limit=`, `?offset=`) |
| `/api/system/settings/branding` | Bearer + Admin + `white_label` feature | White-label branding settings (`BRANDING_*` keys); rejected via the settings validator in community builds |
| `/api/system/backups`, `/api/backup-destinations`, `/api/backup-jobs`, `/api/backups` | Bearer + `backup:*` permissions | Backup logs / destinations / jobs / restore (Backups section below) |

The loader is the only community↔enterprise seam: enterprise routes are mounted AFTER `initLicense()` and BEFORE the 404 catch-all, so they resolve normally. `<!-- VERIFY: exact enterprise route paths beyond the mount prefixes are defined in the private enterprise repo -->`

### SSO status (community)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/auth/sso/status` | No | Public SSO availability (no auth) — see [Auth](#auth-apiauth) |

The admin SSO configuration endpoints (`GET/PUT /sso/config`, `POST /sso/test`) are enterprise-plugin mounts under `/api/sso` — see the table above.

### Webhooks (`/api/webhooks`)

The `webhooks` commodity feature flag was removed in — webhooks are always-ON in all tiers. No license gate.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/webhooks` | Bearer + Admin | List all webhooks |
| POST | `/webhooks` | Bearer + Admin | Create a webhook |
| PUT | `/webhooks/:webhookId` | Bearer + Admin | Update a webhook |
| DELETE | `/webhooks/:webhookId` | Bearer + Admin | Delete a webhook |
| POST | `/webhooks/:webhookId/test` | Bearer + Admin | Send a test payload |

### Push Notifications (`/api/system/push`)

Push notifications are a core UX feature — no license gate on any endpoint.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/system/push/vapid-key` | Bearer | Get public VAPID key for frontend subscription |
| POST | `/system/push/subscribe` | Bearer | Register a push subscription |
| DELETE | `/system/push/subscribe` | Bearer | Unregister a push subscription |
| POST | `/system/push/test` | Bearer + Admin | Send a test push notification |

### Settings (`/api/system/settings`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/system/settings` | Bearer + Admin | Retrieve all system settings |
| PUT | `/system/settings` | Bearer + Admin | Update system settings. Body: `{ configs: [{ key, value }] }` (Zod `bulkSetConfigSchema`). Returns **partial success** `{ updated, rejected }` with `200` — per-key rejections are normal, refetch after save. Rejection sources: `chat_message_retention_days` (has a dedicated write path), `BRANDING_*` keys (rejected for non-Enterprise — either by the enterprise branding validator or the community fallback when no plugin is loaded), unknown/readonly keys, and plugin-validator denials. |
| GET | `/system/embedding-config` | Unauthenticated (collector use) | Active embedding provider config |
| GET | `/system/vector-db-config` | Unauthenticated (collector use) | Active vector DB provider config |

### System (`/api/system`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/system/is-initialized` | No | Check if system has an admin user (`{ initialized, setupWizardMode }`) |
| POST | `/system/initialize` | No | First-launch setup (admin + config; only while `setup_wizard_mode=active` — `409` once completed) |
| POST | `/system/probe-llm` | No (wizard-gated) | Probe the configured LLM endpoint for available models. SSRF-hardened (`assertSafeProbeUrl`), rate-limited by `probeRateLimiter` (10/min prod, 100/min dev). |
| POST | `/system/probe-vector` | No (wizard-gated) | Health-check the configured vector DB. Same SSRF hardening + rate limit as `/probe-llm`. |
| POST | `/system/reset-db` | Bearer + Admin | Reset database (requires `{ confirm: "RESET" }`) |
| POST | `/system/reindex-documents` | Bearer + Admin | Trigger re-indexing of all documents |
| POST | `/system/reembed-documents` | Bearer + Admin | Re-embed all document chunks with the active embedding provider |
| POST | `/system/ocr/prewarm` | Bearer + Admin | Pre-warm an OCR vision model |
| PUT | `/system/chat-retention` | Bearer + `admin:settings` | Configure `chat_message_retention_days`. Sole writer for this key (bypasses `updateSettings`). Body: `{ retentionDays: number | null, confirmDataLoss: true }`. Audited via `eventLogService`. |

### License (`/api/license`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/license/info` | No | Current license tier and feature flags |
| GET | `/license/diagnose` | Bearer + Admin | License diagnostics: verification verdict, tier, JWT structural booleans. The response is redacted — any occurrence of the `LICENSE_KEY` value is replaced with `[REDACTED]`. |

### Analytics (`/api/system/analytics`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/system/analytics/tokens` | Bearer + Admin | Daily token usage for date range (`?days=`) |
| GET | `/system/analytics/models` | Bearer + Admin | Token usage breakdown by model |
| GET | `/system/analytics/top-users` | Bearer + Admin | Most active users by token usage (`?limit=`) |

### Backups

The backup subsystem is split across four mount points, each with its own RBAC permission scope. **These routes are provided by the enterprise plugin** ( EPA-06) and are mounted via `ctx.mountProtected` — in a community build (no `@simmetric-chat/enterprise` package) all four paths return `404`. See [Enterprise plugin](#enterprise-plugin-mounts) below.

#### Backup Logs (`/api/system/backups`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/system/backups` | Bearer + `backup:log:read` | List all backup logs |
| POST | `/system/backups` | Bearer + `backup:log:read` | Trigger an on-demand backup |
| GET | `/system/backups/:backupName/download/:fileType` | Bearer + `backup:log:read` | Download backup file (`db`, `documents`, `vectors`) |

#### Backup Destinations (`/api/backup-destinations`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/backup-destinations` | Bearer + `backup:destination:read` | List destinations |
| POST | `/backup-destinations` | Bearer + `backup:destination:write` + `max_backup_destinations` limit | Create a destination (local disk, S3-compatible) |
| GET | `/backup-destinations/:id` | Bearer + `backup:destination:read` | Get destination detail |
| PUT | `/backup-destinations/:id` | Bearer + `backup:destination:write` | Update a destination |
| DELETE | `/backup-destinations/:id` | Bearer + `backup:destination:write` | Delete a destination |
| POST | `/backup-destinations/:id/test` | Bearer + `backup:destination:read` | Test destination connectivity |

#### Backup Jobs (`/api/backup-jobs`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/backup-jobs` | Bearer + `backup:job:read` | List scheduled backup jobs |
| POST | `/backup-jobs` | Bearer + `backup:job:write` | Create a scheduled backup job (cron + destination + encryption + compression + included data) |
| GET | `/backup-jobs/:id` | Bearer + `backup:job:read` | Get a single backup job |
| PUT | `/backup-jobs/:id` | Bearer + `backup:job:write` | Update a backup job |
| DELETE | `/backup-jobs/:id` | Bearer + `backup:job:write` | Delete a backup job |
| POST | `/backup-jobs/:id/toggle` | Bearer + `backup:job:write` | Enable/disable a backup job |
| POST | `/backup-jobs/:id/run` | Bearer + `backup:job:write` | Trigger an ad-hoc run of a scheduled job |
| GET | `/backup-jobs/:id/logs` | Bearer + `backup:log:read` | List execution logs for a job |

#### Restore (`/api/backups`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/backups` | Bearer + `backup:log:read` | List restoreable backup logs (status `success` or `restored`) |
| POST | `/backups/restore/:logId/dry-run` | Bearer + `backup:restore:write` | Pre-flight: download, verify SHA-256, list contents |
| POST | `/backups/restore/:logId` | Bearer + `backup:restore:write` | Execute the restore (requires explicit `RESTORE` confirmation) |

### Archives (`/api/archives`, `/api/archive-schema-templates`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/archives` | Bearer | List accessible archives |
| POST | `/archives` | Bearer + `archive:write` | Create an archive |
| GET | `/archives/:archiveId` | Bearer | Get archive details |
| PUT | `/archives/:archiveId` | Bearer + `archive:write` | Update an archive |
| DELETE | `/archives/:archiveId` | Bearer + `archive:delete` | Soft-delete an archive |
| POST | `/archives/from-template` | Bearer + `archive:write` | Create an archive from a schema template |
| POST | `/archives/:archiveId/reindex` | Bearer + `archive:write` | Re-index an archive's pages |
| POST | `/archives/:archiveId/index` | Bearer + `archive:write` | Trigger wiki vector consistency re-indexing |
| GET | `/archives/:archiveId/config` | Bearer + `archive:read` | Get archive config |
| PUT | `/archives/:archiveId/config` | Bearer + `archive:write` | Update archive config |
| DELETE | `/archives/:archiveId/config` | Bearer + `archive:delete` | Reset archive config |
| GET | `/archives/:archiveId/search` | Bearer | Search archive pages |
| GET | `/archives/:archiveId/graph` | Bearer + `archive:read` | Get archive link graph |
| GET | `/archives/:archiveId/export` | Bearer + `archive:read` | Export archive content |
| GET | `/archives/:archiveId/pages` | Bearer | List archive pages |
| POST | `/archives/:archiveId/pages` | Bearer + `archive:write` | Create a page |
| GET | `/archives/:archiveId/pages/:slug` | Bearer | Get a page by slug |
| PUT | `/archives/:archiveId/pages/:slug` | Bearer + `archive:write` | Update a page |
| DELETE | `/archives/:archiveId/pages/:slug` | Bearer + `archive:write` | Delete a page |
| POST | `/archives/:archiveId/copy-from-doc` | Bearer + `archive:write` | Copy a document (single `{ documentId }` or batch `{ documentIds: [] }`) into the archive as a page. `document:read` is verified on every source document (fail-closed batch). Returns `202` with a job descriptor. |
| GET | `/archives/import/:jobId` | Bearer + `archive:read` | Poll status of an `ArchiveImportJob`. Owner-or-admin IDOR (403 otherwise). Returns `{ id, archiveId, status, result, error }`. |
| PUT | `/archives/import/:jobId/callback` | `X-Collector-Secret` | Collector parse-result callback. Creates the `ArchivePage` on `completed`, flips the job to `FAILED` on `failed`. Never trusts the callback's archive claim — looks up the job by id. |
| GET | `/archive-schema-templates` | Bearer + `archive:read` | List schema templates |
| GET | `/archive-schema-templates/:id` | Bearer + `archive:read` | Get a schema template |
| POST | `/archive-schema-templates` | Bearer + Admin | Create a schema template |
| POST | `/archive-schema-templates/:id/apply` | Bearer + `archive:write` | Apply a schema template to an archive |

### OCR (`/api/archives`, `/api/ocr`)

OCR jobs are created under the archives mount (`/api/archives/:id/ocr...`); the model catalog and preferences live under `/api/ocr`.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/ocr/models` | Bearer + `archive:read` | List available OCR models |
| POST | `/ocr/preview` | Bearer + `archive:read` | Preview OCR output for a PDF without persisting a job |
| GET | `/ocr/preferences` | Bearer + `archive:read` | Get the caller's OCR preferences |
| POST | `/ocr/preferences` | Bearer + `archive:write` | Save the caller's OCR preferences |
| GET | `/ocr/defaults` | Bearer + `archive:read` | Get default OCR model/mode configuration |
| GET | `/archives/:id/jobs` | Bearer + `archive:read` | List OCR/URL jobs for an archive |
| GET | `/archives/:id/jobs/:jobId` | Bearer + `archive:read` | Get OCR/URL job detail |
| POST | `/archives/:id/jobs/:jobId/approve` | Bearer + `archive:write` | Approve a pending OCR/URL job |
| POST | `/archives/:id/jobs/:jobId/reject` | Bearer + `archive:write` | Reject a pending OCR/URL job |
| DELETE | `/archives/:id/jobs/:jobId` | Bearer + `archive:write` | Delete an OCR/URL job |
| GET | `/archives/:id/jobs/:jobId/pages/:pageNumber/image` | Bearer + `archive:read` | Get a rendered page image for review |

### Synthesis (`/api/synthesis`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/synthesis/status` | Bearer | Get synthesis pipeline status |
| GET | `/synthesis/pending/count` | Bearer | Count of pending synthesis runs |
| POST | `/synthesis/trigger` | Bearer + `archive:write` | Trigger a synthesis run for an archive |
| GET | `/synthesis/:runId` | Bearer | Get a synthesis run by id |
| POST | `/synthesis/:runId/approve` | Bearer + `archive:write` | Approve a pending synthesis run |
| POST | `/synthesis/:runId/reject` | Bearer + `archive:write` | Reject a pending synthesis run |
| DELETE | `/synthesis/:runId` | Bearer + `archive:write` | Cancel/delete a synthesis run |

### Wiki (`/api/wiki-write`, `/api/wikilinks`, `/api/wiki-edits`)

All wiki endpoints require authentication. The `/api/wiki-edits` mount is an alias of `/api/wikilinks`.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| POST | `/wiki-write/preview` | Bearer + `archive:write` | Preview a wiki distillation |
| POST | `/wiki-write/:runId/approve` | Bearer + `archive:write` | Approve a wiki distillation run |
| POST | `/wiki-write/:runId/reject` | Bearer + `archive:write` | Reject a wiki distillation run |
| POST | `/wiki-write/:runId/undo` | Bearer + `archive:write` | Undo an applied wiki distillation |
| GET | `/wiki-write/history/:archiveId` | Bearer + `archive:write` | List wiki distillation history for an archive |
| POST | `/wiki-write/distill` | Bearer + `archive:write` | Trigger a wiki distillation |
| GET | `/wikilinks/maintenance/:archiveId` | Bearer + `archive:write` | Get wiki link maintenance suggestions (`{ suggestions, mergeSuggestions }`) |
| POST | `/wikilinks/maintenance/:archiveId/merge` | Bearer + `archive:write` | Merge two pages into a new one (body: `{ pageA, pageB, title, slug? }`). Archive-scoped slug lookup (cross-archive returns 404). |
| POST | `/wikilinks/resolve` | Bearer | Batch-resolve wiki links (`{ slugs, archiveId }` → `{ resolved }`) |
| GET | `/wikilinks/:archiveId` | Bearer | List wiki links for an archive |
| GET | `/wikilinks/:archiveId/:pageSlug` | Bearer | Get wiki links for a page |
| GET | `/wiki-edits/...` | Bearer | Alias mount of `wikilinks` routes under `/api/wiki-edits` |

### URL Ingestion (removed)

The server-side URL-ingestion routes (`POST /ingest/url`, `GET /ingest/:jobId` — formerly `packages/server/src/routes/urlIngestion.ts`) were removed in commit `f3f52900` (dead route cleanup). URL ingestion now flows through the uploads/OCR pipeline (`packages/server/src/urlIngestion/`);
there is no `/api/ingest` mount on the server.

### Event Logs (`/api/event-logs`)

Provided by the enterprise plugin (`mountProtected`); `404` in community builds.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/event-logs` | Bearer + Admin + `audit_log_immutable` feature | Query audit event logs (`?entityType=`, `?entityId=`, `?userId=`, `?limit=`, `?offset=`) |

### Health

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/` | No | Root uptime check (`{ status: "ok", uptime: <seconds> }`) |
| GET | `/api/health` | No | Service health (DB, collector, disk). Used by the Docker compose healthcheck for the server container. |
| GET | `/api/health/rag` | No | RAG subsystem health (collector reachability + PostgreSQL FTS) |

`GET /api/health` returns `status: "ok"` when all three checks pass, `"degraded"` otherwise (always HTTP `200` — inspect the body):

```json
{
"status": "ok",
"timestamp": "2026-06-01T02:00:00.000Z",
"checks": {
"database": true,
"collector": true,
"disk": { "ok": true, "total": 0, "free": 0, "percentFree": 0 }
},
"details": [{ "check": "collector", "error": "..." }]
}
```

`details` is present only when at least one check fails. `GET /api/health/rag` returns `status` (`ok`/`degraded`), `checks.collector.reachable`, `checks.postgres_fts: "enabled"`, and a `hint` string explaining that vector search is unavailable when the collector is down.

### MCP Server (`/api/mcp/sse`)

The server exposes its RAG search as an MCP (Model Context Protocol) server over SSE, mounted by `mountMCPServer` (`packages/server/src/agent/mcpServer.ts`). Tools: `rag_query` (workspace document search with citations) and `list_workspaces`. External IDE clients (Cursor, VS Code) connect natively.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/mcp/sse` | See below | SSE connection; each connection gets its own per-session `Server` + `SSEServerTransport` pair |
| POST | `/api/mcp/message` | Same gate | MCP client messages routed by `?sessionId=` (query param) or the `Mcp-Session-Id` header; unknown/expired session → `400` |

Auth gate (`mcpAuthCheck`):
- **`MCP_API_KEY` set** — requests must carry `Authorization: Bearer <MCP_API_KEY>`; missing/wrong → `401 { "error": "Missing or invalid MCP_API_KEY" }`.
- **`MCP_API_KEY` unset** — unauthenticated **localhost-only** mode: only loopback clients (`127.0.0.1`, `::1`, IPv4-mapped loopback) are allowed; remote callers get `401` ("MCP_API_KEY not set — remote connections require authentication"). A single warn is logged at mount time.

### Filter Plugins (`/api/filters`)

filter plugin admin API. Both routes require `filters:manage` (admin/superuser only). No POST (filesystem discovery) and no DELETE (no API-side removal) routes exist.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/filters` | Bearer + `filters:manage` | List all registered filter plugins (priority-ordered, with `enabled`, `hasInlet`, `hasOutlet`, `outletStreaming`) |
| PATCH | `/filters/:name` | Bearer + `filters:manage` | Enable/disable a plugin (`{ enabled: boolean }`). Writes `filter_<name>_enabled` to SystemConfig; every toggle emits an audit event. |

### Memories (`/api/memories`)

Per-user-per-workspace Memory CRUD + GDPR export/erase.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/memories` | Bearer + `memory:read` | List memories for the caller in `?workspaceId=` (IDOR workspace-scoped) |
| POST | `/memories` | Bearer + `memory:write` | Create a memory |
| GET | `/memories/:id` | Bearer + `memory:read` | Get a memory |
| PATCH | `/memories/:id` | Bearer + `memory:write` | Update a memory |
| DELETE | `/memories/:id` | Bearer + `memory:write` | Delete a memory |
| GET | `/memories/export` | Bearer | GDPR export — all of the caller's memories across all workspaces |
| DELETE | `/memories` | Bearer | GDPR erase — delete all of the caller's memories (audited as `gdpr.erase`) |

### DLP Patterns (`/api/system/dlp`)

DLP pattern configuration CRUD + test. All routes require `admin:settings`. Malformed `:id` params return `404` (not `400`), so probing clients get no format feedback.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/system/dlp/patterns` | Bearer + `admin:settings` | List patterns (built-ins seeded first, then custom, ordered `createdAt`) |
| POST | `/system/dlp/patterns` | Bearer + `admin:settings` | Create a CUSTOM pattern (`isBuiltIn` forced false) |
| PUT | `/system/dlp/patterns/:id` | Bearer + `admin:settings` | Update a pattern |
| DELETE | `/system/dlp/patterns/:id` | Bearer + `admin:settings` | Delete a pattern |
| POST | `/system/dlp/patterns/:id/test` | Bearer + `admin:settings` | Test a pattern against sample text — nothing is persisted (audit-safe preview) |

### E2E Helpers (`/api/__tests__`)

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| POST | `/__tests__/start-echo-server` | Dev/test only (unauthenticated) | Start the mock echo MCP server for E2E suites; returns `{ port }` |
| POST | `/__tests__/stop-echo-server` | Dev/test only (unauthenticated) | Stop the echo MCP server |

The mount is gated at boot: `NODE_ENV === "production"` returns `404` here; the Playwright harness boots the server with default `NODE_ENV` (development), so E2E is unaffected.

## Collector API (`packages/collector`, port 3210)

The collector is HTTP-only — it has no `DATABASE_URL` and never touches Prisma. All ingestion endpoints (except `/health`, the read-only chunk fetch, `POST /api/ingest/query`, and `POST /api/ingest/rerank`) are gated by `requireCollectorSecret` (`X-Collector-Secret` header validated against `COLLECTOR_SECRET`, constant-time comparison). There is no upload rate limiter on the collector — the secret check is the authz boundary.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Collector liveness probe (`{ status: "ok", service: "collector" }`) |
| GET | `/api/ingest/chunks/:documentId` | No (server proxy; UUID-boundary validated) | List chunks for a document (read-only, used by server for re-index/re-embed) |
| POST | `/api/ingest` | `X-Collector-Secret` | Ingest a file: parse, chunk, embed, store. Multipart `file`. |
| POST | `/api/ingest/query` | No (server proxy) | Vector + FTS query against the collector's vector store (read-only; `limit` capped at 100) |
| POST | `/api/ingest/rerank` | No (server proxy) | Cross-encoder reranking of `{ query, candidates }` via the configured `RERANKER_MODEL` |
| DELETE | `/api/ingest/:documentId` | `X-Collector-Secret` | Delete a document's chunks and vector entries |
| POST | `/api/ingest/reembed` | `X-Collector-Secret` | Re-embed an existing document's chunks with the active embedding provider |
| POST | `/api/ingest/youtube` | `X-Collector-Secret` | Ingest a YouTube transcript by URL |
| POST | `/api/ingest/wiki-pages` | `X-Collector-Secret` | Ingest wiki page(s) for vector indexing |
| DELETE | `/api/ingest/wiki-pages/:pageId` | `X-Collector-Secret` | Delete a wiki page's vector entries |
| POST | `/api/ingest/archive-page` | `X-Collector-Secret` | Ingest an archive page (multipart `file`). Used by the archive import pipeline. |

The collector notifies the server of processing outcomes via `PUT /api/documents/:id/status` and `PUT /api/archives/import/:jobId/callback` (both on the server, secret-gated).

## Widget Service API (`packages/widget`, port 3211)

The widget service hosts the Preact IIFE bundle and proxies chat traffic to the server's internal widget API. Session state is carried in a `widgetSession` request object attached by `sessionMiddleware`. Rate limits are per-widget (keyed on the widget id from the URL path); per-widget overrides (`rateLimitPerMinute`, `sessionLimitPerDay`) are read from the Redis widget-config cache.

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/health` | No | — | Widget service liveness probe (used by its compose healthcheck) |
| GET | `/widget/:widgetId.js` | No | — | Cached JS loader for the Preact IIFE bundle |
| GET | `/widget/:widgetId` | No | — | HTML host page for the widget (sandboxed iframe) |
| GET | `/api/config/:widgetId` | Widget session | — | Fetch widget config for the client (branding, lead capture, etc.) |
| POST | `/api/config/:widgetId/cache-bust` | Widget session | — | Force a config refresh for the caller |
| POST | `/api/sessions` | — (session limiter) | 50/day/IP (prod) | Create an anonymous visitor session |
| POST | `/api/chat/:widgetId/stream` | Widget session + daily-message limiter + widget chat limiter | 30/min + 5 msgs/day (prod defaults) | SSE proxy to the main server chat endpoint; validates with `widgetChatRequestSchema` |
| POST | `/api/lead/:widgetId` | Widget session + widget lead limiter | 3/hour (prod) | Submit a lead-capture form |

Static assets are served from `dist-widget/` (Preact IIFE bundle built by `vite.widget.config.ts`). The service uses `helmet` with CSP off and frameguard off to allow iframe embedding, and `trust proxy 1` for correct client-IP extraction behind Nginx.

## Key Request/Response Examples

### Login

**Request:**

```bash
curl -X POST http://localhost:3000/api/auth/login \
-H "Content-Type: application/json" \
-d '{"username": "admin", "password": "changeme"}'
```

**Response:**

```json
{
"token": "eyJhbGciOiJIUzI1NiIs...",
"user": {
"id": "uuid",
"username": "admin",
"email": "admin@example.com"
}
}
```

### Create a Workspace

**Request:**

```bash
curl -X POST http://localhost:3000/api/workspaces \
-H "Authorization: Bearer <token>" \
-H "Content-Type: application/json" \
-d '{"name": "Support KB", "projectId": "<project-uuid>", "instructions": "Use RAG for all answers"}'
```

**Response:**

```json
{
"id": "workspace-uuid",
"name": "Support KB",
"projectId": "project-uuid",
"createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Streaming Chat

**Request:**

```bash
curl -X POST http://localhost:3000/api/workspaces/<id>/chat/stream \
-H "Authorization: Bearer <token>" \
-H "Content-Type: application/json" \
-d '{"message": "What is the refund policy?"}'
```

**Response (SSE):**

```text
event: status
data: {"message":"Searching documents..."}

event: citations
data: {"sources":[{"documentName":"Policies.pdf","chunkIndex":3,"text":"..."}]}

event: done
data: {"chatId":"chat-uuid","messageId":"msg-uuid","iterations":2,"tokenUsage":{"totalTokens":245},"model":"gemma4:latest","providerType":"ollama","mcpSources":[],"resolvedWikilinks":[]}
```

### Stage and Assign an Upload

**Stage (multipart):**

```bash
curl -X POST http://localhost:3000/api/uploads \
-H "Authorization: Bearer <token>" \
-F "file=@contract.pdf" \
-F "workspaceId=<workspace-uuid>"
```

**Assign (KB leg):**

```bash
curl -X POST http://localhost:3000/api/uploads/<draft-id>/assign \
-H "Authorization: Bearer <token>" \
-H "Content-Type: application/json" \
-d '{"rag": false, "kb": true, "archiveId": "<archive-uuid>"}'
```

**Response (200):** per-leg settle status. `filePath` is never exposed; poll `GET /api/uploads/pending?workspaceId=<id>` for derived terminal state.

### Upload a Document (legacy direct path)

**Request:**

```bash
curl -X POST http://localhost:3000/api/documents/upload \
-H "Authorization: Bearer <token>" \
-F "file=@contract.pdf" \
-F "workspaceId=<workspace-uuid>"
```

**Response:**

```json
{
"id": "doc-uuid",
"name": "contract.pdf",
"type": "pdf",
"status": "pending",
"workspaceId": "workspace-uuid",
"createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Update System Settings

**Request:**

```bash
curl -X PUT http://localhost:3000/api/system/settings \
-H "Authorization: Bearer <token>" \
-H "Content-Type: application/json" \
-d '{"configs": [{"key": "LLM_MODEL", "value": "gemma4:latest"}]}'
```

**Response (200 — partial success is normal):**

```json
{
"updated": [{"key": "LLM_MODEL", "value": "gemma4:latest", "readOnly": false}],
"rejected": []
}
```

An example of a partial failure — a community build rejecting a `BRANDING_*` key while accepting the rest:

```json
{
"updated": [{"key": "LLM_MODEL", "value": "gemma4:latest", "readOnly": false}],
"rejected": ["BRANDING_APP_NAME"]
}
```

### Create an API Key

**Request:**

```bash
curl -X POST http://localhost:3000/api/api-keys \
-H "Authorization: Bearer <token>" \
-H "Content-Type: application/json" \
-d '{"name": "CI Integration", "expiresInDays": 30}'
```

**Response (201 — the raw key is shown only once):**

```json
{
"id": "key-uuid",
"name": "CI Integration",
"key": "sk-xxxxxxxxxxxxxxxx",
"expiresAt": "2025-02-01T00:00:00.000Z",
"createdAt": "2025-01-01T00:00:00.000Z"
}
```

**Revocation:**

```bash
curl -X DELETE http://localhost:3000/api/api-keys/<key-uuid> \
-H "Authorization: Bearer <token>"
# → 200 { "message": "API key revoked" }
# → 404 { "error": "API key not found" } for unknown ids or another user's key
```

### Widget Config (Internal API)

**Request:**

```bash
curl http://localhost:3000/api/internal/widget/<widget-id>/config \
-H "X-Api-Key: sk-xxxxxxxx"
```

**Response:**

```json
{
"id": "widget-uuid",
"name": "Support Widget",
"welcomeMessage": "Hi! How can I help?",
"position": "bottom-right",
"primaryColor": "#4c6ef5",
"botName": "AI Assistant",
"workspaceIds": ["ws-uuid-1", "ws-uuid-2"],
"leadCaptureEnabled": true
}
```

## Restore Flow

The restore flow is administered under `/api/backups`. The list endpoint requires
`backup:log:read`; the dry-run and execute endpoints require `backup:restore:write`.
The restore is synchronous and may take up to 30 minutes for very large backups.

### GET /api/backups

Returns the list of `BackupLog` rows with `status` in `["success", "restored"]`,
ordered by `createdAt` desc. Each entry includes the destination (id, name,
type) and, if previously restored, the user who restored it (id, username).

**Response 200:**

```json
[
{
"id": "uuid",
"destinationId": "uuid",
"jobId": "uuid-or-null",
"fileName": "backup-jobname-2026-06-01T02-00-00.zip",
"fileSize": 12345678,
"checksum": "sha256-hex-digest",
"status": "success",
"errorMessage": null,
"startedAt": "2026-06-01T02:00:00.000Z",
"completedAt": "2026-06-01T02:15:00.000Z",
"createdAt": "2026-06-01T02:00:00.000Z",
"restoredAt": null,
"restoredBy": null,
"destination": { "id": "uuid", "name": "Local nightly", "type": "local" },
"restoredByUser": null
}
]
```

### POST /api/backups/restore/:logId/dry-run

Downloads the ZIP from the destination, verifies SHA-256 against
`BackupLog.checksum`, extracts it into a temporary staging area, lists the
internal files and `CREATE TABLE` statements found in `dbdump.sql`, and
cleans up. No side effects. Does NOT require the `RESTORE` confirmation.

**Path params:** `logId` (UUID, BackupLog id)

**Response 200:**

```json
{
"success": true,
"isValid": true,
"fileSize": 12345678,
"checksumVerified": true,
"contents": {
"files": ["backup-2026-06-01T02-00-00/dbdump.sql", "backup-2026-06-01T02-00-00/storage/documents/..."],
"tables": ["User", "Workspace", "Project", "Chat", "ChatMessage", "Document"]
}
}
```

If `destination.type === "email"`, returns:

```
400 { "error": "Restore from email destination is not supported. Use a different destination for restore." }
```

### POST /api/backups/restore/:logId

Executes the restore. Synchronous: the request waits until the restore
completes (up to 30 minutes) before returning.

**Path params:** `logId` (UUID, BackupLog id)

**Request body:**

```json
{
"selective": "complete",
"confirmation": "RESTORE"
}
```

- `selective`: one of `"db"`, `"files"`, `"complete"`. Default `"complete"`.
- `"db"`: restore only the database from the SQL dump.
- `"files"`: restore only the file-system directories.
- `"complete"`: restore both. On DB failure, files are not touched.
- `confirmation`: literal string `"RESTORE"` (case-sensitive, exact match).
Variants like `"restore"`, `"Restore"`, `"Yes"` are rejected with 400.

**Response 200 (success):**

```json
{
"status": "success",
"summary": {
"restoredAt": "2026-06-01T03:00:00.000Z",
"safetyBackupPath": "/abs/path/to/storage/backups/pre-restore-safety/<uuid>.zip",
"restoredDb": true,
"restoredFiles": true,
"durationMs": 180000
}
}
```

**Response 200 (failed but rolled back):**

```json
{
"status": "failed",
"summary": { "restoredAt": "...", "safetyBackupPath": "...", "restoredDb": false, "restoredFiles": false, "durationMs": 120000 },
"error": "psql restore failed: ..."
}
```

**Response 400 (missing or wrong confirmation):**

```json
{
"error": "Confirmation required. Send confirmation: \"RESTORE\" to proceed.",
"details": { "confirmation": [ "..." ] }
}
```

**Response 400 (email destination):**

```json
{ "error": "Restore from email destination is not supported. Use a different destination for restore." }
```

### Safety & Rollback

Before any destructive operation, the service creates a safety backup at
`storage/backups/pre-restore-safety/{safetyId}.zip`. If the restore fails
after the safety backup is created, the service attempts automatic rollback
from the safety backup's SQL dump. See `docs/MIGRATION_SAFETY.md` for the
full safety contract.

---

## See also

- [Documentation index](./INDEX.md)
- [Architecture](./ARCHITECTURE.md)
- [Configuration](./CONFIGURATION.md)
