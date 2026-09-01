// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiUpload, ApiError } from "./api";
import { queryKeys } from "./keys";
/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  customInstructions: string | null;
  textSize: string | null;
  mustChangePassword: boolean;
  roles: { id: string; name: string; isDefault: boolean }[];
  permissions: string[];
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface ProfileUpdateInput {
  firstName?: string;
  lastName?: string;
  customInstructions?: string;
  textSize?: string;
}

/* ------------------------------------------------------------------ */
/*  Query Hooks                                                        */
/* ------------------------------------------------------------------ */

export function useMe(enabled = true) {
  return useQuery<AuthUser, ApiError>({
    queryKey: queryKeys.auth.me,
    queryFn: () => apiGet<AuthUser>("/auth/me"),
    enabled: enabled && !!localStorage.getItem("token"),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useMenuSections(enabled = true) {
  return useQuery<string[], ApiError>({
    queryKey: queryKeys.auth.menuSections,
    queryFn: () => apiGet<string[]>("/roles/me/menu-sections"),
    enabled: enabled && !!localStorage.getItem("token"),
    staleTime: 5 * 60 * 1000,
  });
}

// Phase 180 dead-code sweep: useRegistrationStatus() REMOVED — zero callers
// (the login page reads the settings payload it already fetches).

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation<
    { user: AuthUser; token: string },
    ApiError,
    LoginInput
  >({
    mutationFn: (input) => apiPost<{ user: AuthUser; token: string }>("/auth/login", input),
    onSuccess: (data) => {
      localStorage.setItem("token", data.token);
      queryClient.setQueryData(queryKeys.auth.me, data.user);
      // Invalidate menu sections so they’re refetched
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.menuSections });
      // Invalidate sidebar data (workspaces + projects) so any errored/stale
      // cache from the unauthenticated login screen is refetched with the
      // fresh token. Covers SSO token-swap flows that bypass useLogout's
      // queryClient.clear().
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useSetInitialPassword() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, ApiError, { newPassword: string }>({
    mutationFn: (input) => apiPost<{ message: string }>("/auth/set-initial-password", input),
    onSuccess: () => {
      // Refetch /auth/me so the cleared mustChangePassword flag unlocks the app.
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.me });
    },
  });
}

// Phase 180 dead-code sweep: useAdminRegister() REMOVED — zero callers
// (the admin onboarding flow uses POST /auth/register directly).

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation<AuthUser, ApiError, ProfileUpdateInput>({
    mutationFn: async (data) => {
      // We need the current user id from the cache
      const user = queryClient.getQueryData<AuthUser>(queryKeys.auth.me);
      if (!user) throw new ApiError(401, "Not authenticated");
      return apiPut<AuthUser>(`/users/${user.id}`, data);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<AuthUser>(queryKeys.auth.me, (old) =>
        old ? { ...old, ...updated } : old,
      );
    },
  });
}

export function useUploadAvatar() {
  const queryClient = useQueryClient();

  return useMutation<{ avatar: string }, ApiError, File>({
    mutationFn: async (file) => {
      const user = queryClient.getQueryData<AuthUser>(queryKeys.auth.me);
      if (!user) throw new ApiError(401, "Not authenticated");
      const formData = new FormData();
      formData.append("avatar", file);
      return apiUpload<{ avatar: string }>(`/users/${user.id}/avatar`, formData);
    },
    onSuccess: (result) => {
      queryClient.setQueryData<AuthUser>(queryKeys.auth.me, (old) =>
        old ? { ...old, avatar: result.avatar } : old,
      );
    },
  });
}

export function useRemoveAvatar() {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, void>({
    mutationFn: async () => {
      const user = queryClient.getQueryData<AuthUser>(queryKeys.auth.me);
      if (!user) throw new ApiError(401, "Not authenticated");
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/users/${user.id}/avatar`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error || res.statusText);
      }
    },
    onSuccess: () => {
      queryClient.setQueryData<AuthUser>(queryKeys.auth.me, (old) =>
        old ? { ...old, avatar: null } : old,
      );
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, void>({
    mutationFn: async () => {
      localStorage.removeItem("token");
      // No API call needed — just clear local state
      return Promise.resolve();
    },
    onSuccess: () => {
      queryClient.clear();
    },
  });
}
