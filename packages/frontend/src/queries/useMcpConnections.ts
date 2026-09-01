// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for MCP connection operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "./api";
import { queryKeys } from "./keys";

export interface McpConnection {
  id: string;
  name: string;
  url: string;
  transportType: "sse" | "streamable-http";
  projectId: string | null;
  workspaceId: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
  liveStatus?: "connected" | "disconnected" | "error";
  toolCount?: number;
  lastError?: string | null;
}

export interface TestResult {
  success: boolean;
  toolCount?: number;
  tools?: Array<{ name: string; description: string }>;
  error?: string;
}

export interface McpConnectionCreateInput {
  name: string;
  url: string;
  transportType: "sse" | "streamable-http";
  projectId?: string;
  workspaceId?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpConnectionUpdateInput {
  name?: string;
  url?: string;
  transportType?: "sse" | "streamable-http";
  projectId?: string;
  workspaceId?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useMcpConnections() {
  return useQuery<McpConnection[], Error>({
    queryKey: queryKeys.mcpConnections.list,
    queryFn: () => apiGet<McpConnection[]>("/mcp-connections/statuses"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useCreateMcpConnection() {
  const queryClient = useQueryClient();

  return useMutation<McpConnection, Error, McpConnectionCreateInput>({
    mutationFn: (data) => apiPost<McpConnection>("/mcp-connections", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections.list });
    },
  });
}

export function useUpdateMcpConnection() {
  const queryClient = useQueryClient();

  return useMutation<McpConnection, Error, { id: string; data: McpConnectionUpdateInput }>({
    mutationFn: ({ id, data }) => apiPut<McpConnection>(`/mcp-connections/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections.list });
    },
  });
}

export function useDeleteMcpConnection() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (id) => apiDelete(`/mcp-connections/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections.list });
    },
  });
}

export function useToggleMcpConnection() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) => apiPost(`/mcp-connections/${id}/toggle`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections.list });
    },
  });
}

export function useTestMcpConnection() {
  return useMutation<TestResult, Error, string>({
    mutationFn: (id) => apiPost<TestResult>(`/mcp-connections/${id}/test`, {}),
  });
}
