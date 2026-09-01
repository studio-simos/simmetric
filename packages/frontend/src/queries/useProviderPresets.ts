// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for the provider preset catalog (quick task 260723-ps2).
 * Mirrors the useProviders / useMarketplace patterns.
 */
import { useQuery, useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { apiGet, apiPost, ApiError } from "./api";
import type { ProviderPreset } from "@simmetric-chat/shared";

export type ProviderPresetWithInstall = ProviderPreset & { isInstalled: boolean };

/**
 * List all provider presets, each augmented with `isInstalled`.
 */
export function useProviderPresets(enabled = true) {
  return useQuery<ProviderPresetWithInstall[], ApiError>({
    queryKey: ["provider-presets"],
    queryFn: () => apiGet<ProviderPresetWithInstall[]>("/provider-presets"),
    enabled,
    staleTime: 60_000,
  });
}

interface InstallPresetArgs {
  presetId: string;
  apiKey?: string;
  name?: string;
}

/**
 * Install a preset as a Provider. On success, invalidate the providers list
 * so the providers panel refreshes.
 */
export function useInstallProviderPreset(): UseMutationResult<
  Record<string, unknown>,
  ApiError,
  InstallPresetArgs
> {
  const qc = useQueryClient();
  return useMutation<Record<string, unknown>, ApiError, InstallPresetArgs>({
    mutationFn: ({ presetId, apiKey, name }) =>
      apiPost<Record<string, unknown>>(`/provider-presets/${presetId}/install`, {
        ...(apiKey ? { apiKey } : {}),
        ...(name ? { name } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-presets"] });
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["providers", "available"] });
    },
  });
}