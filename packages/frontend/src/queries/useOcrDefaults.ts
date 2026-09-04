// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hook for global OCR defaults from SystemConfig.
 */

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api";
import { queryKeys } from "./keys";

interface OcrDefaults {
  model: string;
  ocrMode: string;
  customInstructions: string;
}

export function useOcrDefaults() {
  return useQuery<OcrDefaults, Error>({
    queryKey: queryKeys.ocrJobs.defaults,
    queryFn: () => apiGet<OcrDefaults>("/ocr/defaults"),
    staleTime: 60_000,
  });
}
