// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 184 (SAAS-03) — StorageProvider core unit suite.
 *
 * Mock-the-service style (systemConfig.precedence.test.ts doctrine): the
 * getSetting cascade (Phase 183) is mocked wholesale; the LocalFS provider
 * runs against a temp root (no repo storage/ writes — resolve() is pure
 * path computation and is exercised on the default-root instance too).
 *
 * Coverage:
 *   - getStorageProvider resolution matrix: unset/localfs/invalid → LocalFS
 *     default arm (module-level singleton); "s3" + missing S3_BUCKET /
 *     S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY → NAMED fail-loud throw,
 *     NEVER a silent LocalFS fallback (Pitfall 5 / T-184-01 mitigation);
 *     per-org override → different arms per organizationId (per-request
 *     resolution, D-01).
 *   - LocalFSProvider.resolve two-arm contract (D-05): legacy keys (contain
 *     "storage/") resolve via path.resolve(key) byte-identically to today's
 *     isDraftsPath/reaper semantics; new-layout keys resolve strictly inside
 *     the provider root.
 *   - Traversal matrix (T-184-04): empty, leading-slash, and any ".."-segment
 *     key rejected by BOTH arms BEFORE path.resolve (A5 physical-guard
 *     successor — traversal defense moved into the provider).
 *   - put/get/getReadStream/delete/exists behavioral suite on a temp root,
 *     including overwrite-idempotent re-put (mid-abort probe edge, T-184-06).
 */

import "../helpers/setupEnv";

import fs from "fs";
import os from "os";
import path from "path";
import { LocalFSProvider } from "../../services/storage/localFsProvider";

const mockGetSetting = jest.fn();

jest.mock("../../services/systemConfigService", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

jest.mock("../../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function setting(key: string, value: string | undefined) {
  return { key, value, readOnly: false };
}

/** Mock the 183 cascade: map of key → value (undefined = unset at every tier). */
function configureSettings(map: Record<string, string | undefined>) {
  mockGetSetting.mockImplementation(async (key: string) => setting(key, map[key]));
}

/**
 * Fresh module require — resets storageProvider's module-level LocalFS
 * singleton between tests. jest.mock registrations survive resetModules;
 * the mock factory closure over mockGetSetting persists.
 */
function freshStorageProviderModule() {
  jest.resetModules();
  return require("../../services/storageProvider");
}

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000000";
const NEW_LAYOUT_KEY = `${DEFAULT_ORG}/uploads/doc.pdf`;

// ─── getStorageProvider resolution matrix ────────────────────────────────────

describe("getStorageProvider — resolution matrix (D-01)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("STORAGE_PROVIDER unset → LocalFSProvider default arm (singleton)", async () => {
    configureSettings({});
    const mod = freshStorageProviderModule();

    const provider = await mod.getStorageProvider();
    expect(provider instanceof mod.LocalFSProvider).toBe(true);

    // LocalFS is stateless per root → module-level singleton
    const again = await mod.getStorageProvider();
    expect(again).toBe(provider);
  });

  it("STORAGE_PROVIDER 'localfs' → LocalFSProvider", async () => {
    configureSettings({ STORAGE_PROVIDER: "localfs" });
    const mod = freshStorageProviderModule();

    const provider = await mod.getStorageProvider();
    expect(provider instanceof mod.LocalFSProvider).toBe(true);
    expect(mockGetSetting).toHaveBeenCalledWith("STORAGE_PROVIDER", undefined);
  });

  it("STORAGE_PROVIDER invalid value → LocalFSProvider (default arm covers invalid)", async () => {
    configureSettings({ STORAGE_PROVIDER: "gcs" });
    const mod = freshStorageProviderModule();

    const provider = await mod.getStorageProvider();
    expect(provider instanceof mod.LocalFSProvider).toBe(true);
  });

  it("s3 + missing S3_BUCKET → named fail-loud throw, never silent LocalFS (Pitfall 5)", async () => {
    configureSettings({ STORAGE_PROVIDER: "s3" });
    const mod = freshStorageProviderModule();

    await expect(mod.getStorageProvider()).rejects.toThrow(
      /s3 provider requires S3_BUCKET via system config/,
    );
  });

  it("s3 + missing S3_ACCESS_KEY_ID → named fail-loud throw", async () => {
    configureSettings({ STORAGE_PROVIDER: "s3", S3_BUCKET: "bucket-a" });
    const mod = freshStorageProviderModule();

    await expect(mod.getStorageProvider()).rejects.toThrow(
      /s3 provider requires S3_ACCESS_KEY_ID via system config/,
    );
  });

  it("s3 + missing S3_SECRET_ACCESS_KEY → named fail-loud throw", async () => {
    configureSettings({
      STORAGE_PROVIDER: "s3",
      S3_BUCKET: "bucket-a",
      S3_ACCESS_KEY_ID: "akid",
    });
    const mod = freshStorageProviderModule();

    await expect(mod.getStorageProvider()).rejects.toThrow(
      /s3 provider requires S3_SECRET_ACCESS_KEY via system config/,
    );
  });

  it("s3 + complete config → S3Provider resolved (184-02 filled the plan-01 gap; constructor routed through buildS3Client)", async () => {
    configureSettings({
      STORAGE_PROVIDER: "s3",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "bucket-a",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "akid",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    const mod = freshStorageProviderModule();

    const provider = await mod.getStorageProvider();
    expect(provider instanceof mod.S3Provider).toBe(true);
    // All 5 S3_* keys fetched via the cascade (D-01)
    expect(mockGetSetting).toHaveBeenCalledWith("S3_ENDPOINT", undefined);
    expect(mockGetSetting).toHaveBeenCalledWith("S3_BUCKET", undefined);
    expect(mockGetSetting).toHaveBeenCalledWith("S3_REGION", undefined);
    expect(mockGetSetting).toHaveBeenCalledWith("S3_ACCESS_KEY_ID", undefined);
    expect(mockGetSetting).toHaveBeenCalledWith("S3_SECRET_ACCESS_KEY", undefined);
  });

  it("per-org override resolves different arms per organizationId (per-request resolution)", async () => {
    // org-a rides the default (unset → localfs); org-b has an s3 row with
    // incomplete config → named throw. Both prove the org id reached the
    // cascade and the arms diverged per org.
    mockGetSetting.mockImplementation(async (key: string, organizationId?: string) => {
      if (key === "STORAGE_PROVIDER" && organizationId === "org-b") {
        return setting(key, "s3");
      }
      return setting(key, undefined);
    });
    const mod = freshStorageProviderModule();

    const orgAProvider = await mod.getStorageProvider("org-a");
    expect(orgAProvider instanceof mod.LocalFSProvider).toBe(true);
    expect(mockGetSetting).toHaveBeenCalledWith("STORAGE_PROVIDER", "org-a");

    await expect(mod.getStorageProvider("org-b")).rejects.toThrow(
      /s3 provider requires S3_BUCKET/,
    );
    expect(mockGetSetting).toHaveBeenCalledWith("STORAGE_PROVIDER", "org-b");
  });
});

