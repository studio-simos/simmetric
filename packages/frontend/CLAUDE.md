# CLAUDE.md — Frontend

Vite + React 19 SPA + Tailwind CSS. **No Next.js.** Vite proxies `/api` to server. Port 5173.

## Structure

- **State**: Three-tier architecture documented in `docs/STATE_MANAGEMENT.md`. TanStack Query hooks in `src/queries/` for REST/CRUD server state (23 hooks: auth, chats, chatTokens, workspaces, projects, providers, providerPresets, settings, documents, archives, synthesis, marketplace, MCP connections, widgets, OCR jobs/models/defaults/preferences, backups, licenses, uploadDrafts). React Context in `src/contexts/` for UI lifecycle/navigation state (ChatContext — workspace/chat nav, PageMetaContext — page metadata, ThemeContext — dark/light theme). Raw `fetchEventSource` + `useState`/`useRef` in `src/hooks/useChat.ts` for SSE streaming (NOT TanStack Query — SSE is an open persistent connection, not request/response).
- **Hooks**: useChat (SSE streaming chat with abort, chat rename, message delete, per-chat model persistence, persistedModel, updateChatModel), useFeature (boolean license feature gating), useFeatureLimit (numeric license limit), useLicenseTier (returns "community" or "enterprise"), useKeyboardShortcuts (global Cmd+K/Cmd+Shift+M handlers). **Phase 88 (MOD-02) extracted `useChat` into focused sub-hooks behind a byte-identical facade** in `src/hooks/`: `useChatStreaming` (token accumulation + fetchEventSource lifecycle), `useChatPersistence` (model PATCH + localStorage `modelPref:<ws>`), `useChatModelSelection` (`resolveEffectiveModel` cascade), `useChatPanelState`, `useMessageHistory`, `useModelAvailability` (30s availability polling), `usePaletteCallbacks`. `useChat.ts` remains the public entry that re-exports the composed behavior — import `useChat`, not the sub-hooks, unless refactoring the facade itself.
- **Components**: React components in `src/components/`. Key components: ChatPanel (chat + sidebar + citations + ModelSelector + /model command + comparison mode; below `lg` renders the chat-list and console as Sheets opened from a transparent absolute title-bar overlay, the chat-list Sheet mirrors the console Sheet but anchored left), ChatSidebar (chat list with rename/delete, 30s polling; `variant: "panel" | "sheet"` — panel = inline at lg+, collapses to a `w-9` left rail persisted to `localStorage["chat-sidebar-open"]` default open, close chevron in header next to "New chat"; sheet = fills the mobile Sheet via `w-full` + `onClose` to close from the header chevron — symmetric to `RightPanel`), SettingsPage (5 top-level tabs: `profile`, `llm`, `appearance`, `security`, `advanced` — each containing permissioned sections: personalInfo, customInstructions, languages, providers, llmEmbedding, appearance, roles, users, nonAdminUpload, vectorDB, apiKeys, mcpConnections, maintenance, backups, dlp, chatData, resetDb), SettingsRoles (role CRUD with permissions + menu sections), SettingsEmbed (iframe/script embed code generator), SettingsWidget (widget admin dashboard), SettingsOcr (OCR model catalog, job list, model selection, prompt preview, custom instructions, upload panel), SettingsMaintenance (RAG reindex UI: POST /api/system/reindex-documents trigger with progress result), WidgetForm (widget create/edit with branding), WidgetWorkspaceSelector (workspace whitelist picker), ModelSelector (dropdown with search, provider grouping, Local/Cloud badges, default indicator, capability badges), ModelPalette (Spotlight-style palette for quick model switching, Cmd+K triggered), SettingsProviders (provider CRUD + model management + workspace default model), ArchivesPage + ArchiveDetailPage + ArchiveCreateDialog + ArchiveCard + ArchiveSidebar (archive browsing UI), OcrJobCard + OcrJobList + OcrPreviewModal + OcrModeSelector (OCR job lifecycle)
- **Routing**: react-router-dom v7. App component renders sidebar + routed panels.

## Key Rules

### Theme & CSS
- CSS custom properties (`--bg`, `--surface`, `--text`, etc.) defined in `:root` / `.dark` selectors in `index.css`.
- Tailwind `darkMode: "class"` with `.dark` on `<html>`.
- Use `bg-[var(--surface)]` not `bg-white`. Use `text-[var(--text-muted)]` not `text-gray-500`.
- `ThemeContext` persists to localStorage via a `useLocalStorage`-like pattern.
- 150ms transition on background-color, border-color, color for smooth theme switching.
- Custom primary scale defined in `tailwind.config.ts`: `primary-50` through `primary-900` (indigo-blue palette).
- The theme toggle component adds/removes the `.dark` class on the `<html>` element and stores the preference.

### i18n
- react-i18next with JSON files in `src/i18n/{en,it,ru,de,fr,es,zh}/translation.json`
  (7 languages as of Phase 47 — added `de`, `fr`, `es`, `zh` in quick task
  `20260525-add-languages-de-fr-es-zh`).
- EN, IT, and RU are the parity-checked baseline. New languages (`de`, `fr`,
  `es`, `zh`) are populated but may lag behind for the most recent features
  (typically 1-2 weeks of drift) — check `pnpm i18n:check` to see which keys
  are missing in each locale.
