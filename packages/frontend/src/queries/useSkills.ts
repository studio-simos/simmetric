// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 190 (SKIL-01, D-20) — TanStack Query hooks for the skills management
 * surface. REST golden rule: all data rides /api/skills (Plan 02's
 * skillsCrudRouter), never the read-only /api/agent/skills route.
 *
 * D-10 cache: the list is stale for 5 minutes — the chat palette (Plan 05)
 * reads the same cached data without a fetch on every keystroke.
 * Mutations invalidate queryKeys.skills.all so the page refetches after
 * create/update/delete (SC-1 lifecycle visibility is server-side per-request;
 * this only refreshes the management list).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "./api";
import { queryKeys } from "./keys";

/* ------------------------------------------------------------------ */
/*  Types — Plan 02's wire shape                                       */
/* ------------------------------------------------------------------ */

/** GET /api/skills builtin arm row (read-only registry catalog entries). */
interface BuiltinSkillEntry {
  name: string;
  displayName: string;
  description: string;
  type: string;
}

/** Custom/accessible row — every row carries config.defaultParams + parsed inputSchema. */
export interface CustomSkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  skillMode: string;
  /** Derived server-side: workspaceId→workspace, userId→personal, else global. */
  scope: "personal" | "workspace" | "global";
  isEnabled: boolean;
  workspaceId: string | null;
  createdBy: string | null;
  config: { defaultParams: Record<string, string> };
  inputSchema: Record<string, unknown>;
}

/** GET /api/skills response — { builtin, custom, accessible } (Plan 02). */
export interface SkillsListResult {
  builtin: BuiltinSkillEntry[];
  /** Own + visible globals — the management page renders this array only. */
  custom: CustomSkillRow[];
  /** Other users' workspace-scoped rows in viewer+ workspaces (Plan 05's chat-palette source). */
  accessible: CustomSkillRow[];
}

/** POST /api/skills/:id/test response — compiled prompt, no LLM call (D-21). */
export interface SkillTestResult {
  compiledPrompt: string;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useSkills() {
  return useQuery<SkillsListResult, ApiError>({
    queryKey: queryKeys.skills.list,
    queryFn: () => apiGet<SkillsListResult>("/skills"),
    // D-10: 5-minute staleness — the management page and the (Plan 05)
    // chat palette both read from this cache without refetching.
    staleTime: 5 * 60 * 1000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations — all invalidate the skills family                       */
/* ------------------------------------------------------------------ */

function useInvalidateSkills() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.skills.all });
  };
}

export function useCreateSkill() {
  const invalidate = useInvalidateSkills();
  return useMutation<CustomSkillRow, ApiError, Record<string, unknown>>({
    mutationFn: (data) => apiPost<CustomSkillRow>("/skills", data),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateSkill() {
  const invalidate = useInvalidateSkills();
  return useMutation<CustomSkillRow, ApiError, { id: string; data: Record<string, unknown> }>({
    mutationFn: ({ id, data }) => apiPut<CustomSkillRow>(`/skills/${id}`, data),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteSkill() {
  const invalidate = useInvalidateSkills();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => apiDelete(`/skills/${id}`),
    onSuccess: () => invalidate(),
  });
}

/**
 * POST /api/skills/:id/test — compiled-prompt preview. Returns
 * { compiledPrompt }; the UI never compiles templates client-side (D-20)
 * and never calls the LLM from any skills surface.
 */
export function useTestSkill() {
  return useMutation<SkillTestResult, ApiError, { id: string; params: Record<string, string> }>({
    mutationFn: ({ id, params }) =>
      apiPost<SkillTestResult>(`/skills/${id}/test`, { params }),
  });
}