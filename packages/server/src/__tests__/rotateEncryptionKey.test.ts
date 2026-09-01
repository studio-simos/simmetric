// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";
import crypto from "crypto";

// Mock prisma BEFORE importing the rotation module — the script imports the
// real prisma singleton, which would try to connect to Postgres otherwise.
jest.mock("../utils/prisma", () => {
  const mock = {
    systemConfig: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    provider: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    backupDestination: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
    $disconnect: jest.fn(),
  };
  return { __esModule: true, default: mock, prisma: mock };
});

// Mock commander so importing the script does not parse process.argv.
jest.mock("commander", () => ({
  program: {
    option: jest.fn().mockReturnThis(),
    parse: jest.fn().mockReturnThis(),
    opts: jest.fn().mockReturnThis(),
  },
}));

import { encrypt, decrypt, resetEncryptionKeyCache, getDecryptKeyChain } from "../services/encryptionService";
import { runRotation, ENCRYPTED_COLUMNS, classify, keyFingerprint } from "../../scripts/rotate-encryption-key";
import prisma from "../utils/prisma";

// Deterministic 32-byte test keys (base64-encoded).
const KEY_A = Buffer.alloc(32, 0xaa).toString("base64");
const KEY_B = Buffer.alloc(32, 0xbb).toString("base64");
const KEY_C = Buffer.alloc(32, 0xcc).toString("base64");

function setKeyEnv(opts: { current?: string; previous?: string[] }) {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
  if (opts.current !== undefined) process.env.ENCRYPTION_KEY = opts.current;
  if (opts.previous && opts.previous.length)
    process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS = opts.previous.join(",");
  resetEncryptionKeyCache();
}

