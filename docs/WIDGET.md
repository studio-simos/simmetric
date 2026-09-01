<!-- GSD-DOC: type=custom mode=update generated=2026-04-21 -->
# Embeddable Chat Widget

Integration guide for the Simmetric Chat embeddable widget system. External websites can embed a chat widget powered by the platform's RAG pipeline and agent infrastructure.

---

## Overview

The widget system enables website visitors to chat with an AI assistant without accessing the main Simmetric Chat application. Widgets are workspace-scoped — each widget connects to one or more workspaces' knowledge bases.

**Architecture:** Two-step embedding pattern (loader JS + iframe HTML) eliminates XSS risks from string interpolation. The previous `embed.ts` route was removed entirely (commit 314bbe0b) — all four `/api/embed` endpoints previously returned `410 Gone`. Widget administration (CRUD, branding, CORS origins) lives in the main server at `/api/widgets`. Widget runtime (session management, config delivery) lives in the main server at `/api/internal/widget`; the chat proxy lives in the widget service (`packages/widget/src/routes/chat.ts`, `POST /:widgetId/stream`, proxying to `${SERVER_URL}/api/internal/widget/chat/stream`).

---

## Package Structure

The widget lives in `packages/widget/`:

```text
packages/widget/
├── src/
│ ├── routes/ # Express backend
│ │ ├── session.ts # Widget session creation
│ │ ├── config.ts # Widget configuration endpoint (cached)
│ │ ├── chat.ts # SSE chat proxy to main server
│ │ ├── lead.ts # Lead capture endpoint (mounted at /api/lead)
│ │ └── loader.ts # Two-step embedding: loader JS + iframe HTML
│ ├── middleware/
│ │ ├── session.ts # Session authentication for widget
│ │ └── rateLimit.ts # Rate limiting for widget endpoints
│ ├── services/
│ │ └── widgetApi.ts # Widget API service
│ ├── widget/ # Preact frontend (runs in iframe)
│ │ ├── components/
│ │ │ ├── ChatFab.tsx # Floating action button
│ │ │ ├── ChatPanel.tsx # Main chat panel container
│ │ │ ├── ChatHeader.tsx # Header with ARIA heading role
│ │ │ ├── MessageArea.tsx # Message list with streaming cursor
│ │ │ ├── MessageBubble.tsx # Individual message rendering
│ │ │ ├── InputBar.tsx # Text input with send button
│ │ │ ├── WelcomeScreen.tsx # Initial view with suggested questions
│ │ │ ├── ErrorBar.tsx # Auto-dismissing error display
│ │ │ ├── RateLimitNotice.tsx # Rate limit warning
│ │ │ ├── FallbackMessage.tsx # Fallback for non-chat views
│ │ │ ├── PIIWarningPrompt.tsx # PII consent gate
│ │ │ └── LeadCaptureCard.tsx # Lead capture form
│ │ └── hooks/
│ │ ├── useWidgetConfig.ts # Reads config from JSON script block
│ │ ├── useWidgetChat.ts # Full SSE chat lifecycle
│ │ └── useTriggers.ts # Trigger logic for widget events
│ ├── config/
│ │ └── env.ts # Zod-validated env vars
│ └── __tests__/ # 21 test files
├── vite.widget.config.mts # Vite config for IIFE bundle (CSS inlined)
└── postcss.config.js # PostCSS config
```

---

## Embedding a Widget

### Script tag embedding

Add the loader script to your website HTML:

```html
<script src="https://your-simmetric-chat.com/widget/loader.js?widgetId=WIDGET_ID"></script>
```

The loader dynamically creates an iframe pointing to the widget panel HTML.

### Two-step embedding flow

1. **Loader JS** (`/widget/{widgetId}.js`): Returns a JavaScript file that creates an iframe on the host page
2. **Iframe HTML** (`/widget/{widgetId}?primaryColor=...&position=...&locale=...`): Loads the Preact application inside the iframe

This pattern ensures the widget runs in an isolated iframe context, preventing XSS from string interpolation.

---

## Widget API Routes

### Admin CRUD (`/api/widgets`) — JWT + admin role required

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/widgets` | List all widgets (excludes soft-deleted) |
| POST | `/api/widgets` | Create widget (license-gated: `widget_enabled` + `max_widgets`) |
| GET | `/api/widgets/:id` | Get single widget |
| PUT | `/api/widgets/:id` | Update widget (name, messages, position, branding, CORS origins, active status) |
| DELETE | `/api/widgets/:id` | Soft-delete widget |
| GET | `/api/widgets/:id/workspaces` | List linked workspaces |
| PUT | `/api/widgets/:id/workspaces` | Set workspace whitelist (replaces all links) |

### Internal API (`/api/internal/widget`) — API key auth, dynamic CORS

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:id/config` | Get widget config (branding, workspace, messages) |
| POST | `/session` | Create anonymous session (256-bit hex token, 24h expiry) |
| GET | `/session/:token` | Validate session, return rate limit status |
| PATCH | `/session/:token/increment` | Increment message/conversation counter, enforce rate limits |

