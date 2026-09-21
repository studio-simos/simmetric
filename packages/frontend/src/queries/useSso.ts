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

/**
 * Phase 193 (D-16) — structured LDAP connection diagnostics. Stage NAMES
 * only; raw server/LDAP error strings NEVER cross this boundary (T-193-12).
 */
export interface LdapTestResult {
  reachable: boolean;
  bindOk: boolean;
  userFound: boolean;
  groupsFound: boolean;
  groupCount?: number;
}

/** Phase 193 (D-19) — one staged group→role mapping row. */
export interface LdapMapping {
  ldapGroupDn: string;
  roleId: string;
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
 *
 * Phase 193: `provider` widens additively with the third `"ldap"` member.
 */
export type SsoConfig = SsoConfigResponse & {
  provider: "saml" | "oidc" | "ldap" | null;
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

/* ------------------------------------------------------------------ */
/*  Phase 193 (LDAP) — queries + mutations (193-04)                    */
/* ------------------------------------------------------------------ */

/**
 * Phase 193 (D-18) — LDAP credential login. POSTs `{ username, password }`
 * to the POST-only /auth/ldap/login endpoint and — mirroring useLogin's
 * onSuccess (useAuth.ts:80-91) — stores the JWT under the SAME `token`
 * localStorage key, seeds the /auth/me cache, and invalidates the
 * menu/workspace/project caches so the downstream app boot path is
 * identical. NO browser navigation ever (D-18: the redirect block is
 * saml|oidc-only; this endpoint answers the POST directly).
 */
export function useLdapLogin() {
  const queryClient = useQueryClient();

  return useMutation<{ user: unknown; token: string }, ApiError, { username: string; password: string }>({
    mutationFn: ({ username, password }) =>
      apiFetch<{ user: unknown; token: string }>("/auth/ldap/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    onSuccess: (data) => {
      localStorage.setItem("token", data.token);
      queryClient.setQueryData(queryKeys.auth.me, data.user);
      // Same invalidation family as useLogin — the LDAP user's fresh
      // role set (JIT-provisioned server-side) must refetch.
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.menuSections });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

/**
 * Phase 193 (D-16) — admin test-connection. POST /sso/ldap/test returns
 * the structured diagnostics shape; stage detail lives in server logs only.
 */
export function useTestLdapConnection() {
  return useMutation<LdapTestResult, ApiError, void>({
    mutationFn: async () => {
      const res = await apiFetch<LdapTestResult>("/sso/ldap/test", {
        method: "POST",
      });
      return res;
    },
  });
}

/**
 * Phase 193 (D-19) — group→role mapping read. GET /sso/ldap/map returns
 * `{ mappings: rows }` (the bulk full-list contract).
 */
export function useLdapMap() {
  return useQuery<{ mappings: LdapMapping[] }, ApiError>({
    queryKey: queryKeys.sso.ldapMap,
    queryFn: () => apiGet<{ mappings: LdapMapping[] }>("/sso/ldap/map"),
    staleTime: 30 * 1000, // 30 seconds
  });
}

/**
 * Phase 193 (D-19) — bulk full-list replace. PUT /sso/ldap/map replaces the
 * WHOLE mapping list in one server transaction (per-row routes are
 * prohibited). Invalidates the sso.config family (the panel's config state)
 * AND the map list on success — reusing the sso key family, no new family.
 */
export function usePutLdapMap() {
  const queryClient = useQueryClient();

  return useMutation<{ mappings: LdapMapping[] }, ApiError, { mappings: LdapMapping[] }>({
    mutationFn: ({ mappings }) =>
      apiPut<{ mappings: LdapMapping[] }>("/sso/ldap/map", { mappings }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sso.config });
      queryClient.invalidateQueries({ queryKey: queryKeys.sso.ldapMap });
    },
  });
}