// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for the UploadDraft pending panel (Phase 71-04 Task 3).
 *
 * Consumed by UnifiedUploadPage + PendingDocsPanel in 71-05. The server-side
 * routes are defined in packages/server/src/routes/uploads.ts (Fase 69):
 *   GET  /api/uploads/pending?workspaceId=...  — list unassigned drafts
 *   POST /api/uploads                          — stage a file (multipart)
 *   POST /api/uploads/:id/assign               — Promise.allSettled fan-out
 *
 * D-09 conditional polling: refetchInterval returns 3_000 while any draft has
 * `parseStatus === "assigned"` OR a non-terminal `ragStatus` / `kbStatus`,
 * and `false` once every leg reaches a terminal state. The predicate is
 * exported as `hasInFlightDraft` so 71-05 + tests can invoke it directly.
 *
 * D-08 retry-only-KB: `useRetryKb` posts `{ rag: false, kb: true, archiveId }`
 * — the assign route accepts the same body shape for both initial assign and
 * KB-only retry (server side dispatchUploadDraft skips the rag leg when
 * rag=false, see uploadDraftService.ts:164-205).
 *
 * DEVIATION from plan: the plan instructs to import `UploadDraft` from
 * `@simmetric-chat/shared`, but shared does not export an `UploadDraft` type
 * (it is a Prisma model, and shared has no Prisma dependency — see
 * packages/shared/CLAUDE.md "No Business Logic"). AssignDraftInput IS
 * exported from shared. Per Rule 3 (blocking issue: missing referenced
 * type), the frontend-facing `UploadDraft` interface is defined locally
 * here, mirroring the GET /api/uploads/pending response shape documented in
 * packages/server/src/routes/uploads.ts:398-408 (filePath intentionally
 * omitted — D-06 / T-69-e).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AssignDraftInput } from "@simmetric-chat/shared";
import { apiGet, apiPost, apiPatch, apiDelete } from "./api";
import { queryKeys } from "./keys";

/**
 * Frontend-facing UploadDraft shape. Matches the JSON body returned by
 * GET /api/uploads/pending (packages/server/src/routes/uploads.ts:398-408).
 * `filePath` is deliberately absent (server strips it — D-06 / T-69-e).
 */
export interface UploadDraft {
  id: string;
  parseStatus: string; // "uploaded" | "assigned" | "done" (UPLOAD_DRAFT_STATUSES)
  originalName: string;
  fileSize: number;
  mimeType: string;
  expiresAt: string;
  ragStatus: string | null; // Document.status (pending|processing|completed|failed) | null
  kbStatus: string | null; // OcrJob.status (PENDING|PROCESSING|COMPLETED|FAILED|CANCELLED) | null
  /**
   * Phase 71-05 — assigned-leg flags + target archive. Populated by the
   * server when the draft is assigned (POST /:id/assign). `ragEnabled` /
   * `kbEnabled` drive the D-05 "Assigned to" live label; `assignedArchiveId`
   * is the retry-KB target (D-08). Optional for unassigned drafts.
   */
  ragEnabled?: boolean;
  kbEnabled?: boolean;
  assignedArchiveId?: string;
}

/** Terminal status sets — anything outside these means the leg is in-flight. */
const RAG_TERMINAL = new Set(["completed", "failed"]);
const KB_TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * D-09 conditional polling predicate. Returns true when at least one draft
 * has an in-flight leg (parseStatus "assigned" OR non-terminal ragStatus OR
 * non-terminal kbStatus). Exposed so 71-05 + tests can call it directly
 * without rendering the hook.
 */
export function hasInFlightDraft(data: UploadDraft[] | undefined): boolean {
  if (!data || data.length === 0) return false;
  return data.some(
    (d) =>
      d.parseStatus === "assigned" ||
      (d.ragStatus !== null && !RAG_TERMINAL.has(d.ragStatus)) ||
      (d.kbStatus !== null && !KB_TERMINAL.has(d.kbStatus))
  );
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/**
 * useUploadDrafts — list of unassigned drafts for a workspace.
 * Conditional polling (D-09): every 3s while any leg is in-flight, else stops.
 */
export function useUploadDrafts(workspaceId: string | undefined) {
  return useQuery<UploadDraft[], Error>({
    queryKey: queryKeys.uploadDrafts.list(workspaceId ?? ""),
    queryFn: () =>
      apiGet<UploadDraft[]>(`/uploads/pending?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const data = query.state.data as UploadDraft[] | undefined;
      return hasInFlightDraft(data) ? 3_000 : false;
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

/**
 * 260829-fty — per-leg settled status of a /assign or /retry POST, mirroring
 * serializeDraftAssign (packages/server/src/routes/uploads.ts:202-216):
 * `ragResult` / `kbResult` carry the PromiseSettledResult.status of the
 * corresponding leg ("fulfilled" | "rejected"), or null when the leg was
 * NOT requested by the call body. A 200 alongside a "rejected" leg is normal
 * (Promise.allSettled per-leg isolation) — callers must toast error, not
 * success, when a requested leg reports "rejected".
 */
export interface RetryLegsResponse {
  id: string;
  parseStatus: string;
  ragResult: "fulfilled" | "rejected" | null;
  kbResult: "fulfilled" | "rejected" | null;
}

/**
 * useStageUpload — multipart POST /api/uploads. Uses raw fetch (NOT apiPost)
 * because the browser must set the multipart Content-Type boundary itself.
 * Mirrors the useOcrJobs:84-107 pattern.
 */
export function useStageUpload() {
  const queryClient = useQueryClient();

  return useMutation<
    UploadDraft,
    Error,
    { formData: FormData; workspaceId: string }
  >({
    mutationFn: async ({ formData }) => {
      const token = localStorage.getItem("token");
      const response = await fetch(`/api/uploads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }
      return response.json() as Promise<UploadDraft>;
    },
    onSuccess: (_data, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.uploadDrafts.list(workspaceId),
      });
    },
  });
}

