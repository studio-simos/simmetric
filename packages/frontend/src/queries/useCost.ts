// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 203 (MCC, 203-03 Task 1) — TanStack Query hooks for the cost
 * admin + chat + analytics surfaces.
 *
 * COST DISCIPLINE: costs are server-computed snapshots — the UI NEVER
 * recalculates.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "./api";
import { queryKeys } from "./keys";

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/** @latentByDesign — consumed by the chat cost badge (deferred from 203-04, the UI polish is a follow-up) */
export function useChatCost(workspaceId: string, chatId: string) {
  return useQuery<{ totalByCurrency: Record<string, number>; breakdown: Array<{ messageId: string; promptCost: number | null; completionCost: number | null; totalCost: number | null; currency: string | null }> }, Error>({
    queryKey: queryKeys.cost.chat(workspaceId, chatId),
    queryFn: () => apiGet(`/workspaces/${workspaceId}/chats/${chatId}/cost`),
    staleTime: 30_000,
  });
}

/** @latentByDesign — consumed by TokenCounterPanel (the UI polish is a follow-up) */
export function useTodayCost(workspaceId: string) {
  return useQuery<{ totalByCurrency: Record<string, number> }, Error>({
    queryKey: queryKeys.cost.today(workspaceId),
    queryFn: () => apiGet(`/workspaces/${workspaceId}/cost/today`),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useModelPricing(providerId: string, modelId: string) {
  return useQuery<{
    inputCostPerToken: number | null;
    outputCostPerToken: number | null;
    currency: string | null;
    lastCostUpdated: string | null;
    lastCostUpdatedBy: string | null;
  }, Error>({
    queryKey: [...queryKeys.cost.modelPricing, providerId, modelId] as const,
    queryFn: () => apiGet(`/providers/${providerId}/models/${modelId}/pricing`),
    staleTime: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useUpdateModelPricing() {
  const queryClient = useQueryClient();
  return useMutation<
    { inputCostPerToken: number | null; outputCostPerToken: number | null; currency: string | null },
    Error,
    { providerId: string; modelId: string; inputCostPerToken?: number; outputCostPerToken?: number; currency?: string }
  >({
    mutationFn: ({ providerId, modelId, inputCostPerToken, outputCostPerToken, currency }) =>
      apiPut(`/providers/${providerId}/models/${modelId}/pricing`, { inputCostPerToken, outputCostPerToken, currency }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cost.modelPricing });
    },
  });
}

export function useResetModelPricing() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, Error, { providerId: string; modelId: string }>({
    mutationFn: ({ providerId, modelId }) =>
      apiPost<{ success: boolean }>(`/providers/${providerId}/models/${modelId}/pricing/reset`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cost.modelPricing });
    },
  });
}
