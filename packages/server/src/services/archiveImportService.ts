// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KB-05 / KB-06 archive import pipeline (D-01, D-02, D-03, D-04, D-05).
 *
 * Two entry points feed the same async parse pipeline:
 *
 *   1. KB-05 copy-from-doc — a document already in the platform is copied into
 *      an archive as a single ArchivePage (1 doc → 1 page, no chunking, D-02).
 *      The server dispatches the source document to the collector for
 *      parse-only extraction via HTTP POST /api/ingest/archive-page with
 *      COLLECTOR_SECRET (D-03 — mirrors OcrJob; CLAUDE.md HTTP-only boundary).
 *
 *   2. KB-06 upload — an md/xlsx/docx/pptx file uploaded by the user is
 *      parsed by the collector (reusing the existing parseFile, D-05) and the
 *      extracted text becomes the bodyText of a new ArchivePage.
 *
 * The collector callbacks PUT /api/archives/import/:jobId/callback with
 * { status, extractedText, title, error }. On "completed", the server calls
 * archivePageService.createPage (Plan 03 D-12 UUID/placeholder reject applies)
 * with title=filename (D-02) and category="entities". On "failed", the
 * ArchiveImportJob is flipped to FAILED and no page is created.
 *
 * RBAC (T-64-18 IDOR fix, D-04): the route enforces `archive:write` on the
 * destination archive via requirePermission, AND `document:read` on the source
 * document via assertDocumentReadAccess — a server-side helper mirroring the
 * Phase 61 DOC-01 pattern (documents.ts:380-393). Applies to ALL users including
 * admins (semantic variation of requireWorkspaceAccess). The batch path fails
 * closed: if ANY documentId is inaccessible, the whole batch is 403'd with no
 * partial dispatch.
 */

import axios from "axios";
import matter from "gray-matter";
import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { createPage } from "./archivePageService";
import { logEvent } from "./eventLogService";

/**
 * Reconstruct a document's extracted text from its persisted chunks, ordered
 * by chunkIndex. Mirrors `GET /api/documents/:id/text` (documents.ts:437-442):
 * chunkIndex is NOT a Prisma column — it is encoded as the trailing segment
 * of `chunk.id` (`${documentId}-${chunkIndex}`), so we sort client-side by
 * parsing that trailing segment and join the chunks with blank-line separators.
 *
 * KB-05 copy-from-doc uses this instead of re-dispatching the source file to
 * the collector: the document is already parsed and chunked at ingestion
 * time, so its chunks ARE the source-of-truth extracted text. Re-reading the
 * file from disk would reproduce the identical text already in chunks while
 * depending on the file being present — which it is NOT for draft-origin
 * documents (Phase 69 unified upload) whose staged file is reaped by
 * `uploadDraftReaperJob`. Reconstructing from chunks works uniformly for
 * legacy (UUID-named, file on disk) and draft-origin (file reaped) documents.
 */
function reconstructDocumentText(chunks: { id: string; chunkText: string }[]): string {
  const sorted = [...chunks].sort((a, b) => {
    const idxA = parseInt(a.id.split("-").pop()!, 10);
    const idxB = parseInt(b.id.split("-").pop()!, 10);
    return idxA - idxB;
  });
  return sorted.map((c) => c.chunkText).join("\n\n");
}

/**
 * Dispatch a single copy-from-doc job. Creates the ArchiveImportJob row first
 * (status=PROCESSING) so the pipeline is observable, then fire-and-forgets the
 * text reconstruction + page creation: the source Document's extracted text is
 * reconstructed from its persisted `DocumentChunk` rows and fed directly to
 * `handleArchiveImportCallback`, which creates the ArchivePage (with the
 * `Fonti: [[doc:<documentId>]]` citation) — NO collector round-trip.
 *
 * Why no collector (revision of the earlier multipart fix): KB-05 copies a
 * document that is ALREADY ingested and chunked. Re-parsing its source file
 * would reproduce the identical text already stored in chunks, while
 * depending on the file being on disk — which it is not for draft-origin
 * documents whose staged file is reaped by `uploadDraftReaperJob` (Phase 69).
 * Reconstructing from chunks is robust for every document type.
 *
 * Fire-and-forget contract preserved: the route returns 202 based on `jobId`
 * immediately; the background IIFE flips the job to COMPLETED or FAILED, and
 * the frontend polls the job row. The function NEVER throws on validation
 * failures (missing/soft-deleted Document, no chunks) — those flip the job to
 * FAILED so the user sees a terminal state instead of a stuck PROCESSING.
 */
