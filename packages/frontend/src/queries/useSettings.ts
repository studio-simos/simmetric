// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for system settings.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut, apiUpload, apiDelete, ApiError } from "./api";
import { queryKeys } from "./keys";
import type { SettingsEntry } from "@simmetric-chat/shared";

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useSettings(enabled = true) {
  return useQuery<SettingsEntry[], ApiError>({
    queryKey: queryKeys.settings.all,
    queryFn: () => apiGet<SettingsEntry[]>("/system/settings"),
    enabled,
    staleTime: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation<
    { updated: SettingsEntry[]; rejected: string[] },
    ApiError,
    { key: string; value: string }[]
  >({
    mutationFn: (configs) =>
      apiPut<{ updated: SettingsEntry[]; rejected: string[] }>("/system/settings", { configs }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}

/** Upload an app icon (multipart FormData, field "icon") → POST /system/settings/branding/icon */
export function useUploadBrandingIcon() {
  const queryClient = useQueryClient();
  return useMutation<{ url: string }, ApiError, File>({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append("icon", file);
      return apiUpload<{ url: string }>("/system/settings/branding/icon", fd);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}

/** Remove the app icon → DELETE /system/settings/branding/icon */
export function useDeleteBrandingIcon() {
  const queryClient = useQueryClient();
  return useMutation<{ message: string }, ApiError, void>({
    mutationFn: () => apiDelete<{ message: string }>("/system/settings/branding/icon"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers (drop-in replacements for settingsStore getters)           */
/* ------------------------------------------------------------------ */

export function useSettingsHelpers() {
  const { data: settings } = useSettings();

  const getValue =
    (key: string) => {
      const entry = settings?.find((s) => s.key === key);
      return entry?.value ?? "";
    };

  const isReadOnly =
    (key: string) => {
      const entry = settings?.find((s) => s.key === key);
      return entry?.readOnly ?? false;
    };

  // D-08 (Phase 176): true when an ineffective env var is set for a
  // non-readonly key (the DB value still wins). Mirrors isReadOnly exactly.
  const isEnvOverridden =
    (key: string) => {
      const entry = settings?.find((s) => s.key === key);
      return entry?.envOverridden ?? false;
    };

  return { getValue, isReadOnly, isEnvOverridden };
}
