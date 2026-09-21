// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Masked-chunk persistence + re-embed (Phase 192 plan 02 — D-06/D-07).
 *
 * Order contract (MASK_UPDATE_SQL comment constant below): mask-in-DB →
 * reembed → entity rows. The retry converges because masking is idempotent
 * (mask∘mask = mask, D-03) and the collector reembed is delete-then-write.
 *
 * Trust boundary (T-192-05): the raw-SQL UPDATE bypasses tenantScope by
 * construction — the write targets a documentId resolved through an
 * org-asserted withSoftDelete scoped findFirst upstream (dlpDocumentService
 * scanDocument), the documents.ts:1379-1385 $queryRaw-site disposition
 * precedent. Chunk ids resolved from that SAME scoped read.
 *
 * The ORIGINAL unmasked text is never re-embedded (D-07): the reembed
 * payload carries ONLY the masked chunkText.
 */
import prisma from "../utils/prisma";
import { Prisma } from "@prisma/client";
import { MULTI_CONFIG_TSVECTOR } from "./ftsService";
import { collectorDispatchAgent } from "../utils/collectorDispatchAgent";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { parseMetadata } from "../utils/parseMetadata";
import { ReembedRequestSchema } from "@simmetric-chat/shared";

/**
 * Minimal shape the orchestrator (dlpDocumentService.scanDocument) passes
 * in — a scoped-read chunk with its masked text. chunkId is the
 * document_chunks.id (`${documentId}-${chunkIndex}` per the Bug A
 * alignment), metadata/embeddingId carry the system.ts:864-895 derivation
 * inputs.
 */
export interface MaskedChunk {
  id: string;
  chunkText: string; // MASKED text — placeholders applied
  embeddingId: string;
  metadata: string | null;
}

/** Document shape the reembed needs (subset of the scoped read's include). */
export interface MaskableDocument {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  embeddingModel: string;
  createdAt: Date;
  workspace?: { name?: string | null; id?: string; dlpDocumentScanEnabled?: boolean } | null;
}

/** Order contract documentation (see module header). */
export const MASK_UPDATE_SQL_COMMENT =
  "Order contract (D-06/D-07): mask chunkText in DB (this UPDATE) → reembed masked text to collector (delete-then-write, idempotent) → write DlpEntity entity rows + encrypted original. Retry converges: masking is idempotent (mask∘mask = mask) and reembed is delete-before-write.";

const FTS_BATCH_SIZE = 500;

/**
 * (a) Batched raw-SQL UPDATE of document_chunks with the masked text +
 * both tsvector columns recomputed (searchVector = english; searchVectorMulti
 * = MULTI_CONFIG_TSVECTOR — never hand-rolled). UPDATE (not delete+insert)
 * preserves chunk ids/createdAt — DlpEntity rows reference chunkId.
 *
 * Keyed on chunk ids from the org-asserted scoped read upstream
 * ($queryRaw-site disposition — see module header).
 *
 * FTS failure is NON-BLOCKING (documents.ts:1412-1416 precedent): logged at
 * error, never thrown — vector search still works.
 */
export async function applyMaskedChunks(
  doc: MaskableDocument,
  maskedChunks: MaskedChunk[],
): Promise<void> {
  if (maskedChunks.length === 0) return;
  try {
    for (let i = 0; i < maskedChunks.length; i += FTS_BATCH_SIZE) {
      const batch = maskedChunks.slice(i, i + FTS_BATCH_SIZE);
      const ids = batch.map((c) => c.id);
      const texts = batch.map((c) => c.chunkText);
      await prisma.$executeRaw`
        UPDATE "document_chunks" AS dc
        SET "chunkText" = t.chunkText,
            "searchVector" = to_tsvector('english', t.chunkText),
            "searchVectorMulti" = (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)} FROM (SELECT t.chunkText::text AS t) AS t)
        FROM unnest(
          ${ids}::text[],
          ${texts}::text[]
        ) AS t(id, chunkText)
        WHERE dc.id = t.id AND dc."documentId" = ${doc.id}
      `;
    }
    logger.info(`[dlp-masking] Masked ${maskedChunks.length} chunks in FTS for document ${doc.id}`);
  } catch (ftsErr: unknown) {
    // Non-blocking: vector search still works even if the FTS rewrite fails.
    // The retry (idempotent masking) converges — same discipline as the
    // ingest FTS write at documents.ts:1412-1416.
    const message = ftsErr instanceof Error ? ftsErr.message : String(ftsErr);
    logger.error(`[dlp-masking] Failed to update FTS chunks for document ${doc.id}: ${message}`);
  }
}

