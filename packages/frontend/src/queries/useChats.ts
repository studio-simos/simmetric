// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for chat domain.
 * Replaces Zustand fetch actions with server-state queries + mutations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, ApiError } from "./api";
import { queryKeys } from "./keys";
import { showError, showSuccess } from "../lib/toast";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ChatSummary {
  id: string;
  name: string;
  workspaceId: string;
  updatedAt: string;
  createdAt: string;
  folderId?: string | null;
  isPinned?: boolean;
  /** Linked archive id (Phase 80 D-01 single source of truth). null = no link. */
  archiveId?: string | null;
}

export interface ChatFolder {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useChats(workspaceId: string | undefined) {
  return useQuery<ChatSummary[], ApiError>({
    queryKey: queryKeys.chats.list(workspaceId || ""),
    queryFn: () => apiGet<ChatSummary[]>(`/workspaces/${workspaceId}/chats`),
    enabled: !!workspaceId,
    staleTime: 10_000,
  });
}

export function useChatFolders(workspaceId: string | undefined) {
  return useQuery<ChatFolder[], ApiError>({
    queryKey: ["chats", "folders", workspaceId || ""] as const,
    queryFn: () => apiGet<ChatFolder[]>(`/workspaces/${workspaceId}/folders`),
    enabled: !!workspaceId,
    staleTime: 10_000,
  });
}

// Phase 180 dead-code sweep: useChatMessages() was REMOVED — zero callers
// (message history is loaded inside useChat via loadChat, not a query hook).

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useCreateFolder() {
  const queryClient = useQueryClient();

  return useMutation<ChatFolder, ApiError, { workspaceId: string; name: string }>({
    mutationFn: ({ workspaceId, name }) =>
      apiPost<ChatFolder>(`/workspaces/${workspaceId}/folders`, { name }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["chats", "folders", variables.workspaceId],
      });
    },
  });
}

export function useRenameFolder() {
  const queryClient = useQueryClient();

  return useMutation<
    unknown,
    ApiError,
    { workspaceId: string; folderId: string; name: string }
  >({
    mutationFn: ({ workspaceId, folderId, name }) =>
      apiPut(`/workspaces/${workspaceId}/folders/${folderId}`, { name }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["chats", "folders", variables.workspaceId],
      });
    },
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();

  return useMutation<
    unknown,
    ApiError,
    { workspaceId: string; folderId: string; cascade: boolean }
  >({
    mutationFn: ({ workspaceId, folderId, cascade }) =>
      apiDelete(`/workspaces/${workspaceId}/folders/${folderId}?cascade=${cascade}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["chats", "folders", variables.workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.list(variables.workspaceId),
      });
    },
  });
}

export function usePinChat() {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, { workspaceId: string; chatId: string }>({
    mutationFn: ({ workspaceId, chatId }) =>
      apiPost(`/workspaces/${workspaceId}/chats/${chatId}/pin`, {}),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.list(variables.workspaceId),
      });
    },
  });
}

export function useUnpinChat() {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, { workspaceId: string; chatId: string }>({
    mutationFn: ({ workspaceId, chatId }) =>
      apiDelete(`/workspaces/${workspaceId}/chats/${chatId}/pin`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.list(variables.workspaceId),
      });
    },
  });
}

export function useMoveChat() {
  const queryClient = useQueryClient();

  return useMutation<
    unknown,
    ApiError,
    { workspaceId: string; chatId: string; folderId: string | null }
  >({
    mutationFn: ({ workspaceId, chatId, folderId }) =>
      apiPut(`/workspaces/${workspaceId}/chats/${chatId}/move`, { folderId }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.list(variables.workspaceId),
      });
    },
  });
}

export function useDeleteChat() {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, { workspaceId: string; chatId: string }>({
    mutationFn: ({ workspaceId, chatId }) =>
      apiDelete(`/workspaces/${workspaceId}/chats/${chatId}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.list(variables.workspaceId),
      });
    },
  });
}

export function useRenameChat() {
  const queryClient = useQueryClient();

  return useMutation<
    unknown,
    ApiError,
    { workspaceId: string; chatId: string; name: string }
  >({
    mutationFn: ({ workspaceId, chatId, name }) =>
      apiPut(`/workspaces/${workspaceId}/chats/${chatId}`, { name }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.list(variables.workspaceId),
      });
    },
  });
}

/**
 * useLinkArchive — link/unlink a chat to a workspace archive (Phase 80 D-09).
 *
 * Mirrors `useRenameChat` with `apiPatch` against the dedicated
 * `PATCH /workspaces/:ws/chats/:chat/archive` endpoint. On success, the chats
 * list cache is invalidated so the persisted `archiveId` re-syncs on next
 * render (D-11 full Chat entity response). Optimistic rollback is handled at
 * the Select caller via previousValue; the error toast signals the failure
 * (D-08).
 */
export function useLinkArchive() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<
    unknown,
    ApiError,
    { workspaceId: string; chatId: string; archiveId: string | null }
  >({
    mutationFn: ({ workspaceId, chatId, archiveId }) =>
      apiPatch(`/workspaces/${workspaceId}/chats/${chatId}/archive`, { archiveId }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.list(variables.workspaceId),
      });
      showSuccess(
        variables.archiveId === null
          ? t("chat.archive.unlinked")
          : t("chat.archive.linked"),
      );
    },
    onError: () => {
      showError(t("chat.archive.error"));
    },
  });
}
