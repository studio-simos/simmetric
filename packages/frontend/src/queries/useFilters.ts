// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for filter plugin admin (Phase 100-03).
 *
 * useFilters — GET /api/filters (list all registered plugins with descriptor fields).
 * useUpdateFilter — PATCH /api/filters/:name { enabled } (enable/disable, admin-only).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch } from "./api";
import { queryKeys } from "./keys";

export interface FilterPluginInfo {
  name: string;
  priority: number;
  enabled: boolean;
  hasInlet: boolean;
  hasOutlet: boolean;
  outletStreaming: boolean;
  description: string;
}

export function useFilters() {
  return useQuery<FilterPluginInfo[], Error>({
    queryKey: queryKeys.filters.all,
    queryFn: () => apiGet<FilterPluginInfo[]>("/filters"),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useUpdateFilter() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error, { name: string; enabled: boolean }>({
    mutationFn: ({ name, enabled }) =>
      apiPatch<{ message: string }>(`/filters/${name}`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.filters.all });
    },
  });
}