export async function dispatchCopyDocToArchive(params: {
  archiveId: string;
  documentId: string;
  userId: string;
  sourceFileName?: string;
}): Promise<{ jobId: string }> {
  const job = await prisma.archiveImportJob.create({
    data: {
      archiveId: params.archiveId,
      documentId: params.documentId,
      status: "PROCESSING",
      sourceFileName: params.sourceFileName ?? null,
      createdBy: params.userId,
    },
  });

  // Fire-and-forget — not awaited by the caller. The route returns 202
  // immediately; the frontend polls the job row for COMPLETED/FAILED.
  void (async () => {
    try {
      // findFirst — findUnique cannot apply the `deletedAt: null` soft-delete
      // filter to a non-unique compound (per server CLAUDE.md).
      const document = await prisma.document.findFirst({
        where: { id: params.documentId, deletedAt: null },
        include: { chunks: true },
      });
      if (!document) {
        logger.error("[archiveImport] copy-doc source document missing", {
          jobId: job.id,
          documentId: params.documentId,
        });
        await prisma.archiveImportJob.update({
          where: { id: job.id },
          data: { status: "FAILED", error: "Source document not found: " + params.documentId },
        });
        return;
      }

      const extractedText = reconstructDocumentText(document.chunks);
      if (!extractedText.trim()) {
        // No chunks yet (still processing / failed ingestion) or an
        // image-only PDF that was never OCR'd → nothing to copy.
        logger.error("[archiveImport] copy-doc has no extracted text", {
          jobId: job.id,
          documentId: params.documentId,
          chunkCount: document.chunks.length,
        });
        await prisma.archiveImportJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            error:
              "The document has no extracted text to copy (it may still be processing, have failed ingestion, or be an image-only PDF that was not OCR'd).",
          },
        });
        return;
      }

      // Reuse the collector-callback path: it composes the `Fonti` frontmatter
      // (job.documentId set → `[[doc:<documentId>]]`) and creates the page via
      // createPage with all Plan 03 invariants (D-10/D-12, git commit, event log).
      await handleArchiveImportCallback(job.id, {
        status: "completed",
        extractedText,
        title: document.name,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[archiveImport] copy-doc failed", { jobId: job.id, error: message });
      prisma.archiveImportJob
        .update({
          where: { id: job.id },
          data: { status: "FAILED", error: "Copy failed: " + message },
        })
        .catch(() => {
          /* best-effort — job stays PROCESSING if DB update fails */
        });
    }
  })();

  return { jobId: job.id };
}

/**
 * Dispatch an uploaded file (KB-06) to the collector for parse-only
 * extraction. The file is sent as multipart form data along with
 * { jobId, archiveId } form fields. No documentId — the upload has no
 * source document in the platform (D-03 ArchiveImportJob.documentId is
 * null for the upload path).
 *
 * 71-02 WARNING 3.1 locked refactor: optional `preExistingJobId` param.
 * When provided, skip the internal `prisma.archiveImportJob.create` and
 * reuse the pre-created row (set by `dispatchKbLeg` for both OCR + non-OCR
 * branches — Pitfall 4 AIJ-first). When undefined, create a new AIJ
 * (existing behavior for direct archiveImport callers).
 */
export async function dispatchUploadToArchive(params: {
  archiveId: string;
  userId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  preExistingJobId?: string;
}): Promise<{ jobId: string }> {
  let jobId: string;
  if (params.preExistingJobId) {
    // AIJ was pre-created by the caller (dispatchKbLeg Pitfall 4) — reuse it.
    jobId = params.preExistingJobId;
  } else {
    const job = await prisma.archiveImportJob.create({
      data: {
        archiveId: params.archiveId,
        documentId: null,
        status: "PROCESSING",
        sourceFileName: params.fileName,
        createdBy: params.userId,
      },
    });
    jobId = job.id;
  }

  const env = getEnv();
  // Build the multipart body manually — the form-data npm module uses a
  // CJS require that breaks under pnpm strict isolation in the server
  // image; instead we use the built-in Buffer concat to construct the
  // multipart body bytes directly. The X-Collector-Secret header
  // authenticates the boundary.
  const boundary = `----simmetricFormBoundary${Date.now()}`;
  const parts: Buffer[] = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="jobId"\r\n\r\n${jobId}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archiveId"\r\n\r\n${params.archiveId}\r\n`));
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${params.fileName}"\r\nContent-Type: ${params.mimeType}\r\n\r\n`,
    ),
  );
  parts.push(params.fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const bodyBuffer = Buffer.concat(parts);

  axios
    .post(`${env.COLLECTOR_URL}/api/ingest/archive-page`, bodyBuffer, {
      timeout: 30000,
      headers: {
        "X-Collector-Secret": env.COLLECTOR_SECRET,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(bodyBuffer.length),
      },
    })
    .then((res) => {
      logger.info("[archiveImport] collector upload dispatch ok", {
        jobId,
        status: res.status,
      });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[archiveImport] collector upload dispatch failed", {
        jobId,
        error: message,
      });
      prisma.archiveImportJob
        .update({
          where: { id: jobId },
          data: { status: "FAILED", error: "Collector dispatch failed: " + message },
        })
        .catch(() => {
          /* best-effort */
        });
    });

  return { jobId };
}

