# AGENTS.md — @simmetric-chat/widget

Embeddable chat widget service (port 3211). **CJS** (unlike frontend). Two layers: an Express API (`src/index.ts`, `createApp()` factory) and a **Preact** UI (`src/widget/`) bundled as an IIFE via Vite. Not React — do not import React components/hooks here.

## Commands

```bash
pnpm --filter widget dev                # tsx watch src/index.ts
pnpm --filter widget build              # tsc → dist/ (server code only)
pnpm --filter widget build:widget       # vite build → dist-widget/app.js (Preact IIFE bundle; dist-widget/ is gitignored)
pnpm --filter widget test               # included in root `pnpm test`
pnpm --filter widget typecheck
```

- The Preact bundle is served from `dist-widget/` — run `build:widget` after changing `src/widget/` or the dev server serves a stale bundle.
- Widget tests map `@simmetric-chat/shared` to shared **source** (`../shared/src/index.ts`) — no shared build needed for tests, but `tsc` build does need `shared/dist`.

## Architecture

- `src/routes/` — `chat.ts` (SSE proxy: pre-RAG search + transparent relay with `thinking`-event strip), `session.ts` (anonymous sessions), `config.ts` (appearance config, Redis + 5-min in-memory cache, `cache-bust` endpoint), `loader.ts` (loader JS + iframe HTML), `lead.ts` (lead capture).
- `src/services/widgetApi.ts` — HTTP client for the server's internal widget API (`/api/internal/widget`), authenticated with `WIDGET_API_KEY` on the `X-Api-Key` header. Generate the key server-side: `pnpm --filter server generate-apikey`, then put it in the root `.env` ([widget] section).
- `src/middleware/session.ts` — session JWT validation (`X-Session-Token`), validated server-side on every request.
- The iframe is sandboxed `allow-scripts allow-forms` with **no** `allow-same-origin` (opaque origin) — so the widget persists session/messages on the **parent page** via a `postMessage` storage handshake (`simmetric:storage-get`/`set`/`data`, keys `sc-widget-${widgetId}-session`/`-messages`, with `event.source` validation). Don't switch to iframe-local storage.
- Optional Redis (`REDIS_URL`): shared config cache + distributed rate-limit store; degrades to in-memory when absent.

## Gotchas

- The widget reads the repo-root `.env` (marker-walk via `loadRootEnv()`; cwd-adjacent fallback in packaged layouts — OPS-05 lineage). `WIDGET_API_KEY` is required (Zod-validated, min 1 char).
- helmet is deliberately loosened (CSP/frameguard/COOP/CORP off) so the widget can be embedded in iframes on external sites — don't "harden" it back.
- E2E (`pnpm test:e2e`) boots the widget with plain `tsx src/index.ts` (not `tsx watch` — it stalls on CI) and requires the Enterprise license JWT in the root `.env` plus a matching `api_keys` row (seeded by `e2e/globalSetup.ts`).
- `src/widget/` uses Preact hooks (`useWidgetChat`, `useWidgetConfig`, `useTriggers`) — same SSE event contract as the frontend (`token`/`status`/`citations`/`done`/`error`).
