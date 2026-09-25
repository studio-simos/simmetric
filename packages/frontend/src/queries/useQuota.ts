// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 207 (Plan 04 Task 1): quota query hooks — TanStack Query over the
// Plan 02/03 REST surface (/api/quota). Centralized key registry (keys.ts),
// invalidate-on-success, no Zustand (repo golden rule). Types come from the
// shared inferred schemas — NO re-declaration.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "./api";
import { queryKeys } from "./keys";
import type { QuotaUsage, UpdateQuotaInput } from "@simmetric-chat/shared";

/** Per-user quota usage read (tokens + storage) — admin/sponsor viewers. */
export function useQuota(userId: string | null) {
  return useQuery({
    queryKey: queryKeys.quota.user(userId ?? ""),
    enabled: Boolean(userId),
    queryFn: () => apiGet<QuotaUsage>(`/quota/${userId}`),
  });
}

/** Admin per-user quota column write (PUT /api/quota/:userId — D-09 admin-only). */
export function useUpdateQuota(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateQuotaInput) =>
      apiPut<QuotaUsage>(`/quota/${userId}`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.quota.user(userId) });
    },
  });
}

/** Manual token-quota reset (admin OR sponsor-of-target — D-09). */
export function useResetQuota(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ ok: boolean; kind: string; at: string; windowStart: string }>(
      `/quota/${userId}/reset`,
      { kind: "tokens" },
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.quota.user(userId) });
    },
  });
}