// ─── LocalFSProvider key resolution (D-05) + traversal matrix (T-184-04) ────

describe("LocalFSProvider — resolve two-arm contract", () => {
  let provider: LocalFSProvider;

  beforeEach(() => {
    provider = new LocalFSProvider("storage/uploads");
  });

  it("legacy arm: key containing storage/ → path.resolve(key) byte-identical to today", () => {
    const resolved = provider.resolve("storage/uploads/file.pdf");
    expect(resolved).toBe(path.resolve("storage/uploads/file.pdf"));

    // Backfilled legacy drafts path resolves to the same base the reaper
    // A5 guard computes today
    const legacyDraft = provider.resolve("storage/uploads/drafts/x.pdf");
    expect(legacyDraft).toBe(path.resolve("storage/uploads/drafts/x.pdf"));
    expect(legacyDraft.startsWith(path.resolve("storage/uploads/drafts") + path.sep)).toBe(true);
  });

  it("new-layout arm: {orgId}/uploads/x → strictly inside the provider root", () => {
    const resolved = provider.resolve(NEW_LAYOUT_KEY);
    expect(resolved).toBe(path.resolve("storage/uploads", NEW_LAYOUT_KEY));
    expect(resolved.startsWith(path.resolve("storage/uploads") + path.sep)).toBe(true);
  });

  it("new-layout arm on a custom root resolves inside that root", () => {
    const custom = new LocalFSProvider("storage/uploads");
    const resolved = custom.resolve(NEW_LAYOUT_KEY);
    expect(resolved.startsWith(path.resolve("storage/uploads") + path.sep)).toBe(true);
  });

  it("traversal matrix: empty / leading-slash / '..'-segment keys all rejected", () => {
    expect(() => provider.resolve("")).toThrow(/non-empty/);
    expect(() => provider.resolve("/abs/path")).toThrow(/absolute/);
    expect(() => provider.resolve("a/../../etc/passwd")).toThrow(/\.\./);

    // Both arms reject: a ".."-segment key that carries the legacy prefix
    expect(() => provider.resolve("storage/../../etc/passwd")).toThrow(/\.\./);
    // .. anywhere (not just leading) is rejected
    expect(() => provider.resolve("uploads/../secrets")).toThrow(/\.\./);
  });

  it("valid keys pass validation (legacy + new layout)", () => {
    expect(() => provider.resolve("storage/uploads/file.pdf")).not.toThrow();
    expect(() => provider.resolve(NEW_LAYOUT_KEY)).not.toThrow();
  });
});

