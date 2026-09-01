# State Management Architecture — Simmetric Chat Frontend

## Overview

The frontend uses a **three-tier state management architecture** with a strict boundary rule
that determines which pattern to use for any given piece of state:

| Tier | Pattern | Use Case |
|------|---------|----------|
| 1 | **TanStack Query** | REST/CRUD server state — anything that comes from an HTTP endpoint |
| 2 | **React Context** | UI lifecycle/navigation state — pure client-side data with no server origin |
| 3 | **fetchEventSource + useState/useRef** | SSE streaming — real-time token-by-token data over persistent connections |

### The Boundary Rule

> If data originates from a REST endpoint, use **TanStack Query**.
> If data streams over SSE, use **fetchEventSource + useState/useRef**.
> If data is pure UI state (selected tab, theme, navigation), use **React Context**.

This rule is deterministic: look at where the data comes from, and the pattern follows.

---

## Tier 1: TanStack Query (Server State)

### Location

`packages/frontend/src/queries/` — 22 files

### Technology

`@tanstack/react-query ^5.100.14`

### Query Client Configuration

Defined in `queryClient.ts`:

| Option | Value | Rationale |
|--------|-------|-----------|
| `staleTime` | 30,000ms (30s) | Avoids refetching data that was just fetched; balances freshness vs. network |
| `refetchOnWindowFocus` | `true` | Keeps data current when user returns to tab |
| `retry` (queries) | 1 retry, skipped for 401/403/429 | One retry for transient failures; skip auth/rate-limit errors |
| `retry` (mutations) | `false` | Mutations should not auto-retry (double-create risk) |

### Query Key Registry

`keys.ts` — centralized, hierarchical query keys organized by domain:

```
auth > me, menuSections, registration
providers > all, available, embeddingModels
chats > list (per workspace), messages (per chat)
workspaces > all, detail
projects > all
settings > all, branding
documents > list (per workspace)
archive > list, detail, pages, page, config
synthesis > list, detail, pendingCount, pendingRuns
marketplace > catalog
mcpConnections > list, detail, statuses
widgets > list, detail, leads, lead, analytics
ocrJobs > list, detail, models, preferences, preview, defaults
backups > destinations > list, detail
backups > jobs > list, detail, logs
backups > logs > list, detail
license > info
```

Keys use `as const` for type safety. Key structure follows `[domain, subdomain?, ...params]`.

### Hook Inventory (22 files)

**Infrastructure (4 files):**
- `keys.ts` — query key registry
- `queryClient.ts` — QueryClient singleton with defaults
- `api.ts` — re-exports `apiGet`/`apiPost`/`apiPut`/`apiPatch`/`apiDelete` from `src/utils/api.ts`
- `index.ts` — barrel export

**Domain hooks (18 files):**
- `useAuth.ts` — user session, menu sections
- `useChats.ts` — chat list per workspace, chat CRUD
- `useWorkspaces.ts` — workspace CRUD
- `useSettings.ts` — system configuration
- `useArchives.ts` — archive list, detail, pages, config
- `useSynthesis.ts` — synthesis runs, pending count
- `useMarketplace.ts` — MCP catalog, install/uninstall
- `useMcpConnections.ts` — MCP connection CRUD, status polling
- `useWidgets.ts` — widget CRUD, leads, analytics
- `useOcrJobs.ts` — OCR job lifecycle
- `useOcrModels.ts` — OCR model catalog
- `useOcrPreferences.ts` — per-user OCR preferences
- `useProviders.ts` — LLM providers, available models
- `useLicense.ts` — license tier and feature flags
- `useBackupDestinations.ts` — backup destination CRUD
- `useBackupJobs.ts` — backup job management
- `useBackupLogs.ts` — backup log history
- `useOcrDefaults.ts` — OCR default settings

### Naming Convention

- Queries: `use{Entity}()` — e.g., `useAuth()`, `useChats(workspaceId)`
- Mutations: `use{Entity}Mutations()` or inline `useMutation` inside the hook file
- API calls: imported from `src/queries/api.ts` which re-exports from `src/utils/api.ts`

### API Utility

All HTTP calls go through the centralized utilities in `src/utils/api.ts`:
- `apiGet(path)` — GET request
- `apiPost(path, body)` — POST request
- `apiPut(path, body)` — PUT request
- `apiPatch(path, body)` — PATCH request
- `apiDelete(path)` — DELETE request
- `apiUpload(path, formData)` — multipart upload

The `api.ts` re-export in `src/queries/` keeps query functions self-contained without
importing from `../utils/api` in every file.

### Query Patterns

```typescript
// Standard query
export function useAuth() {
  return useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: () => apiGet("/api/auth/me"),
  });
}

// Query with parameters
export function useChatMessages(chatId: string | null) {
  return useQuery({
    queryKey: queryKeys.chats.messages(chatId!),
    queryFn: () => apiGet(`/api/chats/${chatId}/messages`),
    enabled: !!chatId,
  });
}

// Mutation with cache invalidation
export function useDeleteChat() {
  return useMutation({
    mutationFn: (chatId: string) => apiDelete(`/api/chats/${chatId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chats.list }),
  });
}
```

---

## Tier 2: React Context (UI Lifecycle State)

### Location

`packages/frontend/src/contexts/` — 3 files

### Contexts

| Context | File | State Managed |
|---------|------|---------------|
| `ChatContext` | `ChatContext.tsx` | Current workspace ID, current chat ID, navigation between chats. Also provides module-level imperative setters (`setWorkspaceIdImperative`, `setChatIdImperative`) for use in non-React callbacks (e.g., mutation `onSuccess` handlers). |
| `PageMetaContext` | `PageMetaContext.tsx` | Page title, breadcrumb trail, and page-level metadata for layout rendering. |
| `ThemeContext` | `ThemeContext.tsx` | Dark/light theme toggle with localStorage persistence. Applies `.dark` class to `<html>` element. |

### When to Use React Context

React Context is appropriate when:
1. Multiple components need to read the same piece of state
2. The state does NOT originate from a REST endpoint
3. The state is pure client-side UI information

Examples: selected tab, active route metadata, theme preference, modal open/close state, form draft data.

### When NOT to Use React Context

Do NOT use React Context for:
- Server data that has a TanStack Query hook (duplicate state source)
- Data that changes frequently at high volume (context triggers re-renders in all consumers)
- State that only one component needs (use local `useState`)

### Pattern

```typescript
// ChatContext.tsx — UI navigation state with imperative setters
export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(null);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  // ...imperative setter registration for non-React callbacks
}