- Language persisted to localStorage.
- Hook: `const { t } = useTranslation()` then `t("key.path")`.
- Parity check: run `pnpm i18n:check` to validate EN/IT/RU completeness. The
  script reports drift for other languages but does not fail the build.
- The i18n check script (`i18n-check.cjs`) validates that all keys present in
  EN also exist in IT and RU, scoped to specific namespaces. The canonical
  namespace set is defined by the `i18n:check` script in `package.json` (pass
  `--namespaces=`): `chat.palette, chat.comparison, chat.fallback,
  chat.modelSelector, chat.modelCommand, chat.capabilities, wiki, config,
  archives, uploads, chat.archive, mcpHelp, documents, synthesis.rename`. When
  you add a feature under one of these namespaces, all its keys must exist in
  EN/IT/RU or `pnpm i18n:check` will flag drift. To add a new namespace, append
  it to the `--namespaces` list in `package.json` (the script is the source of
  truth for which namespaces are parity-checked).
- New UI features must include translations for all three parity-checked
  languages (EN/IT/RU) before merging. The other four languages should be
  updated in a follow-up quick task if drift grows large.
- The `t()` function supports interpolation with `{{variable}}` syntax and
  pluralization via `count` option.

### Auth & Session
- JWT tokens stored in localStorage.
- `fetchMe()` only clears token on 401/403. On 429/500/network errors, session is preserved to avoid logging users out during transient failures.
- `useAuth()` (TanStack Query) initializes by calling `fetchMe()` on app load; if the token is invalid, the user is redirected to login.
- API calls include `Authorization: Bearer <token>` header for authenticated requests.
- The `ApiError` class in `src/utils/api.ts` extends `Error` with `status` and `details` fields for structured error handling.

### Chat Streaming
- `useChat` hook connects to `/api/workspaces/:id/chat/stream` SSE endpoint.
- Uses `@microsoft/fetch-event-source` for SSE.
- Events: `token`, `status`, `citations`, `done` (includes `modelUsed`, `providerUsed`), `error`.
- Supports abort via `AbortController`.
- Per-chat model selection: `persistedModel` and `updateChatModel(providerId, model)`.
- The `done` event payload includes `messageId`, `chatId`, `model`, and `providerType`; these are stored in message metadata.
- The `token` event data is a plain string; it is appended to `streamingContent` state for live rendering.

### Model Selection UI
- `ModelSelector` renders searchable dropdown grouped by provider with Local/Cloud badges, default indicator, and capability badges (local-only=green, fastest=amber, smartest=purple, reasoning=blue).
- `ModelPalette` is a Spotlight-style overlay triggered by Cmd+K. Supports filtering by model name. Footer advertises comparison shortcut.
- `useModelPalette` hook extracts shared model list logic for reuse by dropdown and palette.
- Cross-component palette open uses `CustomEvent("open-palette")` with optional `detail.filter`.
- The palette supports keyboard navigation: ArrowUp/ArrowDown to move selection, Enter to select, Escape to close.
- Capability badges are rendered inline per component with Tailwind color classes; no shared `CapabilityBadge` component exists yet.

### Keyboard Shortcuts
- **Cmd+K / Ctrl+K**: Open model palette.
- **Cmd+Shift+M / Ctrl+Shift+M**: Open model comparison mode.
- **Esc**: Close palette or comparison mode.
- Global shortcuts registered in App component via `useKeyboardShortcuts` hook.
- The `useKeyboardShortcuts` hook listens on `document` level and prevents default browser behavior for the bound keys.
- Shortcuts are disabled when an input element is focused to avoid interfering with text entry.

### Model Comparison
- Side-by-side CSS Grid 50/50 layout on desktop, stacked vertically on mobile.
- Two independently-selectable model panes with separate `AbortController` instances.
- Closing or aborting one pane does not affect the other.
- Responsive: sidebar hidden in comparison mode.
- Each comparison pane runs its own `useChat` instance with isolated message history.
- Comparison state is ephemeral and component-local (useState/useRef), not persisted to any global store.
- The comparison view is toggled via `window.dispatchEvent(new CustomEvent("toggle-comparison"))`.

### Graceful Fallback
- When selected model becomes unavailable, UI shows warning badge state.
- Auto-retry with fallback model (workspace default → global default → any available).
- Non-blocking toast with Undo action.
- Optimistic badge update on fallback.
- The fallback watcher in `useChat` polls `availableModels` from `useProviders()` (TanStack Query) every 30 seconds.
- If the current model is no longer in `availableModels`, `handleFallback()` is triggered automatically.
- The Undo action in the toast reverts to the previously selected model via `updateChatModel`.
- **Fallback on SSE `error` (quick 260723-lrx, RC-2):** `handleFallback()` is ALSO triggered when an SSE `error` event arrives mid-stream while a model is explicitly selected — not only on `onerror` connection drops. This auto-recovers when the selected model itself errors at the LLM provider (HTTP 400 "model not found", 401, Ollama cloud-offline) instead of leaving the user stuck with a hard error and forcing a manual dropdown pick. Guards: only fires when `persistedModelRef.current.providerId` is set and `isFallbackInProgressRef.current` is false (no loop).

