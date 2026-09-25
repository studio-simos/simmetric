# Connector Setup Guide (Google Drive, Microsoft 365, Gmail & Chat Connectors)

This guide covers the first-party connector surfaces:

- the **connector tools** — read-only builtin skills that let an AI assistant
  search, read, and ingest content from a connected **Google Drive**,
  **Microsoft 365** (Graph), or **Gmail** account — with org-scoped OAuth
  connections authorized from the admin UI; and
- the **Chat Connectors** (Telegram, Discord, Slack, WhatsApp) — inbound chat
  channels that feed external messages into the same agent pipeline.

Connector setup is an **admin** task; the tools then ride the workspace
agent-config skill palette like any other builtin.

---

## Contents

1. [Overview](#overview)
2. [Google Setup](#google-setup)
3. [Google App Verification Paths](#google-app-verification-paths)
4. [Microsoft Entra Setup](#microsoft-entra-setup)
5. [Environment Keys Reference](#environment-keys-reference)
6. [Connecting in the UI](#connecting-in-the-ui)
7. [Using Connector Tools in Chat](#using-connector-tools-in-chat)
8. [Gmail Tools (Phase 197)](#gmail-tools-phase-197)
9. [Chat Connectors (Telegram, Discord, Slack, WhatsApp)](#chat-connectors-telegram-discord-slack-whatsapp)
   - [Chat Connector Overview](#chat-connector-overview)
   - [Webhook vs Polling](#webhook-vs-polling)
   - [Telegram Setup](#telegram-setup)
   - [Discord Setup](#discord-setup)
   - [Slack Setup](#slack-setup)
   - [WhatsApp Setup](#whatsapp-setup)
   - [Air-Gap Matrix](#air-gap-matrix)
   - [Platform Costs](#platform-costs)
   - [Proxy / Environment Overrides](#proxy-environment-overrides)
   - [The WhatsApp 24-Hour Window](#the-whatsapp-24-hour-window)

---

## Overview

The connector tools are first-party **builtin skills** in the agent skill
registry — not external MCP servers and not coupled to per-chat MCP pins. They
resolve the OAuth access token at execute-time from the org's MCP connection
rows, build the `Authorization: Bearer` strictly server-side, and never expose
token material to the LLM, the browser, or logs.

The six tools (read-only v1):

| Tool | Provider | What it does |
|------|----------|--------------|
| `gdrive_search` | google | Search the connected Drive (name/type/folder) → file metadata list |
| `gdrive_read` | google | Export a Docs/Sheets/Slides file to markdown/csv/plain text, or download a binary as text |
| `gdrive_ingest` | google | Download a Drive file and dispatch it to the indexing pipeline — it lands in the workspace knowledge base and becomes searchable via `rag_search` |
| `graph_mail_search` | microsoft | Search the connected mailbox (Graph `$search` keyword mode or `$filter` subject mode, with provider-cursor pagination) |
| `graph_sharepoint_search` | microsoft | Tenant-wide SharePoint site search, or drive items within a site |
| `graph_onedrive_ingest` | microsoft | Download a OneDrive item (following Graph's redirect chain) and dispatch it to the indexing pipeline |

Properties of the v1 surface:

- **Org-scoped OAuth connections.** Tools resolve connections inside the
  requesting chat's organization — a workspace can only use connections its
  org owns (or global both-null-scoped connections an admin configured).
- **Read-only v1.** No write operations against Docs, Gmail, or Graph.
- **OAuth-only tokens.** Connector tools ride the connection's OAuth token —
  static-header connections do not gate them.

---

## Google Setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   select) a project.
2. Configure the **OAuth consent screen** (External or Internal — see the
   verification paths below). Add the scopes you will request:
   `https://www.googleapis.com/auth/drive.readonly` (the connector default
   scope set also ships `gmail.readonly` for the Phase 197 Gmail tools; admins
   may reduce, never amplify, the requested scope list per connection).
3. Create credentials → **OAuth client ID** → type **Web application**.
4. Under **Authorized redirect URIs**, add exactly:

   ```
   ${SERVER_URL}/api/mcp-connections/oauth/callback
   ```

   where `${SERVER_URL}` is the server's public base URL (e.g.
   `http://localhost:3000` in development). The redirect URI is fixed on the
   env-sourced `SERVER_URL` — it is never client-supplied.
5. Copy the client ID and secret into the root `.env`:

   ```
   GOOGLE_CLIENT_ID=<your-client-id>
   GOOGLE_CLIENT_SECRET=<your-client-secret>
   ```

   Client credentials are env-only in v1 (the per-org `oauthClientId` column
   stays dormant). Plaintext env secrets follow the same file-secrecy posture
   as `OIDC_CLIENT_SECRET` — never commit them, never log them.

---

## Google App Verification Paths

A Google OAuth client that requests restricted scopes must pass one of two
verification paths before arbitrary users can consent. Choose per deployment:

| Path | When to choose | Cap / constraints |
|------|----------------|-------------------|
| **Internal (Google Workspace)** | Your organization runs Workspace and every consenting user belongs to it. The app is flagged *Internal* on the consent screen. | Unrestricted user count; no Google review needed. The consent screen is internal-only — outside users cannot consent. |
| **Public "in testing"** | Public/community deployments, or users outside a single Workspace tenant. | The app runs in **testing** mode with a **100-user cap** on consent grants. No verification review is required while in testing; the cap is enforced by Google at the consent screen. Plan the full verification review before exceeding 100 users. |

Both paths use the SAME OAuth client configuration — the choice affects only
the consent screen's audience and the user-count ceiling, not the redirect URI
or the code flow. Re-visit the choice when scaling past the internal tenant or
the 100-user testing cap.

---

## Microsoft Entra Setup

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), register
   an application (**App registrations** → **New registration**). Choose the
   account audience that matches your tenant configuration (below).
2. Under **API permissions**, add **delegated** Microsoft Graph permissions:

   - `Files.Read` — OneDrive item reads (ingest)
   - `Mail.Read` — mailbox search
   - `Sites.Read.All` — SharePoint site search
   - `offline_access` — refresh token (mandatory; without it no refresh token
     is issued)
   - `openid`, `profile`, `email` — identity scopes

   Delegated permissions run as the consenting user — no admin consent is
   required for these read-only scopes unless your tenant restricts them.
3. Under **Authentication**, add the platform **Web** redirect URI:

   ```
   ${SERVER_URL}/api/mcp-connections/oauth/callback
   ```

   The server sends `response_mode=query` on the authorize request, so the
   authorization code rides the query string (no implicit-flow checkbox
   needed).
4. Tenant configuration — set which tenant path the IdP endpoints use:

   ```
   OAUTH_MICROSOFT_TENANT=common        # any Microsoft account (default)
   OAUTH_MICROSOFT_TENANT=organizations # work/school accounts only
   OAUTH_MICROSOFT_TENANT=<tenant-id>   # single-tenant enterprise installs
   ```

   The `{tenant}` segment in the Microsoft authorize/token URLs is substituted
   from this key at resolve time. Single-tenant deployments should register
   the app as "Single tenant" and set the key to the tenant ID (GUID) or
   domain.
5. Copy the application (client) ID and secret into the root `.env`:

   ```
   MICROSOFT_CLIENT_ID=<application-client-id>
   MICROSOFT_CLIENT_SECRET=<application-secret>
   ```

---

## Environment Keys Reference

Every key this feature reads. All are **optional** — unset keys mean the
provider is simply not configurable (the OAuth start route answers a clear
`400 { error }`), and the server boots without them.

| Key | Applies to | Purpose |
|-----|------------|---------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | server | Google OAuth client credentials (consent screen + token exchange). Both required for Google connections. |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | server | Entra app credentials. Both required for Microsoft connections. |
| `OAUTH_GOOGLE_AUTH_URL` / `OAUTH_GOOGLE_TOKEN_URL` | server | Provider endpoint overrides (air-gap/proxy installs). Unset = the registry defaults (`accounts.google.com` / `oauth2.googleapis.com`). `.url()`-validated. |
| `OAUTH_MICROSOFT_AUTH_URL` / `OAUTH_MICROSOFT_TOKEN_URL` | server | Microsoft endpoint overrides; the `{tenant}` segment is substituted from `OAUTH_MICROSOFT_TENANT`. |
| `OAUTH_MICROSOFT_TENANT` | server | Tenant path segment for the Microsoft v2.0 endpoints — `common` (default) \| `organizations` \| a tenant-id GUID. |
| `GDRIVE_API_BASE_URL` | server | Google Drive API base-URL override (default `https://www.googleapis.com`). The air-gap lever for the `gdrive_*` connector tools. |
| `GRAPH_API_BASE_URL` | server | Graph base-URL override (default `https://graph.microsoft.com`). The tenant-configurable endpoint for the `graph_*` tools. |
| `GMAIL_API_BASE_URL` | server | Gmail API base-URL override (default `https://gmail.googleapis.com`). The air-gap lever for the `gmail_*` connector tools (Phase 197). |
| `COLLECTOR_INGEST_TIMEOUT_MS` | server | Optional operator cap (ms) on the ingest-dispatch wait — the ingest tool waits unbounded when unset (local-CPU embeds can exceed fixed windows). Raise it above ~300s for large PDFs. |
| `SERVER_URL` | infra | The public server base URL — composes the OAuth redirect URI. ENV-only (never DB-resolved). |
| `COLLECTOR_URL` / `COLLECTOR_SECRET` | infra | The collector's ingest endpoint and shared secret — the ingest bridge reuses the established multipart contract verbatim (`X-Collector-Secret` header). |

Values are documented by NAME only here — never paste real credentials into
version control. The single exhaustive env documentation lives in the root
`.env.example` (`[server]` section); the Zod schema in
`packages/server/src/config/env.ts` is the source of truth for the key set.

---

## Connecting in the UI

1. Open **Settings → Advanced → MCP Connections** (admin role).
2. **Create connection**: set a name, the MCP server URL, transport type, and
   (optionally) the workspace scope. Set **Authentication** to **OAuth** and
   pick the provider (google \| microsoft). Optionally enter a reduced
   `oauthScopes` space-separated list — the registry may only REDUCE the
   provider defaults (scope-reduce-only invariant).
3. Click **Connect** on the oauth row → the app full-page-redirects to the
   provider consent screen (no popup — the callback returns to
   `/settings?tab=mcpConnections&oauth=<status>`).
4. After consent the badge flips to **OAuth ✓**; a pending flow shows the
   animated **pending** badge, and an expiry within 10 minutes flips the badge
   to the amber **expiring** variant. Authorization failures surface the
   ✗ badge with a sanitized error summary tooltip (raw provider errors and
   secrets stay server-side).
5. **Reauthorize** (same flow, fresh state) re-runs the consent without
   reconfiguring the connection; **Revoke** (destructive confirm) wipes the
   local credential columns and — for Google — revokes the token
   provider-side.
6. The **granted scopes** panel (expand the status cell on an authorized row)
   shows the decoded granted scope chips with the restricted-scope warning
   when a granted scope belongs to a restricted-scope provider.

Lifecycle actions require the `mcp:oauth:manage` permission; they are hidden
entirely without it (badges and the scope panel stay visible).

---

## Using Connector Tools in Chat

Connector tools appear in a chat's skill palette when BOTH are true:

1. the tool is enabled in the workspace agent config's skills list
   (**Workspace → Agent config → skills checkboxes**, reading
   `GET /api/agent/skills`), and
2. an authorized OAuth connection for the tool's provider exists for the
   workspace (org-scoped availability gate). If no authorized connection
   exists, the tool is EXCLUDED from the palette rather than offered and
   failing — connect the provider first.

Example prompts:

- *"Search the connected Drive for files named report"* → `gdrive_search`
- *"Read the Q3 report from Drive and summarize it"* → `gdrive_read`
- *"Ingest the Q3 report from Drive into this workspace"* → `gdrive_ingest`
  (then: *"search the knowledge base for the Q3 numbers"* via `rag_search`)
- *"Find emails about the budget"* → `graph_mail_search`
- *"Search SharePoint for the onboarding docs"* → `graph_sharepoint_search`
- *"Ingest the OneDrive file into the workspace"* → `graph_onedrive_ingest`

Provider content returned by connector tools is untrusted by construction —
the tool descriptions mark it as data, not instructions; anything inside a
Drive file or an email is treated as untrusted content by the agent loop.

---

## Gmail Tools (Phase 197)

The Gmail connector tools are first-party **builtin skills** riding the same
infrastructure as the Drive/Graph tools above (org-scoped OAuth connections,
server-side Bearer, palette gate). They are read-only v1 — no send, no draft
creation, no modify/trash operations.

### The three tools

| Tool | Provider | What it does |
|------|----------|--------------|
| `gmail_search` | google | Search the connected Gmail mailbox with Gmail search syntax (`q` passed verbatim, e.g. `from:x has:attachment`, `subject:report`, `is:unread after:2026/01/01`) → message metadata list (id, thread id, subject, sender, date, snippet) with pagination via `pageToken` |
| `gmail_get_thread` | google | Read a full thread by id — fetches the message list (`format=full`), extracts each message's body text from the MIME tree (text/plain preferred; HTML falls back to a tag-stripped excerpt labeled `[HTML content]`), bounded by a truncation budget |
| `gmail_ingest_thread` | google | Compose a thread into ONE text document and dispatch it to the indexing pipeline — the thread lands in the workspace knowledge base and becomes searchable via `rag_search` with standard RAG citations |

Example prompts:

- *"Find emails about the budget"* → `gmail_search`
- *"Read the invoice thread"* → `gmail_get_thread`
- *"Ingest the invoice thread into this workspace"* → `gmail_ingest_thread`
  (then: *"search the knowledge base for the invoice total"* via `rag_search`)

### The gmail.readonly scope

All three tools fail closed on the
`https://www.googleapis.com/auth/gmail.readonly` scope: a connection whose
granted scope set lacks it returns a structured "missing required scope"
error naming the scope. `gmail.readonly` is already part of the shipped
Google provider default scopes — no extra configuration is needed — and it is
a **restricted scope**: the Phase 196 scope panel renders the amber
restricted-scope warning for Gmail connections (the connection's granted
scopes panel shows the warning when a granted scope belongs to a
restricted-scope provider).

Admins may reduce (never amplify) the requested scope list per connection —
but reducing a Gmail connection below `gmail.readonly` (e.g. to the narrower
`gmail.metadata` scope) makes the tools fail closed: the format-based reads
(`format=full` / `format=metadata`) are blocked entirely under the
`gmail.metadata` scope.

### Google verification paths (restricted scope)

Because `gmail.readonly` is a restricted scope, the Google OAuth client must
pass one of the two verification paths before users can consent (the same
two paths as the Drive tools — see
[Google App Verification Paths](#google-app-verification-paths)):

- **Internal Google Workspace deployment** — the app is flagged *Internal*
  on the consent screen and every consenting user belongs to the tenant:
  **no verification needed**.
- **Public app** — running in **"in testing"** mode is sufficient for pilots
  (100-user cap on consent grants, no review required); **full verification**
  is required for scale past the testing cap.

Both paths use the SAME OAuth client configuration — the choice affects only
the consent screen's audience and the user-count ceiling.

### Environment keys

| Key | Applies to | Purpose |
|-----|------------|---------|
| `GMAIL_API_BASE_URL` | server | Gmail API base-URL override (default `https://gmail.googleapis.com`). The air-gap lever for the `gmail_*` connector tools — air-gapped deployments can point it at a local proxy serving the Gmail v1 REST surface. |

### Known quirk

On OAuth connection rows the MCP-transport `mcpClient` reconnect attempts
log a benign `Failed to connect` line after a successful Connect (OAuth
connections have no MCP-transport URL to dial; the OAuth state badges show
the true state). This is a known first-party-tools quirk, not an error.

---

## Chat Connectors (Telegram, Discord, Slack, WhatsApp)

### Chat Connector Overview

Chat Connectors are the inbound chat channel surface — the counterpart to the
MCP connections documented above. An **MCPConnection** is a tool surface the
agent *calls*; a **ChatConnector** is an inbound chat channel (a messaging
platform conversation) that feeds the SAME agent pipeline. Connectors are
created in **Settings → Advanced → Connectors** (admin, `connector:manage`) by
picking a platform, pasting the platform credentials, and binding the
connector to a workspace (its knowledge base).

Every connector runs the same pipeline: an inbound platform message →
signature gate (webhook) or poll (polling) → dedup → persistent session/Chat
→ rolling rate limit → agent turn → platform reply. Secrets pasted at create
time are encrypted (`botTokenEncrypted` / `configEncrypted`) and never echoed
back — responses carry `hasBotToken` / `hasSigningSecret` / `hasVerifyToken`
booleans only.

### Webhook vs Polling

| Platform | Ingress | Semantics |
|----------|---------|-----------|
| Telegram | webhook **or** polling (per-connector `pollMode`) | Webhook needs a public URL; polling long-polls `getUpdates` from the Bot API — works behind NAT/firewalls with no inbound exposure. The webhook URL is composed from `SERVER_URL` (`${SERVER_URL}/api/connectors/telegram/<connectorId>/webhook`) and registered with Telegram via the webhook-setup route; never body-supplied. |
| Discord | WebSocket Gateway | No webhook at all — the connector holds a live Gateway connection (zero-webhook note). |
| Slack | webhook (Events API) | Slack POSTs signed events to your server; a public URL is required. |
| WhatsApp | webhook (Cloud API) | Meta POSTs webhook notifications; a public URL is required (verified with the verify-token GET handshake). |

### Telegram Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → `/newbot`; copy
   the bot token.
2. In the admin UI create a **telegram** connector with the bot token.
3. Choose the mode per connector: **webhook** (run the webhook-setup route
   after exposing the server publicly) or **polling** (no public URL needed —
   the poller advances the update cursor).

### Discord Setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications)
   create an application, add a **Bot**, and copy the bot token.
2. Invite the bot to your server (OAuth2 → URL Generator with the `bot` scope).
3. Create a **discord** connector in the admin UI with the token.
4. **Zero-webhook note:** Discord needs NO webhook registration and NO public
   URL — the connector connects OUT to the Discord Gateway over WebSocket and
   receives DMs there. This makes Discord the only fully air-gappable inbound
   channel.

### Slack Setup

1. At [api.slack.com/apps](https://api.slack.com/apps) create a Slack App.
2. **Scopes** — add these bot token scopes (OAuth & Permissions):

   | Scope | Why |
   |-------|-----|
   | `chat:write` | Post replies (`chat.postMessage`) |
   | `im:history` | (bot DM parity) read access for the im event surface |

3. **Event Subscriptions** — enable and set the Request URL to the
   PLATFORM-PREFIXED webhook URL (the route is registered per connector):

   ```
   ${SERVER_URL}/api/connectors/slack/<connectorId>/webhook
   ```

   Create the connector first (you need its `<connectorId>`), then subscribe
   to the `message.im` event. Slack's URL verification handshake is answered
   automatically by the same route (signed `url_verification` challenge echo).
4. **Redirect URL** (only for the OAuth install path) — register the
   connector OAuth callback:

   ```
   ${SERVER_URL}/api/connectors/oauth/callback
   ```

   This is the SAME value the server sends as `redirect_uri` on both the
   authorize URL and the token exchange (`resolveConnectorRedirectUri()`) —
   Slack validates redirect_uri consistency between the two calls.
5. **Install paths** — both create a usable connector:
   - **OAuth Connect**: set `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` in the
     root `.env`; the "Connect with Slack" outline button renders in the
     create dialog and runs the "Add to Slack" consent flow (comma-joined
     `chat:write,im:history` scopes; no expiry on the installed token).
     The signing secret is still required at create time — the OAuth response
     carries none, and the callback preserves the create-time value.
   - **Static token**: create a bot token (`xoxb-`) and paste it plus the
     App's **Signing Secret** (from *Basic Information → App Credentials*) in
     the create dialog. No OAuth env needed.

### WhatsApp Setup

1. In the [Meta Business / developer dashboard](https://developers.facebook.com)
   create an app and add the **WhatsApp** product (WhatsApp Business Platform /
   Cloud API).
2. Note the **Phone Number ID** of the sending phone (WhatsApp → API Setup).
3. Create a **whatsapp** connector in the admin UI with:
   - the **access token** (from the Meta app's WhatsApp Business platform),
   - **Phone Number ID** (the sending phone's ID — the send target),
   - **App Secret** (Meta App credentials — verifies webhook payloads via
     `X-Hub-Signature-256`),
   - a **Verify Token** you choose (Meta echoes it when verifying the webhook
     URL),
   - optionally the **WhatsApp Business Account ID** (stored, unused in v1).
4. In the Meta App dashboard → WhatsApp → Configuration, set the **Callback
   URL** to the PLATFORM-PREFIXED webhook route:

   ```
   ${SERVER_URL}/api/connectors/whatsapp/<connectorId>/webhook
   ```

   The verify-token GET handshake (timing-safe compare → parseInt challenge
   echo) is answered automatically by the same route.

### Air-Gap Matrix

Whether a platform works on an air-gapped / no-public-URL deployment:

| Platform | Air-gap OK? | Why |
|----------|-------------|-----|
| Telegram (polling) | ✓ | Outbound long-poll only — no inbound URL required. |
| Discord (Gateway WS) | ✓ | Outbound WebSocket — no inbound URL required. |
| Slack | ✗ | Slack POSTs event deliveries to your server — a publicly reachable URL is required. |
| WhatsApp | ✗ | Meta POSTs webhook notifications — a publicly reachable URL is required. |

**Tunnel caveat:** Slack/WhatsApp deployments without a public IP can bridge
the gap with an HTTPS tunnel (ngrok, Cloudflare Tunnel, frp) pointed at the
server, and register the tunneled `${SERVER_URL}` in the platform dashboard.
Tunnels add a third-party dependency to the message path — for strict
air-gap installs prefer Telegram polling or Discord.

### Platform Costs

| Platform | Cost model |
|----------|------------|
| Telegram | Free (Bot API, no message fees) |
| Discord | Free (Gateway WS, no message fees) |
| Slack | Free tier with API rate limits (per-workspace tiered limits; fine for a reply bot) |
| WhatsApp | Free for **user-initiated** conversations within the 24-hour customer service window (utility/service conversations; Meta's per-conversation pricing applies to template/business-initiated messages — out of scope, see below) |

### Proxy / Environment Overrides

Every platform URL is env-overridable (the air-gap lever set). Unset keys use
the platform defaults.

| Key | Purpose |
|-----|---------|
| `TELEGRAM_API_URL` | Telegram Bot API base (default `https://api.telegram.org`) |
| `DISCORD_API_URL` | Discord REST base (default `https://discord.com/api`) |
| `DISCORD_GATEWAY_URL` | Discord Gateway WS base (default wss gateway host) |
| `SLACK_API_URL` | Slack Web API base (default `https://slack.com/api`) |
| `WHATSAPP_API_URL` | WhatsApp Cloud API base (default `https://graph.facebook.com/v18.0`) |
| `OAUTH_SLACK_AUTH_URL` / `OAUTH_SLACK_TOKEN_URL` | Slack OAuth endpoint overrides (proxy installs; `.url()`-validated) |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack OAuth client credentials (enables the Connect-with-Slack arm) |

Air-gapped deployments can point each base at a local proxy serving the
platform's REST/WS surface — the adapters are direct-`fetch` (no SDKs) and
ride the override BEFORE any default host.

### The WhatsApp 24-Hour Window

The Cloud API only lets a business reply free-of-charge within **24 hours**
of the user's last inbound message; outside the window Meta rejects the send
with error code **131047** ("re-engagement message is required"). v1 is
**inbound-reply-only by construction** (no proactive sends, no template
messages — templates are explicitly out of scope), so the window is
enforced by construction: a reply send that still fails with 131047
(possible after long agent runs) is a **terminal** error — `lastError` is
persisted with the Graph code, health flips to `error` (the connector stays
enabled), and there is NO retry and NO template fallback.

---

## See also

- [MCP_MARKETPLACE.md](MCP_MARKETPLACE.md) — the marketplace workflow for
  external MCP servers and per-chat pinning
- [CONFIGURATION.md](CONFIGURATION.md) — the full environment variable
  reference
- [DEPLOYMENT.md](DEPLOYMENT.md) — `SERVER_URL` conventions and air-gap notes

Return to the [documentation index](INDEX.md).