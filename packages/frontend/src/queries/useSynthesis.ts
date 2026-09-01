// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for synthesis operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch, apiDelete } from "./api";
import { queryKeys } from "./keys";

interface SynthesisContradiction {
  pageSlug: string;
  claimA: { text: string; source: string; date: string };
  claimB: { text: string; source: string; date: string };
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface SynthesisChange {
  pageSlug: string;
  action: "create" | "update" | "skip";
  category: string;
  title: string;
  currentContent?: string;
  proposedContent: string;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "UNVERIFIED";
  sources: { fileName: string; ingestDate: string }[];
  approved: boolean;
}

interface SynthesisPreview {
  runId: string;
  archiveId: string;
  status: string;
  createdAt: string;
  budgetUsed: {
    pagesRead: number;
    pagesWritten: number;
    tokensUsed: number;
    llmCallsUsed: number;
  };
  contradictions: SynthesisContradiction[];
  changes: SynthesisChange[];
}

export interface SynthesisRunData {
  id: string;
  archiveId: string;
  name: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "APPROVED" | "REJECTED" | "PARTIAL" | "FAILED";
  pagesRead: number;
  pagesWritten: number;
  pagesApplied?: number;
  tokensUsed: number;
  llmCallsUsed: number;
  contradictionsFound: number;
  previewJson: SynthesisPreview | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archive?: { slug: string; name: string };
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useSynthesisPendingRuns(archiveId?: string) {
  return useQuery<SynthesisRunData[], Error>({
    queryKey: queryKeys.synthesis.pendingRuns(archiveId),
    queryFn: () => {
      const query = archiveId ? `?archiveId=${encodeURIComponent(archiveId)}` : "";
      return apiGet<SynthesisRunData[]>(`/synthesis/status${query}`);
    },
    staleTime: 30_000,
  });
}

export function useSynthesisRunDetail(runId: string | undefined) {
  return useQuery<SynthesisRunData, Error>({
    queryKey: queryKeys.synthesis.detail(runId ?? ""),
    queryFn: () => apiGet<SynthesisRunData>(`/synthesis/${runId}`),
    enabled: !!runId,
    staleTime: 30_000,
  });
}

export function useSynthesisPendingCount() {
  return useQuery<{ count: number }, Error>({
    queryKey: queryKeys.synthesis.pendingCount,
    queryFn: () => apiGet<{ count: number }>("/synthesis/pending/count"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useApproveSynthesisRun() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { runId: string; pageSlugs?: string[] }>({
    mutationFn: ({ runId, pageSlugs }) =>
      apiPost(`/synthesis/${runId}/approve`, { pageSlugs }),
    onSuccess: (_, { runId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.synthesis.pendingRuns() });
      queryClient.invalidateQueries({ queryKey: queryKeys.synthesis.detail(runId) });
    },
  });
}

export function useRejectSynthesisRun() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { runId: string; pageSlugs?: string[] }>({
    mutationFn: ({ runId, pageSlugs }) =>
      apiPost(`/synthesis/${runId}/reject`, { pageSlugs }),
    onSuccess: (_, { runId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.synthesis.pendingRuns() });
      queryClient.invalidateQueries({ queryKey: queryKeys.synthesis.detail(runId) });
    },
  });
}

export function useDeleteSynthesisRun() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (runId) => apiDelete(`/synthesis/${runId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.synthesis.pendingRuns() });
      queryClient.invalidateQueries({ queryKey: queryKeys.synthesis.pendingCount });
    },
  });
}

export function useRenameSynthesisRun() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { runId: string; name: string }>({
    mutationFn: ({ runId, name }) =>
      apiPatch(`/synthesis/${runId}/rename`, { name }),
    onSuccess: (_, { runId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.synthesis.pendingRuns() });
      queryClient.invalidateQueries({ queryKey: queryKeys.synthesis.detail(runId) });
    },
  });
}
