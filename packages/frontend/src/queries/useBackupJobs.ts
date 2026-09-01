// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for backup job CRUD, toggle, run, and logs.
 * Mirrors the `useMcpConnections` pattern: useQuery for list/detail,
 * useMutation for create/update/delete/toggle/run, with queryClient
 * invalidation on success.
 *
 * The `BackupLog` interface is imported from `useBackupLogs.ts` (single
 * source of truth across `queries/`).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "./api";
import { queryKeys } from "./keys";

export type BackupJobFrequency = "daily" | "weekly" | "monthly" | "manual";

export interface BackupJob {
  id: string;
  name: string;
  destinationId: string;
  destinationName: string;
  frequency: BackupJobFrequency;
  schedule: string | null;
  retentionDays: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupJobCreateInput {
  name: string;
  destinationId: string;
  frequency: BackupJobFrequency;
  schedule?: string;
  retentionDays?: number;
  enabled?: boolean;
}

export interface BackupJobUpdateInput {
  name?: string;
  destinationId?: string;
  frequency?: BackupJobFrequency;
  schedule?: string;
  retentionDays?: number;
  enabled?: boolean;
}

export interface BackupJobRunResult {
  success: boolean;
  message?: string;
  logId?: string;
  fileName?: string;
  fileSize?: number;
  checksum?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useBackupJobs() {
  return useQuery<BackupJob[], ApiError>({
    queryKey: queryKeys.backups.jobs.list,
    queryFn: () => apiGet<BackupJob[]>("/backup-jobs"),
    staleTime: 30_000,
    // 4xx is not recoverable by retrying — disable retries so React
    // StrictMode double-mounts don't produce duplicate 404 noise in
    // the browser console.
    retry: false,
  });
}

// Phase 180 dead-code sweep: useBackupJob() was REMOVED — zero callers
// (backup detail views are enterprise-gated; the list + create/run hooks
// below stay live for the community backup-jobs section).

export function useCreateBackupJob() {
  const queryClient = useQueryClient();
  return useMutation<BackupJob, ApiError, BackupJobCreateInput>({
    mutationFn: (data) => apiPost<BackupJob>("/backup-jobs", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backups.jobs.list });
    },
  });
}

export function useUpdateBackupJob() {
  const queryClient = useQueryClient();
  return useMutation<
    BackupJob,
    ApiError,
    { id: string; data: BackupJobUpdateInput }
  >({
    mutationFn: ({ id, data }) => apiPut<BackupJob>(`/backup-jobs/${id}`, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backups.jobs.list });
      queryClient.invalidateQueries({
        queryKey: queryKeys.backups.jobs.detail(variables.id),
      });
    },
  });
}

export function useDeleteBackupJob() {
  const queryClient = useQueryClient();
  return useMutation<{ message: string }, ApiError, string>({
    mutationFn: (id) => apiDelete<{ message: string }>(`/backup-jobs/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backups.jobs.list });
    },
  });
}

export function useToggleBackupJob() {
  const queryClient = useQueryClient();
  return useMutation<BackupJob, ApiError, { id: string; enabled: boolean }, { previous: BackupJob[] | undefined }>({
    mutationFn: ({ id, enabled }) =>
      apiPost<BackupJob>(`/backup-jobs/${id}/toggle`, { enabled }),
    // CR-04: optimistic update so the Switch flips immediately and
    // a second rapid click sees the new value (no race with stale
    // cache). On error, roll back the cache to the snapshot.
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.backups.jobs.list });
      const previous = queryClient.getQueryData<BackupJob[]>(queryKeys.backups.jobs.list);
      if (previous) {
        queryClient.setQueryData<BackupJob[]>(
          queryKeys.backups.jobs.list,
          previous.map((j) => (j.id === id ? { ...j, enabled } : j)),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.backups.jobs.list, context.previous);
      }
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backups.jobs.list });
      queryClient.invalidateQueries({
        queryKey: queryKeys.backups.jobs.detail(variables.id),
      });
    },
  });
}

export function useRunBackupJob() {
  const queryClient = useQueryClient();
  return useMutation<BackupJobRunResult, ApiError, string>({
    mutationFn: (id) =>
      apiPost<BackupJobRunResult>(`/backup-jobs/${id}/run`, {}),
    onSuccess: () => {
      // Refresh both: the list (lastRunAt/lastRunStatus changed) and the logs
      // (a new running log was created by the server).
      queryClient.invalidateQueries({ queryKey: queryKeys.backups.jobs.list });
      // Invalidate all backup-log list queries regardless of filter — the
      // server doesn't expose a "logs" non-list query key, so we use the
      // parent prefix to catch every active filter set.
      queryClient.invalidateQueries({ queryKey: ["backups", "logs"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Logs (per-job)                                                     */
/* ------------------------------------------------------------------ */

// Phase 180 dead-code sweep: useBackupJobLogs() was REMOVED — zero
// callers (the log viewer moved with the enterprise backup detail view;
// BackupLogs list component consumes useBackupLogs, not this hook).

