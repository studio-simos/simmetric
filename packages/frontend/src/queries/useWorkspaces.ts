// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete, apiFetch } from "../utils/api";
import { queryKeys } from "./keys";
import { setWorkspaceIdImperative } from "../contexts/ChatContext";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface WorkspaceWithMeta {
  id: string;
  name: string;
  instructions: string | null;
  createdAt: string;
  deletedAt: string | null;
  projectId: string;
  project?: {
    createdBy: string;
    name: string;
    creator?: { username: string; firstName: string | null; lastName: string | null };
  };
  _count?: { chats: number; documents: number };
  allowMemberUploads?: boolean;
  icon?: string | null;
  embeddingModel?: string;
  templateId?: string | null;
  agentConfig?: {
    systemPrompt: string;
    enabledSkills: string;
    constraints?: string;
    parsingConfig?: string;
  } | null;
}

/* ------------------------------------------------------------------ */
/*  Query Hooks                                                        */
/* ------------------------------------------------------------------ */

export function useWorkspaces(enabled = true) {
  return useQuery<WorkspaceWithMeta[], Error>({
    queryKey: queryKeys.workspaces.all,
    queryFn: () => apiGet<WorkspaceWithMeta[]>("/workspaces"),
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useDeletedWorkspaces(enabled = true) {
  return useQuery<WorkspaceWithMeta[], Error>({
    queryKey: [...queryKeys.workspaces.all, "deleted"],
    queryFn: () => apiGet<WorkspaceWithMeta[]>("/workspaces?deleted=true"),
    enabled,
    staleTime: 30 * 1000,
  });
}

/* ------------------------------------------------------------------ */
/*  Create Workspace                                                   */
/* ------------------------------------------------------------------ */

export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, Record<string, unknown>, { snapshot: WorkspaceWithMeta[] }>({
    mutationFn: (body) => apiPost("/workspaces", body),
    // Optimistically insert a temp workspace so the sidebar selector updates
    // immediately. (Feature 7.3 Slice B — quick task 260714-n3q)
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.workspaces.all });
      const snapshot = queryClient.getQueryData<WorkspaceWithMeta[]>(queryKeys.workspaces.all) ?? [];
      const optimistic: WorkspaceWithMeta = {
        id: `temp-${Date.now()}`,
        name: (body.name as string) ?? "New workspace",
        instructions: null,
        createdAt: new Date().toISOString(),
        deletedAt: null,
        projectId: (body.projectId as string) ?? "",
        _count: { chats: 0, documents: 0 },
      };
      queryClient.setQueryData<WorkspaceWithMeta[]>(queryKeys.workspaces.all, [...snapshot, optimistic]);
      return { snapshot };
    },
    onError: (_err, _body, context) => {
      if (context) {
        queryClient.setQueryData<WorkspaceWithMeta[]>(queryKeys.workspaces.all, context.snapshot);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export interface UpdateWorkspaceInput {
  name?: string;
  instructions?: string | null;
  allowMemberUploads?: boolean;
  icon?: string | null;
  systemPrompt?: string;
  skills?: string[];
  constraints?: { localLLMOnly?: boolean; hybridSearchForced?: boolean; citationRequired?: boolean };
  parsingConfig?: { ocrRequired?: boolean };
  embeddingModel?: string;
}

export function useUpdateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { id: string; data: UpdateWorkspaceInput }>({
    mutationFn: ({ id, data }) => apiPut(`/workspaces/${id}`, data).then(() => undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (id) => apiDelete(`/workspaces/${id}`).then(() => undefined),
    onSuccess: (_data, id) => {
      // Mirror the old store behaviour: clear current workspace if it was deleted
      const lastWorkspaceId = typeof localStorage !== "undefined" ? localStorage.getItem("lastWorkspaceId") : null;
      if (lastWorkspaceId === id) {
        setWorkspaceIdImperative("");
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.workspaces.all, "deleted"] });
    },
  });
}

// Phase 180 dead-code sweep: useRestoreWorkspace() was REMOVED — zero
// callers (single-item restore is unused; bulk restore
// useBulkRestoreWorkspaces below is the live surface).

export function useBulkRestoreWorkspaces() {
  const queryClient = useQueryClient();

  return useMutation<PromiseSettledResult<void>[], Error, string[]>({
    mutationFn: async (ids) => {
      const results = await Promise.allSettled(
        ids.map((id) => apiPut(`/workspaces/${id}/restore`, {}).then(() => undefined))
      );
      return results;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.workspaces.all, "deleted"] });
    },
  });
}

export function useBulkDeleteWorkspaces() {
  const queryClient = useQueryClient();

  return useMutation<PromiseSettledResult<void>[], Error, string[]>({
    // Client-side fan-out over the EXISTING per-row DELETE endpoint (D-04) —
    // the server keeps enforcing per-row permissions; each settled rejection
    // (e.g. 403) surfaces as a skipped-row count, never silently swallowed.
    mutationFn: async (ids) => {
      const results = await Promise.allSettled(
        ids.map((id) => apiDelete(`/workspaces/${id}`).then(() => undefined))
      );
      return results;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.workspaces.all, "deleted"] });
    },
  });
}

export function usePermanentDeleteWorkspaces() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string[]>({
    mutationFn: async (ids) => {
      await apiFetch(`/workspaces/permanent`, {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.workspaces.all, "deleted"] });
    },
  });
}
