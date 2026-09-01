// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for document operations.
 *
 * `useDocumentText` is the first documents query hook. The legacy
 * DocumentsPage list fetch uses direct `apiGet` + `useState` (pre-refactor)
 * and is intentionally NOT migrated here — only the read-only viewer
 * text fetch is wired through TanStack Query.
 */

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../utils/api";
import { queryKeys } from "./keys";

/**
 * Response shape of `GET /api/documents/:id/text`.
 * `filePath` is deliberately absent — the server never exposes it.
 */
export interface DocumentText {
  text: string;
  length: number;
  name: string;
  type: string;
  status: string;
}

/**
 * Fetch the concatenated chunk text for a document.
 * Mirrors `useArchivePage`: `staleTime: 30_000`, `enabled: !!documentId`.
 */
export function useDocumentText(documentId: string | undefined) {
  return useQuery<DocumentText, Error>({
    queryKey: queryKeys.documents.text(documentId ?? ""),
    queryFn: () => apiGet<DocumentText>(`/documents/${documentId}/text`),
    enabled: !!documentId,
    staleTime: 30_000,
  });
}