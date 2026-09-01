// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";
import crypto from "crypto";

// Mock prisma BEFORE importing the verify module — the script imports the real
// prisma singleton, which would try to connect to Postgres otherwise.
jest.mock("../utils/prisma", () => {
  const mock = {
    provider: {
      findMany: jest.fn(),
    },
    backupDestination: {
      findMany: jest.fn(),
    },
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

import { encrypt, resetEncryptionKeyCache, getDecryptKeyChain } from "../services/encryptionService";
import { runVerification, ENCRYPTED_COLUMNS, classify } from "../../scripts/verify-encryption-key";
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

// runVerification returns the exit code in summary.exitCode and does NOT call
// process.exit — process.exit lives in main() so tests can assert the gate
// decision without a sentinel-throw interrupting the return value.
async function runVerify(opts?: { json?: boolean }): Promise<{ summary: Awaited<ReturnType<typeof runVerification>>; exitCode: number }> {
  const summary = await runVerification({ json: opts?.json ?? false });
  return { summary, exitCode: summary.exitCode };
}

describe("verify-encryption-key — ENCRYPTED_COLUMNS registry (Pitfall 2)", () => {
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

describe("verify-encryption-key — classify helper", () => {
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

describe("verify-encryption-key — verify gate below_active=0 pass", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    setKeyEnv({ current: KEY_B });
  });

  it("all rows decrypt with chain[0] → below_active === 0 → exit 0", async () => {
    const activeCt = encrypt("already-rotated");
    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: "p1", apiKey: activeCt }])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);

    const { summary, exitCode } = await runVerify();

    expect(exitCode).toBe(0);
    expect(summary?.belowActive).toBe(0);
    expect(summary?.total.active).toBe(1);
    expect(summary?.total.legacy).toBe(0);
    expect(summary?.total.undecryptable).toBe(0);
  });
});

describe("verify-encryption-key — verify gate below_active>0 fails non-zero", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("at least one row decrypts only with a previous/scrypt key → below_active > 0 → exit 1", async () => {
    setKeyEnv({ current: KEY_A });
    const legacyCt = encrypt("legacy-row");
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });

    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: "p1", apiKey: legacyCt }])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);

    const { summary, exitCode } = await runVerify();

    expect(exitCode).toBe(1);
    expect(summary?.belowActive).toBe(1);
    expect(summary?.total.legacy).toBe(1);
  });
});

describe("verify-encryption-key — verify includes soft-deleted BackupDestination", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    setKeyEnv({ current: KEY_B });
  });

  it("a BackupDestination row with deletedAt IS NOT NULL IS visited and classified", async () => {
    const activeCt = encrypt("active-backup-config");
    const deletedRow = {
      id: "bd-soft-deleted",
      config: activeCt,
      deletedAt: new Date("2026-01-01").toISOString(),
    };

    (prisma.provider.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.backupDestination.findMany as jest.Mock)
      .mockResolvedValueOnce([deletedRow])
      .mockResolvedValueOnce([]);

    const { summary, exitCode } = await runVerify();

    // The findMany call must NOT include a deletedAt: null filter (Pitfall 4).
    const findArgs = (prisma.backupDestination.findMany as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(findArgs)).not.toContain("deletedAt");

    expect(exitCode).toBe(0);
    expect(summary?.perColumn.backupDestination?.visited).toBe(1);
    expect(summary?.perColumn.backupDestination?.active).toBe(1);
  });
});

describe("verify-encryption-key — verify reports undecryptable", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("a row no key in the chain can decrypt is reported as undecryptable (separate from legacy) and exits non-zero", async () => {
    setKeyEnv({ current: KEY_A });
    const undecryptableCt = encrypt("will-be-undecryptable");
    setKeyEnv({ current: KEY_C }); // KEY_A not in chain

    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: "p1", apiKey: undecryptableCt }])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);

    const { summary, exitCode } = await runVerify();

    expect(exitCode).toBe(1);
    expect(summary?.total.undecryptable).toBe(1);
    expect(summary?.total.legacy).toBe(0);
    expect(summary?.belowActive).toBe(0); // undecryptable is separate from legacy
  });
});

describe("verify-encryption-key — verify pre-rotation audit mode", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("running the pass reports the current active/legacy mix WITHOUT writing (read-only by construction)", async () => {
    setKeyEnv({ current: KEY_A });
    const legacyCt = encrypt("legacy-audit-row");
    setKeyEnv({ current: KEY_B, previous: [KEY_A] });
    const activeCt = encrypt("active-audit-row");

    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([
        { id: "p1", apiKey: activeCt },
        { id: "p2", apiKey: legacyCt },
      ])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);

    const { summary, exitCode } = await runVerify();

    // Audit reports the mix: 1 active + 1 legacy. Gate fails (below_active=1)
    // because this is a pre-rotation state — that's the audit signal.
    expect(summary?.total.active).toBe(1);
    expect(summary?.total.legacy).toBe(1);
    expect(summary?.belowActive).toBe(1);
    expect(exitCode).toBe(1);

    // Read-only: the verify pass only calls findMany. No $transaction, no update
    // method is even defined on the mocked prisma (the factory omits them) — so
    // any write attempt would throw at runtime. Assert no write API exists.
    expect((prisma as unknown as Record<string, unknown>).$transaction).toBeUndefined();
  });
});

describe("verify-encryption-key — --json machine-readable output", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    setKeyEnv({ current: KEY_B });
  });

  it("emits JSON to stdout when --json is set", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const activeCt = encrypt("json-active");
    (prisma.provider.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: "p1", apiKey: activeCt }])
      .mockResolvedValueOnce([]);
    (prisma.backupDestination.findMany as jest.Mock).mockResolvedValue([]);

    await runVerify({ json: true });

    // The first console.log call should be a JSON-parseable string.
    expect(logSpy).toHaveBeenCalled();
    const firstCall = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(firstCall);
    expect(parsed).toHaveProperty("below_active", 0);
    expect(parsed).toHaveProperty("total");
    expect(parsed).toHaveProperty("per_column");

    logSpy.mockRestore();
  });
});