/**
 * chunkIndex derivation (Pitfall 7 — reembed must cover the SAME chunk set
 * the vector store holds): embeddingId prefix parse first, metadata.chunkIndex
 * fallback (system.ts:864-895 pattern verbatim).
 */
export function deriveChunkIndex(
  documentId: string,
  embeddingId: string,
  metadata: string | null | undefined,
): number | undefined {
  const prefix = `${documentId}-`;
  if (embeddingId.startsWith(prefix)) {
    const suffix = embeddingId.slice(prefix.length);
    const parsed = Number.parseInt(suffix, 10);
    if (Number.isInteger(parsed) && !Number.isNaN(parsed)) {
      return parsed;
    }
  }
  // metadata fallback — parseMetadata guarantees a non-null object.
  const meta = parseMetadata(metadata ?? null);
  const candidate = meta.chunkIndex;
  if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
    return candidate;
  }
  return undefined;
}

/**
 * (b) The masked reembed call (D-06/D-07): POST /api/ingest/reembed with the
 * MASKED chunkText, documentType + documentCreatedAt re-stamps, and the
 * document's embeddingModel — riding the timeout-exempt
 * `collectorDispatchAgent` (the 2026-09-18 undici headersTimeout incident:
 * local CPU re-embedding of a 270k-char doc legitimately exceeds 300s).
 *
 * Zero derivable chunks → LOUD failure (Pitfall 7: silently passing would
 * leave unmasked vectors searchable) — throws so the caller marks
 * dlpScanState="failed" instead of silently passing.
 */
export async function callMaskedReembed(
  doc: MaskableDocument,
  maskedChunks: MaskedChunk[],
): Promise<void> {
  const env = getEnv();
  const collectorUrl = env.COLLECTOR_URL || "http://localhost:3210";

  const reembedChunks: Array<{ chunkIndex: number; chunkText: string }> = [];
  for (const c of maskedChunks) {
    const chunkIndex = deriveChunkIndex(doc.id, c.embeddingId, c.metadata);
    if (chunkIndex === undefined) {
      // Non-derivable chunk: it cannot be addressed in the vector store —
      // excluded (the collector would reject it). Logged, like system.ts.
      logger.warn(
        `[dlp-masking] Doc ${doc.id}: chunk ${c.id} has no derivable chunkIndex (embeddingId=${c.embeddingId}), excluded from reembed`,
      );
      continue;
    }
    reembedChunks.push({ chunkIndex, chunkText: c.chunkText });
  }

  if (reembedChunks.length === 0) {
    // Pitfall 7 loud-failure arm — never silently pass.
    throw new Error(
      `Document ${doc.id}: no chunks with derivable chunkIndex — reembed would under-cover (masked FTS + stale unmasked vectors). Manual review required.`,
    );
  }

  const payload = ReembedRequestSchema.parse({
    documentId: doc.id,
    workspaceId: doc.workspaceId,
    workspaceName: doc.workspace?.name ?? undefined,
    chunks: reembedChunks,
    embeddingModel: doc.embeddingModel,
    documentType: doc.type,
    documentCreatedAt: doc.createdAt.toISOString(),
  });

  const response = await fetch(`${collectorUrl}/api/ingest/reembed`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "X-Collector-Secret": env.COLLECTOR_SECRET,
      "Content-Type": "application/json",
    },
    // quick 260918-j9m: bypass undici's global 300s headersTimeout — local
    // CPU re-embedding legitimately exceeds it (documents.ts:1290-1303
    // precedent).
    dispatcher: collectorDispatchAgent,
  } as unknown as Parameters<typeof fetch>[1]);

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({ error: "Unknown error" }))) as {
      error?: string;
      details?: string;
    };
    throw new Error(
      `Collector reembed error (${response.status}): ${errorData.error ?? "Unknown error"}${errorData.details ? ` — ${errorData.details}` : ""}`,
    );
  }

  logger.info(
    `[dlp-masking] Re-embedded ${reembedChunks.length} masked chunks for document ${doc.id}`,
  );
}