### Model Selection Persistence (quick 260723-lrx)
- The effective model is validated against the live `availableModels` list before being applied or sent (RC-1). `resolveEffectiveModel(availableModels, candidates, workspaceDefault)` (exported from `useChat.ts`, with `isModelAvailable` type guard) walks candidates in priority order — per-chat stored → workspace default → global default (localStorage) — and returns the first one present in `availableModels`; if none match, it falls back to the three-tier chain via `resolveFallbackModel`. A stale workspace/global default pointing at a deleted/unavailable model is skipped instead of sent to the server (where it would fail to resolve and error).
- **`loadChat` persists the resolved model onto the Chat record (RC-3):** when an opened chat has no `Chat.providerId` OR its stored model is no longer in `availableModels` (we fell back to a different one), `loadChat` PATCHes `/workspaces/:ws/chats/:id/model` directly (with the explicit `chatId`, NOT `updateChatModel` — that reads the stale `currentChatId` state inside the async closure). This makes the actually-used model sticky so refresh / page navigation / return-to-chat restore the exact same model. When `availableModels` is empty (providers query not hydrated on a cold load), the stored/server/global value is trusted as-is and NOT patched (can't confirm availability, avoid clearing a valid selection).
- **`handleNewChat` persists the workspace preference (RC-4):** `localStorage["modelPref:<workspaceId>"]` is now written whenever a model is effectively chosen — including the auto-default case — not only on explicit dropdown selection. Returning to a new chat restores the same model. Resolution uses `resolveEffectiveModel` with candidates `[modelPref, workspaceDefault, globalDefault]`; the workspace default is fetched async from `/agent-config`.
- The server only writes `Chat.providerId/model` on `prisma.chat.create` when the request body includes them, so persisting the effective model client-side (via the PATCH above, or by sending `providerId/model` in the stream body for a brand-new chat) is what makes the model survive across sessions.

### /model Slash Command
- Implemented in `ChatPanel.handleKeyDown`.
- Four branches: empty args opens palette, exact match switches immediately, partial match opens filtered palette, no match shows error toast.
- Command text always stripped before any action via `setInput("")`.
- The `/model` command is intercepted on Enter key press before `handleSend()` is called.
- Exact matching compares against both `model.name` and `model.displayName` for user-friendly switching.
- Partial matches dispatch `CustomEvent("open-palette", { detail: { filter: remainder } })` to open the palette pre-filtered.

### ChatSidebar Polling
- Uses `showError()` from `src/lib/toast.ts` (stable import reference), avoids dependency issues.
- Polling interval: 30s.
- The chat list is fetched via `apiGet(/workspaces/${workspaceId}/chats)` and sorted by `updatedAt` descending.
- Chat rename and delete operations optimistically update the local list before API confirmation.

### Toast Usage in useEffect
- Toasts use the `sonner` library directly via `src/lib/toast.ts` helpers (`showSuccess`, `showError`, `showInfo`, `toastWithAction`).
- Call as `showError("Error message")` or `showSuccess("Success")`.
- `toastWithAction(msg, actionLabel, onClick, type)` supports action buttons (e.g., "Undo").
- Toast duration defaults to 4 seconds; error toasts persist until manually dismissed.

### Vite Proxy
- Dev server proxies `/api` to `http://localhost:3000`. If backend is down, you get ECONNREFUSED on frontend API calls.
- The proxy configuration is in `vite.config.ts` under the `server.proxy` field.
- **Dev-proxy ECONNREFUSED retry hook (Phase 89-era):** the server (:3000, `tsx watch`) boots slower than Vite (~1s) — it loads the Prisma client, connects Postgres, runs auto-seed, license init, FTS, backup scheduler. The app's initial GETs (`/auth/me`, `/license/info`, `/workspaces`, …) fire before :3000 binds, so http-proxy emits ECONNREFUSED and Vite's default handler dumps a scary `AggregateError` stack on every `pnpm dev` start. `vite.config.ts` installs a custom `onError` handler that retries connection-refused up to 8× / ~4s (GET/HEAD only — **never replays a POST/SSE body**) then falls back to a single concise 502 + one warn line. If you see repeated 502s after this window, the backend is genuinely down (not a boot race). Do not remove this hook without a replacement — the default handler spams the console on every cold start.
- In production builds, the frontend expects the API to be served from the same origin (e.g., via Nginx reverse proxy).
- WebSocket proxying is not configured; SSE streams work over standard HTTP proxy.

### Settings
- After saving settings (`fetchSettings()`), always refetch to reflect actual state since PUT `/api/system/settings` may partially reject some keys.
- `useSettings()` (TanStack Query) tracks `errorStatus` (HTTP status) alongside `error` for auth-aware error handling.
- SettingsPage shows persistent error banner (not just toast) with retry button. On 401/403, auto-redirects to login after 3s.
- SettingsProviders tab: admin CRUD for LLM providers and model management.
- SettingsMcpConnections tab: admin list/edit/test MCP connections with live status polling.
- SettingsRoles tab: role CRUD with permission checkboxes and menu section selection.
- SettingsWidget tab: widget admin dashboard with creation gated by license.
- SettingsEmbed tab: generates iframe and script embed code with live preview.

### License & Feature Gating
- `useLicense()` (TanStack Query) fetches license info on app load. The `license.features` map contains both boolean flags and numeric limits.
- `useFeature(flag)` returns boolean — use to conditionally render enterprise UI (e.g. `<UpgradePrompt feature="webhooks" />`).
- `useFeatureLimit(flag)` returns number (0 if not loaded) — use to check numeric limits like `max_workspaces`.
- `useLicenseTier()` returns `"community"` or `"enterprise"`.
- `UpgradePrompt` component renders locked-state card with feature label and upgrade CTA. Supports all 16 FeatureFlag values.
- The license query (`useLicense()`) refetches on window focus to detect tier changes without requiring a page reload.
- Feature-gated routes in the sidebar are filtered based on `menuSections` from `useAuth()`, not just `useFeature`.

### Provider Store
- `useProviders()` (TanStack Query) fetches providers and available models from the server on app load.
- `fetchAvailableModels()` calls `GET /api/providers/models/available` and flattens the nested provider→models structure.
- `updateChatModel()` calls `PATCH /api/workspaces/:id/chats/:chatId/model` with 200ms debounce.
- Provider polling runs every 30 seconds to keep availability status current.
- `fetchEmbeddingModels()` filters available models by `isEmbedding` flag for the document ingestion UI.

### File Uploads
- Document uploads use `react-dropzone` for drag-and-drop with file type validation.
- Uploaded files are sent via `apiUpload()` which uses `FormData` with `multipart/form-data` encoding.
- Supported document types: PDF, DOCX, PPTX, XLSX, TXT, MD, CSV, and image files (with OCR fallback).
- Upload progress is not tracked; the UI shows a loading spinner until the server responds.
- After upload, the document appears in the workspace document list with a "processing" status until the collector finishes.

### Markdown Rendering
- Assistant messages are rendered via `renderMarkdown()` in `src/utils/markdown.ts`.
- Uses `markdown-it` for parsing and `highlight.js` for code syntax highlighting.
- HTML is sanitized via `dompurify` before injection to prevent XSS.
- Code blocks include a copy button and language label for readability.
- Citations in the response are rendered as clickable badges that open the CitationPanel.

### Citation Panel
- Citations from RAG search are displayed in a slide-out panel triggered by clicking citation badges in assistant messages.
- The `CitationPanel` component receives `SourceCitation[]` and renders document name, chunk text, and relevance score.
- Each citation badge shows the document name and a score indicator; hovering reveals the full chunk text tooltip.
- The `CitationBadge` component is used inline in messages; `CitationPanel` is the full overlay.
- Citations are stored in `ChatMessage.metadata.sources` as an array of `SourceCitation` objects.

### Speech Recognition
- Voice input is implemented via a custom hook `useSpeechRecognition`
  in `src/hooks/useSpeechRecognition.ts`, which wraps the browser-native
  Web Speech API (`window.SpeechRecognition` / `webkitSpeechRecognition`).
  This replaces the deprecated `react-speech-recognition` package.
- API is identical to the previous library: `const { transcript,
  listening, resetTranscript, browserSupportsSpeechRecognition } =
  useSpeechRecognition();` plus a static `SpeechRecognition` object with
  `startListening({ continuous, language })` and `stopListening()`.
- A module-level `SpeechRecognitionManager` singleton shares state across
  multiple hook consumers (ChatPanel + ComparisonInputBar) so the
  microphone state stays consistent.
- The microphone button in `ChatPanel` toggles listening state; transcript
  is appended to the input field.
- Browser support is detected at module load via
  `window.SpeechRecognition || window.webkitSpeechRecognition`.
- Speech recognition is continuous mode; the user must manually stop
  listening or it times out after silence.
- Transcript resets automatically after `handleSend()` to avoid duplicate
  input on the next message.
- If the browser does not support speech recognition, the mic button is hidden.

### Text-to-Speech
- Read-aloud functionality uses the browser's native `speechSynthesis` API.
- The TTS button appears on each assistant message; clicking it speaks the message content.
- Clicking the same button again cancels the current utterance and resets the playing state.
- `speechSynthesis.cancel()` is called before starting a new utterance to prevent overlapping playback.
- The utterance uses default rate (1.0) and pitch (1.0); no voice selection UI is provided.
- TTS state (`ttsPlaying`) stores the message ID of the currently playing message for UI feedback.

### Drag and Drop
- File drop zones use `react-dropzone` with `accept` configuration limiting to supported document types.
- Dropped files are immediately uploaded via `apiUpload()`; the user sees a loading state.
- On success, the uploaded document ID is attached to the next chat message via `attachedDoc` state.
- The attached document badge shows the filename and can be removed before sending.
- Multiple file drops are not supported in chat; only one document can be attached per message.
- The drop zone is disabled while streaming to prevent upload conflicts.

### Sidebar Navigation
- The sidebar is rendered by the `App` component and contains navigation links, workspace switcher, and user menu.
- Menu sections are filtered by `useAuth()` query data (`menuSections`) which is fetched on login.
- The 13 menu sections (from `@simmetric-chat/shared` `MENU_SECTIONS`) are: `dashboard`, `chat`, `documents`, `knowledgeBase`, `workspaces`, `projects`, `marketplace`, `mcpConnections`, `eventLog`, `analytics`, `widget`, `settings`, `uploads`. Note: `archives` and `synthesis` are routes (sidebar entries are derived from `MENU_SECTIONS`, not these route names).
- Admin and Superuser roles see all 13 sections; User role sees `dashboard`, `chat`, `documents`, `knowledgeBase`, `workspaces`, `widget`, `uploads`.
- The sidebar collapses on mobile and can be toggled via a hamburger button.
- Active route highlighting uses `react-router-dom` `NavLink` with custom CSS for the active state.
- New sections added in Phases 51–53:
  - `archives` — workspace-scoped multi-page knowledge bases with wikilink support
  - `synthesis` — admin-only AI synthesis runs (preview/approve/reject workflow)
  - `marketplace` — MCP catalog browser (admin/superuser)

### Document Management
- Documents are listed in the workspace-scoped Documents page with upload date, status, and actions.
- Document status values: `pending`, `processing`, `completed`, `failed`.
- The document list polls every 30 seconds to reflect processing status updates from the collector.
- Document deletion is soft-delete; the document record remains but is excluded from queries via `deletedAt` filter.
- The document viewer renders plain text extracted content with pagination for large documents.
- OCR fallback images (from image-only PDFs) are displayed alongside extracted text with page thumbnails.

### API Utilities
- `apiGet`, `apiPost`, `apiPut`, `apiPatch`, `apiDelete`, and `apiUpload` are centralized in `src/utils/api.ts`.
- All utility functions prepend `/api` to paths and automatically include the JWT token from localStorage.
- `handleResponse<T>()` parses JSON and throws `ApiError` for non-2xx responses with status and details.
- Network errors (fetch failure) throw `ApiError` with status 0 and message "Network error".
- `apiUpload` uses `FormData` and sets the `Content-Type` header implicitly via the browser for multipart uploads.
- Request timeout is not implemented at the utility level; individual hooks/components manage timeout logic.

### State Management

Three-tier architecture (see `docs/STATE_MANAGEMENT.md` for full documentation):

- **TanStack Query** (`src/queries/`) for REST/CRUD server state: 23 hooks using `useQuery`/`useMutation` with centralized key registry in `queries/keys.ts`. Query client defaults: 30s staleTime, 1 retry (skipped for 401/403/429), no mutation retries.
- **React Context** (`src/contexts/`) for UI lifecycle state: ChatContext (workspace/chat nav with imperative setters for non-React callbacks), PageMetaContext (page metadata), ThemeContext (dark/light with localStorage).
- **fetchEventSource + useState/useRef** (`hooks/useChat.ts`) for SSE streaming: @microsoft/fetch-event-source handles token-by-token streaming. NOT TanStack Query — SSE is an open persistent connection.

**Golden rule:** If data originates from a REST endpoint, use TanStack Query. If it streams over SSE, use fetchEventSource + useState/useRef. If it's pure UI state (selected tab, theme, navigation), use React Context.

Zustand was fully removed on 2026-05-24. The `src/stores/` directory no longer exists. Zustand patterns like `set({ loading: false, error: err.message })` are obsolete.

### Bootstrap UI Preferences (FOUC-safe)

Phase 66.1 (FONT-01) introduced two lib modules that apply saved UI
preferences at **module-level init** (mirroring `ThemeContext.tsx`'s FOUC-safe
pattern) — the side-effect runs at import time, before
`createRoot().render()`, so the preference is applied before first paint. This
fixes the reload-on-`/chat` bug where a user who set font scale to `lg` did
not see the larger font until they navigated to Settings → Appearance.

- **`src/lib/uiFontScale.ts`** — single source of truth for the
  `--ui-font-scale` CSS var on `<html>`. Exports `UiFontScale`,
  `UI_FONT_SCALE_KEY`, `UI_FONT_SCALE_VALUES`, `readUiFontScale`,
  `applyUiFontScale`. Module-level init: reads the saved value from
  localStorage and calls `applyUiFontScale()` on first import. SSR guards:
  `typeof localStorage === "undefined"` in `readUiFontScale` and
  `typeof document === "undefined"` in `applyUiFontScale`. Values are drawn
  from a fixed literal `UI_FONT_SCALE_VALUES` map — no CSS injection vector.
- **`src/lib/uiDensity.ts`** — single source of truth for the
  `density-compact` class on `<html>`. Exports `Density`, `UI_DENSITY_KEY`,
  `readDensity`, `applyDensity`. Same module-level init pattern + SSR guards.
  Unknown localStorage values fall back to `"md"` / `"comfortable"` (no throw
  on bad localStorage).
- **`src/main.tsx` import order**: both modules are imported via side-effect
  imports (`import "./lib/uiFontScale"; import "./lib/uiDensity";`) BEFORE
  `import App from "./App";`, so the CSS var + class are set before
  `createRoot().render()`. The full side-effect import block in `main.tsx`
  is: `./i18n`, `./index.css`, `@fontsource-variable/inter`,
  `./lib/uiFontScale`, `./lib/uiDensity`, then `App`.
- **`src/components/SettingsAppearance.tsx`** imports the read/apply helpers
  from `../lib/uiFontScale` + `../lib/uiDensity` (single source of truth) and
  only retains the on-change apply + persist `useEffect` blocks. The previous
  mount-only apply `useEffect` was removed — it is superseded by the
  module-level init in `main.tsx`.
- **No inline script in `index.html`** — the bootstrap pattern lives entirely
  in the module-level init, consistent with the repo's anti-flash convention
  (grep returns 0 for `uiFontScale`/`uiDensity` in `index.html`).
- **Tests**: `src/__tests__/uiFontScale.test.ts` (7 tests),
  `src/__tests__/uiDensity.test.ts` (5 tests),
  `src/__tests__/mainImportOrder.test.ts` (3 tests) cover the read/apply/SSR
  guard/module-init contract and the import-order invariant (no
  `document.write` / `innerHTML` injection).

## MCP Marketplace

The frontend provides catalog browsing, server detail inspection, one-click
install/uninstall, and per-chat tool pinning. Admin/superuser only.

### Routing

- `/mcp-marketplace` — main catalog page
- `/mcp-marketplace/:entryId` — server detail page
- Both rendered by `react-router-dom` v7. Access gated by `"marketplace"` menu
  section from the `useAuth()` query (`menuSections`).

### Navigation

- `"marketplace"` menu section in sidebar, visible to admin/superuser roles.
  Controlled via `RoleMenuSection` model + `useAuth()` query data (`menuSections`).

### Store -- useMarketplace (TanStack Query)

- State: `entries: CatalogEntry[]`, `searchQuery: string`,
  `activeCategory: string | null`, `installedIds: Set<string>`,
  `loading: boolean`, `error: string | null`
- **`CatalogEntry`** interface: `id`, `name`, `url`, `transportType`,
  `headers`, `description`, `category`, `version`, `author`, `verified`,
  `verificationTier`, `healthStatus`, `lastHealthCheck`, `lastHealthError`,
  `lastCommitDate`, `isInstalled`
- Queries & Mutations: `useMarketplaceCatalog(workspaceId?)` calls `GET /mcp-marketplace`, `useInstallMarketplaceEntry()` calls `POST /mcp-marketplace/:entryId/install` (optimistic), `useUninstallMarketplaceEntry()` calls `POST /mcp-marketplace/:entryId/uninstall` (optimistic).
- `installedIds` derived from catalog response when workspaceId provided; used to render "Installed" badge on cards.
- All in `src/queries/useMarketplace.ts` — standard TanStack Query patterns with `queryClient.invalidateQueries` for cache updates.

### Components

- **`MarketplacePage.tsx`** -- catalog browser: search bar (text input, filters by
  name/description with 300ms debounce), category filter pills (dynamically
  derived from unique categories in catalog data, "All" default), responsive
  card grid (Tailwind: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6`),
  empty state: "No MCP servers found matching your search"
- **`MarketplaceCard.tsx`** -- server card: name + description (2-line truncation)
  + category badge + verification tier badge (official/verified_community) +
  health status badge (healthy/stale/down/not checked) + Install button or
  three-dots context menu with Uninstall confirmation
- **`MarketplaceDetail.tsx`** -- full detail page: description paragraph, metadata
  (author, version), verification tier badge + health status badge + commit
  recency badge, tool list with names and descriptions (fetched via live
  `testConnection()` after install), Install/Installed button with workspace
  requirement
- **`McpPinnerPopover.tsx`** -- chat header dropdown: icon button in
  `ChatPanel` header, lists workspace-installed MCP connections with live
  status dots (green=connected, gray=disconnected, red=error), toggle switch per
  connection for pin/unpin, optimistic UI (toggle updates immediately, API
  confirms in background), empty state: "No MCP connections installed in this
  workspace" with "Browse Marketplace" link

### Install UX Flow

Install button -> `useInstallMarketplaceEntry()` mutation -> `POST /mcp-marketplace/:entryId/install` -> on success, entry added to
`installedIds` Set -> button changes to green "Installed" badge with checkmark
-> three-dots context menu appears with Uninstall option. Revert on error.

### Workspace Dependency

Catalog browsing works without a selected workspace (browse-only mode). Install
button is disabled with tooltip when no workspace is selected. Pin/unpin
requires active workspace + installed connections.

### Responsive Breakpoints

3 cols on `lg+` (desktop), 2 cols on `sm` (tablet), 1 col on mobile. Sidebar collapses on mobile. Detail page stacks vertically on mobile.

### Empty States

- Catalog: "No MCP servers found matching your search. Try adjusting your search terms or filters."
- Detail loading: skeleton
- Pinner: "No MCP connections installed in this workspace" with marketplace link

### Component Patterns
- Components are functional components with hooks; no class components are used.
- Props interfaces are defined inline or in a separate `Props` interface at the top of the file.
- Callback props are typed with React event types: `React.KeyboardEvent`, `React.ChangeEvent`, `React.MouseEvent`.
- Refs use `useRef<T>` with `null` initial value; DOM refs are typed to the specific element type.
- Memoization uses `useMemo` for expensive computations and `useCallback` for event handlers passed to child components.
- `React.FC` is not used; components are defined as `function ComponentName(props: Props)` or `export default function ComponentName(props)`.
- Forward refs are used sparingly; prefer callback refs or direct ref passing via props for simple cases.

### Routing
- Routes are defined in `src/App.tsx` using `react-router-dom` v7 `Routes` and `Route` components.
- The app uses `BrowserRouter` with a basename of `/` for deployment flexibility.
- Route parameters (e.g., `:workspaceId`) are accessed via `useParams` in the routed component.
- Navigation uses `useNavigate` for programmatic redirects; `Link` and `NavLink` for declarative navigation.
- The default route redirects to `/chat` after authentication; unauthenticated users are redirected to `/login`.
- Route guards are implemented as conditional rendering in `App.tsx` based on the `useAuth()` query's `isAuthenticated` field.

### Testing
- Component tests use `@testing-library/react` with `jest-environment-jsdom`.
- **Transform:** `@swc/jest` (Phase 89-01 swap, Rust/SWC). `jest.config.cjs` sets `extensionsToTreatAsEsm: [".ts",".tsx"]` + `module.type: "esm"` and targets `es2022` with React automatic runtime. `ts-jest` is retained only as the rollback transformer (see the header comment in `jest.config.cjs` — `git revert` the DEP-01 commit restores it); it is not used at runtime. Frontend is ESM (`"type": "module"`), so Jest treats `.ts`/`.tsx` as ESM — use `import`/`export`, not `require`.
- API mocking uses `jest.mock` on `src/utils/api.ts` or `msw` (Mock Service Worker) for integration tests.
- Query tests use `@tanstack/react-query` testing utilities or instantiate hooks directly with a wrapper.
- Hook tests use `@testing-library/react-hooks` (or `renderHook` in v13+) with `act()` for state updates.
- E2E tests use Playwright targeting `localhost:5173` with authenticated state seeded via API calls.

### Performance Considerations
- The `useChat` hook uses `useRef` for streaming content accumulation to avoid re-rendering on every token.
- `streamingContent` state is updated with the functional `setStreamingContent((prev) => prev + token)` pattern to avoid stale closures.
- The `messages` array is immutable; updates create new arrays via spread operator to ensure React re-renders correctly.
- Large message histories (100+ messages) may cause performance issues; pagination or virtualization is recommended for v1.4+.
- The `useProviders()` query fetches available models only on mount and every 30s (staleTime); it does not fetch on every render.
- The palette filters models via `useMemo` with a dependency on `searchQuery` and `availableModels` to avoid recomputation.
- Debounced operations (model update, search) use `setTimeout` with cleanup in `useEffect` return to prevent memory leaks.

### Accessibility
- The ModelPalette uses ARIA roles: `role="dialog"`, `aria-modal="true"`, `role="listbox"`, `role="option"`, `aria-selected`.
- Keyboard navigation in the palette follows WAI-ARIA combobox pattern: typeahead search, arrow keys, Enter to select, Escape to close.
- Focus management returns focus to the trigger element when the palette or comparison mode is closed.
- All interactive elements have visible focus rings using Tailwind `focus:ring` and `focus:border` utilities.
- Color contrast is maintained in both light and dark themes; the primary indigo-blue palette meets WCAG AA for normal text.
- Toast notifications are announced via `aria-live="polite"` region for screen reader users.

### Error Boundaries
- `ErrorBoundary` component wraps the entire app in `main.tsx` — catches React rendering errors from any component in the tree.
- Class-based inner component (`ErrorBoundaryInner`) with `getDerivedStateFromError` + `componentDidCatch`; wrapped by a functional component (`ErrorBoundary`) that provides i18n via `useTranslation()`.
- Fallback UI: warning icon + localized "Something went wrong" message + collapsible error details + "Reload page" button. Styled with Tailwind + CSS custom properties.
- i18n keys in `common`: `unexpectedError`, `errorBoundaryDescription`, `errorDetails`, `reloadPage` — available in all 7 languages, parity-checked for EN/IT/RU.
- API errors are handled at the TanStack Query hook level (`onError` callbacks, error state), not via error boundaries; error boundaries catch only React lifecycle errors.
- If the SSE connection fails, the `useChat` hook sets `error` state which is rendered inline in the chat panel.
- Network errors during model switching are surfaced as toast messages with retry options.
- If the SSE connection fails, the `useChat` hook sets `error` state which is rendered inline in the chat panel.
- Network errors during model switching are surfaced as toast messages with retry options.

### Build and Deployment
- Production builds use `vite build` which outputs to `dist/` with hashed asset filenames for cache busting.
- The frontend Docker image (`docker/Dockerfile.frontend`) uses Nginx to serve static files and proxy `/api` to the server container.
- Environment variables for the frontend are baked at build time via Vite's `import.meta.env`; there is no runtime env injection.
- The `base` config in `vite.config.ts` is `/` for standard deployment; adjust for subdirectory hosting if needed.
- Source maps are generated in production for Sentry-style error tracking; disable for air-gapped deployments.
- The frontend bundle size is monitored; code splitting via dynamic imports is used for Settings tabs to reduce initial load.

### State Hydration
- On app load, the auth store reads `token` from localStorage and calls `fetchMe()` to validate the session.
- If `fetchMe()` returns 401, the token is removed and the user is shown the login screen.
- The theme store reads `theme` from localStorage and applies the `.dark` class before the first paint to avoid flash.
- i18n initialization reads `language` from localStorage and sets the active locale before rendering routes.
- The chat store attempts to restore the last active workspace ID from localStorage for session continuity.
- If the restored workspace no longer exists (deleted or access revoked), the query returns an error and the workspace selector is shown.
- License info is fetched after auth hydration; if the license check fails, the app falls back to Community tier UI.

### Mobile Responsiveness
- The layout uses a collapsible sidebar that hides on screens narrower than 768px.
- Chat input area uses a fixed bottom bar with safe-area-inset padding for notched devices.
- The model comparison view stacks vertically on mobile with swipeable panes instead of side-by-side grid.
- Toast notifications are positioned at the bottom on mobile and top-right on desktop.
- The ModelPalette uses `max-w-[560px]` and `max-h-[70vh]` to fit small screens without overflow.
- Touch targets are at least 44x44 pixels for accessibility; all buttons use `min-h-[44px]` or larger.

### Code Organization
- Each component lives in its own file under `src/components/` with PascalCase naming.
- Hooks live in `src/hooks/` with camelCase and `use` prefix.
- Query hooks live in `src/queries/` with camelCase and `use` prefix (e.g., `useAuth`, `useChats`).
- Utility functions live in `src/utils/` with camelCase naming.
- Types that are not shared with the server live in `src/types/`; shared types must be imported from `@simmetric-chat/shared`.
- Constants and configuration live in `src/constants/` or inline at the top of the relevant file.
- Test files are co-located in `__tests__/` directories adjacent to the code they test.

### RAG Maintenance UI (Phase 35)
- `SettingsMaintenance` tab in the Settings page (admin only). Provides a one-click
  reindex trigger for all documents across the system.
- Calls `POST /api/system/reindex-documents` with empty body — the server fans
  out to the collector for each document and re-embeds with the current
  `EMBEDDING_MODEL`. Returns `{ reindexed, skipped, errors, totalDocuments,
  durationSeconds }`.
- The UI shows a result panel with counts: reindexed / skipped / errors, plus
  the total duration. If `errors.length > 0`, an error toast is shown
  (`t("settings.maintenance.reindexErrors", { count })`); otherwise a success
  toast with the reindexed count.
- The button is disabled while reindexing (no concurrent runs). There is no
  cancel button — long runs must complete or be killed server-side.
- This UI is the primary recovery tool after an embedding model change
  (e.g., switching from `all-MiniLM-L6-v2` to `bge-base-en-v1.5` requires
  re-embedding all documents).
- i18n keys: `settings.maintenance.title`, `reindexTitle`, `reindexDesc`,
  `reindexSuccess`, `reindexErrors`, `reindexError`. Required in EN/IT/RU.

### OCR Admin UI (Phase 35, expanded Phase 53)
- `SettingsOcr` tab in the Settings page (admin only). Exposes the OCR model
  catalog and active jobs.
- Sub-components (all in `src/components/`):
  - `OcrModelSelector` — dropdown for choosing the active OCR model, surfaces
    capabilities (languages supported, handwriting, VRAM, local/cloud) from
    the catalog returned by `GET /api/ocr/models`.
  - `OcrModeSelector` — toggles between document OCR modes (auto, always-OCR,
    text-only). Persists via `ocrPreferencesSchema` (PATCH /api/users/me).
  - `OcrPromptPreview` — shows the current OCR extraction prompt with
    placeholder substitution preview.
  - `OcrCustomInstructions` — textarea for per-user custom instructions
    appended to the OCR prompt. Saved via `PATCH /api/users/me`.
  - `OcrUploadPanel` — file upload zone for triggering new OCR jobs. Disabled
    while a job is in flight.
  - `OcrJobList` / `OcrJobCard` — list of pending/processing/completed jobs
    with status, model, confidence, and a "View" button that opens
    `OcrPreviewModal`.
  - `OcrPreviewModal` — full OCR result viewer: page-by-page text + image
    thumbnails + confidence scores. Approve / Reject actions.
- All OCR actions go through the server (`packages/server/src/routes/ocr.ts`).
  The frontend never imports any OCR model library or runs OCR locally.
- Approving a job pushes the OCR'd text into the workspace's RAG pipeline as
  a synthetic document. Rejecting discards the result and logs the reason.

### Archive UI (Phase 51)
- `ArchivesPage` (`/archives`) lists all archives across the user's accessible
  workspaces. Workspace selector scopes the list.
- `ArchiveDetailPage` (`/archives/:archiveId`) shows archive metadata, page
  tree (with collapsible sections), and the wikilink graph in
  `ArchiveGraphView`.
- `ArchiveSidebar` — page tree with rename/delete/create actions. Supports
  wikilink resolution via `GET /api/wiki/resolve`.
- `ArchiveCreateDialog` — modal with name + description + initial page path
  inputs. Calls `POST /api/archives`.
- `ArchiveConfigPanel` — per-archive settings: rendering mode, search
  behavior, optional embedding model override. Calls
  `PATCH /api/archives/:id/config`.
- `ArchiveExportDialog` — exports archive to JSON / Markdown bundle. Calls
  `GET /api/archives/:id/export` with format query param.
- `ArchivePageFullView` — full-page reader with TOC, search highlights, and
  prev/next page navigation.
- Archive routes are gated by the `archives` menu section (all roles with
  read access). Write/delete require `archive:write` / `archive:delete`
  permissions.

### Template Copy Fix for Docker (Phase 53)
- Templates (chat templates, agent prompts) are seeded into the database from
  `prisma/seed.ts`. In Docker, the seed step runs **inside the server
  container** but the default templates live in the monorepo source tree.
- Prior to the fix, seeding silently failed in Docker because
  `process.cwd()` was `/app` and the template files were not on that path.
  The fix copies the template directory into the Docker image at
  `/app/packages/server/prisma/templates/` via a `COPY` step in
  `docker/Dockerfile.server` (and the single-container `docker/Dockerfile`).
- For local dev (`pnpm db:seed`), the templates are read relative to
  `process.cwd() = packages/server/`, so `prisma/templates/` is the
  expected path.
- If you add a new template file, you must:
  1. Add it under `packages/server/prisma/templates/`.
  2. Reference it from `prisma/seed.ts` using a path relative to
     `process.cwd()`.
  3. Rebuild the Docker image — the `COPY` layer is cached and won't pick
     up new files until the build is re-run.
- Missing-template errors during seed in Docker almost always mean the
  Docker image is stale. Rebuild with `docker compose -f
  docker/docker-compose.yml build server --no-cache`.

---

*This file documents frontend-specific patterns, components, and conventions. For cross-cutting concerns (RBAC, SSE protocol, feature flags), see the root CLAUDE.md.*

