// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for OCR model catalog and prompt preview.
 */

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api";
import { queryKeys } from "./keys";
import type { OcrModelConfig } from "@simmetric-chat/shared";

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useOcrModels() {
  return useQuery<OcrModelConfig[], Error>({
    queryKey: queryKeys.ocrJobs.models,
    queryFn: () => apiGet<OcrModelConfig[]>("/ocr/models"),
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

// Phase 180 dead-code sweep: useOcrPreview() was REMOVED — zero callers
// (its only consumer, the OcrPromptPreview component, was itself dead and
// removed in the same sweep; the /ocr/preview server route stays).
