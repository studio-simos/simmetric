// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for MCP marketplace operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete } from "./api";
import { queryKeys } from "./keys";

export interface CatalogEntry {
  id: string;
  name: string;
  url: string;
  transportType: string;
  headers: string;
  description: string | null;
  category: string | null;
  version: string | null;
  author: string | null;
  verified: boolean;
  verificationTier?: string;
  healthStatus?: string;
  lastHealthCheck?: string | null;
  lastHealthError?: string | null;
  lastCommitDate?: string | null;
  createdAt: string;
  updatedAt: string;
  isInstalled: boolean;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useMarketplaceCatalog(workspaceId?: string) {
  return useQuery<CatalogEntry[], Error>({
    queryKey: queryKeys.marketplace.catalog(workspaceId),
    queryFn: () => {
      let url = "/mcp-marketplace";
      if (workspaceId) {
        url += `?workspaceId=${encodeURIComponent(workspaceId)}`;
      }
      return apiGet<CatalogEntry[]>(url);
    },
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useInstallMarketplaceEntry() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { entryId: string; workspaceId: string; headers?: Record<string, string> }>({
    mutationFn: ({ entryId, workspaceId, headers }) =>
      apiPost(`/mcp-marketplace/${entryId}/install`, { workspaceId, headers }),
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.marketplace.catalog(workspaceId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections.list });
    },
  });
}

export function useUninstallMarketplaceEntry() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { entryId: string; workspaceId: string }>({
    mutationFn: ({ entryId, workspaceId }) =>
      apiPost(`/mcp-marketplace/${entryId}/uninstall`, { workspaceId }),
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.marketplace.catalog(workspaceId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections.list });
    },
  });
}

// quick 260918-qts (D-1): per-entry catalog delete. The catalog is global —
// invalidate the ["marketplace", "catalog"] PREFIX (2 segments) so every
// cached workspace variant refetches; queryKeys.marketplace.catalog() would
// only match the no-workspace "global" arm. mcpConnections.list is NOT
// invalidated: the server 409s a delete while connections still reference
// the entry, so a successful delete can never change the connections list.
export function useDeleteMarketplaceEntry() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error, { entryId: string }>({
    mutationFn: ({ entryId }) => apiDelete<{ message: string }>(`/mcp-marketplace/${entryId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.marketplace.catalog().slice(0, 2) });
    },
  });
}
