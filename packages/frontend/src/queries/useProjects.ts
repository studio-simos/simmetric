// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for project CRUD (Feature 3.5 / UI_DESIGN.md).
 *
 * - useProjects: list projects accessible to the current user (GET /api/projects).
 * - useCreateProject: create a project via POST /api/projects. Optimistically
 *   inserts a temp project into the cache on onMutate, rolls back on onError,
 *   and invalidates on onSuccess so the real server record replaces the temp.
 *   (Feature 7.3 Slice B — quick task 260714-n3q)
 * - useRenameProject: rename a project via PUT /api/projects/:id. On success it
 *   invalidates the projects cache and dispatches a `projects-changed` CustomEvent
 *   so any non-TanStack listeners (legacy raw-fetch sidebar code) stay in sync.
 *
 * The shared `Project` type lives in `@simmetric-chat/shared` and mirrors the server
 * response (id, name, description, createdBy, timestamps).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project, CreateProjectInput } from "@simmetric-chat/shared";
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "./api";
import { queryKeys } from "./keys";

/**
 * Pre-delete usage counts returned by GET /api/projects/:id/usage.
 * Used by ProjectsPanel to warn the user before confirming a soft delete.
 */
export interface ProjectUsage {
  workspaces: number;
  chats: number;
  documents: number;
  mcpConnections: number;
  accessGrants: number;
}

export function useProjects(enabled = true) {
  return useQuery<Project[], ApiError>({
    queryKey: queryKeys.projects.all,
    queryFn: () => apiGet<Project[]>("/projects"),
    enabled,
    staleTime: 60_000,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation<Project, ApiError, CreateProjectInput, { snapshot: Project[] }>({
    mutationFn: (input) => apiPost<Project>("/projects", input),
    // Optimistically insert a temp project so the sidebar selector updates
    // immediately. The server response replaces this temp on onSuccess via
    // cache invalidation.
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects.all });
      const snapshot = queryClient.getQueryData<Project[]>(queryKeys.projects.all) ?? [];
      const optimistic: Project = {
        id: `temp-${Date.now()}`,
        name: input.name,
        description: input.description ?? null,
        createdBy: "",
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      queryClient.setQueryData<Project[]>(queryKeys.projects.all, [...snapshot, optimistic]);
      return { snapshot };
    },
    onError: (_err, _input, context) => {
      // Rollback to the pre-mutation snapshot if the create fails.
      if (context) {
        queryClient.setQueryData<Project[]>(queryKeys.projects.all, context.snapshot);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export interface RenameProjectInput {
  projectId: string;
  name: string;
}

export function useRenameProject() {
  const queryClient = useQueryClient();

  return useMutation<Project, ApiError, RenameProjectInput>({
    mutationFn: ({ projectId, name }) =>
      apiPut<Project>(`/projects/${projectId}`, { name }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      // Notify any legacy listeners that still fetch /api/projects manually.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("projects-changed", { detail: { id: updated.id } }));
      }
    },
  });
}
/**
 * useProjectUsage — pre-delete usage check. Returns counts of related
 * resources (workspaces, chats, documents, mcpConnections, accessGrants)
 * so the UI can warn the user before deleting a project that is in use.
 *
 * `staleTime: 0` ensures a fresh fetch each time the delete dialog opens.
 */
export function useProjectUsage(projectId: string | null) {
  return useQuery<ProjectUsage, ApiError>({
    queryKey: ["projects", projectId, "usage"],
    queryFn: () => apiGet<ProjectUsage>(`/projects/${projectId}/usage`),
    enabled: !!projectId,
    staleTime: 0,
  });
}

/**
 * useDeleteProject — soft-delete a project. On success invalidates the
 * projects cache and dispatches the `projects-changed` CustomEvent so
 * legacy raw-fetch listeners (e.g., sidebar selectors) stay in sync.
 */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (projectId: string) => apiDelete<void>(`/projects/${projectId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("projects-changed"));
      }
    },
  });
}

/**
 * useBulkDeleteProjects — permanently delete multiple projects at once.
 * Fires individual DELETE /projects/:id calls via Promise.allSettled so
 * a single failing request does not prevent the rest from completing.
 * Invalidates the projects cache on success.
 */
export function useBulkDeleteProjects() {
  const queryClient = useQueryClient();

  return useMutation<PromiseSettledResult<void>[], ApiError, string[]>({
    mutationFn: async (ids) => {
      const results = await Promise.allSettled(
        ids.map((id) => apiDelete<void>(`/projects/${id}`))
      );
      return results;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("projects-changed"));
      }
    },
  });
}

/**
 * useProjectExport — download the project history as a JSON file. Fetches
 * the export endpoint as a blob and triggers a browser download. Uses a
 * raw fetch (not apiGet) because the response is a file, not JSON-parsed
 * by the shared client.
 */
export function useProjectExport() {
  return useMutation<void, ApiError, { projectId: string; name: string }>({
    mutationFn: async ({ projectId }) => {
      const token = typeof localStorage !== "undefined" ? localStorage.getItem("token") : null;
      const res = await fetch(`/api/projects/${projectId}/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = projectId.slice(0, 8);
      a.download = `project-${safeName}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  });
}
