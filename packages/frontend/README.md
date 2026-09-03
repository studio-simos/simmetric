<!-- generated-by: gsd-doc-writer -->

# @simmetric-chat/frontend

React 19 single-page application for Simmetric Chat. Provides the end-user web interface with real-time SSE chat streaming, workspace and document management, admin settings panels, model palette with keyboard shortcuts, side-by-side model comparison, MCP marketplace browsing, archive/synthesis/OCR UI, and backup management.

**Part of the [Simmetric Chat](../../README.md) monorepo.**

## Overview

This package is the browser-facing UI of the platform. It communicates exclusively with the backend server (`@simmetric-chat/server`) via HTTP and Server-Sent Events. The frontend is built with Vite, styled with Tailwind CSS, and uses a three-tier state management architecture: TanStack Query for REST/CRUD server state, React Context for UI lifecycle/navigation state, and `fetchEventSource` + `useState`/`useRef` for SSE streaming. It supports dark/light themes, internationalization (8 languages: English, Italian, Russian, German, French, Spanish, Chinese, Portuguese), and responsive layouts for desktop and mobile.

Zustand was fully removed on 2026-05-24. The `src/stores/` directory no longer exists — all server state lives in TanStack Query, UI state in React Context, and SSE streaming state in `useChat`'s `useState`/`useRef`.

## Entry Points

- `src/main.tsx` — Application bootstrap. Creates the React root (inside `StrictMode`) and mounts the tree as `ErrorBoundary > QueryClientProvider > BrowserRouter > ThemeProvider > ChatProvider > PageMetaProvider > EnterpriseModulesProvider`. Side-effect imports apply FOUC-safe UI preferences (`./lib/uiFontScale`, `./lib/uiDensity`) plus i18n, `index.css`, and the Inter/Geist/JetBrains Mono fonts before `App` renders. Also registers the push-notification service worker (`/sw.js`) on window load.
- `src/App.tsx` — Root component. Handles auth initialization, sidebar navigation, route guards, menu-section gating, and global keyboard shortcuts.
- `index.html` — Vite entry HTML. `window.__APP_VERSION__` is injected by a custom Vite plugin (reads the monorepo root `package.json` version).

## Scripts

Run these from the monorepo root or within this package directory:

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start the Vite dev server on port 5173 |
| `pnpm build` | Type-check (`tsc --noEmit`) and build for production to `dist/` |
| `pnpm preview` | Preview the production build locally |
| `pnpm lint` | Run ESLint on `src/` |
| `pnpm typecheck` | Run TypeScript without emitting |
| `pnpm test` | Run Jest test suite (config `jest.config.cjs`, `@swc/jest` transform) |
| `pnpm i18n:check` | Validate translation key parity across all 8 locales (EN baseline) for the `--namespaces=` list (`chat.palette`, `chat.comparison`, `chat.fallback`, `chat.modelSelector`, `chat.modelCommand`, `chat.capabilities`, `wiki`, `config`, `archives`, `uploads`, `chat.archive`, `mcpHelp`, `documents`, `synthesis.rename`, `settings.webSearch`, `widgets`, `setup.wizard`, `workspace`, `synthesis`, `ocr`); `i18n-usage-check.cjs` additionally fails on `t()` keys absent from `en` |

## Key Directories

