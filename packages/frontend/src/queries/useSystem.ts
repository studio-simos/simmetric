// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// STATE: TanStack Query — system-state queries + mutations (server state tier)
/**
 * Phase 152-03 (WIZ-01, D-04/D-06/D-08) — system query hooks for the
 * first-run Setup Wizard. These follow the frontend state golden rule:
 * REST → TanStack Query. The wizard step index itself is local UI state
 * (D-03 — see SetupWizard.tsx); only the server-state calls live here.
 *
 * `useSystemIsInitialized` is PUBLIC (no `Authorization` header gate — the
 * wizard runs before the user has a JWT, so unlike `useMe` it does NOT
 * `enabled: !!localStorage.getItem("token")`). `staleTime: 0` keeps the
 * response fresh across App mounts so the wizard-vs-login gate never
 * shows a stale `setupWizardMode`.
 *
 * The probe hooks (`useProbeLlm`, `useProbeVector`) are implemented as
 * `useMutation` rather than `useQuery` with `enabled: false` + manual
 * `refetch`. The plan described the latter mechanism, but a mutation is
 * the idiomatic TanStack Query primitive for an on-demand POST trigger
 * and avoids the stale-closure footgun that `useQuery` + dynamic input
 * carries (the queryFn would close over stale state unless a ref is
 * threaded through). The observable contract is identical — manual
 * trigger, `isPending`, non-blocking result (D-06) — and the state golden
 * rule (REST → TanStack Query) is fully satisfied either way. The probes
 * are commands (side-effectful health checks), not cacheable queries.
 *
 * `useInitialize` is a `useMutation` wrapping `POST /api/system/initialize`
 * (Plan 01 contract — admin creation + config save + JWT issuance + mode
 * flip). The wizard stores the returned JWT in `localStorage("token")`
 * (D-08 auto-login) and redirects to `/chat` (D-09).
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiGet, apiPost, type ApiError } from "./api";
import { queryKeys } from "./keys";
import type { InitializeInput } from "@simmetric-chat/shared";

/** Response of `GET /api/system/is-initialized` (Plan 01 extension). */
export interface IsInitializedResponse {
  initialized: boolean;
  /** `active` on a fresh install (no admin); `completed` once an admin exists. */
  setupWizardMode: "active" | "completed";
}

/** Response of `POST /api/system/probe-llm` (Plan 01 — non-blocking). */
export interface ProbeLlmResponse {
  ok: boolean;
  models?: string[];
  error?: string;
}

/** Response of `POST /api/system/probe-vector` (Plan 01 — non-blocking). */
export interface ProbeVectorResponse {
  ok: boolean;
  error?: string;
}

/** Success response of `POST /api/system/initialize` (Plan 01 — returns a JWT). */
export interface InitializeResponse {
  user: {
    id: string;
    username: string;
    email: string;
    mustChangePassword: boolean;
    [key: string]: unknown;
  };
  token: string;
}

/** Input for `useProbeLlm` — matches the Plan 01 `/probe-llm` body. */
export interface ProbeLlmInput {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Input for `useProbeVector` — matches the Plan 01 `/probe-vector` body. */
export interface ProbeVectorInput {
  provider: string;
  url?: string;
}

/**
 * Public query for the system initialization state. No token gate — the
 * wizard runs before auth. `staleTime: 0` so App.tsx always refetches on
 * mount and the wizard-vs-login branch never shows a stale value.
 */
export function useSystemIsInitialized() {
  return useQuery<IsInitializedResponse, ApiError>({
    queryKey: queryKeys.system.isInitialized,
    queryFn: () => apiGet<IsInitializedResponse>("/system/is-initialized"),
    staleTime: 0,
  });
}

/**
 * Mutation wrapping `POST /api/system/initialize` (Plan 01 — admin
 * creation + config save + JWT issuance + `setup_wizard_mode` flip to
 * `completed`). The wizard calls `mutateAsync`, stores `result.token`
 * in `localStorage("token")` (D-08 auto-login), and redirects to `/chat`
 * (D-09).
 */
export function useInitialize() {
  return useMutation<InitializeResponse, ApiError, InitializeInput>({
    mutationFn: (input) => apiPost<InitializeResponse>("/system/initialize", input),
  });
}

/**
 * On-demand probe for `POST /api/system/probe-llm` (Plan 01 —
 * non-blocking model listing). The wizard's "Test connection" button
 * calls `mutateAsync(input)`; `isPending` drives the spinner, and the
 * non-blocking `{ ok: false, error }` response is returned (not thrown)
 * so the wizard can show an inline error but still allow Next (D-06).
 */
export function useProbeLlm() {
  return useMutation<ProbeLlmResponse, ApiError, ProbeLlmInput>({
    mutationFn: (input) => apiPost<ProbeLlmResponse>("/system/probe-llm", input),
    // Probe results are point-in-time and should not be retried — a
    // transient failure shows the inline error and the user retries by
    // clicking "Test connection" again (D-06).
    retry: false,
  });
}

/**
 * On-demand probe for `POST /api/system/probe-vector` (Plan 01 —
 * non-blocking health check). Same manual-trigger + non-blocking
 * contract as `useProbeLlm`.
 */
export function useProbeVector() {
  return useMutation<ProbeVectorResponse, ApiError, ProbeVectorInput>({
    mutationFn: (input) => apiPost<ProbeVectorResponse>("/system/probe-vector", input),
    retry: false,
  });
}