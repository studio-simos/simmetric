// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../queries/api";
import { useMe } from "../queries/useAuth";

export interface EnterpriseModulesResult {
  enterpriseInstalled: boolean;
  modules: string[];
}

/**
 * Phase 147 (EPA-11 — D-06): TanStack Query hook for the enterprise
 * modules manifest. Calls `GET /api/enterprise/modules`, AUTH-GATED and
 * session-reactive (quick 260831-nzf).
 *
 * - 200 → `{ modules: string[] }` → `enterpriseInstalled: true`
 * - 404 (community build — no enterprise plugin mounted) → `enterpriseInstalled: false`
 * - any other error → `enterpriseInstalled: false` (safe degraded state)
 *
 * Auth gating (quick 260831-nzf): the query is disabled until a session
 * exists — `hasSession = !!me || !!localStorage.getItem("token")`. The
 * `useMe()` subscription is the reactive session signal: password login
 * (`useLogin.onSuccess` writes the me cache via `setQueryData`), the SSO
 * `?token=` handoff (token stored → App re-renders → `useMe(hasToken)`
 * refetches → me-data lands in the cache), and logout
 * (`queryClient.clear()` wipes it → degraded state) all flip
 * `hasSession`, and TanStack refetches the manifest when `enabled`
 * flips false→true. The localStorage fallback lets the manifest fetch
 * start at boot in parallel with `/auth/me` on a page reload WITH a
 * stored token — no request waterfall, and no unauthenticated 401 probe
 * on the login screen.
 *
 * `retry: false` — a 404 WITH a token is the expected community state;
 * retrying won't help. `staleTime: Infinity` — the manifest is static
 * for the session. The hook is called ONCE at the app root (inside
 * `EnterpriseModulesProvider` in `main.tsx`) and the result is exposed
 * via `EnterpriseModulesContext` to avoid repeated fetches; because the
 * provider sits ABOVE `App`, the `useMe()` subscription inside this hook
 * is what makes it re-render on auth transitions.
 */
export function useEnterpriseModules(): EnterpriseModulesResult {
  const { data: me } = useMe();
  const hasSession = !!me || !!localStorage.getItem("token");
  const query = useQuery({
    queryKey: ["enterprise-modules"],
    queryFn: () => apiGet<{ modules: string[] }>("/enterprise/modules"),
    enabled: hasSession,
    retry: false,
    staleTime: Infinity,
  });

  if (query.isSuccess) {
    return { enterpriseInstalled: true, modules: query.data.modules };
  }
  // 404 (community — no enterprise plugin) or any error → not installed.
  return { enterpriseInstalled: false, modules: [] };
}