- `src/components/` — React components (PascalCase), with `chat/`, `sidebar/`, and `ui/` (shadcn primitives) subdirectories. Includes `ChatPanel` (chat orchestrator with citations, ModelSelector, `/model` slash command, and comparison mode), `ChatSidebar` (chat list with rename/delete; `variant: "panel" | "sheet"` — data from `useChats()` with 10s staleTime), `ModelSelector` / `ModelPalette` (Cmd+K Spotlight-style switcher) / `ModelComparisonView` (side-by-side grid layout), `SettingsPage` (5 deep-linkable tabs: `profile`, `llm`, `appearance`, `security`, `advanced` — each containing permissioned sections), `SettingsRoles`, `SettingsProviders`, `SettingsOcr`, `SettingsMaintenance` (widget admin UI lives in `WidgetsPage` — SettingsPage redirects `tab=widgets` to `/widgets`), `MarketplacePage` / `MarketplaceDetail` / `MarketplaceCard`, archive UI (`ArchivesPage`, `ArchiveDetailPage`, `ArchiveGraphView`, `ArchiveConfigPanel`), synthesis UI, OCR UI, and backup management.
- `src/queries/` — TanStack Query hooks (26 hook modules, 144 exported hooks) for REST/CRUD server state: `useAuth`, `useChats`, `useChatTokens`, `useWorkspaces`, `useProjects`, `useProviders`, `useProviderPresets`, `useSettings`, `useDocuments`, `useArchives`, `useSynthesis`, `useMarketplace`, `useMcpConnections`, `useWidgets`, `useLicense`, `useOcrJobs`, `useOcrModels`, `useDlpPatterns`, `useBackupDestinations`, `useBackupJobs`, `useBackupLogs`, `useUploadDrafts`, `useFilters`, `useSso`, `useTemplates`, `useSystem`. Centralized key registry in `queries/keys.ts`; client in `queries/queryClient.ts`.
- `src/contexts/` — React Context providers for UI lifecycle state: `ChatContext` (workspace/chat navigation with imperative setters), `PageMetaContext` (page metadata), `ThemeContext` (dark/light theme, persisted to localStorage), `EnterpriseModulesContext` (enterprise module manifest, mounted innermost).
- `src/hooks/` — Custom React hooks. Key hooks: `useChat` (SSE streaming via `@microsoft/fetch-event-source`, split into `useChatStreaming` / `useChatPersistence` / `useChatModelSelection` / `useChatPanelState` / `useMessageHistory` siblings; per-chat model persistence, `resolveEffectiveModel` with three-tier fallback), `useFeature` / `useFeatureLimit` / `useLicenseTier` (license gating), `useKeyboardShortcuts` (global Cmd+K / Cmd+Shift+M via `useEffectEvent`), `useModelPalette`, `useModelAvailability` (30s poll), `useSpeechRecognition` (Web Speech API wrapper), `usePushNotifications` (web push), `useIsMobile`, `useBackupPermission`, `usePageMeta`, `usePaletteCallbacks`.
- `src/utils/` — API utilities (`api.ts`: `apiGet` / `apiPost` / `apiPut` / `apiPatch` / `apiDelete` / `apiUpload` prepend `/api` and inject `Authorization: Bearer <token>` from localStorage; `handleResponse<T>` throws `ApiError` on non-2xx; session validation is handled by the `useMe()`/`useAuth()` TanStack Query hooks hitting `/auth/me`, not by a util function), markdown rendering (`markdown.ts` — markdown-it + highlight.js + DOMPurify), widget embed helpers (`widgetSnippet.ts`, `widgetServiceUrl.ts`), and other utilities.
- `src/lib/` — Shared library utilities: `toast.ts` (sonner helpers `showSuccess` / `showError` / `showInfo` / `toastWithAction`), `uiFontScale.ts` and `uiDensity.ts` (FOUC-safe module-init), `utils.ts`.
- `src/i18n/` — Translation JSON files for 8 languages: `en` (parity baseline) plus `it`, `ru`, `de`, `fr`, `es`, `zh`, `pt` (all must stay in parity — run `pnpm i18n:check`).
- `src/types/` — Frontend-only TypeScript types. Shared types are imported from `@simmetric-chat/shared`.
- `src/__tests__/` — Co-located component and utility tests (Jest + React Testing Library + jsdom).

## Dev Server and Proxy

The Vite dev server runs on **port 5173** and proxies API, avatar, and branding requests to the backend at `http://localhost:3000`, plus widget service routes to the widget at `http://localhost:3211`:

```ts
// vite.config.ts (excerpt)
server: {
  port: 5173,
  proxy: {
    "^/widget/":                    { target: "http://localhost:3211", changeOrigin: true, configure: configureDevProxy },
    "^/api/(sessions|config|chat|lead)(/|$)": { target: "http://localhost:3211", changeOrigin: true, configure: configureDevProxy },
    "/api":      { target: "http://localhost:3000", changeOrigin: true, configure: configureDevProxy },
    "/avatars":  { target: "http://localhost:3000", changeOrigin: true, configure: configureDevProxy },
    "/branding": { target: "http://localhost:3000", changeOrigin: true, configure: configureDevProxy },
  },
}
```

The widget regex keys are declared BEFORE the generic `/api` key — Vite matches proxy keys in insertion order with `startsWith()`, so the SPA's `/widgets` admin routes and MCP pin routes (`/api/chats`, `/api/chats/:id/pins`) are not hijacked. The same proxy table is applied to `vite preview`.

`configureDevProxy` retries `ECONNREFUSED` up to 8 times with a 500ms backoff on GET/HEAD only (POST and SSE bodies are never replayed) to absorb the dev backend's slower boot (Prisma client + Postgres + auto-seed + license/FTS/scheduler init). Once the server binds, the retry succeeds; if it stays down, a single concise 502 is returned instead of a stack dump. In production, the frontend is served as static files by Nginx, which also handles API routing.

Vite resolves a `@` path alias to `./src` and `@simmetric-chat/shared` to `../shared/src/index.ts`.

## State Management

Three-tier architecture (full boundary document in `docs/STATE_MANAGEMENT.md`):

- **TanStack Query** (`src/queries/`, 26 hook modules) — REST/CRUD server state. Query client defaults: 30s staleTime, refetch on window focus, 1 retry (skipped for 401/403/429), no mutation retries. Centralized cache key registry in `queries/keys.ts`.
- **React Context** (`src/contexts/`) — UI lifecycle/navigation state. `ChatContext` exposes imperative setters so non-React callbacks (SSE handlers) can update navigation.
- **fetchEventSource + useState/useRef** (`src/hooks/useChat.ts`) — SSE streaming. NOT TanStack Query; SSE is an open persistent connection, not request/response.

