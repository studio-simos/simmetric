<!-- generated-by: gsd-doc-writer -->

# @simmetric-chat/widget

Embeddable chat widget for the Simmetric Chat platform. Provides an Express service that serves a Preact-based chat widget as an IIFE bundle, along with API routes for anonymous sessions, widget configuration, SSE chat streaming, and lead capture.

## Overview

The widget package lets external websites embed a white-label AI chat assistant powered by the Simmetric Chat backend. It consists of two layers:

- **Express API** (`src/index.ts`) — handles widget sessions, proxies SSE chat streams to the main server, serves the Preact bundle, and manages iframe loaders.
- **Preact UI** (`src/widget/`) — a lightweight, sandboxed iframe chat interface rendered via a Vite IIFE bundle, with client-side i18n (`src/widget/i18n/`) covering 8 locales (en/de/es/fr/it/ru/zh/pt) via i18next, air-gap bundled into the IIFE.

All communication with the main Simmetric Chat server goes through the internal widget API (`/api/internal/widget`), authenticated with an API key. The widget runtime is **license-gated**: the server's internal router applies `requireFeature("widget_enabled")` (Community tier → `widget_enabled: false`), so every internal call returning 402 is mapped by the widget service to a graceful `503 { error: "Widget disabled" }` instead of a 500. The widget service is **not** a React app — it uses Preact for a smaller bundle footprint inside the sandboxed iframe, and the loader is served at `/widget/:widgetId.js` for drop-in embedding on external sites.

The iframe is sandboxed with `allow-scripts allow-forms` and **no** `allow-same-origin` (opaque origin). Because an opaque-origin iframe cannot reliably use its own `sessionStorage`, the widget persists session tokens and message history on the **parent page** via a `postMessage` storage handshake (`simmetric:storage-get` / `simmetric:storage-set` / `simmetric:storage-data`) using namespaced keys `sc-widget-${widgetId}-session` and `sc-widget-${widgetId}-messages`, with `event.source` validation on both sides. Chat requests are authenticated with a session JWT (`X-Session-Token` header) validated server-side on every request.

Since v0.19, the widget service integrates with **Redis** (optional, via `REDIS_URL`) for a shared widget-config cache (`widget:config:{widgetId}`) and a distributed rate-limit store (`rate-limit-redis`), with graceful degradation to the in-memory fallbacks when Redis is unavailable.

Part of the [Simmetric Chat](../../README.md) monorepo.

> For the full integration guide and the `simmetric:*` postMessage protocol reference, see [docs/WIDGET.md](../../docs/WIDGET.md). That doc is the single source of truth for the protocol table; this README stays the package-internal readme.

## Installation

This package is private and intended for use within the monorepo only. It is not published to npm.

```bash
pnpm install
```

## Usage

### Embedding the widget on an external site

Add a container element and a single `<script>` tag to any page. The loader reads the `data-*` attributes from the container (referenced via `data-target`), not from the script tag:

```html
<div id="simmetric-widget"
     data-widget-id="YOUR_WIDGET_ID"
     data-primary-color="#4c6ef5"
     data-position="bottom-right"
     data-locale="en">
</div>
<script src="http://localhost:3211/widget/YOUR_WIDGET_ID.js"
        data-target="simmetric-widget">
</script>
```

The loader script creates a sandboxed iframe (`sandbox="allow-scripts allow-forms"`, no `allow-same-origin`, `allow="clipboard-write"`), reads the container's `data-*` attributes for customization (`data-widget-id`, `data-primary-color`, `data-position`, `data-locale`, `data-locale-source`, `data-bot-name`, `data-logo-url`), patches `history.pushState`/`replaceState` for SPA URL-change detection, listens for `popstate`/`hashchange`, and detects exit intent via `mouseleave` (cursor `clientY <= 10`). URL changes and exit-intent events are relayed to the iframe via `postMessage` (`simmetric:urlChange`, `simmetric:exitIntent`). The Preact UI handles anonymous session creation, SSE chat streaming, and optional lead capture automatically. Trigger overrides (`?autoOpenDelay`, `?autoOpenUrlPatterns`, `?exitIntentEnabled`) can be passed on the script's own `src` URL and are forwarded to the iframe (query > DB priority).