### Widget Client Routes (in `packages/widget/`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/widget/:widgetId.js` | Returns loader JavaScript |
| GET | `/widget/:widgetId` | Returns iframe HTML with Preact app |
| POST | `/api/sessions` | Create widget session |
| GET | `/api/config/:widgetId` | Get widget configuration (in-memory cached) |
| POST | `/api/chat/:widgetId/stream` | SSE chat proxy to main server agent endpoint |
| POST | `/api/lead/:widgetId` | Submit lead from widget visitor |

---

## Preact UI Components

### ChatFab
Floating action button (FAB) positioned at bottom-right. Accessible with ARIA labels. Click toggles chat panel visibility.

### ChatPanel
Main chat container. Features:
- PII consent gate — user must accept before chatting
- Conditional views: welcome screen or message history
- Error auto-dismiss after timeout
- Rate limit notice display

### WelcomeScreen
Initial view shown before first message. Displays:
- Welcome message
- Suggested questions (clickable)
- AI disclosure subtitle
- PII notice text

### MessageArea
Message list with streaming cursor animation during response generation.

### InputBar
Text input with send button. Submits messages via `useWidgetChat` hook.

---

## Preact Hooks

### `useWidgetConfig`
Reads widget configuration from the `textContent` of the `<script type="application/json" id="widget-config">` JSON block inside the iframe's own document (injected by `loader.ts`; see `useWidgetConfig.ts:198` and `loader.ts:735`). Provides:
- Widget ID
- Primary color
- Position
- Welcome message
- Suggested questions

### `useWidgetChat`
Manages the full SSE chat lifecycle:
1. Creates session via `/api/sessions`
2. Sends messages via `/api/chat/:widgetId/stream` (SSE)
3. Streams token-by-token responses
4. Handles citations, status messages, and errors
5. Supports abort via AbortController

---

## Build Configuration

The widget Preact app is built as an IIFE bundle via `vite.widget.config.mts`:

- **Output format:** IIFE (immediately-invoked function expression)
- **Target:** Runs inside an iframe, no module system needed
- **CSS:** Tailwind CSS v4 with `@theme` in `index.css` (no separate config file)
- **Bundle:** Single JS file with CSS inlined for iframe consumption

Build command:
```bash
pnpm --filter @simmetric-chat/widget build:widget
```

---

## Security

- **Session auth:** Widget sessions are created server-side and validated on every request
- **Rate limiting:** Per-session limits: 20 messages/hour, 5 conversations/day. Returns 429 with `retryAfter` when exceeded
- **Dynamic CORS:** `widgetCors` middleware on `/api/internal/widget` validates the `Origin` header against each widget's `allowedOrigins` list. Returns 403 for disallowed preflight requests. Fail-closed on DB errors
- **XSS prevention:** Two-step iframe embedding eliminates string interpolation risks
- **Removed routes:** The old `/api/embed` endpoints were removed (commit 314bbe0b); no `/api/embed` route exists in the codebase
- **PII consent:** Users must acknowledge PII handling before chatting
- **License gating:** Widget creation requires `widget_enabled` feature flag and respects `max_widgets` numeric limit

---

## Branding & Customization

Widgets support visual customization via branding fields:

| Field | Default | Description |
|-------|---------|-------------|
| `primaryColor` | `#4c6ef5` | Primary accent color (hex format) |
| `botName` | `AI Assistant` | Display name shown in chat header |
| `logoUrl` | `null` | Custom logo image URL (shown in FAB and header) |
| `avatarUrl` | `null` | Custom assistant avatar image URL (shown in message bubbles) |
| `position` | `bottom-right` | Widget position: `bottom-right` or `bottom-left` |

**Community tier**: Branding fields can be set but defaults are applied when values are empty/null.
**Enterprise tier**: Full customization, gated by `white_label` feature flag for UI-level writes.

Branding is rendered via CSS custom properties in the Preact widget client (`--widget-primary`, `--widget-bot-name`). The `widgetConfigResponseSchema` in `@simmetric-chat/shared` defines the config shape delivered to the client.

---

## Configuration