Golden rule: REST data → TanStack Query. SSE data → `fetchEventSource` + `useState`/`useRef`. Pure UI state (selected tab, theme, navigation) → React Context.

## Model UI

- `ModelSelector` — popover + command list with search, provider grouping, Local/Cloud badges, default indicator, and capability badges (plain `<Badge variant="outline">` chips, no per-capability colors).
- `ModelPalette` — Spotlight-style `CommandDialog` triggered by **Cmd+K**. ArrowUp/ArrowDown to move selection, Enter to select, Escape to close. Footer advertises the comparison shortcut.
- `ModelComparisonView` — side-by-side CSS Grid 50/50 layout (stacked on mobile). Two independently-selectable panes, each running its own `useChat` instance with isolated message history and a separate `AbortController`. Toggled via `window.dispatchEvent(new CustomEvent("toggle-comparison"))`.
- `/model` slash command — intercepted in `ChatPanel.handleKeyDown` on Enter before `handleSend()`. Empty args open the palette; exact match (against `model.name` and `model.displayName`) switches immediately; partial match opens a pre-filtered palette; no match shows an error toast.
- Cross-component palette open uses `CustomEvent("open-palette")` with optional `detail.filter`.

### Keyboard Shortcuts

- **Cmd+K / Ctrl+K** — open model palette.
- **Cmd+Shift+M / Ctrl+Shift+M** — open model comparison mode.
- **Esc** — close palette or comparison mode.

Registered in `App` via `useKeyboardShortcuts` (listens on `document`, prevents default browser behavior, skips key repeats and Alt-modified keys).

## Dependencies

- **Framework**: React 19.2.8 (with `babel-plugin-react-compiler` 1.0.0, `target: "19"`), react-router-dom 7.18.2, Vite 8.2.2, TypeScript 6
- **Styling**: Tailwind CSS 4.3.3 (`darkMode: "class"`; shadcn-style tokens (`--background`, `--foreground`, `--card`, `--primary`, `--border`, etc.) defined in `src/index.css` `:root` / `.dark` and mapped through `@theme inline`; `tailwind.config.ts` contains only `content` + `darkMode` — no custom color scale; 150ms transitions on bg/border/color), Radix UI primitives + `radix-ui` umbrella (Slot.Root pattern), shadcn 4.19.1, Lucide, `@tailwindcss/typography`, `tw-animate-css`, `class-variance-authority`, `clsx`, `tailwind-merge`
- **State**: TanStack Query 5.102.3, React Context (no Zustand — removed 2026-05-24)
- **HTTP / Streaming**: Native fetch (`src/utils/api.ts`), `@microsoft/fetch-event-source` 2.0.1
- **Markdown / Code**: markdown-it 14.3.0, highlight.js 11.12.0, dompurify 3.4.14
- **Charts**: Recharts 3.10.1, D3 7.9.0
- **Forms / DnD**: react-hook-form 7.86 + `@hookform/resolvers` 5.9 (Zod), `@dnd-kit/core` 6.3.1, react-dropzone 15, zod 4.4
- **TTS / Voice**: native `speechSynthesis` API (read-aloud on assistant messages), `useSpeechRecognition` (Web Speech API wrapper)
- **i18n**: react-i18next 17.0.12 + i18next 26.4.0 (8 locales)
- **UI extras**: sonner 2.0.8 (toasts), cmdk 1.1.1 (command palette), diff-match-patch 1.0.5, `@fontsource-variable/inter` / `@fontsource-variable/geist` / `@fontsource/jetbrains-mono`
- **Compiler / Lint**: `babel-plugin-react-compiler` 1.0.0, `eslint-plugin-react-compiler` + `eslint-plugin-react-hooks` (registered manually in the root flat config)
- **Shared**: `@simmetric-chat/shared` (types, schemas, constants) — only cross-package import

## Build Configuration

- Module system: ESM (`"type": "module"`, `"module": "ESNext"`); target `ES2022`; TypeScript `strict: true` plus `noUnusedLocals` / `noUnusedParameters` / `noUncheckedIndexedAccess`.
- No runtime env injection — Vite bakes `import.meta.env` at build time. The only build-time global injected into `index.html` is `window.__APP_VERSION__` (from the monorepo root `package.json`).
- `vite build` emits to `dist/` with hashed asset filenames and source maps (disable source maps for air-gapped deployments). Code splitting via dynamic imports is used for Settings tabs to reduce initial load.
- ESLint flat config lives at the monorepo root (`eslint.config.mjs`); frontend-specific `react-compiler` and `react-hooks` plugins are registered there.

## How It Fits into the Monorepo

```text
shared ← frontend
```

The frontend imports **only** from `@simmetric-chat/shared` and communicates with the server via HTTP/SSE. It does not import server or collector code directly. This keeps the dependency graph unidirectional and enforces clean package boundaries.

The frontend package is marked `private: true` — it is not published and is consumed as part of the monorepo workspace.