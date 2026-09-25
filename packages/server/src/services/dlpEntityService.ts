// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP entity-map service (Phase 192 plan 02 — D-04).
 *
 * The DlpEntity mapping table IS the re-composition source of truth: chat
 * re-composition (plan 03) and preview unmask (plan 05) decrypt original
 * entity values through buildRecompositionMap — decryption happens HERE at
 * call time so permission gates stay in the callers.
 *
 * Encryption discipline (D-04, T-192-06): every stored original value rides
 * `encryptionService.encrypt()` (AES-256-GCM). No plaintext column exists —
 * column reads must reference `originalEncrypted`. Never log the plaintext
 * or the ciphertext (log entityClass + placeholder only).
 *
 * Prisma singleton from ../utils/prisma (repo hard rule — never
 * `new PrismaClient()`).
 */
import prisma from "../utils/prisma";
import * as encryptionService from "./encryptionService";
import { logger } from "../utils/logger";
import type { DlpEntityClass } from "@simmetric-chat/shared";

/** One entity occurrence entry produced by the scan pipeline (plan 02). */
export interface DlpEntityMapEntry {
  entityClass: string;
  placeholder: string;
  /** The ORIGINAL (unmasked) entity value — stored encrypted only. */
  original: string;
  /** Optional chunk anchor — document-wide entities may not pin one chunk. */
  chunkId?: string;
  /** Times the entity appears in the document text (document-wide count). */
  occurrences: number;
}

/**
 * Persist the scan's entity rows (D-04). Each row's `originalEncrypted` is
 * the ONLY clean copy of the entity value — `encryptionService.encrypt()`
 * output, never plaintext (the checkpoint-approved one-way door: dropping
 * DLP later means deleting these rows AND losing unmask ability forever).
 *
 * Write-per-row try/catch: one entity failure must not orphan the whole
 * document's map — the failed entry is logged (entityClass + placeholder
 * ONLY, never the value) and the row is skipped. Callers treat a partial
 * write as a scan failure (scanDocument marks dlpScanState="failed" on any
 * thrown error; a partially-written map without the failed marker is
 * avoided because persistEntityMap rethrows after logging).
 */
export async function writeEntityMap(
  documentId: string,
  entries: DlpEntityMapEntry[],
): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    try {
      await prisma.dlpEntity.create({
        data: {
          documentId,
          chunkId: entry.chunkId ?? null,
          entityClass: entry.entityClass,
          placeholder: entry.placeholder,
          originalEncrypted: encryptionService.encrypt(entry.original),
          occurrences: entry.occurrences,
        },
      });
      written += 1;
    } catch (err: unknown) {
      // T-192-09 discipline: log identifiers only — never the entity value.
      logger.error("[dlp-entity] entity row write failed (continuing map write)", {
        documentId,
        entityClass: entry.entityClass,
        placeholder: entry.placeholder,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
  return written;
}

/**
 * Load the entity-map rows for a document, ordered by placeholder
 * (deterministic re-composition source ordering for plans 03/05).
 */
async function loadEntityMap(documentId: string) {
  return prisma.dlpEntity.findMany({
    where: { documentId },
    orderBy: { placeholder: "asc" },
  });
}

/**
 * Re-composition source of truth for chat unmask (plan 03) + preview unmask
 * (plan 05): Map<placeholder, decrypted original>. Decryption happens HERE
 * at call time — permission gates stay in the CALLERS (the map is only
 * resolved after the caller has asserted the dlp:unmask right). Rows whose
 * ciphertext fails to decrypt (key rotation / lost ENCRYPTION_KEY) are
 * DROPPED with an error log — the masked placeholder simply stays visible
 * for that entity (fail-closed: never render garbage in place of a secret).
 */
export async function buildRecompositionMap(
  documentIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (documentIds.length === 0) return map;
  const rows = await prisma.dlpEntity.findMany({
    where: { documentId: { in: documentIds } },
    orderBy: { placeholder: "asc" },
  });
  for (const row of rows) {
    if (map.has(row.placeholder)) continue;
    try {
      map.set(row.placeholder, encryptionService.decrypt(row.originalEncrypted));
    } catch (err: unknown) {
      // Guided failure discipline: the decrypt error text never discloses
      // key material; we log the placeholder only.
      logger.error("[dlp-entity] decrypt failed for entity row — placeholder stays masked", {
        documentId: row.documentId,
        placeholder: row.placeholder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return map;
}

/**
 * Delete the entity rows for a document (used by the re-scan arm in plan 06
 * and the document-purge cascade tests; document deletion already cascades
 * via FK, this is the explicit re-scan refresh seam).
 *
 * Phase 204 (DEBT-SW-05): the designed re-scan refresh seam is now WIRED —
 * the document text-edit route (PUT /:documentId/text) calls this in its DLP
 * re-scan arm so a re-scan after an edit rebuilds a clean placeholder map
 * instead of stacking duplicate entity rows on stale placeholders
 * (writeEntityMap only creates; the read-side buildRecompositionMap tolerates
 * duplicates by map-overwrite, so the delete-then-rewrite keeps the map
 * exact rather than merely tolerated).
 */
export async function deleteEntityMap(documentId: string): Promise<number> {
  const result = await prisma.dlpEntity.deleteMany({ where: { documentId } });
  return result.count;
}

/**
 * Tolerant per-placeholder matcher (Pitfall 3(a)) — Phase 192 plan 04 owns
 * this export (the 192-03/192-04 unification: dlpRecomposeService now
 * imports THIS definition instead of carrying a local copy).
 *
 * Case-insensitive, whitespace-tolerant: "[ PERSON_1 ]", "[person_1]",
 * "[Person_1]", "[PERSON_ 1]" all resolve to the same original. The
 * class/number split rides the LAST underscore — the GOV_ID class itself
 * contains an underscore, so a first-underscore split would mangle
 * "[GOV_ID_1]" (plan-03 latent bug fixed here at the single definition).
 * Per-call compilation is intentional — the map is small (one entry per
 * distinct entity in a document) and a per-call RegExp avoids shared
 * lastIndex state across concurrent substitutions.
 */
export function buildPlaceholderRegex(placeholder: string): RegExp {
  const inner = placeholder.slice(1, -1); // strip [ ]
  const lastUnderscore = inner.lastIndexOf("_");
  const cls = lastUnderscore > 0 ? inner.slice(0, lastUnderscore) : inner;
  const num = lastUnderscore > 0 ? inner.slice(lastUnderscore + 1) : "";
  const clsPattern = cls.split("").join("\\s*");
  const numPattern = num.split("").join("\\s*");
  return new RegExp(`\\[\\s*${clsPattern}\\s*_\\s*${numPattern}\\s*\\]`, "gi");
}