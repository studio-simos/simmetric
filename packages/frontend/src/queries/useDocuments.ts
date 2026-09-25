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
 *
 * Phase 192 (D-10): `useDocumentText(documentId, unmask?)` gains the
 * per-view unmask variant + the placeholder-token probe helpers used by
 * the DocumentViewerPage toggle/notice (UI-SPEC surface 2).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "../utils/api";

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
 * Phase 192 (D-10): placeholder-token probe — a lightweight inline tokenizer
 * that counts bracketed entity placeholders (`[PERSON_1]`, `[GOV_ID_2]`, …)
 * in served text. This is the zero-contract-change entity signal: the server
 * response shape stays `{ text, length, name, type, status }` (plan 04) and
 * the presence of placeholder tokens IS server truth that entities exist
 * (the masker writes them; masking is idempotent, D-03 — no regex on the
 * original values, only on the placeholder syntax).
 */
const DLP_PLACEHOLDER_REGEX = /\[\s*[A-Z][A-Z_]*\s*_\s*\d+\s*\]/;

export function hasDlpPlaceholders(text: string | undefined): boolean {
  return typeof text === "string" && DLP_PLACEHOLDER_REGEX.test(text);
}

/**
 * Fetch the concatenated chunk text for a document.
 * Mirrors `useArchivePage`: `staleTime: 30_000`, `enabled: !!documentId`.
 *
 * Phase 192 (D-10): the optional `unmask` param selects the variant —
 * queryKey gains the flag so the masked and unmasked texts cache under
 * separate entries; `queryFn` appends `?unmask=true` ONLY when unmask.
 * The DEFAULT (no arg) fetch is the masked text. The server remains the
 * gate (the unmask arm re-checks permission + workspace toggle); the
 * flag only requests the variant.
 */
export function useDocumentText(documentId: string | undefined, unmask = false) {
  return useQuery<DocumentText, Error>({
    queryKey: ["documents", "text", documentId ?? "", unmask] as const,
    queryFn: () =>
      apiGet<DocumentText>(
        unmask ? `/documents/${documentId}/text?unmask=true` : `/documents/${documentId}/text`,
      ),
    enabled: !!documentId,
    staleTime: 30_000,
  });
}

/**
 * Phase 204 (DEBT-SW-05, FEAT-01) — PUT /documents/:documentId/text mutation.
 *
 * Mirrors `useUpdatePage` (useArchives.ts): apiPut + targeted invalidation in
 * onSuccess. The server answers 202 { documentId, status: "reindexing" } and
 * re-indexes asynchronously via the collector callback; invalidating the
 * document text prefix (["documents", "text", documentId]) covers BOTH the
 * masked and unmask query variants, and the list-key invalidation refreshes
 * the doc-list status badges (the row flips pending → processing → completed
 * while the existing 30s polling surface renders the async completion).
 */
export function useUpdateDocumentText() {
  const queryClient = useQueryClient();

  return useMutation<
    { documentId: string; status: string },
    Error,
    { documentId: string; body: string }
  >({
    mutationFn: ({ documentId, body }) =>
      apiPut<{ documentId: string; status: string }>(`/documents/${documentId}/text`, { body }),
    onSuccess: (_, { documentId }) => {
      queryClient.invalidateQueries({ queryKey: ["documents", "text", documentId] });
      queryClient.invalidateQueries({ queryKey: ["documents", "list"] });
    },
  });
}