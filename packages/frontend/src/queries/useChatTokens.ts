// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for token usage aggregation (Feature 2: Token Counter).
 * - useChatTokens: per-conversation totals + per-message breakdown.
 * - useSessionTokens: per-session (today, current workspace) totals.
 */

import { useQuery } from "@tanstack/react-query";
import { apiGet, ApiError } from "./api";
import { queryKeys } from "./keys";

interface ChatTokenPerMessage {
  id: string;
  role: string;
  input: number;
  output: number;
  total: number;
}

export interface ChatTokenAggregate {
  totalInput: number;
  totalOutput: number;
  total: number;
  perMessage?: ChatTokenPerMessage[];
  since?: string;
}

export function useChatTokens(workspaceId: string | undefined, chatId: string | null) {
  return useQuery<ChatTokenAggregate, ApiError>({
    queryKey: queryKeys.chats.tokens(chatId || ""),
    queryFn: () =>
      apiGet<ChatTokenAggregate>(`/workspaces/${workspaceId}/chats/${chatId}/tokens`),
    enabled: !!workspaceId && !!chatId,
    staleTime: 15_000,
  });
}

export function useSessionTokens(workspaceId: string | undefined) {
  return useQuery<ChatTokenAggregate, ApiError>({
    queryKey: queryKeys.chats.sessionTokens(workspaceId || ""),
    queryFn: () => apiGet<ChatTokenAggregate>(`/workspaces/${workspaceId}/tokens/today`),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}