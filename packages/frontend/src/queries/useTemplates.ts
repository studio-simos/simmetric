// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for industry templates (WorkspaceTemplate) admin CRUD
 * (Phase 112-01).
 *
 * useTemplates — GET /api/templates (list all, any authenticated user).
 * useCreateTemplate — POST /api/templates (create custom template).
 * useUpdateTemplate — PUT /api/templates/:id (admin only; built-ins rejected
 *   server-side with 403).
 * useDeleteTemplate — DELETE /api/templates/:id (admin only; built-ins
 *   rejected server-side with 403).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "./api";
import { queryKeys } from "./keys";

export interface WorkspaceTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  systemPrompt: string;
  skills: string[];
  parsingConfig: { ocrRequired?: boolean; [key: string]: unknown };
  constraints: {
    localLLMOnly?: boolean;
    hybridSearchForced?: boolean;
    citationRequired?: boolean;
    [key: string]: unknown;
  };
  embeddingModel: string | null;
  isBuiltIn: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateTemplateInput {
  slug: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  systemPrompt: string;
  skills?: string[];
  parsingConfig?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  embeddingModel?: string | null;
  persistToDisk?: boolean;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  systemPrompt?: string;
  skills?: string[];
  parsingConfig?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  embeddingModel?: string | null;
}

export function useTemplates() {
  return useQuery<WorkspaceTemplate[], Error>({
    queryKey: queryKeys.templates.all,
    queryFn: () => apiGet<WorkspaceTemplate[]>("/templates"),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();

  return useMutation<WorkspaceTemplate, Error, CreateTemplateInput>({
    mutationFn: (input) => apiPost<WorkspaceTemplate>("/templates", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates.all });
    },
  });
}

export function useUpdateTemplate() {
  const queryClient = useQueryClient();

  return useMutation<WorkspaceTemplate, Error, { id: string; data: UpdateTemplateInput }>({
    mutationFn: ({ id, data }) =>
      apiPut<WorkspaceTemplate>(`/templates/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates.all });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error, string>({
    mutationFn: (id) => apiDelete<{ message: string }>(`/templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates.all });
    },
  });
}
