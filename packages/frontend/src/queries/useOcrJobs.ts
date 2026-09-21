// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for OCR job operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete } from "./api";
import { queryKeys } from "./keys";

export interface OcrJob {
  id: string;
  archiveId: string;
  type: "OCR" | "URL";
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  totalPages: number | null;
  processedPages: number;
  currentPage: number | null;
  modelName: string | null;
  sourceFileName: string | null;
  contentHash: string | null;
  result: {
    qualityScore?: number;
    totalTokens?: number;
    totalDurationMs?: number;
    hasUnverified?: boolean;
    /** 260919-kvm: pages whose markdown carries a [FAILED: marker */
    failedPages?: number;
    pageResults?: Array<{
      pageNumber: number;
      markdown: string;
      imagePath?: string;
      tokensUsed: number;
      durationMs: number;
    }>;
    credibilityScore?: number;
    credibilitySignals?: Record<string, boolean>;
    extractedTitle?: string;
    sourceUrl?: string;
    approved?: boolean;
    rejected?: boolean;
  } | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useOcrJobs(archiveId: string | undefined) {
  return useQuery<OcrJob[], Error>({
    queryKey: queryKeys.ocrJobs.list(archiveId ?? ""),
    queryFn: () => apiGet<OcrJob[]>(`/archives/${archiveId}/jobs`),
    enabled: !!archiveId,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const data = query.state.data as OcrJob[] | undefined;
      const hasActive = data?.some(
        (j) => j.status === "PENDING" || j.status === "PROCESSING"
      );
      return hasActive ? 2_000 : false;
    },
  });
}

// Phase 180 dead-code sweep: useOcrJob() was REMOVED — zero callers (the
// OCR job list hook useOcrJobs is the live surface; detail-view polling
// was never wired after the F72 72-04 route removal).

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useApproveOcrJob() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { archiveId: string; jobId: string }>({
    mutationFn: ({ archiveId, jobId }) =>
      apiPost(`/archives/${archiveId}/jobs/${jobId}/approve`, {}),
    onSuccess: (_, { archiveId, jobId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrJobs.list(archiveId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrJobs.detail(archiveId, jobId) });
    },
  });
}

export function useRejectOcrJob() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { archiveId: string; jobId: string; reason?: string }>({
    mutationFn: ({ archiveId, jobId, reason }) =>
      apiPost(`/archives/${archiveId}/jobs/${jobId}/reject`, { reason }),
    onSuccess: (_, { archiveId, jobId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrJobs.list(archiveId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrJobs.detail(archiveId, jobId) });
    },
  });
}

export function useDeleteOcrJob() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { archiveId: string; jobId: string }>({
    mutationFn: ({ archiveId, jobId }) =>
      apiDelete(`/archives/${archiveId}/jobs/${jobId}`),
    onSuccess: (_, { archiveId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrJobs.list(archiveId) });
    },
  });
}

/**
 * quick 260918-p3h (D-3): cancel a running OCR job (PENDING/PROCESSING →
 * CANCELLED). Posts to the dedicated cancel endpoint; the OCR pipeline stops
 * cooperatively at the next page boundary. On success invalidates the jobs
 * list so the card re-renders with the cancelled badge.
 */
export function useCancelOcrJob() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error, { archiveId: string; jobId: string }>({
    mutationFn: ({ archiveId, jobId }) =>
      apiPost<{ message: string }>(`/archives/${archiveId}/jobs/${jobId}/cancel`, {}),
    onSuccess: (_, { archiveId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrJobs.list(archiveId) });
    },
  });
}

/**
 * 260919-kvm: re-OCR failed pages of a COMPLETED job. Omitted `pages` = all
 * [FAILED: pages; explicit list = single-page repair from the preview modal.
 */
export function useRepairOcrPages() {
  const queryClient = useQueryClient();

  return useMutation<
    { repaired: Array<{ pageNumber: number; markdown: string; stillFailed: boolean }>; failedPages: number; qualityScore: number | null },
    Error,
    { archiveId: string; jobId: string; pages?: number[] }
  >({
    mutationFn: ({ archiveId, jobId, pages }) =>
      apiPost(
        `/archives/${archiveId}/jobs/${jobId}/pages/retry`,
        pages ? { pages } : {},
      ),
    onSuccess: (_, { archiveId, jobId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrJobs.list(archiveId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrJobs.detail(archiveId, jobId) });
    },
  });
}
