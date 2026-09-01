// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for DLP pattern configuration (quick 260829-ony —
 * DLP_FEATURES_SPEC §2.3/Fase 4). REST CRUD against /api/system/dlp/patterns.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete, type ApiError } from "../utils/api";
import { queryKeys } from "./keys";
import type { DlpPatternResponse } from "@simmetric-chat/shared";

export type DlpPattern = DlpPatternResponse;

interface PatternsListResponse {
  patterns: DlpPattern[];
}

export function useDlpPatterns() {
  return useQuery<DlpPattern[], ApiError>({
    queryKey: queryKeys.dlpPatterns.all,
    queryFn: async () => {
      const res = await apiGet<PatternsListResponse>("/system/dlp/patterns");
      return res.patterns;
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export interface CreateDlpPatternPayload {
  name: string;
  displayName: string;
  pattern: string;
  patternFlags?: string;
  replacement?: string;
  isEnabled?: boolean;
}

export function useCreateDlpPattern() {
  const queryClient = useQueryClient();
  return useMutation<{ pattern: DlpPattern }, ApiError, CreateDlpPatternPayload>({
    mutationFn: (payload) => apiPost<{ pattern: DlpPattern }>("/system/dlp/patterns", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dlpPatterns.all });
    },
  });
}

export interface UpdateDlpPatternPayload {
  displayName?: string;
  pattern?: string;
  patternFlags?: string;
  replacement?: string;
  isEnabled?: boolean;
}

export function useUpdateDlpPattern() {
  const queryClient = useQueryClient();
  return useMutation<{ pattern: DlpPattern }, ApiError, { id: string; data: UpdateDlpPatternPayload }>({
    mutationFn: ({ id, data }) => apiPut<{ pattern: DlpPattern }>(`/system/dlp/patterns/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dlpPatterns.all });
    },
  });
}

export function useDeleteDlpPattern() {
  const queryClient = useQueryClient();
  return useMutation<{ message: string }, ApiError, string>({
    mutationFn: (id) => apiDelete<{ message: string }>(`/system/dlp/patterns/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dlpPatterns.all });
    },
  });
}

// Phase 180 dead-code sweep: useTestDlpPattern() was REMOVED — zero
// callers (the pattern-test button was never wired in SettingsDlpPatterns).
