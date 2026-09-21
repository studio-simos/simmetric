// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 192 (DLP-05/DLP-06) — TanStack Query hooks for the document-scan
 * eval gate + legacy backfill (REST golden rule).
 *
 * - useDlpEvalResult() → GET /api/system/dlp/eval/result (192-10 Gap 1
 *   closure — the server-served path; was the hyphenated /eval-result 404) —
 *   the discriminated no-run/full-result union from @simmetric-chat/shared
 *   (dlpEvalResultSchema); the WorkspaceRow gate + the panel both read THIS
 *   one cache entry.
 * - useRunDlpEval() → POST /api/system/dlp/eval/run (single-flight at the
 *   panel; invalidates the result key on success so the gate re-reads).
 * - useDlpBackfill() → POST /api/system/dlp/backfill (plan 06) — response
 *   { enqueued, skipped, totalEligible, errors }; a 409 gate rejection
 *   carries ApiError.status 409 for the panel's gate-blocked banner.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, type ApiError } from "../utils/api";
import { queryKeys } from "./keys";
import type { DlpBackfillResponse, DlpEvalResult, DlpEvalRunResponse } from "@simmetric-chat/shared";

export type { DlpBackfillResponse, DlpEvalResult, DlpEvalRunResponse };

/**
 * The persisted last eval run. 200 with the no-run arm
 * `{ passed: false, noRun: true }` when never run (NOT an error — the panel
 * renders the documented empty state from it and the workspace toggle treats
 * it as gate-not-passed). 192-10 Gap 1 closure: the queryFn path above is the
 * exact route system.ts serves (see the header bullet — the hyphenated
 * /eval-result variant is a 404).
 */
export function useDlpEvalResult() {
  return useQuery<DlpEvalResult, ApiError>({
    queryKey: queryKeys.dlp.evalResult,
    queryFn: () => apiGet<DlpEvalResult>("/system/dlp/eval/result"),
    staleTime: 30_000,
    retry: 1,
  });
}

/** Trigger an eval run (admin). Success invalidates the gate result so the toggle + panel re-read it. */
export function useRunDlpEval() {
  const queryClient = useQueryClient();

  return useMutation<DlpEvalRunResponse, ApiError, void>({
    mutationFn: () => apiPost<DlpEvalRunResponse>("/system/dlp/eval/run", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dlp.evalResult });
    },
  });
}

/** Trigger the legacy-corpus backfill (admin, destructive confirm upstream). */
export function useDlpBackfill() {
  const queryClient = useQueryClient();

  return useMutation<DlpBackfillResponse, ApiError, void>({
    mutationFn: () => apiPost<DlpBackfillResponse>("/system/dlp/backfill", {}),
    onSuccess: () => {
      // Re-enqueued jobs will flip dlpScannedAt/dlpScanState — the workspace
      // list (toggle rows) is the shared surface; keep it fresh.
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}