export function useChatNav(): ChatNavContextValue {
  const ctx = useContext(ChatNavContext);
  if (!ctx) throw new Error("useChatNav must be used within ChatProvider");
  return ctx;
}
```

---

## Tier 3: SSE Streaming (Real-time Data)

### Location

`packages/frontend/src/hooks/useChat.ts` — the sole SSE consumer

### Technology

`@microsoft/fetch-event-source`

### Why NOT TanStack Query

TanStack Query's `queryFn` must return a value once (request/response cycle). SSE is an
**open persistent connection** that emits multiple events over time (`token`, `status`,
`citations`, `done`, `error`). These two models are fundamentally incompatible:

- `queryFn` returns once → `useQuery` caches the result
- SSE emits continuously → each event updates local state

Using `fetchEventSource` directly with `useState`/`useRef` is the correct pattern for SSE.

### Events

| Event | Payload | State Update |
|-------|---------|-------------|
| `token` | string (raw token text) | Appended to `streamingContent` via `setStreamingContent(prev => prev + token)` |
| `status` | `{ status: string, ... }` | Stored in `status` state for UI feedback |
| `citations` | `SourceCitation[]` | Stored in `citations` state for citation panel |
| `done` | `{ messageId, chatId, model, providerType }` | Finalizes message, appends to `messages[]` |
| `error` | `{ error: string }` | Stored in `error` state, shown to user |

### State Management

```typescript
// Local state for reactive UI updates
const [messages, setMessages] = useState<ChatMessage[]>([]);
const [streamingContent, setStreamingContent] = useState("");
const [citations, setCitations] = useState<SourceCitation[]>([]);
const [error, setError] = useState<string | null>(null);

// Refs for non-reactive values (no re-render needed)
const abortControllerRef = useRef<AbortController | null>(null);
const contentBufferRef = useRef<string>("");
```

The functional updater `setStreamingContent(prev => prev + token)` prevents stale closure
issues and batches token updates efficiently.

### Relationship with TanStack Query

SSE streaming (Tier 3) handles the real-time chat message flow, but REST operations still
use TanStack Query (Tier 1):

| Operation | Tier | Hook |
|-----------|------|------|
| Fetch chat list | Tier 1 | `useChats(workspaceId)` |
| Rename chat | Tier 1 | `useRenameChat()` mutation |
| Delete chat | Tier 1 | `useDeleteChat()` mutation |
| Stream messages | Tier 3 | `useChat()` — `fetchEventSource` |
| Fetch message history | Tier 1 | `useChatMessages(chatId)` |

---

## What NOT to Do

### Anti-patterns to Avoid

1. **Do NOT use TanStack Query for SSE streaming.**
   `queryFn` must return once. SSE emits continuously. Use `fetchEventSource` + `useState`/`useRef`.

2. **Do NOT use React Context for server data.**
   If the data comes from `GET /api/*`, it belongs in a TanStack Query hook, not a context provider.
   Context is for UI-only state.

3. **Do NOT use fetchEventSource for REST endpoints.**
   REST is request/response. Use the existing TanStack Query hooks. Don't reinvent `useQuery`.

4. **Do NOT create new Zustand stores.**
   Zustand was fully removed on 2026-05-24. The entire state management layer migrated to
   TanStack Query + React Context + fetchEventSource. There is no `src/stores/` directory.

5. **Do NOT mix tiers in a single component without justification.**
   A component that fetches chat messages should use `useChatMessages()` from Tier 1, not
   import `fetchEventSource` directly. An SSE streaming component should use `useChat()` from
   Tier 3, not a `useQuery` wrapper.

---

## Migration History

| Date | Event |
|------|-------|
| Pre-May 2024 | Zustand for all state: 8 stores (`authStore`, `chatStore`, `settingsStore`, `licenseStore`, `themeStore`, `toastStore`, `widgetStore`, `providerStore`) |
| 2026-05-24 | Quick task "rimuovi-completamente-zustand-dal-frontend" — removed Zustand from `package.json`, migrated all stores to TanStack Query + React Context + fetchEventSource |
| Current | ~22 TanStack Query hooks, 3 React Contexts, 1 SSE streaming hook. Zero Zustand dependencies. |

### Key Migration Decisions

- **Server state went to TanStack Query** because it provides caching, invalidation, retry,
  and optimistic updates out of the box — no manual store management needed.
- **Theme went to React Context** because it's pure client-side UI state with no server origin.
- **SSE streaming stayed with `fetchEventSource`** because it was already the correct pattern;
  TanStack Query cannot model a persistent event stream.

---

*Last updated: 2026-06-09 for quick task `260609-0nu` (document TanStack/Context/SSE boundary)*
