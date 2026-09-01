// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut, apiFetch, ApiError } from "./api";
import { queryKeys } from "./keys";
import { useSettingsHelpers } from "./useSettings";
import type {
  SsoConfigResponse,
  SaveSsoConfigInput,
  SsoStatusResponse,
} from "@simmetric-chat/shared";

export interface ScimTestResult {
  success: boolean;
  message: string;
  scimEndpoint: string;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Frontend-facing SSO config. Mirrors `SsoConfigResponse` from shared but
 * widens `provider` to allow `null` so the panel can render the empty/default
 * state returned by `GET /api/sso/config` when no config row exists yet
 * (server returns `{ provider: null, enabled: false, clientSecretConfigured: false }`).
 *
 * NOTE: the server response is a FLAT shape — `clientId`, `discoveryUrl`,
 * `entryPoint`, `cert`, … are top-level fields, not nested under `config`.
 * This was the root cause of the SSO panel crash: the panel previously
 * expected `ssoConfig.config.clientId` while the API returns `ssoConfig.clientId`
 * directly. Aligned to the canonical `ssoConfigResponseSchema` in shared.
 */
export type SsoConfig = SsoConfigResponse & {
  provider: "saml" | "oidc" | null;
};

export type SsoSaveInput = SaveSsoConfigInput;

/* ------------------------------------------------------------------ */
/*  Query Hooks                                                        */
/* ------------------------------------------------------------------ */

export function useSsoConfig() {
  return useQuery<SsoConfig, ApiError>({
    queryKey: queryKeys.sso.config,
    queryFn: () => apiGet<SsoConfig>("/sso/config"),
    staleTime: 30 * 1000, // 30 seconds
  });
}

/**
 * Public SSO availability status for the unauthenticated login page.
 * Hits GET /api/auth/sso/status — no auth header required. Returns only
 * booleans/enums (enabled, provider, oidcProvider); never configuration
 * details or secrets (T-260808-p5y-01).
 */
export function useSsoStatus() {
  return useQuery<SsoStatusResponse, ApiError>({
    queryKey: queryKeys.sso.status,
    queryFn: () => apiGet<SsoStatusResponse>("/auth/sso/status"),
    staleTime: 30 * 1000, // 30 seconds
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useSaveSsoConfig() {
  const queryClient = useQueryClient();

  return useMutation<SsoConfig, ApiError, SsoSaveInput>({
    mutationFn: (data) => apiPut<SsoConfig>("/sso/config", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sso.config });
    },
  });
}

export function useScimBearerToken() {
  const { getValue, isReadOnly } = useSettingsHelpers();
  return {
    token: getValue("SCIM_BEARER_TOKEN"),
    isReadOnly: isReadOnly("SCIM_BEARER_TOKEN"),
  };
}

export function useTestScim() {
  return useMutation<ScimTestResult, ApiError, void>({
    mutationFn: async () => {
      const res = await apiFetch<ScimTestResult>("/sso/scim/test", {
        method: "POST",
      });
      return res;
    },
  });
}