describe("rotate-encryption-key — ENCRYPTED_COLUMNS registry (Pitfall 2)", () => {
  it("lists exactly 2 entries: provider.apiKey + backupDestination.config", () => {
    expect(ENCRYPTED_COLUMNS).toHaveLength(2);
    const tables = ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`);
    expect(tables).toEqual(["provider.apiKey", "backupDestination.config"]);
    expect(ENCRYPTED_COLUMNS.some((c) => (c.table as string) === "system_config")).toBe(false);
    expect(ENCRYPTED_COLUMNS.some((c) => (c.table as string) === "mcp_connections")).toBe(false);
  });

  it("backupDestination entry has includeDeleted: true (Pitfall 4)", () => {
    const bd = ENCRYPTED_COLUMNS.find((c) => c.table === "backupDestination");
    expect(bd?.includeDeleted).toBe(true);
  });

  it("provider entry has includeDeleted: false (no deletedAt field)", () => {
    const p = ENCRYPTED_COLUMNS.find((c) => c.table === "provider");
    expect(p?.includeDeleted).toBe(false);
  });
});

describe("rotate-encryption-key — classify helper", () => {
  it("classifies a row decryptable with chain[0] as active", () => {
    setKeyEnv({ current: KEY_B });
    const ct = encrypt("hello");
    const chain = getDecryptKeyChain();
    expect(classify(ct, chain)).toBe("active");
  });

  it("classifies a row decryptable only with a previous key as legacy", () => {
    setKeyEnv({ current: KEY_A });
    const ct = encrypt("legacy-secret");
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });
    const chain = getDecryptKeyChain();
    expect(classify(ct, chain)).toBe("legacy");
  });

  it("classifies a row no key can decrypt as undecryptable", () => {
    setKeyEnv({ current: KEY_A });
    const ct = encrypt("undecryptable");
    setKeyEnv({ current: KEY_C }); // neither current nor previous
    const chain = getDecryptKeyChain();
    expect(classify(ct, chain)).toBe("undecryptable");
  });
});

describe("rotate-encryption-key — rotation skip-already-new (idempotent)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    setKeyEnv({ current: KEY_B });
  });

  it("does NOT re-write a row whose ciphertext already decrypts with the new key", async () => {
    const activeCiphertext = encrypt("already-rotated");
    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: "p1", apiKey: activeCiphertext }])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});
    (prisma.systemConfig.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb({
      provider: { findUnique: jest.fn().mockResolvedValue({ apiKey: activeCiphertext }), update: jest.fn() },
    }));

    const result = await runRotation({ dryRun: false, resume: false });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.provider.skipped).toBe(1);
    expect(result.provider.reEncrypted).toBe(0);
  });
});

describe("rotate-encryption-key — rotation re-encrypts legacy row", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("re-encrypts a legacy row inside a prisma.$transaction; after, it decrypts with the new key", async () => {
    // Encrypt with KEY_A (legacy), then switch to KEY_B with KEY_A as previous.
    setKeyEnv({ current: KEY_A });
    const legacyCiphertext = encrypt("legacy-secret-value");
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });

    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: "p1", apiKey: legacyCiphertext }])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});
    (prisma.systemConfig.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    let capturedUpdate: any = null;
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      const tx = {
        provider: {
          findUnique: jest.fn().mockResolvedValue({ apiKey: legacyCiphertext }),
          update: jest.fn((args: any) => {
            capturedUpdate = args;
            return {};
          }),
        },
      };
      return cb(tx);
    });

    const result = await runRotation({ dryRun: false, resume: false });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.provider.reEncrypted).toBe(1);
    expect(capturedUpdate).not.toBeNull();
    // The re-encrypted value must decrypt with the new key (chain[0] = KEY_B).
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });
    expect(decrypt(capturedUpdate.data.apiKey)).toBe("legacy-secret-value");
  });
});

describe("rotate-encryption-key — fail-closed undecryptable (D-07)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("throws an Error naming {table, id} and aborts the sweep — no later row touched", async () => {
    setKeyEnv({ current: KEY_A });
    const undecryptableCt = encrypt("will-be-undecryptable");
    setKeyEnv({ current: KEY_C }); // KEY_A not in chain → undecryptable

    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([
        { id: "p-first", apiKey: undecryptableCt },
        { id: "p-second", apiKey: undecryptableCt },
      ])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});
    (prisma.$transaction as jest.Mock).mockResolvedValue({});

    await expect(
      runRotation({ dryRun: false, resume: false }),
    ).rejects.toThrow(/Fail-closed: cannot decrypt provider\.id=p-first/);

    // No $transaction should have been invoked — the sweep aborts before writing.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("rotate-encryption-key — resume marker (D-08)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("writes the marker via prisma.systemConfig.upsert (NOT updateSettings)", async () => {
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });
    (prisma.provider.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});
    (prisma.systemConfig.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    await runRotation({ dryRun: false, resume: false });

    expect(prisma.systemConfig.upsert).toHaveBeenCalled();
    const upsertArgs = (prisma.systemConfig.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertArgs.where.key).toBe("encryption_key_rotation_progress");
    // Marker stores a sha256 fingerprint prefix, never the key itself.
    const parsed = JSON.parse(upsertArgs.update.value);
    expect(parsed.toKeyFingerprint).toBe(keyFingerprint(Buffer.from(KEY_B, "base64")));
    expect(JSON.stringify(upsertArgs.update.value)).not.toContain(KEY_B);
  });

  it("--resume reads the marker and skips the completed table/row", async () => {
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });
    const chain = getDecryptKeyChain();
    const marker = {
      fromKeyFingerprint: keyFingerprint(Buffer.from(KEY_A, "base64")),
      toKeyFingerprint: keyFingerprint(chain[0]!),
      startedAt: new Date().toISOString(),
      lastTable: "provider",
      lastId: "p-done",
      status: "in_progress",
    };
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: "encryption_key_rotation_progress",
      value: JSON.stringify(marker),
    });
    // backupDestination still has rows to sweep.
    (prisma.provider.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});
    (prisma.systemConfig.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const result = await runRotation({ dryRun: false, resume: true });

    // Provider table skipped (marker.lastTable === "provider"); the findMany
    // cursor for provider must not re-visit rows before lastId. We assert the
    // provider sweep reported 0 processed rows (skipped via resume).
    expect(result.provider.reEncrypted).toBe(0);
    expect(result.provider.skipped).toBe(0);
    expect(result.resumedFrom).toEqual({ lastTable: "provider", lastId: "p-done" });
  });

  it("a marker with a non-matching toKeyFingerprint is ignored (fresh sweep)", async () => {
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });
    const staleMarker = {
      fromKeyFingerprint: "deadbeef",
      toKeyFingerprint: "cafef00d", // does NOT match KEY_B fingerprint
      startedAt: new Date().toISOString(),
      lastTable: "provider",
      lastId: "p-old",
      status: "in_progress",
    };
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: "encryption_key_rotation_progress",
      value: JSON.stringify(staleMarker),
    });
    (prisma.provider.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});
    (prisma.systemConfig.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const result = await runRotation({ dryRun: false, resume: true });

    expect(result.resumedFrom).toBeNull();
  });
});

describe("rotate-encryption-key --dry-run no-write", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("decrypts + classifies + reports but NEVER calls prisma.update / $transaction; marker NOT written", async () => {
    setKeyEnv({ current: KEY_A });
    const legacyCiphertext = encrypt("legacy-for-dryrun");
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });

    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: "p1", apiKey: legacyCiphertext }])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});
    (prisma.systemConfig.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const result = await runRotation({ dryRun: true, resume: false });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.systemConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.systemConfig.deleteMany).not.toHaveBeenCalled();
    expect(result.provider.legacyDetected).toBe(1);
    expect(result.provider.reEncrypted).toBe(0);
  });
});

describe("rotate-encryption-key — sweep includes soft-deleted BackupDestination (Pitfall 4)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("visits a BackupDestination row with deletedAt IS NOT NULL", async () => {
    setKeyEnv({ current: KEY_A });
    const legacyConfig = JSON.stringify({ type: "local", path: "/backups" });
    const legacyCiphertext = encrypt(legacyConfig);
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });

    const deletedRow = {
      id: "bd-soft-deleted",
      config: legacyCiphertext,
      deletedAt: new Date("2026-01-01").toISOString(),
    };

    (prisma.provider.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.backupDestination.findMany as jest.Mock)
      .mockResolvedValueOnce([deletedRow])
      .mockResolvedValueOnce([]);
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});
    (prisma.systemConfig.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    let capturedWhere: any = null;
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      const tx = {
        backupDestination: {
          findUnique: jest.fn().mockResolvedValue({ config: legacyCiphertext }),
          update: jest.fn((args: any) => {
            capturedWhere = args.where;
            return {};
          }),
        },
      };
      return cb(tx);
    });

    const result = await runRotation({ dryRun: false, resume: false });

    // The findMany call must NOT include a deletedAt: null filter.
    const findArgs = (prisma.backupDestination.findMany as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(findArgs)).not.toContain("deletedAt");
    expect(result.backupDestination.reEncrypted).toBe(1);
    expect(capturedWhere.id).toBe("bd-soft-deleted");
  });
});