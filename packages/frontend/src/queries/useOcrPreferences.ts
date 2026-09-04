// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hook for OCR preferences (DB-primary + localStorage cache).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "./api";
import { queryKeys } from "./keys";

export interface OcrPreferences {
  model?: string;
  ocrMode?: string;
  customInstructions?: string;
}

function getPrefsKey(userId: string, workspaceId: string): string {
  return `ocrPrefs_${userId}_${workspaceId}`;
}

function getCachedPrefs(
  userId: string,
  workspaceId: string
): OcrPreferences | null {
  try {
    const raw = localStorage.getItem(getPrefsKey(userId, workspaceId));
    if (!raw) return null;
    return JSON.parse(raw) as OcrPreferences;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useOcrPreferences(userId: string, workspaceId: string) {
  const queryClient = useQueryClient();

  const query = useQuery<OcrPreferences, Error>({
    queryKey: queryKeys.ocrJobs.preferences(userId, workspaceId),
    queryFn: () =>
      apiGet<OcrPreferences>(
        `/ocr/preferences?workspaceId=${encodeURIComponent(workspaceId)}`
      ),
    initialData: () => getCachedPrefs(userId, workspaceId) ?? undefined,
    staleTime: 30_000,
    enabled: !!userId && !!workspaceId,
  });

  const mutation = useMutation<OcrPreferences, Error, OcrPreferences>({
    mutationFn: (prefs) =>
      apiPost<OcrPreferences>("/ocr/preferences", {
        workspaceId,
        ...prefs,
      }),
    onSuccess: (_data, variables) => {
      localStorage.setItem(
        getPrefsKey(userId, workspaceId),
        JSON.stringify(variables)
      );
      queryClient.setQueryData(
        queryKeys.ocrJobs.preferences(userId, workspaceId),
        variables
      );
    },
  });

  return {
    preferences: query.data ?? {},
    isLoading: query.isLoading,
    save: mutation.mutate,
  };
}
