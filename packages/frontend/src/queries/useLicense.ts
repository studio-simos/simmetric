// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for license domain.
 */

import { useQuery } from "@tanstack/react-query";
import { apiGet, ApiError } from "./api";
import { queryKeys } from "./keys";
import type { LicenseInfo } from "@simmetric-chat/shared";

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useLicenseInfo(enabled = true) {
  return useQuery<LicenseInfo, ApiError>({
    queryKey: queryKeys.license.info,
    queryFn: () => apiGet<LicenseInfo>("/license/info"),
    enabled,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
