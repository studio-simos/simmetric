// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// STATE: TanStack Query — query key registry (server state tier)
/**
 * Central query keys registry for TanStack Query.
 * Keeps keys organized by domain to avoid collisions and enable
 * targeted invalidation.
 */

export const queryKeys = {
  auth: {
    me: ["auth", "me"] as const,
    menuSections: ["auth", "menuSections"] as const,
    registration: ["auth", "registration"] as const,
  },
  // Phase 152-03 (WIZ-01, D-04) — system state queries. `isInitialized`
  // drives the App.tsx wizard-vs-login gate (always refetch on mount —
  // staleTime: 0 in useSystem.ts). Probe query keys embed the request
  // payload so distinct probe inputs get distinct cache entries.
  system: {
    isInitialized: ["system", "is-initialized"] as const,
    probeLlm: (provider: string, baseUrl: string, apiKey?: string) =>
      ["system", "probe-llm", provider, baseUrl, apiKey ?? ""] as const,
    probeVector: (provider: string, url?: string) =>
      ["system", "probe-vector", provider, url ?? ""] as const,
  },
  providers: {
    all: ["providers"] as const,
    available: ["providers", "available"] as const,
    embeddingModels: ["providers", "embeddingModels"] as const,
  },
  chats: {
    list: (workspaceId: string) => ["chats", "list", workspaceId] as const,
    messages: (chatId: string) => ["chats", "messages", chatId] as const,
    tokens: (chatId: string) => ["chats", "tokens", chatId] as const,
    sessionTokens: (workspaceId: string) => ["chats", "sessionTokens", workspaceId] as const,
  },
  workspaces: {
    all: ["workspaces"] as const,
    detail: (id: string) => ["workspaces", "detail", id] as const,
  },
  projects: {
    all: ["projects"] as const,
  },
  settings: {
    all: ["settings"] as const,
    branding: ["settings", "branding"] as const,
  },
  documents: {
    list: (workspaceId: string) => ["documents", "list", workspaceId] as const,
    text: (id: string) => ["documents", id, "text"] as const,
  },
  archive: {
    list: ["archive", "list"] as const,
    detail: (id: string) => ["archive", "detail", id] as const,
    pages: (archiveId: string) => ["archive", "pages", archiveId] as const,
    page: (archiveId: string, slug: string) => ["archive", "page", archiveId, slug] as const,
    config: (id: string) => ["archive", "config", id] as const,
  },
  synthesis: {
    list: ["synthesis", "list"] as const,
    detail: (id: string) => ["synthesis", "detail", id] as const,
    pendingCount: ["synthesis", "pendingCount"] as const,
    pendingRuns: (archiveId?: string) =>
      ["synthesis", "pendingRuns", archiveId ?? "global"] as const,
  },
  marketplace: {
    catalog: (workspaceId?: string) =>
      ["marketplace", "catalog", workspaceId ?? "global"] as const,
  },
  mcpConnections: {
    list: ["mcpConnections", "list"] as const,
    detail: (id: string) => ["mcpConnections", "detail", id] as const,
    statuses: ["mcpConnections", "statuses"] as const,
  },
  widgets: {
    list: ["widgets"] as const,
    detail: (id: string) => ["widgets", "detail", id] as const,
    leads: (widgetId: string) => ["widgets", "leads", widgetId] as const,
    lead: (widgetId: string, leadId: string) => ["widgets", "leads", widgetId, leadId] as const,
    analytics: (widgetId: string) => ["widgets", "analytics", widgetId] as const,
  },
  ocrJobs: {
    list: (archiveId: string) => ["ocrJobs", "list", archiveId] as const,
    detail: (archiveId: string, jobId: string) =>
      ["ocrJobs", "detail", archiveId, jobId] as const,
    models: ["ocrJobs", "models"] as const,
    preferences: (userId: string, workspaceId: string) =>
      ["ocrJobs", "preferences", userId, workspaceId] as const,
    preview: ["ocrJobs", "preview"] as const,
    defaults: ["ocrJobs", "defaults"] as const,
  },
  // Phase 71-04 — UploadDraft pending list + per-draft detail (used by
  // UnifiedUploadPage / PendingDocsPanel in 71-05).
  uploadDrafts: {
    list: (workspaceId: string) => ["uploadDrafts", "list", workspaceId] as const,
    detail: (id: string) => ["uploadDrafts", "detail", id] as const,
  },
  backups: {
    destinations: {
      list: ["backups", "destinations", "list"] as const,
      detail: (id: string) => ["backups", "destinations", "detail", id] as const,
    },
    jobs: {
      list: ["backups", "jobs", "list"] as const,
      detail: (id: string) => ["backups", "jobs", "detail", id] as const,
      logs: (jobId: string) => ["backups", "jobs", jobId, "logs"] as const,
    },
    logs: {
      list: (filters: Record<string, unknown>) =>
        ["backups", "logs", "list", filters] as const,
      detail: (id: string) => ["backups", "logs", "detail", id] as const,
    },
  },
  license: {
    info: ["license", "info"] as const,
  },
  // Phase 100-03 — filter plugin admin UI (FiltersTab in Settings → Avanzate).
  filters: {
    all: ["filters"] as const,
  },
  // Phase 112-01 — industry templates (WorkspaceTemplate) CRUD admin UI.
  templates: {
    all: ["templates"] as const,
    detail: (id: string) => ["templates", "detail", id] as const,
  },
  // Phase 113-05 — SSO config queries.
  sso: {
    config: ["sso", "config"] as const,
    // Quick 260808-p5y — public SSO availability status (login page).
    status: ["sso", "status"] as const,
  },
  // Phase 115-02 — DLP audit panel event log query.
  eventLogs: {
    list: (filters: Record<string, unknown>) => ["eventLogs", "list", filters] as const,
  },
  // Quick 260829-ony — DLP pattern configuration admin UI.
  dlpPatterns: {
    all: ["dlpPatterns"] as const,
  },
} as const;
