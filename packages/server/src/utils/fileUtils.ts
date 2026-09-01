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