/**
 * useAssignDraft — POST /api/uploads/:id/assign with the assignDraftSchema
 * body shape ({ rag, kb, archiveId? }). On success invalidates the pending
 * list so the assigned draft disappears from the panel.
 *
 * Toast wiring is left to 71-05's mutation call site — the hook just throws
 * on error. This keeps the hook reusable across different toast strategies.
 */
export function useAssignDraft(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    unknown,
    Error,
    { id: string; body: AssignDraftInput }
  >({
    mutationFn: ({ id, body }) => apiPost(`/uploads/${id}/assign`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.uploadDrafts.list(workspaceId),
      });
    },
  });
}

/**
 * useRetryKb — D-08 retry-only-KB. Posts the body
 * `{ rag: false, kb: true, archiveId }` to the dedicated /retry endpoint
 * (D-01 — no 409 terminal-state gate, unlike /assign). The server
 * re-dispatches the KB leg via dispatchUploadDraft (which skips the RAG
 * leg when rag=false). The external signature is unchanged from the
 * pre-redirect /assign version — PendingDocsPanel's handleRetryKb call
 * site stays identical.
 */
export function useRetryKb(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<RetryLegsResponse, Error, { id: string; archiveId: string }>({
    mutationFn: ({ id, archiveId }) =>
      apiPost(`/uploads/${id}/retry`, {
        rag: false,
        kb: true,
        archiveId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.uploadDrafts.list(workspaceId),
      });
    },
  });
}

/**
 * useRetryRag — D-02 retry-RAG. Posts `{ rag: true, kb: false }` to the
 * /retry endpoint. The server soft-deletes the old Document (if any) and
 * re-dispatches the RAG leg — no parseStatus gate (D-01).
 */
export function useRetryRag(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<RetryLegsResponse, Error, { id: string }>({
    mutationFn: ({ id }) =>
      apiPost(`/uploads/${id}/retry`, { rag: true, kb: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.uploadDrafts.list(workspaceId),
      });
    },
  });
}

/**
 * useRetryBoth — D-02 retry both legs. Posts
 * `{ rag: true, kb: true, archiveId }` to the /retry endpoint.
 */
export function useRetryBoth(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<RetryLegsResponse, Error, { id: string; archiveId: string }>({
    mutationFn: ({ id, archiveId }) =>
      apiPost(`/uploads/${id}/retry`, { rag: true, kb: true, archiveId }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.uploadDrafts.list(workspaceId),
      });
    },
  });
}

/**
 * useStageUploadUrl — D-17 URL ingest stage mutation. Posts a JSON body
 * {sourceType:"url", url, archiveId, ocrMode, workspaceId} to /api/uploads
 * (NO FormData, NO multipart — the server stage route branches on
 * sourceType==="url" and validates with createUploadDraftUrlSchema from
 * 71-02). On success invalidates the pending list so the new URL draft
 * appears + D-09 polling picks up its in-flight KB status.
 */
export function useStageUploadUrl() {
  const queryClient = useQueryClient();

  return useMutation<
    UploadDraft,
    Error,
    {
      sourceType: "url";
      url: string;
      archiveId: string;
      ocrMode?: string;
      workspaceId: string;
    }
  >({
    mutationFn: (vars) => apiPost<UploadDraft>("/uploads", vars),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.uploadDrafts.list(vars.workspaceId),
      });
    },
  });
}

/**
 * useDeleteDraft — DELETE /api/uploads/:id (Phase 76-02). On success
 * invalidates the pending list so the deleted draft disappears from the
 * panel without a manual refresh. Mirrors the useAssignDraft/useRetryKb
 * invalidation pattern (no optimistic setQueryData — the 3s poll would
 * race with an optimistic edit).
 *
 * Toast/error handling is left to the 76-03 call site (handleBulkDeleteConfirm
 * per-draft try/catch), matching the useAssignDraft convention.
 */
export function useDeleteDraft(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<{ message: string }, Error, { id: string }>({
    mutationFn: ({ id }) => apiDelete<{ message: string }>(`/uploads/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.uploadDrafts.list(workspaceId),
      });
    },
  });
}

/**
 * useRenameDraft — PATCH /api/uploads/:id body { originalName } (Phase
 * 76-02). On success invalidates the pending list so the new name persists
 * across reloads. Mirrors the useRenameSynthesisRun apiPatch + invalidate
 * pattern. D-07: rename is non-destructive and allowed in every state.
 *
 * The return type is the minimal { id, originalName } shape (no filePath —
 * T-76-04b mitigation); the client refetches the full list via invalidation.
 */
export function useRenameDraft(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    { id: string; originalName: string },
    Error,
    { id: string; originalName: string }
  >({
    mutationFn: ({ id, originalName }) =>
      apiPatch(`/uploads/${id}`, { originalName }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.uploadDrafts.list(workspaceId),
      });
    },
  });
}