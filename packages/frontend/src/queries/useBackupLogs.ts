// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for backup log operations (Phase 57-03).
 *
 * Provides the paginated list with server-side filters, conditional
 * 5-second polling while any log is "running" (D-12), a single-log
 * detail accessor (W-04: implemented as a filtered list lookup because
 * GET /api/backups/:id does not exist), and the dry-run + execute
 * restore mutations (D-17, D-18).
 *
 * The exported `BackupLog` type is the single source of truth for
 * the BackupLog shape across the `queries/` folder. Plan 02 added an
 * inline stub in `useBackupJobs.ts`; this file is the W-03
 * reconciliation point.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, ApiError } from "./api";
import { queryKeys } from "./keys";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type BackupLogStatus = "running" | "success" | "failed" | "restored";

interface BackupDestinationSummary {
  id: string;
  name: string;
  type: string;
}

interface BackupJobSummary {
  id: string;
  name: string;
}

interface BackupUserSummary {
  id: string;
  username: string;
}

/**
 * Server response for a single BackupLog. Note: the `BackupLog` Prisma
 * model does not store `durationMs` directly — clients compute it from
 * `completedAt - startedAt` when needed. The server returns startedAt
 * and completedAt as ISO-8601 strings.
 */
export interface BackupLog {
  id: string;
  destinationId: string;
  jobId: string | null;
  fileName: string | null;
  fileSize: number | null;
  checksum: string | null;
  status: BackupLogStatus;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  restoredAt: string | null;
  restoredBy: string | null;
  destination: BackupDestinationSummary;
  job: BackupJobSummary | null;
  restoredByUser: BackupUserSummary | null;
}

export interface BackupLogFilters {
  status?: BackupLogStatus | string;
  destinationId?: string;
  jobId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface BackupLogsResponse {
  data: BackupLog[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface BackupDryRunResult {
  success: boolean;
  isValid: boolean;
  fileSize: number;
  checksumVerified: boolean;
  contents: {
    files: string[];
    tables: string[];
  };
}

export interface BackupRestoreInput {
  selective: "db" | "files" | "complete";
  confirmation: "RESTORE";
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildBackupLogsQueryString(filters: BackupLogFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", String(filters.status));
  if (filters.destinationId) params.set("destinationId", filters.destinationId);
  if (filters.jobId) params.set("jobId", filters.jobId);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (filters.page != null) params.set("page", String(filters.page));
  if (filters.pageSize != null) params.set("pageSize", String(filters.pageSize));
  if (filters.sort) params.set("sort", filters.sort);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/**
 * Paginated, filterable list of backup logs. Polls every 5s while any
 * row is in `running` state (D-12) so the UI can show live progress
 * after a fire-and-navigate from the Jobs sub-tab.
 */
export function useBackupLogs(filters: BackupLogFilters = {}) {
  return useQuery<BackupLogsResponse, ApiError>({
    queryKey: queryKeys.backups.logs.list(filters as Record<string, unknown>),
    queryFn: () =>
      apiGet<BackupLogsResponse>(`/backups${buildBackupLogsQueryString(filters)}`),
    staleTime: 5_000,
    // 4xx (e.g. 404 on a misconfigured path) is not recoverable by
    // retrying — disable retries so the console doesn't show 4× the
    // same 404 in dev (React StrictMode double-mounts amplify this).
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as BackupLogsResponse | undefined;
      const hasRunning = data?.data?.some((l) => l.status === "running");
      return hasRunning ? 5_000 : false;
    },
  });
}

/**
 * Single-log detail accessor. W-04 verified: GET /api/backups/:id does
 * not exist server-side. To keep the Restore dialog polling working
 * (plan 04) without adding a new server route, we fetch a small page
 * of the most recent logs and find the one matching `id`. The cost is
 * negligible (single small DB query) and avoids a new endpoint for a
 * single-call read pattern.
 *
 * WR-03: page size dropped from 100 to 20 because this hook is
 * called on every poll tick (10s) and the response also includes
 * \`contents\`, \`destination\`, \`job\`, \`restoredByUser\` — the
 * payload adds up. 20 is sufficient for the polling fallback
 * (a 30-min restore outlives any 20-row window).
 *
 * Pass `poll: true` to enable automatic refetching (used by the
 * Restore dialog's D-18 network-drop fallback). The cadence is 10s so
 * the wall-clock guard in the dialog (5 minutes) gets ~30 polls.
 */
export function useBackupLog(
  id: string | undefined,
  options: { poll?: boolean } = {},
) {
  const { poll = false } = options;
  return useQuery<BackupLog, ApiError>({
    queryKey: queryKeys.backups.logs.detail(id ?? ""),
    queryFn: async () => {
      // Use a small page size — this is a single-row lookup, the
      // page is just the lookup surface.
      const res = await apiGet<BackupLogsResponse>(
        "/backups?page=1&pageSize=20",
      );
      const match = res.data.find((l) => l.id === id);
      if (!match) {
        throw new ApiError(
          404,
          "Backup log not found",
        );
      }
      return match;
    },
    enabled: !!id,
    staleTime: 5_000,
    refetchInterval: poll ? 10_000 : false,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

/**
 * Dry-run pre-flight check (REST-06, REST-07). No cache invalidation —
 * a dry-run is a read-only side effect.
 */
export function useDryRunRestore() {
  return useMutation<BackupDryRunResult, ApiError, { logId: string }>({
    mutationFn: ({ logId }) =>
      apiPost<BackupDryRunResult>(`/backups/restore/${logId}/dry-run`, {}),
  });
}

/**
 * Execute the restore (REST-04, REST-05, REST-08). On success the
 * server moves the log's status to `restored`, so we invalidate the
 * logs list (prefix) so the Storico sub-tab refetches.
 */
export function useExecuteRestore() {
  const queryClient = useQueryClient();
  return useMutation<
    { status: "success" | "failed"; [key: string]: unknown },
    ApiError,
    { logId: string; data: BackupRestoreInput }
  >({
    mutationFn: ({ logId, data }) =>
      apiPost(`/backups/restore/${logId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["backups", "logs"] });
    },
  });
}
