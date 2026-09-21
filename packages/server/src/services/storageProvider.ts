// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { Readable } from "stream";
import { getSetting } from "./systemConfigService";
import { LocalFSProvider } from "./storage/localFsProvider";
import { S3Provider } from "./storage/s3Provider";

// Re-export for consumers + tests (the default arm's class is part of the
// module's public surface, vectorStore-style).
/**
 * @enterpriseConsumed — RUNTIME-imported by the private enterprise repo
 * (services/backup/providers/providerRegistry.ts dynamic import of
 * S3Provider). knip cannot see the private repo.
 */
export { LocalFSProvider, S3Provider };

/**
 * StorageProvider — the storage strategy interface (Phase 184, SAAS-03).
 *
 * Every file byte that today flows through fs.* on document/draft/avatar
 * paths crosses this interface: `put` after the DB row (upload seams),
 * `get` for Buffer-parity reads (forwardToCollector pdf pre-check + FormData
 * blob), `getReadStream` for streaming consumers, `delete` for terminal
 * cleanup, `exists` for retry/assign guards.
 */
export interface StorageProvider {
  /**
   * Copy a local file (typically the multer ingress tmp) into the provider
   * under `key`. Overwrite-idempotent — a retry writing the SAME key
   * replaces the object cleanly (mid-abort probe edge, T-184-06).
   */
  put(localPath: string, key: string): Promise<{ key: string; size: number }>;
  /** Read the whole object as a Buffer — parity with today's fs.readFileSync call sites (D-06). */
  get(key: string): Promise<Buffer>;
  /**
   * Stream the object. Exercised by the 184-02 conformance suite;
   * production reads ride get()'s Buffer parity this phase (research A3).
   */
  getReadStream(key: string): Promise<Readable>;
  /** Best-effort existence-checked delete — missing key is a no-op, never a throw (D-08 cleanup contract). */
  delete(key: string): Promise<void>;
  /** Physical-existence probe — the D-06 successor of fs.existsSync guards (never silently false on S3-backed rows). */
  exists(key: string): Promise<boolean>;
}

/**
 * The default arm — LocalFS is stateless per root, so a module-level
 * singleton is safe (the collector's LanceDBProvider precedent).
 */
const localFsProvider = new LocalFSProvider("storage/uploads");

/**
 * Resolve the StorageProvider for an operation (D-01 — per-tenant storage).
 *
 * Resolution is PER-REQUEST, never a boot singleton: one org may ride S3
 * while the community default stays LocalFS (research "Resolution Timing" —
 * a boot singleton would pin one provider for all orgs). The Phase 183
 * cascade (getSetting(key, organizationId?) — Redis-cached) makes per-request
 * resolution cheap; only the S3Client is memoized (184-02, by config
 * fingerprint — connection pools are not per-request).
 *
 * Arms:
 *   - DEFAULT: STORAGE_PROVIDER unset / "localfs" / any invalid value →
 *     LocalFSProvider. (The "config missing → default" degradation shape
 *     applies ONLY to this arm.)
 *   - S3: "s3" fetches the 5 S3_* keys via Promise.all and fail-louds a
 *     NAMED error when S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *     is missing (vectorStore error shape) — NEVER a silent LocalFS
 *     fallback (Pitfall 5: tenant bytes must not silently land on local
 *     disk outside any bucket/backup strategy).
 *
 * Intentional gap (resolved next plan without architectural change): until
 * 184-02 landed S3Provider + buildS3Client, a fully-configured s3 arm
 * resolves an S3Provider through the central client factory (D-02).
 */
export async function getStorageProvider(organizationId?: string): Promise<StorageProvider> {
  const providerSetting = await getSetting("STORAGE_PROVIDER", organizationId);
  // Default arm: unset, "localfs", or any invalid value → LocalFS
  if (providerSetting.value !== "s3") {
    return localFsProvider;
  }

  const [endpoint, bucket, region, accessKeyId, secretAccessKey] = await Promise.all([
    getSetting("S3_ENDPOINT", organizationId),
    getSetting("S3_BUCKET", organizationId),
    getSetting("S3_REGION", organizationId),
    getSetting("S3_ACCESS_KEY_ID", organizationId),
    getSetting("S3_SECRET_ACCESS_KEY", organizationId),
  ]);

  // Fail-loud named errors (vectorStore.ts:908-931 shape) — NEVER a silent
  // LocalFS fallback when STORAGE_PROVIDER=s3 and config is incomplete.
  if (!bucket.value) {
    throw new Error("s3 provider requires S3_BUCKET via system config");
  }
  if (!accessKeyId.value) {
    throw new Error("s3 provider requires S3_ACCESS_KEY_ID via system config");
  }
  if (!secretAccessKey.value) {
    throw new Error("s3 provider requires S3_SECRET_ACCESS_KEY via system config");
  }

  // S3Provider + buildS3Client factory (forcePathStyle + WHEN_REQUIRED
  // checksums, D-02) — 184-02 fills the plan-01 named gap. The provider
  // constructor routes through the central client factory (memoized by
  // config fingerprint — per-request resolution, pooled clients).
  return new S3Provider({
    endpoint: endpoint.value || undefined,
    bucket: bucket.value,
    region: region.value || undefined,
    accessKeyId: accessKeyId.value,
    secretAccessKey: secretAccessKey.value,
  });
}