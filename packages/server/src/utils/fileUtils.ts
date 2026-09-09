// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import fs from "fs";
import path from "path";
import { sanitizeFileName } from "@simmetric-chat/shared";

/**
 * Single drafts-prefix rule (quick 260829-jv7, D-01).
 *
 * Returns true when `relPath` resolves INSIDE the staged drafts directory
 * (storage/uploads/drafts, process.cwd()-relative) — the directory whose
 * files are owned solely by the upload-draft lifecycle: the 24h reaper
 * (uploadDraftReaperJob, A5 prefix guard), the DELETE /api/uploads/:id
 * route (A5 guard), and the /retry+/assign source-file guards. No other
 * code path may delete or overwrite those files.
 *
 * Reaper-A5 semantics (mirrors uploadDraftReaperJob.ts:91):
 *   1. path.resolve — resolves relative to process.cwd(), matching where
 *      multer wrote the draft (documents.ts UPLOADS_DIR / uploads.ts
 *      DRAFTS_DIR are relative literals).
 *   2. Prefix + trailing path.sep — the trailing separator prevents a bare
 *      "storage/uploads/drafts" (the directory itself) and a "drafts-evil"
 *      sibling-prefix directory from matching (Pitfall 5).
 */
export function isDraftsPath(relPath: string): boolean {
  const base = path.resolve("storage/uploads/drafts") + path.sep;
  return path.resolve(relPath).startsWith(base);
}

/**
 * Key-space successor of isDraftsPath (Phase 184, SAAS-03 D-08): classifies a
 * row-carried storageKey as draft-owned for every terminal cleanup path
 * (collector status callback, 24h reaper A5 guard, DELETE route,
 * retry/assign restore guards).
 *
 * TWO arms — the cleanup contract must work for both key generations:
 *
 *   1. NEW-LAYOUT arm — keys shaped "{orgId}/uploads/drafts/{uuid}-{name}".
 *      The prefix guard is TRAILING-SEPARATOR ("…/uploads/drafts/"): a bare
 *      "{orgId}/uploads/drafts" (the directory itself) and a sibling-prefix
 *      "{orgId}/uploads/drafts-evil/x" do NOT match. This is A5 Pitfall 5
 *      reborn in key space — a startsWith guard without the trailing
 *      separator would let a sibling-prefix directory be classified as a
 *      draft and never cleaned (or, inversely, let the reaper skip real
 *      drafts).
 *
 *   2. LEGACY arm — the M6 migration backfilled storageKey = filePath, so
 *      backfilled rows carry the old cwd-relative path ("storage/uploads/
 *      drafts/x.pdf"). Those delegate to isDraftsPath (which stays — it is
 *      the canonical A5 resolve) for zero behavioral delta on pre-184 data
 *      (air-gap invariant).
 *
 * Deliberately-false arms: URL sentinels (backfilled URL drafts carry the
 * URL itself as their key — matches today's A5-rejects-URL behavior: never
 * deleted by any cleanup path) and null/undefined/empty (no key, nothing to
 * clean).
 *
 * ⚠ A5 Pitfall 5 reborn in key space: ANY future cleanup guard keyed on a
 * drafts prefix MUST go through this helper (or carry the same trailing-sep
 * rule) — a plain startsWith("…/uploads/drafts") reopens the sibling-prefix
 * hole this contract closes.
 */
export function isDraftStorageKey(key: string | null | undefined): boolean {
  if (!key) return false;
  // New-layout arm: {orgId}/uploads/drafts/ — trailing-sep prefix guard
  // (anti sibling-prefix "drafts-evil", same semantics as A5: reaper:95,
  // isDraftsPath:29).
  if (/^[0-9a-fA-F-]{36}\/uploads\/drafts\//.test(key)) {
    return true;
  }
  // Legacy arm: backfilled rows carry filePath — delegate to the existing
  // A5 resolve.
  return isDraftsPath(key);
}

/**
 * Dato un nome file originale, restituisce il percorso completo
 * garantendo che sia unico. Se esiste già un file con lo stesso nome,
 * aggiunge uno scalare numerico prima dell'estensione.
 *
 * Esempi:
 *   file.pdf      -> file.pdf  (se non esiste)
 *   file.pdf      -> file-1.pdf (se file.pdf esiste già)
 *   file-1.pdf    -> file-2.pdf (se sia file.pdf che file-1.pdf esistono)
 *   .hidden       -> .hidden-1  (file senza estensione)
 *   archive.tar.gz -> archive.tar-1.gz (scalare prima dell'ultima estensione)
 */
export function getUniqueFilePath(destDir: string, originalName: string): string {
  const sanitized = sanitizeFileName(originalName);
  const ext = path.extname(sanitized);
  const base = sanitized.slice(0, sanitized.length - ext.length) || sanitized;

  let candidate = path.join(destDir, sanitized);

  // Se il file non esiste, usa il nome originale così com'è
  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  // Altrimenti, prova con scalari -1, -2, -3, ...
  let counter = 1;
  while (true) {
    const dedupedName = ext ? `${base}-${counter}${ext}` : `${base}-${counter}`;
    candidate = path.join(destDir, dedupedName);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    counter++;
    // Safety guard: se per qualche ragione il contatore esplode, fermati
    if (counter > 10000) {
      // Fallback: aggiungi timestamp per garantire unicità
      const fallbackName = ext
        ? `${base}-${Date.now()}${ext}`
        : `${base}-${Date.now()}`;
      return path.join(destDir, fallbackName);
    }
  }
}
