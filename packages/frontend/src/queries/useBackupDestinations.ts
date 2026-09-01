// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for backup destination CRUD.
 * Mirrors the `useMcpConnections` pattern: useQuery for list/detail,
 * useMutation for create/update/delete/test, with queryClient invalidation
 * on success.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "./api";
import { queryKeys } from "./keys";

export type BackupDestinationType =
  | "local"
  | "s3"
  | "s3_compatible"
  | "google_drive"
  | "dropbox"
  | "sftp"
  | "ftp"
  | "email";

type BackupDestinationStatus = "online" | "offline" | "error" | "unknown";

export interface BackupDestination {
  id: string;
  name: string;
  type: BackupDestinationType;
  status: BackupDestinationStatus;
  config: Record<string, unknown>;
  lastTestedAt: string | null;
  lastTestError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface BackupDestinationCreateInput {
  name: string;
  type: BackupDestinationType;
  config: Record<string, unknown>;
}

export interface BackupDestinationUpdateInput {
  name?: string;
  config?: Record<string, unknown>;
}

export interface BackupTestResult {
  success: boolean;
  message?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useBackupDestinations() {
  return useQuery<BackupDestination[], ApiError>({
    queryKey: queryKeys.backups.destinations.list,
    queryFn: () => apiGet<BackupDestination[]>("/backup-destinations"),
    staleTime: 30_000,
    // 4xx is not recoverable by retrying — disable retries so React
    // StrictMode double-mounts don't produce duplicate 404 noise in
    // the browser console.
    retry: false,
  });
}

// Phase 180 dead-code sweep: useBackupDestination() was REMOVED — zero
// callers (the backup UI is enterprise-gated; the enterprise plugin carries
// its own detail view. The list hook above + the mutations below stay live).


/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useCreateBackupDestination() {
  const queryClient = useQueryClient();
  return useMutation<BackupDestination, ApiError, BackupDestinationCreateInput>({
    mutationFn: (data) => apiPost<BackupDestination>("/backup-destinations", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backups.destinations.list });
    },
  });
}

export function useUpdateBackupDestination() {
  const queryClient = useQueryClient();
  return useMutation<
    BackupDestination,
    ApiError,
    { id: string; data: BackupDestinationUpdateInput }
  >({
    mutationFn: ({ id, data }) => apiPut<BackupDestination>(`/backup-destinations/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backups.destinations.list });
    },
  });
}

export function useDeleteBackupDestination() {
  const queryClient = useQueryClient();
  return useMutation<{ message: string }, ApiError, string>({
    mutationFn: (id) => apiDelete<{ message: string }>(`/backup-destinations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backups.destinations.list });
    },
  });
}

export function useTestBackupDestination() {
  return useMutation<BackupTestResult, ApiError, string>({
    mutationFn: (id) => apiPost<BackupTestResult>(`/backup-destinations/${id}/test`, {}),
  });
}
