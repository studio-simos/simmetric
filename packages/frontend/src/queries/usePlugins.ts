// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-05, 202-04 Task 1) — TanStack Query hooks for the plugin
 * manager admin UI. Rides the 202-03 REST surface unchanged
 * (/api/plugins list/upload/toggle/uninstall/license/verify/restart) — zero
 * new endpoints.
 *
 * SECRET DISCIPLINE (T-202-19, the useConnectors.ts header pattern): the
 * serialized row NEVER carries licenseKeyEncrypted/packageJson — the server's
 * serializePluginRow strips them and the STRICT shared pluginRowSchema
 * REJECTS any payload that carries them. The UI type is the shared inferred
 * PluginRow: the license JWT exists only as a write-only modal input and is
 * NEVER echoed back (A-6 — the modal always opens empty; the card's license
 * badge is the only persisted license state the UI shows).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete, apiUpload } from "./api";
import { queryKeys } from "./keys";
import type {
  PluginRow,
  PluginListResponse,
} from "@simmetric-chat/shared";

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/**
 * List (plugins:manage) — 30s staleTime + 30s refetchInterval keep status /
 * license badges / licenseCheckedAt fresh with zero extra code (the
 * useConnectors polling idiom; UI-SPEC §10). The envelope carries
 * restartMode (server-owned, A-2) alongside the secrets-stripped rows.
 */
export function usePlugins() {
  return useQuery<PluginListResponse, Error>({
    queryKey: queryKeys.plugins.list,
    queryFn: () => apiGet<PluginListResponse>("/plugins"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

/**
 * Install (plugins:manage) — POST /plugins with the zip as multipart
 * FormData via apiUpload (Content-Type is set by the browser boundary —
 * never manually). NOT optimistic: the response is the truth — a failed
 * install leaves no row server-side, so no ghost card (UI-SPEC §5).
 */
export function useInstallPlugin() {
  const queryClient = useQueryClient();

  return useMutation<PluginRow, Error, File>({
    mutationFn: (file) => {
      const formData = new FormData();
      formData.append("file", file);
      return apiUpload<PluginRow>("/plugins", formData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.list });
    },
  });
}

/** Enable/disable (plugins:manage) — PUT /plugins/:id { enabled }. */
export function useTogglePlugin() {
  const queryClient = useQueryClient();

  return useMutation<PluginRow, Error, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) => apiPut<PluginRow>(`/plugins/${id}`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.list });
    },
  });
}

/** Uninstall (plugins:manage) — DELETE /plugins/:id (disabled rows only). */
export function useUninstallPlugin() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (id) => apiDelete<{ success: boolean }>(`/plugins/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.list });
    },
  });
}

/**
 * Save license (plugins:manage) — PUT /plugins/:id/license with the pasted
 * JWT. Write-only discipline: the JWT is sent once and NEVER echoed back —
 * the response carries licenseStatus only.
 */
export function useSavePluginLicense() {
  const queryClient = useQueryClient();

  return useMutation<{ licenseStatus: string }, Error, { id: string; licenseKey: string }>({
    mutationFn: ({ id, licenseKey }) =>
      apiPut<{ licenseStatus: string }>(`/plugins/${id}/license`, { licenseKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.list });
    },
  });
}

/**
 * Verify license (plugins:manage) — POST /plugins/:id/verify-license.
 * Read-shaped mutation (the useValidateConnectorToken pattern): it persists
 * NOTHING server-side, so there is no list invalidation.
 */
export function useVerifyPluginLicense() {
  return useMutation<{ licenseStatus: string }, Error, { id: string; licenseKey: string }>({
    mutationFn: ({ id, licenseKey }) =>
      apiPost<{ licenseStatus: string }>(`/plugins/${id}/verify-license`, { licenseKey }),
  });
}

/**
 * Restart (plugins:manage) — POST /plugins/restart. retry OFF explicitly
 * (UI-SPEC A-10): retrying a server-killing mutation is nonsense — the 202
 * is the truth and the server dies mid-teardown.
 */
export function useRestartServer() {
  return useMutation<{ restarting: boolean }, Error, void>({
    mutationFn: () => apiPost<{ restarting: boolean }>("/plugins/restart", {}),
    retry: false,
  });
}