The open/close FAB lives on the **host page** (appended to the embed container, always `pointer-events: auto`) — the closed container is `pointer-events: none`, so an iframe-internal FAB would be unclickable. When the embed loads via the loader (`&hostFab=1`), the iframe hides its own FAB; the host FAB toggles open/close via `simmetric:widgetOpen`/`simmetric:widgetClose` postMessages, repaints itself from the iframe's `simmetric:widgetConfig` color report, and opens the credits URL on `simmetric:creditsOpen` (the sandboxed iframe cannot `window.open` itself). All inbound loader listeners validate `event.source === iframe.contentWindow` (WR-01 hardening).

### Generating the server API key

The `WIDGET_API_KEY` used by this service to authenticate against the main server's internal widget API is generated on the server side:

```bash
pnpm --filter server generate-apikey
```

Copy the resulting key into the root `.env` as `WIDGET_API_KEY` (the `[widget]` section — see the root `.env.example`; the script also stores it in the server's widget API key store).

### Running in development

```bash
pnpm --filter widget dev
```

Starts the widget Express service on port 3211 (default) with auto-reload via `tsx watch`. The Preact bundle is served from `dist-widget/` — run `pnpm --filter widget build:widget` first if the bundle hasn't been built yet.

## API Summary

The widget package exports a single public function from `src/index.ts`:

- **`createApp(): Express`** — Factory function that creates and configures the Express application with all routes, middleware, and error handling. Exported as both named and default export. Used by tests to create isolated app instances without starting the server.

Key internal modules (not exported publicly, but relevant for development):

| Module | Purpose |
|--------|---------|
| `src/config/env.ts` | Zod-validated environment variables (`getEnv()`), `.env` resolved from a `__dirname`-relative path |
| `src/middleware/session.ts` | Session JWT validation middleware (`sessionMiddleware`) via the server internal API |
| `src/middleware/rateLimit.ts` | Rate limiters for chat (per-minute burst + per-day message cap), session, and lead endpoints (Redis-backed store when available) |
| `src/services/widgetApi.ts` | HTTP client for server internal widget API |
| `src/services/redisService.ts` | Lazy Redis singleton (`getRedis()`), null when `REDIS_URL` is unset |
| `src/routes/chat.ts` | SSE chat proxy route (pre-RAG search + transparent SSE relay with `thinking`-event strip) |
| `src/routes/session.ts` | Anonymous session creation route |
| `src/routes/config.ts` | Widget appearance config route (Redis + 5-min in-memory cache, `cache-bust` endpoint) |
| `src/routes/loader.ts` | Widget loader JS and iframe HTML routes (incl. storage handshake) |
| `src/routes/lead.ts` | Lead capture submission route |
| `src/widget/hooks/useWidgetChat.ts` | SSE streaming hook for Preact client (token/status/citations/done/error) + loader storage handshake |
| `src/widget/hooks/useWidgetConfig.ts` | Config reading hook (parses the JSON `#widget-config` block's `textContent` — its only DOM input) |
| `src/widget/hooks/useTriggers.ts` | Auto-open and exit-intent trigger hook (postMessage-driven) |
| `src/widget/i18n/index.ts` | i18next init module (`initWidgetI18n(locale)`) — fresh instance per call, 8 statically-imported locale resources, `t()` helper; locale is server-resolved (`?locale=` → Accept-Language → config `fallbackLocale` → legacy scalars → `"en"`) and applied via `useWidgetConfig` |

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start the widget service in development mode with auto-reload (`tsx watch`) |
| `pnpm build` | Compile TypeScript server code to `dist/` |
| `pnpm build:widget` | Build the Preact IIFE bundle to `dist-widget/app.js` via Vite |
| `pnpm lint` | Run ESLint over `src/` |
| `pnpm test` | Run the Jest test suite |
| `pnpm i18n:check` | Verify all 8 locale files (`src/widget/i18n/`) are in flat-key parity with `en.json` and contain no empty-string values |
| `pnpm typecheck` | Run TypeScript type checking without emitting files |

## Directory Structure

```
src/
├── index.ts              # Express app factory and server entry point
├── config/
│   └── env.ts            # Zod-validated environment variables (__dirname-relative .env)
├── routes/
│   ├── chat.ts           # SSE chat proxy endpoint (pre-RAG + transparent SSE relay)
│   ├── config.ts         # Widget appearance config endpoint (Redis + 5-min in-memory cache)
│   ├── lead.ts           # Lead capture submission endpoint
│   ├── loader.ts         # Widget loader JS and iframe HTML (incl. storage handshake)
│   └── session.ts        # Anonymous session creation endpoint
├── middleware/
│   ├── rateLimit.ts      # Express rate limiters (chat burst/daily, session, lead; Redis store)
│   └── session.ts        # Session JWT validation middleware
├── services/
│   ├── redisService.ts   # Lazy Redis singleton (graceful degradation)
│   └── widgetApi.ts      # HTTP client for server internal widget API
├── types/
│   └── css.d.ts          # CSS module type declarations
├── utils/
│   ├── chatPanelLogic.ts # Pure UI logic helpers (lead card, send gating)
│   ├── globToRegex.ts    # Glob-to-RegExp utility for URL trigger patterns
│   ├── logger.ts         # Winston logger
│   ├── matchUrlPattern.ts# URL pattern matching for auto-open triggers
│   └── widgetStateBridge.ts # iframe→parent postMessage bridges (open state, config, credits)
├── widget/               # Preact UI source (NOT React)
│   ├── index.tsx         # UI entry point — mounts App into #widget-root
│   ├── App.tsx           # Root component, config reading, state coordination
│   ├── index.css         # Tailwind CSS custom properties
│   ├── i18n/             # i18next setup + 8 locale resources (en/de/es/fr/it/ru/zh/pt)
│   ├── components/       # Chat UI components (ChatFab, ChatPanel, InputBar, etc.)
│   └── hooks/            # Preact hooks (useWidgetChat, useWidgetConfig, useTriggers)
└── __tests__/            # Jest test files (HTTP routes, middleware, hooks, utils)
```

## Build Output

The package produces two separate build artifacts:

1. **Server code** (`dist/`) — compiled by `tsc` from `src/index.ts` and supporting modules. Served by Node.js at runtime.
2. **Widget bundle** (`dist-widget/app.js`) — compiled by Vite as an IIFE bundle from `src/widget/index.tsx`. This self-executing script mounts the Preact chat UI when loaded inside the sandboxed iframe. Served by Express static middleware at `/widget/app.js`.

The Vite build config (`vite.widget.config.mts`) uses `@preact/preset-vite`, Tailwind CSS, `vite-plugin-css-injected-by-js` (CSS injected by the JS bundle), and targets `es2020`.

## Dependencies

This package follows the monorepo's strict modularity rules. It is allowed to import from:

- `@simmetric-chat/shared` — shared types, Zod schemas, constants, and permission definitions

All other dependencies are third-party packages declared in this package's `package.json`. The widget never imports from `server`, `frontend`, or `collector`.

Key runtime dependencies:

- `express` — HTTP server framework
- `preact` — lightweight React alternative for the widget UI (the widget does **not** use React)
- `@microsoft/fetch-event-source` — SSE streaming on the client side
- `axios` — HTTP client for server-to-server API calls
- `cors`, `helmet` — security middleware (helmet is iframe-relaxed: no CSP, no frameguard, no COOP/COEP/CORP)
- `express-rate-limit`, `rate-limit-redis` — rate limiting with a Redis store
- `ioredis` — Redis client for the shared config cache and rate-limit store
- `i18next` — client-side widget translations (8 locales, statically bundled into the IIFE)
- `markdown-it`, `dompurify` — safe Markdown rendering in chat bubbles
- `winston` — structured logging
- `zod` — environment variable and request validation

## How It Fits Into the Monorepo

```text
shared ← widget
shared ← server
shared ← collector
shared ← frontend
```

- The widget imports **only** from `@simmetric-chat/shared` for types and schemas. It never imports from `server`, `frontend`, or `collector`.
- The widget service communicates with the main **server** exclusively via HTTP over the internal widget API (`/api/internal/widget`), authenticated with `WIDGET_API_KEY` sent as the `X-Api-Key` header.
- The widget is served on its own port (`WIDGET_PORT`, default `3211`) and is designed to be embedded in external websites via a `<script>` tag and sandboxed iframe.

## Configuration

Configuration lives in the repo-root `.env` (the single runtime config for all packages — see the root `.env.example`, `[widget]` section). The file is resolved by walking up from `__dirname` to the repo-root marker (`pnpm-workspace.yaml`), independent of the operator's working directory, with a cwd-adjacent fallback for packaged layouts (e.g. the Tauri sidecar) that skip the root merge. Missing required keys produce an actionable diagnostic listing the resolved `.env` path and the missing key names before exit.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WIDGET_API_KEY` | Yes | — | API key for authenticating with the server's internal widget API (`X-Api-Key` header). Generate via `pnpm --filter server generate-apikey`. |
| `WIDGET_PORT` | No | `3211` | Port the widget Express service listens on |
| `SERVER_URL` | No | `http://localhost:3000` | Base URL of the main Simmetric Chat server |
| `REDIS_URL` | No | — | Redis connection string for the shared config cache and rate-limit store. When unset, the service operates in single-instance mode with in-memory fallbacks. |
| `LOG_LEVEL` | No | `info` | Winston log level |
| `NODE_ENV` | No | `development` | Runtime environment (production applies stricter rate-limit values) |

## Chat Flow and SSE Proxy

The widget chat route (`src/routes/chat.ts`) is a **transparent SSE proxy** — it relays raw bytes from the upstream server to the widget iframe via `responseType: "stream"` without parsing or transforming events, with one exception: `event: thinking` blocks are stripped from the byte stream (`stripThinkingEvent`, defense-in-depth — the widget never sets `include_thinking` upstream). SSE events follow the standard project format: `token`, `status`, `citations`, `done` (with `model`, `providerType`, `mcpSources`, `doneReason`, `pipeline`, and `dlp_matches` when DLP is enabled and matches were found), and `error`.

Before proxying starts, the route performs a **pre-RAG search** against the widget's linked workspaces via `searchWidgetWorkspaces(message, widgetId)` — it sends only the `widgetId`, letting the server resolve workspace IDs from its `WidgetWorkspace` whitelist (IDOR prevention). If the search fails or returns zero results, the route emits a `status: rag-degraded` event to the client and sets `disableRagSearch` on the upstream request (non-blocking: chat continues without context). The visitor locale is forwarded upstream when the client sends one so the server can localize the no-results sentence. Before proxying, the route also increments the session's `messageCount` via the server internal API (the server enforces the hourly cap and returns 429 when exhausted).

The Preact client (`useWidgetChat` hook) parses the SSE stream with `@microsoft/fetch-event-source`. The `PIIWarningPrompt` modal is a **pre-send consent gate** — the visitor must accept the PII notice before the first message is sent (consent is persisted via the loader handshake under `sc-widget-<id>-consent`); PII scanning itself happens server-side in the agent's DLP filter (`dlp_matches` on the `done` event).

### Session persistence (sessionStorage fixture)

Per WID-03 D-05/D-06, chat message history and the session token are stored on the loader/parent page (stable origin) via `postMessage` — the sandboxed iframe (opaque origin, no `allow-same-origin`) cannot reliably use its own `sessionStorage`. The handshake works in both directions:

- **Iframe → loader**: `simmetric:storage-get` / `simmetric:storage-set` posted to `window.parent`. The iframe accepts `simmetric:storage-data` replies only when `event.source === window.parent` (origin comparison is impossible under an opaque origin — `window.location.origin` serializes to `"null"`).
- **Loader → iframe**: the loader only serves storage requests when `event.source === iframeEl.contentWindow` (WR-01 inbound hardening — prevents token reads and session fixation via crafted messages from host-page scripts or sibling iframes).

Keys (defined by `sessionKey()`/`messagesKey()`/`consentKey()`/`leadSubmittedKey()` in `src/routes/loader.ts`):

- `sc-widget-<widgetId>-session` — cached session JWT (`{ token }`), reused on reload so a new session is **not** created (prevents blow-through of the session limit). Read before `POST /api/sessions` with a 1500 ms timeout.
- `sc-widget-<widgetId>-messages` — chat message history, persisted only on `done`/`error`/unmount (D-05 — never per-token, to avoid postMessage flooding on multi-hundred-token SSE responses) and restored on reload so the conversation survives a page navigation.
- `sc-widget-<widgetId>-consent` — visitor consent flag, set when the user accepts the chat (`ChatPanel.tsx`)
- `sc-widget-<widgetId>-lead-submitted` — flag preventing duplicate lead submissions in the same session (`ChatPanel.tsx`)
- `sc-widget-<widgetId>-contact-banner-dismissed` — contact-banner dismiss flag (persisted via the same handshake)

All `sessionStorage` access is wrapped in try/catch because the sandboxed iframe (`allow-scripts allow-forms`, no `allow-same-origin`) may block storage — failures degrade silently without breaking the chat.

## Rate Limiting

Rate limiting is enforced at two layers — widget middleware and server-side (DB-tracked session counters):

| Limiter | Scope | Limit (prod / dev) | Window | Key |
|---------|-------|--------------------|--------|-----|
| `widgetDailyMessageLimiter` | Per visitor per widget | 5 / 50 (or per-widget `sessionLimitPerDay` from Redis config) | 24 hours | `widgetId` + IP composite (from `req.originalUrl` URL path; falls back to IP via `ipKeyGenerator`, then `"unknown"`) |
| `widgetChatLimiter` | Per tenant (Widget) | 30 / 200 (or per-widget `rateLimitPerMinute` from Redis config) | 1 minute | `widgetId` (from `req.originalUrl` URL path; falls back to IP via `ipKeyGenerator`, then `"unknown"`) |
| `widgetSessionLimiter` | Per IP | 50 / 500 | 24 hours | IP |
| `widgetLeadLimiter` | Per IP | 3 / 30 | 1 hour | IP |
| Server session counters | Per session | 20 messages (hourly) / 5 conversations (daily) | Session-lifetime (session expires after 24h) | DB counters on `WidgetSession` (`hourlyRemaining` / `dailyRemaining` returned to the client; the server rejects with 429 when a counter is exhausted) |

Development (NODE_ENV !== "production") raises middleware limits to the dev values in the table above — a 10x multiplier for the daily/session/lead limiters, but ~6.7x for `widgetChatLimiter` (30/min prod → 200/min dev). Server-side limits are checked in the chat route before SSE proxying starts.

Since v0.19, `widgetChatLimiter` and `widgetDailyMessageLimiter` use a **Redis-backed store** (`rate-limit-redis`, prefix `rl:`) when Redis is available, and their `max` is a function that reads `rateLimitPerMinute` / `sessionLimitPerDay` from the Redis widget-config cache (`widget:config:{widgetId}`) — falling back to the global defaults (30/5 prod, 200/50 dev) on cache miss or Redis unavailability. The limiters run **before** `sessionMiddleware`, so they read Redis directly rather than `req.widgetConfig`. The other limiters remain in-memory (`express-rate-limit` default store).

## Testing

Run tests for this package in isolation:

```bash
pnpm --filter widget test
```

Tests cover HTTP routes (supertest), middleware, Redis integration, and pure helper logic. The Jest config maps `@simmetric-chat/shared` to the monorepo shared package source and uses `@swc/jest` for transformation. Test files live in `src/__tests__/` (`chat.proxy.test.ts`, `chatPanelLogic.test.ts`, `chatPanel.seam.test.ts`, `envExampleParity.test.ts`, `globToRegex.test.ts`, `loader.test.ts`, `matchUrlPattern.test.ts`, `rateLimit.test.ts`, `rateLimit.daily.test.ts`, `rateLimit.redis.test.ts`, `rawEnvReads.test.ts`, `redisService.test.ts`, `session.test.ts`, `session-route.test.ts`, `sourceCitationSeam.test.ts`, `useWidgetChat.dedup.test.ts`, `useWidgetConfig.test.ts`, `welcomeScreen.seam.test.ts`, `widgetApi.test.ts`, `widgetApp.test.ts`, `widgetEmbedLayout.seam.test.ts`, `widgetI18n.test.ts`, `widgetOpenState.test.ts`) with shared env setup under `src/__tests__/helpers/setupEnv.ts`.
