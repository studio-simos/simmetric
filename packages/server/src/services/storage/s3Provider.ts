// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "fs";
import type { Readable } from "stream";
import { logger } from "../../utils/logger";
import type { StorageProvider } from "../storageProvider";

/**
 * S3Provider — the S3-compatible StorageProvider strategy (Phase 184, SAAS-03).
 *
 * Targets AWS S3, MinIO, R2, Wasabi behind ONE client factory (D-02):
 * when a custom `endpoint` is configured, the client is pinned with
 * `forcePathStyle: true` (bucket-in-path — no wildcard-DNS on MinIO/R2)
 * AND `requestChecksumCalculation`/`responseChecksumValidation` set to
 * "WHEN_REQUIRED" (SDK v3.729.0+ checksum landmine — MinIO #20845, R2
 * reject the default CRC32 checksum headers). A second construction site
 * missing either pin fails cryptically against custom endpoints, so the
 * conformance suite asserts THIS factory's output (T-184-08) and the client
 * is memoized by config fingerprint — per-request provider RESOLUTION stays,
 * connection pools are not per-request.
 *
 * Multipart: `put` rides `@aws-sdk/lib-storage` Upload (8MB parts, queueSize
 * 4) for the ~100MB cap — a single PUT would break against most S3-compatible
 * providers (5GB/5min limits). `leavePartsOnError: false` auto-aborts a
 * failed multipart (waits for in-flight parts, completes nothing — no
 * orphaned parts, no partial object; verified by the conformance abort
 * probe, T-184-07).
 *
 * Key handling mirrors LocalFSProvider's cheap validation guard (empty /
 * absolute / ".." segments) — S3 keys are opaque strings safe by
 * construction, but the uniform contract keeps the conformance matrix
 * symmetric and catches corrupted-row keys identically (T-184-04).
 *
 * Legacy keys (M6 backfill: storageKey = filePath, e.g. "storage/uploads/x.pdf")
 * are NOT servable from S3 — an operator re-uploads legacy files to the
 * bucket (D-05, runbook) or an optional migration script handles them
 * (Parte II). Any put/get on a legacy-shaped key is treated as a normal S3
 * object key (opaque); the documented non-servability is a data-layout
 * concern, not a runtime guard.
 */

/** Resolved S3 config (from the 183 cascade via getStorageProvider). */
export interface S3Config {
  endpoint?: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Client memo (Pattern 2): Map keyed by the JSON fingerprint of the
 * bucket-independent client fields (region, endpoint, accessKeyId,
 * secretAccessKey). Resolution is per-request; client construction (and its
 * connection pool) is not — two resolutions with the same fingerprint share
 * one S3Client instance.
 */
const clientMemo = new Map<string, S3Client>();

/** Test-only accessor for the memoization probe (conformance suite). */
export function getClientMemoSize(): number {
  return clientMemo.size;
}

/**
 * THE factory — every S3Client in the codebase is built here (D-02: "mai un
 * `new S3Client` sparsa"). Pinned config on custom endpoints:
 *   - forcePathStyle: true (bucket-in-path)
 *   - requestChecksumCalculation + responseChecksumValidation: WHEN_REQUIRED
 * Non-AWS (no endpoint): neither pin applies (AWS defaults are correct).
 */
export function buildS3Client(cfg: S3Config): S3Client {
  const isCustomEndpoint = Boolean(cfg.endpoint); // non-AWS: MinIO/R2/Wasabi
  const fingerprint = JSON.stringify({
    region: cfg.region || "us-east-1",
    endpoint: cfg.endpoint || null,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });

  let client = clientMemo.get(fingerprint);
  if (!client) {
    client = new S3Client({
      region: cfg.region || "us-east-1", // v3 requires a region; sentinel fine for MinIO
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: isCustomEndpoint, // D-02 gate (bucket-in-path)
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      ...(isCustomEndpoint && {
        requestChecksumCalculation: "WHEN_REQUIRED", // SDK v3.729.0+ checksum landmine (MinIO #20845, R2)
        responseChecksumValidation: "WHEN_REQUIRED",
      }),
    });
    clientMemo.set(fingerprint, client);
  }
  return client;
}

/**
 * S3Provider implements StorageProvider against one bucket. Constructor
 * takes the resolved config; the S3Client comes from buildS3Client (never
 * constructed inline — Pitfall 4).
 */
export class S3Provider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.client = buildS3Client(cfg);
    this.bucket = cfg.bucket;
  }

  /**
   * Cheap uniform validation guard (symmetric with LocalFSProvider): S3 keys
   * are opaque but the shared contract rejects the corrupted-row classes
   * before any network call.
   */
  private validateKey(key: string): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("Storage key must be a non-empty string");
    }
    if (key.startsWith("/") || key.includes("//")) {
      throw new Error(`Storage key must not be absolute: "${key}"`);
    }
    if (key.split(/[\\/]/).includes("..")) {
      throw new Error(`Storage key must not contain ".." segments: "${key}"`);
    }
  }

  /**
   * Copy a local file into the bucket under `key` via lib-storage Upload —
   * 8MB parts (13 parts for 100MB), queueSize 4, leavePartsOnError: false
   * (auto-abort on failure: waits for in-flight parts, completes nothing).
   * Overwrite-idempotent: a re-put to the same key replaces the object
   * (S3 PutObject semantics; multipart completes replace the object too).
   */
  async put(localPath: string, key: string): Promise<{ key: string; size: number }> {
    this.validateKey(key);
    const size = fs.statSync(localPath).size;
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: fs.createReadStream(localPath),
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
    return { key, size };
  }

  /**
   * Exposed for the abort probe (conformance suite): drives the same
   * lib-storage Upload with a caller-supplied stream so a mid-multipart
   * failure can be simulated deterministically. Production put() reads from
   * local files; this helper is test-surface only.
   */
  async uploadStream(
    body: Readable,
    key: string,
    size: number,
  ): Promise<{ key: string; size: number }> {
    this.validateKey(key);
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
    return { key, size };
  }

  /** GetObjectCommand → Buffer.concat of the Body stream chunks. */
  async get(key: string): Promise<Buffer> {
    this.validateKey(key);
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    const body = response.Body as Readable;
    for await (const chunk of body) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** GetObjectCommand Body as a Readable (streaming consumers). */
  async getReadStream(key: string): Promise<Readable> {
    this.validateKey(key);
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return response.Body as Readable;
  }

  /**
   * DeleteObjectCommand — NoSuchKey/404 treated as success (best-effort
   * contract: a missing key is a no-op, never a throw; symmetric with the
   * LocalFS exists-checked unlink).
   */
  async delete(key: string): Promise<void> {
    this.validateKey(key);
    try {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // Missing key on S3-compatible endpoints surfaces as 404/NoSuchKey —
      // treated as success. Other failures: best-effort delete logs warn and
      // resolves (reaper try/catch-warn shape — cleanup never masks the
      // primary error).
      const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } });
      if (code.name === "NoSuchKey" || code.$metadata?.httpStatusCode === 404) {
        return;
      }
      logger.warn("[storage-provider] s3 delete failed (best-effort)", {
        key,
        error: (err as Error).message,
      });
    }
  }

  /**
   * HeadObjectCommand — false on NotFound/404/NoSuchKey, true on 200. The
   * D-06 existence probe (never silently false on S3-backed rows).
   */
  async exists(key: string): Promise<boolean> {
    this.validateKey(key);
    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const code = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        code.name === "NotFound" ||
        code.name === "NoSuchKey" ||
        code.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw err;
    }
  }
}