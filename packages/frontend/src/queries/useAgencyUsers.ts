// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 206 (AGENCY-01/02, Plan 05 Task 1): agency team-management query
// hooks. TanStack Query golden rule — REST/CRUD server state, centralized
// key registry (keys.ts), invalidate-on-success, no Zustand.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, ApiError } from "./api";
import { queryKeys } from "./keys";

export interface AgencySubUser {
  id: string;
  username: string;
  email: string;
  disabledAt: string | null;
  mustChangePassword: boolean;
  createdAt: string;
  // Phase 206 (owner UAT): current delegated grants — the picker pre-selects
  // them on reopen (full-replace semantics otherwise wipe them on save).
  permissions: string[];
}

export interface AgencyCeiling {
  maxSponsoredUsers: number;
  active: number;
  remaining: number;
}

export interface CreatedSubUser {
  user: {
    id: string;
    username: string;
    email: string;
    mustChangePassword: boolean;
  };
  generatedPassword?: string;
}

export function useAgencyUsers(enabled = true) {
  return useQuery<{ users: AgencySubUser[] }, ApiError>({
    queryKey: queryKeys.agency.users,
    queryFn: () => apiGet<{ users: AgencySubUser[] }>("/agency/users"),
    enabled: enabled && !!localStorage.getItem("token"),
    staleTime: 30 * 1000,
  });
}

export function useAgencyCeiling(enabled = true) {
  return useQuery<AgencyCeiling, ApiError>({
    queryKey: queryKeys.agency.ceiling,
    queryFn: () => apiGet<AgencyCeiling>("/agency/ceiling"),
    enabled: enabled && !!localStorage.getItem("token"),
    staleTime: 30 * 1000,
  });
}

export function useDelegatablePermissions(enabled = true) {
  return useQuery<{ permissions: string[] }, ApiError>({
    queryKey: queryKeys.agency.delegatable,
    queryFn: () => apiGet<{ permissions: string[] }>("/agency/delegatable-permissions"),
    enabled: enabled && !!localStorage.getItem("token"),
    staleTime: 60 * 1000,
  });
}

export function useCreateSubUser() {
  const queryClient = useQueryClient();
  return useMutation<CreatedSubUser, ApiError, { username: string; email: string; password?: string }>({
    mutationFn: (input) => apiPost<CreatedSubUser>("/agency/users", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agency.users });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agency.ceiling });
    },
  });
}

export function useDisableSubUser() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => apiPost<unknown>(`/agency/users/${id}/disable`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agency.users });
    },
  });
}

export function useEnableSubUser() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => apiPost<unknown>(`/agency/users/${id}/enable`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agency.users });
    },
  });
}

export function useResetSubUserPassword() {
  const queryClient = useQueryClient();
  return useMutation<{ tempPassword: string }, ApiError, string>({
    mutationFn: (id) => apiPost<{ tempPassword: string }>(`/agency/users/${id}/reset-password`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agency.users });
    },
  });
}

export function useUpdateSubUserPermissions() {
  const queryClient = useQueryClient();
  return useMutation<{ count: number }, ApiError, { id: string; permissions: string[] }>({
    mutationFn: (input) =>
      apiPut<{ count: number }>(`/agency/users/${input.id}/permissions`, {
        permissions: input.permissions,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agency.users });
    },
  });
}