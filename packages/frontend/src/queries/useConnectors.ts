// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 199 (199-02, ECCO-05) — TanStack Query hooks for the external
 * chat-connector admin UI. Rides the Phase 198 REST surface unchanged
 * (/api/connectors CRUD + validate + webhook-setup/remove + test) — zero new
 * endpoints.
 *
 * SECRET DISCIPLINE (T-199-05): the serialized row NEVER carries
 * botToken/configEncrypted — the server's serializeConnector strips them and
 * adds hasBotToken/hasWebhookSecret booleans. The UI type below mirrors that
 * EXACT surface: the write-only token exists only as a create-input field.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "./api";
import { queryKeys } from "./keys";

export type ConnectorPlatform = "telegram" | "discord" | "slack" | "whatsapp";
type ConnectorPollMode = "polling" | "webhook";
type ConnectorHealthStatus = "healthy" | "error" | "unknown";

/**
 * The serialized connector row the UI consumes (server serializeConnector,
 * routes/connectors.ts:127 — secrets stripped, hasBotToken/hasWebhookSecret
 * added, pollOffset omitted as BigInt). botToken/configEncrypted are NEVER
 * present on this type.
 */
export interface Connector {
  id: string;
  platform: ConnectorPlatform;
  name: string;
  workspaceId: string;
  archiveId: string | null;
  botUsername: string | null;
  botDisplayName: string | null;
  welcomeMessage: string | null;
  fallbackMessage: string | null;
  fallbackLocale: string | null;
  isEnabled: boolean;
  pollMode: ConnectorPollMode;
  rateLimitPerMinute: number | null;
  sessionLimitPerDay: number | null;
  healthStatus: ConnectorHealthStatus;
  lastWebhookAt: string | null;
  lastPollAt: string | null;
  lastError: string | null;
  hasBotToken: boolean;
  hasWebhookSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Validate result — POST /:platform/validate (never persists anything). */
export interface ConnectorValidateResult {
  valid: boolean;
  botUsername: string | null;
  botDisplayName: string | null;
}

export interface ConnectorCreateInput {
  platform: ConnectorPlatform;
  name: string;
  workspaceId: string;
  archiveId?: string | null;
  botToken: string;
  welcomeMessage?: string;
  fallbackMessage?: string;
  fallbackLocale?: string;
  // Phase 200 (ECCO-06, D-16): per-platform config fields consumed by the
  // Plan 01 createConnectorSchema extension — slack signingSecret; whatsapp
  // phoneNumberId/appSecret/verifyToken/whatsappBusinessAccountId. The server
  // persists them INSIDE configEncrypted; they are NEVER echoed back.
  signingSecret?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
  whatsappBusinessAccountId?: string;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/** List (connector:view) — 30s staleTime + 30s refetchInterval keep the
 * health badges and lastPollAt/lastWebhookAt stamps live with zero extra
 * code (UI-SPEC A-9). TanStack keeps previous data on refetch. */
export function useConnectors() {
  return useQuery<Connector[], Error>({
    queryKey: queryKeys.connectors.list,
    queryFn: () => apiGet<Connector[]>("/connectors"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

/** Create (connector:manage) — POST /connectors. */
export function useCreateConnector() {
  const queryClient = useQueryClient();

  return useMutation<Connector, Error, ConnectorCreateInput>({
    mutationFn: (data) => apiPost<Connector>("/connectors", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors.list });
    },
  });
}

/** Enable/disable (connector:manage) — PUT /connectors/:id { isEnabled }. */
export function useToggleConnector() {
  const queryClient = useQueryClient();

  return useMutation<Connector, Error, { id: string; isEnabled: boolean }>({
    mutationFn: ({ id, isEnabled }) => apiPut<Connector>(`/connectors/${id}`, { isEnabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors.list });
    },
  });
}

/** Soft delete (connector:manage) — DELETE /connectors/:id. */
export function useDeleteConnector() {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error, string>({
    mutationFn: (id) => apiDelete<{ message: string }>(`/connectors/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors.list });
    },
  });
}

/**
 * Validate a bot token (connector:manage) — POST /connectors/:platform/validate
 * with the CURRENTLY ENTERED platform + token. Read-shaped mutation: it
 * persists nothing server-side (D-05), so there is no list invalidation.
 * Phase 200: the platform config fields ride the input (Plan 01's
 * validateTokenSchema extension) — the whatsapp probe consumes phoneNumberId.
 */
export function useValidateConnectorToken() {
  return useMutation<
    ConnectorValidateResult,
    Error,
    {
      platform: ConnectorPlatform;
      botToken: string;
      signingSecret?: string;
      phoneNumberId?: string;
      appSecret?: string;
      verifyToken?: string;
      whatsappBusinessAccountId?: string;
    }
  >({
    mutationFn: (payload) =>
      apiPost<ConnectorValidateResult>(`/connectors/${payload.platform}/validate`, payload),
  });
}

/** Telegram webhook setup (connector:manage) — POST /:id/webhook-setup. */
export function useWebhookSetup() {
  const queryClient = useQueryClient();

  return useMutation<Connector, Error, { id: string; url: string }>({
    mutationFn: ({ id, url }) => apiPost<Connector>(`/connectors/${id}/webhook-setup`, { url }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors.list });
    },
  });
}

/** Telegram webhook removal (connector:manage) — POST /:id/webhook-remove. */
export function useWebhookRemove() {
  const queryClient = useQueryClient();

  return useMutation<Connector, Error, string>({
    mutationFn: (id) => apiPost<Connector>(`/connectors/${id}/webhook-remove`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors.list });
    },
  });
}

/** Test message (connector:manage) — POST /:id/test { platformUserId }. */
export function useTestConnector() {
  return useMutation<{ sent: boolean }, Error, { id: string; platformUserId: string }>({
    mutationFn: ({ id, platformUserId }) =>
      apiPost<{ sent: boolean }>(`/connectors/${id}/test`, { platformUserId }),
  });
}

/* ------------------------------------------------------------------ */
/*  OAuth (Phase 200, D-05)                                            */
/* ------------------------------------------------------------------ */

/** GET /oauth/providers response row — the visibility signal the create
 * dialog's "Connect with Slack" arm consumes (UI-SPEC contract 4). The
 * server returns booleans ONLY — never client IDs or secret material
 * (T-200-13). */
export interface OauthProviderSignal {
  id: string;
  configured: boolean;
}

/** GET /oauth/providers response envelope. */
export interface OauthProvidersResponse {
  providers: OauthProviderSignal[];
}

/**
 * OAuth-provider visibility signal (connector:manage) — GET
 * /connectors/oauth/providers. Read-shaped: it drives the Connect-with-Slack
 * button's visibility (rendered only when the platform reports configured
 * true — UI-SPEC partial state / D-05 static-token fallback). staleTime 60s
 * — the flag changes only on a server restart with new env, never per-keystroke.
 */
export function useOauthProviders() {
  return useQuery<OauthProviderSignal[], Error>({
    queryKey: queryKeys.connectors.oauthProviders,
    queryFn: () =>
      apiGet<OauthProvidersResponse>("/connectors/oauth/providers").then((r) => r.providers),
    staleTime: 60_000,
  });
}

/**
 * Start the connector OAuth flow (connector:manage) — POST
 * /connectors/:id/oauth/start. Resolves with the provider authorizeUrl — the
 * caller redirects via assignRedirect (lib/redirect seam: full-page
 * navigation, never a popup; the 196-03 lesson). No list invalidation: the
 * OAuth completion happens server-side at the public callback and the
 * redirect back to the connectors settings surface refetches through the
 * normal list query.
 */
export function useStartConnectorOauth() {
  return useMutation<{ authorizeUrl: string }, Error, string>({
    mutationFn: (id) => apiPost<{ authorizeUrl: string }>(`/connectors/${id}/oauth/start`, {}),
  });
}