// ─── LocalFSProvider behavioral suite (temp root) ────────────────────────────

describe("LocalFSProvider — put/get/getReadStream/delete/exists", () => {
  let root: string;
  let srcDir: string;
  let provider: LocalFSProvider;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "storageprovider-root-"));
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "storageprovider-src-"));
    provider = new LocalFSProvider(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  function writeSource(name: string, payload: Buffer): string {
    const src = path.join(srcDir, name);
    fs.writeFileSync(src, payload);
    return src;
  }

  it("put creates parent dirs recursively, copies the file, returns { key, size }", async () => {
    const payload = Buffer.from("hello storage provider");
    const src = writeSource("a.pdf", payload);
    const key = `${DEFAULT_ORG}/uploads/nested/deep/a.pdf`;

    const result = await provider.put(src, key);

    expect(result.key).toBe(key);
    expect(result.size).toBe(fs.statSync(src).size);
    expect(result.size).toBe(payload.length);
    expect(fs.readFileSync(path.join(root, key)).equals(payload)).toBe(true);
  });

  it("get returns a Buffer byte-equal to the stored file", async () => {
    const payload = Buffer.from([1, 2, 3, 255, 0, 42]);
    const src = writeSource("b.bin", payload);
    await provider.put(src, NEW_LAYOUT_KEY);

    const buffer = await provider.get(NEW_LAYOUT_KEY);
    expect(buffer.equals(payload)).toBe(true);
  });

  it("getReadStream returns a Readable whose consumed bytes equal the file", async () => {
    const payload = Buffer.from("stream me byte by byte");
    const src = writeSource("c.txt", payload);
    await provider.put(src, NEW_LAYOUT_KEY);

    const stream = await provider.getReadStream(NEW_LAYOUT_KEY);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it("delete on a missing key resolves as a no-op (not a throw)", async () => {
    await expect(provider.delete(`${DEFAULT_ORG}/uploads/never-existed.pdf`)).resolves.toBeUndefined();
  });

  it("delete on an existing key removes the file and resolves", async () => {
    const src = writeSource("c.txt", Buffer.from("delete me"));
    await provider.put(src, `${DEFAULT_ORG}/uploads/c.txt`);
    const physical = path.join(root, DEFAULT_ORG, "uploads", "c.txt");
    expect(fs.existsSync(physical)).toBe(true);

    await provider.delete(`${DEFAULT_ORG}/uploads/c.txt`);

    expect(fs.existsSync(physical)).toBe(false);
  });

  it("exists returns true for a stored key and false otherwise", async () => {
    const src = writeSource("d.txt", Buffer.from("exists probe"));
    await provider.put(src, `${DEFAULT_ORG}/uploads/d.txt`);

    expect(await provider.exists(`${DEFAULT_ORG}/uploads/d.txt`)).toBe(true);
    expect(await provider.exists(`${DEFAULT_ORG}/uploads/missing.txt`)).toBe(false);
  });

  it("put to the same key is overwrite-idempotent (mid-abort probe edge)", async () => {
    const key = `${DEFAULT_ORG}/uploads/overwrite.txt`;
    const first = writeSource("first.txt", Buffer.from("first payload"));
    await provider.put(first, key);

    const second = writeSource("second.txt", Buffer.from("second-payload-longer"));
    await provider.put(second, key);

    const buffer = await provider.get(key);
    expect(buffer.equals(Buffer.from("second-payload-longer"))).toBe(true);
  });

  it("put/get/delete reject traversal keys before any fs touch (T-184-04)", async () => {
    const src = writeSource("evil.txt", Buffer.from("evil"));
    await expect(provider.put(src, "../escape.txt")).rejects.toThrow(/\.\./);
    await expect(provider.get("/etc/passwd")).rejects.toThrow(/absolute/);
    await expect(provider.delete("a/../../etc/passwd")).rejects.toThrow(/\.\./);
  });
});