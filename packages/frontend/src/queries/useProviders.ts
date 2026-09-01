// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for provider/model domain.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "./api";
import { queryKeys } from "./keys";
import type { Provider, ProviderModel } from "@simmetric-chat/shared";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AvailableModel {
  id: string;
  name: string;
  displayName: string | null;
  isLocal: boolean;
  providerId: string;
  providerName: string;
  providerType: "ollama" | "openai" | "anthropic" | "openrouter";
  isDefault: boolean;
  capabilities: string[];
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useProviders(enabled = true) {
  return useQuery<Provider[], ApiError>({
    queryKey: queryKeys.providers.all,
    queryFn: () => apiGet<Provider[]>("/providers"),
    enabled,
    staleTime: 30_000,
  });
}

export function useAvailableModels(enabled = true) {
  return useQuery<AvailableModel[], ApiError>({
    queryKey: queryKeys.providers.available,
    queryFn: async () => {
      const providers = await apiGet<
        Array<{
          id: string;
          name: string;
          type: "ollama" | "openai" | "anthropic" | "openrouter";
          isDefault: boolean;
          models: Array<{
            id: string;
            name: string;
            displayName: string | null;
            isLocal: boolean;
            isDefault: boolean;
            capabilities: string[];
          }>;
        }>
      >("/providers/models/available");

      return providers.flatMap((p) =>
        p.models.map((m) => ({
          id: m.id,
          name: m.name,
          displayName: m.displayName,
          isLocal: m.isLocal,
          providerId: p.id,
          providerName: p.name,
          providerType: p.type,
          isDefault: m.isDefault,
          capabilities: m.capabilities || [],
        }))
      );
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation<
    Provider,
    ApiError,
    { name: string; type: string; baseUrl: string; apiKey?: string }
  >({
    mutationFn: (data) => apiPost<Provider>("/providers", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
    },
  });
}

export function useUpdateProvider() {
  const queryClient = useQueryClient();
  return useMutation<
    Provider,
    ApiError,
    { id: string; data: { name?: string; baseUrl?: string; apiKey?: string; isEnabled?: boolean } }
  >({
    mutationFn: ({ id, data }) => apiPut<Provider>(`/providers/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
    },
  });
}

export function useDeleteProvider() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => apiDelete(`/providers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
    },
  });
}

export function useSetDefaultProvider() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => apiPut(`/providers/${id}/set-default`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
    },
  });
}

export function useRefreshModels() {
  const queryClient = useQueryClient();
  return useMutation<
    { refreshed: number; models: ProviderModel[] },
    ApiError,
    string
  >({
    mutationFn: (providerId) =>
      apiPost<{ refreshed: number; models: ProviderModel[] }>(
        `/providers/${providerId}/models/refresh`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
    },
  });
}

export function useSetDefaultModel() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, { providerId: string; modelId: string }>({
    mutationFn: ({ providerId, modelId }) =>
      apiPut(`/providers/${providerId}/models/${modelId}/set-default`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
    },
  });
}

export function useUpdateModel() {
  const queryClient = useQueryClient();
  return useMutation<
    unknown,
    ApiError,
    {
      providerId: string;
      modelId: string;
      data: {
        displayName?: string | null;
        isEnabled?: boolean;
        isEmbedding?: boolean;
        isOcr?: boolean;
        temperature?: number | null;
        maxTokens?: number | null;
      };
    },
    { previousProviders: Provider[] | undefined }
  >({
    mutationFn: ({ providerId, modelId, data }) =>
      apiPut(`/providers/${providerId}/models/${modelId}`, data),
    // Optimistic update: write the new flag value into the cached providers list
    // immediately so toggles (e.g. isOcr, isEmbedding) appear instant and never
    // briefly revert to the old value while the background refetch is in flight.
    onMutate: async ({ providerId, modelId, data }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.providers.all });
      const previousProviders = queryClient.getQueryData<Provider[]>(queryKeys.providers.all);
      if (previousProviders) {
        queryClient.setQueryData<Provider[]>(queryKeys.providers.all, (old) =>
          (old ?? []).map((p) =>
            p.id !== providerId
              ? p
              : {
                  ...p,
                  models: (p.models ?? []).map((m) =>
                    m.id !== modelId
                      ? m
                      : { ...m, ...stripUndefined(data) }
                  ),
                }
          )
        );
      }
      return { previousProviders };
    },
    onError: (_err, _vars, context) => {
      // Rollback to the snapshot taken in onMutate if the PUT fails.
      if (context?.previousProviders) {
        queryClient.setQueryData(queryKeys.providers.all, context.previousProviders);
      }
    },
    onSettled: () => {
      // Always re-sync with the server, even on success, to pick up
      // any server-side side effects (e.g. updatedAt).
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
    },
  });
}

/**
 * Drop keys with `undefined` values so they don't overwrite existing fields
 * when spread into the cached model object.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export function useDeleteModel() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, { providerId: string; modelId: string }>({
    mutationFn: ({ providerId, modelId }) =>
      apiDelete(`/providers/${providerId}/models/${modelId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
    },
  });
}

// Phase 180 dead-code sweep: useUpdateChatModel() was REMOVED — zero
// callers. The per-chat model PATCH lives in hooks/useChatPersistence.ts +
// hooks/useChatModelSelection.ts (Phase 88 facade restructure); this was
// the orphaned pre-facade hook.