/**
 * Handle the collector's parse-result callback. On "completed" the
 * extracted text becomes the bodyText of a new ArchivePage via
 * archivePageService.createPage (Plan 03 D-12 UUID/placeholder reject applies
 * to the title). On "failed" the job is flipped to FAILED and no page is
 * created. The title defaults to the callback-supplied title, then the
 * job's sourceFileName, then "Untitled" — createPage D-10 derivation kicks in
 * if the resolved title is a UUID/placeholder/empty (Plan 03 D-12).
 */
export async function handleArchiveImportCallback(
  jobId: string,
  body: {
    status: "completed" | "failed";
    extractedText?: string;
    title?: string;
    error?: string;
  },
): Promise<void> {
  const job = await prisma.archiveImportJob.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new Error("ArchiveImportJob not found: " + jobId);
  }

  if (body.status === "failed") {
    await prisma.archiveImportJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: body.error ?? "Parse failed (no error message)" },
    });
    logger.warn("[archiveImport] callback marked job FAILED", {
      jobId,
      error: body.error,
    });

    // Push notification: KB import failed
    import("../routes/push")
      .then(({ sendPushNotification }) =>
        sendPushNotification(
          "Errore importazione documento",
          `"${job.sourceFileName}" non è stato importato: ${body.error ?? "errore sconosciuto"}`,
          job.createdBy,
          "/uploads",
        ).catch(() => {}),
      )
      .catch(() => {});
    return;
  }

  // Completed — create the ArchivePage via the existing service so all of
  // Plan 03's invariants (D-10 derive-on-omit, D-12 UUID/placeholder reject,
  // path-traversal guard, git commit, event log) apply uniformly.
  //
  // Phase 79-03 D-06 / WIKI-01: compose a `Fonti` frontmatter citation
  // before calling createPage. createPage takes a FULL .md string (it
  // parses with gray-matter internally — RESEARCH Pitfall 3), so we use
  // matter.stringify to compose frontmatter + body (F77 D-04 landmine:
  // never string-concatenate frontmatter).
  //   - copy-from-doc (job.documentId set) cites [[doc:<documentId>]]
  //     (platform Document reference — WIKI-01 allows piattaforma doc ref)
  //   - upload (job.documentId null) cites [[raw_sources/<sourceFileName>]]
  //     The upload import path does NOT persist raw files to raw_sources/,
  //     so this wikilink is a redlink by design — documented divergence
  //     for 79-05 (do NOT "fix" by writing raw files here).
  const resolvedTitle = body.title || job.sourceFileName || "Untitled";
  const fontiValue = job.documentId
    ? [`[[doc:${job.documentId}]]`]
    : [`[[raw_sources/${job.sourceFileName}]]`];
  const content = matter.stringify(body.extractedText ?? "", { Fonti: fontiValue });
  const page = await createPage(
    job.archiveId,
    {
      title: resolvedTitle,
      content,
      category: "entities",
    },
    job.createdBy,
  );

  await prisma.archiveImportJob.update({
    where: { id: jobId },
    data: { status: "COMPLETED", result: { title: page.title, pageId: page.id } as Prisma.InputJsonValue },
  });

  logEvent("archive_import", jobId, "archive_import.completed", job.createdBy, {
    archiveId: job.archiveId,
    title: page.title,
    pageId: page.id,
  }).catch(() => {
    /* best-effort event log */
  });

  // Push notification: KB document imported
  import("../routes/push")
    .then(({ sendPushNotification }) =>
      sendPushNotification(
        "Documento aggiunto al knowledge base",
        `"${page.title}" è stato importato con successo`,
        job.createdBy,
        "/knowledge-base",
      ).catch(() => {}),
    )
    .catch(() => {});
}

/**
 * B1 IDOR fix (D-04, T-64-18). Mirrors the Phase 61 DOC-01 access check from
 * `packages/server/src/routes/documents.ts:380-393`. Verifies the user has
 * document:read on the source document BEFORE the route dispatches the
 * copy-from-doc job. Applies to ALL users including admins (semantic
 * variation of requireWorkspaceAccess — admin requires workspace access here,
 * mirroring the existing documents.ts gate).
 *
 * Throws:
 *   - "Document not found: <id>"    → caller maps to 404
 *   - "Access denied to this document" → caller maps to 403
 *
 * Exported so the route can call it for both single and batch paths.
 */
export async function assertDocumentReadAccess(
  documentId: string,
  userId: string,
): Promise<void> {
  const document = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    include: { workspace: { include: { project: true } } },
  });

  if (!document) {
    throw new Error("Document not found: " + documentId);
  }

  const isProjectOwner = document.workspace?.project?.createdBy === userId;
  const hasWorkspaceAccess = await prisma.workspaceAccess.findFirst({
    where: { userId, workspaceId: document.workspaceId },
  });
  const hasProjectAccess = await prisma.projectAccess.findFirst({
    where: { userId, projectId: document.workspace?.projectId },
  });

  if (!isProjectOwner && !hasWorkspaceAccess && !hasProjectAccess) {
    throw new Error("Access denied to this document");
  }
}