// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-01, D-05 client half): the personal-workspace creation
 * mutation behind the OnboardingWizard. On success the invalidations make
 * the App empty-state gate re-render past the wizard:
 *  - queryKeys.workspaces.all refetch → the new workspace lands in the list
 *    (workspaces.length flips 0 → 1);
 *  - queryKeys.auth.me refetch → hasOnboarded=true observed (Pitfall 4
 *    client half — the server's invalidateAuthCache is the Redis half).
 * No workspace-role cache anywhere (Pitfall 9).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost } from "../utils/api";
import { queryKeys } from "./keys";

export interface CreatePersonalWorkspaceResult {
  workspace: { id: string; name: string; projectId: string };
  hasOnboarded: boolean;
}

export function useCreatePersonalWorkspace() {
  const queryClient = useQueryClient();

  return useMutation<CreatePersonalWorkspaceResult, Error, { workspaceName: string }>({
    mutationFn: ({ workspaceName }) =>
      apiPost<CreatePersonalWorkspaceResult>("/users/me/personal-workspace", { workspaceName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      // Pitfall 4 client half: /auth/me must re-serve the flipped flag or
      // the wizard re-shows after refresh.
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.me });
    },
  });
}