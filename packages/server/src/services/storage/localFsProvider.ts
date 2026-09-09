// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import fs from "fs";
import path from "path";
import type { Readable } from "stream";
import { logger } from "../../utils/logger";
import type { StorageProvider } from "../storageProvider";

/**
 * LocalFSProvider — the default StorageProvider strategy (Phase 184, SAAS-03).
 *
 * A behavior-preserving wrap around the pre-184 fs call sites
 * (fs.readFileSync / fs.copyFileSync / fs.createReadStream / fs.unlinkSync),
 * with the two-arm key resolution contract from D-05:
 *
 *   1. LEGACY arm — backfilled rows carry the old cwd-relative filePath as
 *      their storageKey (M6 backfill: storageKey = filePath, e.g.
 *      "storage/uploads/file.pdf"). A key containing "storage/" resolves via
 *      path.resolve(key) — byte-identical to what isDraftsPath
 *      (fileUtils.ts:29) and the reaper/DELETE-route A5 guards compute today
 *      (path.resolve vs process.cwd()).
 *
 *   2. NEW-LAYOUT arm — keys like "{organizationId}/uploads/{uuid}-{name}"
 *      resolve strictly inside the provider root (default "storage/uploads",
 *      the research-canonical root): path.resolve(root, key).
 *
 * Key validation (T-184-04 mitigation, A5 physical-guard successor): every
 * method validates the key BEFORE resolving — empty keys, absolute paths and
 * any ".." segment are rejected. Legacy keys become filesystem paths, so the
 * traversal defense lives here, in the provider, for both arms.
 *
 * `put` is overwrite-idempotent (copyFileSync semantics) — a retried upload
 * writing the SAME key overwrites cleanly (mid-abort probe edge, T-184-06).
 * `delete` is a best-effort existence-checked unlink: a missing file is a
 * no-op resolve; an unlink failure logs warn and resolves anyway (absorbs
 * the reaper try/catch-warn shape so call sites stay clean).
 */
export class LocalFSProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string = "storage/uploads") {
    this.root = root;
  }

  /**
   * Two-arm key resolution (D-05).
   *
   * Legacy arm: a key containing "storage/" IS the legacy filePath — resolve
   * exactly as today's code does (byte-identical path.resolve semantics).
   * New-layout arm: resolve inside the provider root.
   */
  resolve(key: string): string {
    this.validateKey(key);
    // Legacy arm: backfilled rows carry filePath ("storage/uploads/…") —
    // resolve exactly as isDraftsPath/reaper do today (path.resolve vs
    // process.cwd()), byte-identical.
    if (key.includes("storage/")) {
      return path.resolve(key);
    }
    // New-layout arm: {orgId}/uploads/… → inside the provider root.
    return path.resolve(this.root, key);
  }

  /**
   * Rejects empty keys, absolute paths and any ".." segment BEFORE resolve.
   * Runs on both arms — legacy keys are equally path-bearing (M6 backfill
   * makes storageKey = filePath; a corrupted row must never escape the
   * storage tree, T-184-04).
   */
  private validateKey(key: string): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("Storage key must be a non-empty string");
    }
    if (key.startsWith("/") || path.isAbsolute(key)) {
      throw new Error(`Storage key must not be absolute: "${key}"`);
    }
    if (key.split(/[\\/]/).includes("..")) {
      throw new Error(`Storage key must not contain ".." segments: "${key}"`);
    }
  }

  async put(localPath: string, key: string): Promise<{ key: string; size: number }> {
    const resolved = this.resolve(key);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    // Overwrite-idempotent: copyFileSync truncates/replaces the destination —
    // a retry of an interrupted put lands a complete file.
    fs.copyFileSync(localPath, resolved);
    return { key, size: fs.statSync(localPath).size };
  }

  async get(key: string): Promise<Buffer> {
    const resolved = this.resolve(key);
    return fs.readFileSync(resolved);
  }

  /**
   * Exercised by the 184-02 conformance suite; production reads ride
   * get()'s Buffer parity this phase (research A3 — the existing call sites
   * already buffer whole files via fs.readFileSync, so Buffer parity keeps
   * the collector contract byte-identical with no streaming rework).
   */
  async getReadStream(key: string): Promise<Readable> {
    const resolved = this.resolve(key);
    return fs.createReadStream(resolved);
  }

  /**
   * Best-effort existence-checked delete — a missing key is a no-op resolve
   * (mirrors the fs.existsSync+unlinkSync guards at the call sites); an
   * unlink failure logs warn with a tagged prefix and resolves anyway
   * (absorbs the reaper try/catch-warn shape, PATTERNS shared pattern).
   */
  async delete(key: string): Promise<void> {
    const resolved = this.resolve(key);
    try {
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
    } catch (err) {
      logger.warn("[storage-provider] localfs delete failed (best-effort)", {
        key,
        resolved,
        error: (err as Error).message,
      });
    }
  }

  async exists(key: string): Promise<boolean> {
    const resolved = this.resolve(key);
    return fs.existsSync(resolved);
  }
}