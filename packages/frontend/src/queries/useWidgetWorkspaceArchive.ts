// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for the Widget Workspace Archive (WGTA-01, 188-02).
 *
 * Read-only projections over the WidgetWorkspace join served by Plan 188-01's
 * three GET endpoints:
 * - GET /api/widgets/workspace-archive       → grouped-by-project groups
 * - GET /api/widgets/workspace-archive/flat  → one row per widgetId × workspaceId
 * - GET /api/widgets/workspace-archive/stats → totals + effective orphans
 *
 * D-03: display-only data — these hooks expose NO mutations. All edits go
 * through the existing per-widget whitelist editor (WidgetWorkspaceSelector
 * via PUT /api/widgets/:id/workspaces); the archive keys derive from the
 * "widgets" prefix so those mutations' invalidations cascade here (SC-2).
 *
 * The flat hook is lazily enabled (useWidgetLeads idiom) — the flat endpoint
 * is only fetched when the archive UI's flat view is active (D-07).
 */

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api";
import { queryKeys } from "./keys";
import type { WidgetWorkspaceArchiveFilterInput } from "@simmetric-chat/shared";

/** A widget inside a project group, with only THAT project's workspaces (server shape, Plan 188-01). */
export interface ArchiveGroupWidget {
  id: string;
  name: string;
  isActive: boolean;
  workspaces: { id: string; name: string }[];
}

/** One project group of the grouped archive view (server shape, Plan 188-01). */
export interface ArchiveProjectGroup {
  project: { id: string; name: string };
  widgets: ArchiveGroupWidget[];
}

/** One row of the flat archive: the join row itself (server shape, Plan 188-01). */
export interface ArchiveFlatRow {
  widgetId: string;
  widgetName: string;
  widgetIsActive: boolean;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
}

/** Four-field stats object (spec §3.1): totals + effective orphans (D-02). */
export interface ArchiveStats {
  totalWidgets: number;
  totalWorkspacesLinked: number;
  totalProjects: number;
  orphans: number;
}

/** URLSearchParams built only from set filters (uuid strings — no coercion needed). */
function buildArchiveParams(filters: WidgetWorkspaceArchiveFilterInput): string {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.workspaceId) params.set("workspaceId", filters.workspaceId);
  if (filters.widgetId) params.set("widgetId", filters.widgetId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Grouped-by-project archive (D-06 default view). */
export function useWidgetWorkspaceArchive(filters: WidgetWorkspaceArchiveFilterInput) {
  return useQuery<ArchiveProjectGroup[], Error>({
    queryKey: queryKeys.widgets.archive.grouped(filters as Record<string, unknown>),
    queryFn: () => apiGet<ArchiveProjectGroup[]>(`/widgets/workspace-archive${buildArchiveParams(filters)}`),
    staleTime: 30_000,
  });
}

/** Flat archive — lazily fetched ONLY while the flat view is active (D-07). */
export function useFlatArchive(filters: WidgetWorkspaceArchiveFilterInput, enabled: boolean) {
  return useQuery<ArchiveFlatRow[], Error>({
    queryKey: queryKeys.widgets.archive.flat(filters as Record<string, unknown>),
    queryFn: () => apiGet<ArchiveFlatRow[]>(`/widgets/workspace-archive/flat${buildArchiveParams(filters)}`),
    enabled,
    staleTime: 30_000,
  });
}

/** Archive stats header — totals + effective orphans (no filters, spec §3.1). */
export function useArchiveStats() {
  return useQuery<{
    totalWidgets: number;
    totalWorkspacesLinked: number;
    totalProjects: number;
    orphans: number;
  }, Error>({
    queryKey: queryKeys.widgets.archive.stats,
    queryFn: () => apiGet(`/widgets/workspace-archive/stats`),
    staleTime: 30_000,
  });
}