Widget-specific environment variables (in the root `.env`, `[widget]` section — see the root `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WIDGET_API_KEY` | — (required) | API key for authenticating to the main server's `/api/internal/widget` endpoints |
| `WIDGET_PORT` | `3211` | Widget service port |
| `SERVER_URL` | `http://localhost:3000` | Main server URL for chat proxy |

---

## `simmetric:*` postMessage Protocol

The widget iframe and the host page communicate via `postMessage` using the `simmetric:*` message-type namespace. This protocol is **stable public API**. Breaking changes (removing or renaming a message type, changing a payload shape) require a **major version bump** and a **migration note** in the changelog.

### Message Types

| Message | Direction | Payload | Purpose |
|---------|-----------|---------|---------|
| `simmetric:storage-get` | iframe → host | `{ type, widgetId, keys, requestId }` | Iframe requests cached `sessionStorage` values from the parent (opaque-origin iframe cannot read its own storage). |
| `simmetric:storage-set` | iframe → host | `{ type, widgetId, key, value }` | Iframe writes a value to the parent's `sessionStorage`. **Persistence is batched** on `done`/`error`/iframe-unmount — never per-token — to avoid `postMessage` flooding. Do not expect real-time per-token persistence. |
| `simmetric:storage-data` | host → iframe | `{ type, data, requestId }` | Parent replies to a `simmetric:storage-get`. `requestId` correlates the reply to the originating request (G-131-18). |
| `simmetric:widgetOpen` | bidirectional (iframe → host AND host → iframe) | `{ type }` | iframe → host: iframe notifies the host that the panel opened (host lifts `pointer-events: none`). host → iframe: a FAB click tells the iframe to open. |
| `simmetric:widgetClose` | bidirectional | `{ type }` | iframe → host: panel closed (host restores `pointer-events: none`). host → iframe: a FAB click tells the iframe to close. |
| `simmetric:widgetConfig` | iframe → host | `{ type, primaryColor }` (`primaryColor` is a hex `#rrggbb` string) | iframe notifies the host of the effective per-widget primary color so the host can repaint the FAB. |
| `simmetric:creditsOpen` | iframe → host | `{ type, url }` (`url` is `http`/`https` only) | iframe asks the host to open the credits link in a new tab. The sandboxed iframe has no `allow-popups`, so the host performs `window.open(url, "_blank", "noopener")` after re-validating the URL scheme. |
| `simmetric:urlChange` | host → iframe | `{ type, url, pathname }` (`url` is the full `window.location.href`; `pathname` is `window.location.pathname`) | Host notifies the iframe of an SPA URL change (pushState/replaceState/popstate/hashchange) so auto-open URL triggers can evaluate. |
| `simmetric:exitIntent` | host → iframe | `{ type }` | Host notifies the iframe of a `mouseleave` exit-intent (cursor leaves the viewport near the top) so auto-open triggers can fire. |

### Security

- **Inbound (host-side) validation:** every host-received message is validated with `event.source === iframeEl.contentWindow` (the WR-01 guard) before acting. This prevents host-page scripts or sibling iframes from forging `simmetric:widgetOpen` / `widgetClose` / `widgetConfig` / `creditsOpen` / `storage-*` messages (e.g. session-fixation via a crafted `simmetric:storage-set`).
- **Outbound (iframe-side) target:** the iframe calls `window.parent.postMessage(msg, "*")`. `"*"` is safe because the sandboxed iframe has an opaque origin (no `allow-same-origin`), and `postMessage` on a specific `contentWindow` delivers only to that window — sibling iframes have their own `contentWindow` and never receive it. The real authentication is the inbound `event.source` check on both sides.
- **Storage key namespacing:** keys are `sc-widget-${widgetId}-session`, `sc-widget-${widgetId}-messages`, `sc-widget-${widgetId}-consent`, `sc-widget-${widgetId}-lead-submitted`, `sc-widget-${widgetId}-contact-banner-dismissed`. The `sc-widget-*` prefix is the legacy key namespace, kept for storage-handshake backwards compatibility.

### Versioning

This protocol was introduced as `simmetric:*` during the v1.0 rename. There is **no `simos:*` predecessor**. Breaking changes (removing/renaming a message type, changing a payload shape) require a major version bump and a changelog migration note.

---

## Testing

21 test files in `packages/widget/src/__tests__/`:

| Test | Coverage |
|------|----------|
| `session.test.ts` | Session middleware |
| `session-route.test.ts` | Session creation endpoint |
| `rateLimit.test.ts` | Rate limiting |
| `rateLimit.redis.test.ts` | Rate limiting with Redis store |
| `loader.test.ts` | Loader route (JS + HTML) |
| `chat.proxy.test.ts` | SSE chat proxy |
| `chatPanelLogic.test.ts` | Chat panel logic |
| `widgetApi.test.ts` | Widget API service |
| `redisService.test.ts` | Redis service |
| `globToRegex.test.ts` | URL pattern matching |
| `matchUrlPattern.test.ts` | URL pattern matching |
| `sourceCitationSeam.test.ts` | Source citation seam |
| `useWidgetChat.dedup.test.ts` | useWidgetChat dedup logic |
| `useWidgetConfig.test.ts` | useWidgetConfig hook |
| `widgetI18n.test.ts` | Widget i18n |
| `widgetOpenState.test.ts` | Widget open state |

---

## See also

- [Documentation index](./INDEX.md)
- [API Reference](./API.md)
- [Architecture](./ARCHITECTURE.md)