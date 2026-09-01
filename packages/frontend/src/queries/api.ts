// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// STATE: TanStack Query — re-exports REST API utilities (server state tier)
/**
 * Re-export API utilities for use inside query functions.
 * This keeps the queries directory self-contained while
 * reusing the existing fetch wrappers in src/utils/api.ts.
 */

export { apiGet, apiPost, apiPut, apiPatch, apiDelete, apiUpload, apiFetch, ApiError } from "../utils/api";
