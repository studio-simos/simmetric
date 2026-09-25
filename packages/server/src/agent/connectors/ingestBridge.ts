// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Connector ingest bridge (Phase 196, MCPO-04 D-06) —
 * the server-side Document-row-first collector multipart bridge shared by
 * `gdrive_ingest` and `graph_onedrive_ingest`.
 *
 * Contract (verbatim from the proven dispatch shapes):
 * - documents.ts:504-517 — prisma.document.create (status "pending") BEFORE
 *   dispatch (Pitfall 3: the collector's notifyServerStatus PUTs
 *   /api/documents/:id/status, which must find the row — without the row the
 *   file lands in LanceDB yet stays invisible in Documents and unqueryable
 *   via rag_search's FTS half).
 * - documents.ts:1340-1412 / builtinSkills.ts:505-551 — multipart POST
 *   `${COLLECTOR_URL}/api/ingest` with the X-Collector-Secret header, the
 *   COLLECTOR_INGEST_TIMEOUT_MS operator cap (unset = unbounded), the
 *   timeout-exempt `collectorDispatchAgent` (undici v7 pairing rule —
 *   FormData+fetch, never hand-built multipart bytes), and the
 *   "Collector ingest timed out after Ns — raise COLLECTOR_INGEST_TIMEOUT_MS"
 *   timeout message convention.
 * - workspaceName is resolved SERVER-SIDE from the workspace row (Pitfall 2:
 *   the collector's buildCollectionName needs it or vectors land in
 *   ws_<fullUuid> while rag_search reads ws_<sanitized>_<shortId> — the
 *   silent-citation-miss bug). NEVER trust LLM input for it.
 *
 * FTS chunks are NOT written here — the collector rides the SAME status
 * callback + server-side completion write as uploads (the dispatch response's
 * chunkCount is surfaced for the SkillResult only). Dispatch, return, let the
 * callback finish the row.
 *
 * Idempotency truth (MCPO-04): re-ingesting the same file creates a NEW
 * Document row — the cacheKey column is @unique, so it carries the run
 * suffix `connector-<provider>-<fileId>-<Date.now()>`; each run resolves its
 * own token, creates its own row, and dispatches independently.
 */

import prisma from "../../utils/prisma";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { collectorDispatchAgent } from "../../utils/collectorDispatchAgent";

/** Provider byte source of the ingest (registry provider ids). */
type ConnectorIngestProvider = "google" | "microsoft";

/**
 * Collector-side client cap (T-196-07, DoS): refuse dispatches whose byte
 * payload exceeds this BEFORE the multipart POST. Mirrors the collector's
 * ingest.ts upload-limit posture — the collector would 413 the dispatch
 * anyway, but the bytes must never be downloaded+held for a file that can
 * never be processed.
 */
export const CONNECTOR_INGEST_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

export interface CreateAndDispatchConnectorDocumentParams {
  workspaceId: string;
  /** File name (already provider-sourced metadata — not raw LLM text). */
  fileName: string;
  fileBytes: Buffer;
  fileId: string;
  provider: ConnectorIngestProvider;
  /** Document.type value (pdf|md|txt|csv|docx|xlsx|…). */
  docType: string;
  embeddingModel: string;
}

export type ConnectorIngestOutcome =
  | { ok: true; documentId: string; chunkCount: number }
  | { ok: false; error: string };

/**
 * Create the workspace-KB Document row (status pending) and dispatch the
 * downloaded provider bytes to the collector's POST /api/ingest with the
 * exact proven multipart contract. Structured outcome — never throws past
 * the skill surface (Pattern 3).
 *
 * The Document row MUST exist before dispatch (Pitfall 3). `filePath` is the
 * non-nullable String column (schema-verified), so it gets the "" no-op
 * value — NEVER undefined: the terminal-callback unlink arm in
 * documents.ts:243-250 guards on `document.filePath &&` (+ isDraftsPath),
 * so an empty path short-circuits to a no-op. The cacheKey carries the run
 * suffix because the column is @unique — re-ingesting the same file without
 * it would violate the constraint on the second create.
 */
export async function createAndDispatchConnectorDocument(
  params: CreateAndDispatchConnectorDocumentParams,
): Promise<ConnectorIngestOutcome> {
  const { workspaceId, fileName, fileBytes, fileId, provider, docType, embeddingModel } = params;

  // Size cap BEFORE any row write (T-196-07) — a too-large download must not
  // leave a pending row behind that the collector would then fail.
  if (fileBytes.byteLength > CONNECTOR_INGEST_MAX_BYTES) {
    return {
      ok: false,
      error: `File is too large to ingest (${Math.round(fileBytes.byteLength / (1024 * 1024))} MB — the ingest limit is ${CONNECTOR_INGEST_MAX_BYTES / (1024 * 1024)} MB)`,
    };
  }

  // Resolve workspace NAME server-side (Pitfall 2 — never trust LLM input).
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });
  if (!workspace) {
    return { ok: false, error: "Workspace not found" };
  }
  const workspaceName = workspace.name;

  // The Document row BEFORE dispatch (Pitfall 3): the collector's completion
  // callback PUTs /api/documents/:id/status — without the row it 404s
  // harmlessly, the file never appears in Documents, and rag_search's FTS
  // half stays empty. filePath "" is the unlink-arm no-op (see above);
  // storageKey null (provider bytes are not in server storage); cacheKey
  // carries the run suffix against the @unique collision.
  const document = await prisma.document.create({
    data: {
      workspaceId,
      name: fileName,
      type: docType,
      filePath: "", // non-nullable column; unlink arm guards on existence — no-op (documents.ts:243-250)
      storageKey: null,
      cacheKey: `connector-${provider}-${fileId}-${Date.now()}`,
      chunkCount: 0,
      embeddingModel,
      status: "pending",
      fileSize: fileBytes.byteLength,
    },
  });

  try {
    const env = getEnv();

    const blob = new Blob([fileBytes as unknown as BlobPart]);
    const formData = new FormData();
    formData.append("file", blob, fileName);
    formData.append("documentId", document.id);
    formData.append("workspaceId", workspaceId);
    formData.append("workspaceName", workspaceName);
    formData.append("embeddingModel", embeddingModel);
    formData.append("docType", docType);

    // Same operator OPT-IN wait cap as forwardToCollector/document_temp_process
    // (quick 260918-gxs D-1): UNSET = unbounded dispatch.
    const ingestTimeoutMs = env.COLLECTOR_INGEST_TIMEOUT_MS;
    const capConfigured = typeof ingestTimeoutMs === "number" && ingestTimeoutMs > 0;
    const controller = new AbortController();
    const timeoutId = capConfigured
      ? setTimeout(() => controller.abort(), ingestTimeoutMs)
      : null;

    let response: Response;
    try {
      logger.info(
        `[connectors] Dispatching to collector: provider=${provider} id=${document.id} name="${fileName}" bytes=${fileBytes.byteLength} timeoutMs=${capConfigured ? ingestTimeoutMs : "unlimited"}`,
      );
      response = await fetch(`${env.COLLECTOR_URL}/api/ingest`, {
        method: "POST",
        body: formData,
        ...(capConfigured ? { signal: controller.signal } : {}),
        headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
        // Timeout-exempt dispatcher (undici v7 pairing — collectorDispatchAgent
        // upgrade rule): long local-CPU embeds must not die at the global 300s
        // headersTimeout; the operator cap above stays armed.
        dispatcher: collectorDispatchAgent,
      } as unknown as Parameters<typeof fetch>[1]);
    } catch (fetchErr: unknown) {
      if (controller.signal.aborted) {
        const cappedTimeoutMs = ingestTimeoutMs as number;
        throw new Error(
          `Collector ingest timed out after ${Math.round(cappedTimeoutMs / 1000)}s — raise COLLECTOR_INGEST_TIMEOUT_MS or retry the ingest`,
          { cause: fetchErr },
        );
      }
      throw fetchErr;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(
        `Collector error (${response.status}): ${errorData.error}${errorData.details ? ` — ${errorData.details}` : ""}`,
      );
    }

    // chunkCount surfaces for the SkillResult only — the FTS chunk write is
    // the collector callback + forwardToCollector contract; connector docs
    // ride the SAME status callback (no duplicate FTS write here).
    const data = (await response.json()) as { chunkCount?: number; chunks?: number };
    const chunkCount = data.chunkCount ?? data.chunks ?? 0;

    return { ok: true, documentId: document.id, chunkCount };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // WR-04: a dispatch failure (timeout, collector 4xx/5xx, network error)
    // must not orphan the pre-created pending row forever — the collector
    // never calls back for it, so it would rest at "pending" indefinitely
    // (permanently "processing" in Documents, fileSize/cacheKey occupied,
    // no retry handle since each retry mints a NEW run-suffixed row).
    // Transition to the terminal failed state + statusMessage before the
    // structured error returns; best-effort (a row-write failure here must
    // not mask the dispatch error the skill surface needs).
    try {
      await prisma.document.update({
        where: { id: document.id },
        data: { status: "failed", statusMessage: message },
      });
    } catch {
      // best-effort: the structured dispatch error below is the surface
      // contract; the failed-marker write failing (row deleted mid-flight,
      // transient DB outage) must not mask it.
    }
    logger.error("[connectors] Connector ingest dispatch failed", {
      documentId: document.id,
      provider,
      error: message,
    });
    return { ok: false, error: `Ingest failed: ${message}` };
  }
}