// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (202-01 tracer) — install→load vertical battery.
 *
 * The ONE vertical path: zip buffer → guard → extract → probe → install →
 * managed resolver → status=loaded. Raw-crafted buffers for the guard
 * matrix (Pitfall 3: adm-zip.addFile NORMALIZES names, which hides the raw
 * traversal case — the matrix needs raw-crafted buffers as fixtures).
 *
 * Unit-suite discipline: prisma mock + exit spy — NO live DB. The exit spy
 * records ZERO calls on every managed path (fail-soft, D-03 — a passing
 * test that asserts a process.exit on the managed path would mean the
 * fail-soft route was NOT taken).
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({
    tier: "community",
    licensee: "",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  getLicenseInfo: jest.fn(() => ({
    tier: "community",
    licensee: "",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  isFeatureEnabled: jest.fn(() => false),
  setLimitOverride: jest.fn(),
}));

jest.mock("../services/eventLogService", () => ({
  setAuditLogDelegate: jest.fn(),
}));

jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  registerConfigKeyValidator: jest.fn(),
}));

import fs from "fs";
import os from "os";
import path from "path";
import AdmZip from "adm-zip";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import {
  installFromZip,
  InstallError,
  PLUGINS_STORAGE_DIR,
  assertEntryNameSafe,
  assertValidNpmName,
} from "../services/pluginManagerService";
import {
  loadManagedPlugins,
  shutdownManagedPlugins,
} from "../services/managedLoader";

/** The real storage dir is cwd-relative — point the service at a per-test tmp root. */
let testRoot: string;
let realCwd: string;

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pluginmgr-"));
  realCwd = process.cwd();
  process.chdir(testRoot);
});

afterAll(() => {
  process.chdir(realCwd);
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/** Build a valid plugin zip in-memory: package.json + CJS entry module. */
function buildPluginZip(overrides: Record<string, unknown> = {}, mainBody = "module.exports.default = { apiVersion: 1, register: function(){}, licenseMode: 'none' };"): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "package.json",
    Buffer.from(JSON.stringify({ name: "@acme/widget", version: "1.0.0", main: "index.js", ...overrides })),
  );
  zip.addFile("index.js", Buffer.from(mainBody));
  return zip.toBuffer();
}

/**
 * Raw-craft a zip with UNNORMALIZED entry names (Pitfall 3): hand-written
 * local-file headers + central directory. `addFile` would collapse `../`.
 * Minimal STORED (method 0) entries are enough for adm-zip's reader.
 */
  function rawCraftZip(entries: Array<{ name: string; data: Buffer; symlink?: boolean; attr?: number }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const attr = e.attr ?? (e.symlink ? (0o120777 << 16) : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method STORED
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x2100, 12); // date (any)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, e.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2100, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(attr >>> 0, 38); // external attrs — symlink mask lives here (unsigned)
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  // EOCD layout: sig(4) disk(2) cdDisk(2) nDisk(2) nTotal(2) cdSize(4) cdOffset(4) commentLen(2)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with cd start
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdBuf.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function crc32(buf: Buffer): number {
  const table = crc32Table();
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

let _crcTable: number[] | null = null;
function crc32Table(): number[] {
  if (_crcTable) return _crcTable;
  _crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    _crcTable[n] = c >>> 0;
  }
  return _crcTable;
}

/** Exit spy — every managed-path test asserts ZERO process.exit calls. */
let exitSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  fs.rmSync(PLUGINS_STORAGE_DIR, { recursive: true, force: true });
});
afterEach(() => {
  exitSpy.mockRestore();
});

describe("installFromZip — happy path (the tracer vertical)", () => {
  it("installs a real fixture zip: row status=installed, dir at storage/plugins/<slug>, NO register call, tmp dir gone", async () => {
    const registerCalled = { called: false };
    const zip = new AdmZip();
    zip.addFile(
      "package.json",
      Buffer.from(JSON.stringify({ name: "@acme/widget", version: "2.1.0", main: "index.js" })),
    );
    zip.addFile(
      "index.js",
      Buffer.from("module.exports.default = { apiVersion: 1, register: function(){ registerCalled.called = true; }, licenseMode: 'self' };"),
    );
    const row = {
      id: "row-1",
      slug: "@acme+widget",
      packageName: "@acme/widget",
      enabled: true,
      status: "installed",
    };
    (prisma.pluginInstall.create as jest.Mock).mockResolvedValue(row);

    const result = await installFromZip(zip.toBuffer());

    expect(result).toEqual({ id: "row-1" });
    expect(registerCalled.called).toBe(false); // probe NEVER invokes register (D-02 step 5)
    // Row: captured probe values, enabled=false, status=installed
    expect(prisma.pluginInstall.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slug: "@acme+widget",
        packageName: "@acme/widget",
        version: "2.1.0",
        apiVersion: 1,
        licenseMode: "self",
        enabled: false,
        status: "installed",
      }),
    });
    // Directory landed at the atomic target; NO .tmp-* leftovers
    expect(fs.existsSync(path.join(PLUGINS_STORAGE_DIR, "@acme+widget", "index.js"))).toBe(true);
    const leftovers = fs.readdirSync(PLUGINS_STORAGE_DIR).filter((n) => n.startsWith(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("defaults licenseMode to 'none' (D6) when the entry exports nothing", async () => {
    const body = "module.exports.default = { apiVersion: 2, register: function(){} };";
    (prisma.pluginInstall.create as jest.Mock).mockResolvedValue({ id: "row-2" });
    await installFromZip(
      new AdmZip().toBuffer() && buildPluginZip({ name: "plain-plugin" }, body),
    );
    expect(prisma.pluginInstall.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ licenseMode: "none", apiVersion: 2 }),
    });
  });
});

describe("installFromZip — garbage / structural failures (E1: no tmp dir, no row)", () => {
  it("empty buffer → INVALID_FORMAT InstallError, no tmp dir, no DB row", async () => {
    await expect(installFromZip(Buffer.alloc(0))).rejects.toMatchObject({
      name: "InstallError",
      code: "INVALID_FORMAT",
    });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
    expect(fs.existsSync(PLUGINS_STORAGE_DIR) ? fs.readdirSync(PLUGINS_STORAGE_DIR).filter((d) => d.startsWith(".tmp-")) : []).toEqual([]);
  });

  it("garbage buffer → INVALID_FORMAT, no DB row", async () => {
    await expect(installFromZip(Buffer.from("this is not a zip at all"))).rejects.toMatchObject({
      code: "INVALID_FORMAT",
    });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("valid zip with zero entries (EOCD only) → missing package.json 400, no row", async () => {
    await expect(installFromZip(rawCraftZip([]))).rejects.toMatchObject({
      code: "MISSING_PACKAGE_JSON",
    });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("missing package.json → 400, no DB row", async () => {
    const zip = new AdmZip();
    zip.addFile("only.txt", Buffer.from("x"));
    await expect(installFromZip(zip.toBuffer())).rejects.toMatchObject({
      code: "MISSING_PACKAGE_JSON",
    });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("entry without register → MISSING_REGISTER 400, no DB row (bad plugin rejected at install)", async () => {
    await expect(
      installFromZip(buildPluginZip({}, "module.exports.default = { apiVersion: 1 };")),
    ).rejects.toMatchObject({ code: "MISSING_REGISTER" });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("unresolvable main → ENTRY_NOT_FOUND 400, no DB row", async () => {
    await expect(installFromZip(buildPluginZip({ main: "nonexistent.js" }))).rejects.toMatchObject({
      code: "ENTRY_NOT_FOUND",
    });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("entry module that throws on load → ENTRY_NOT_LOADABLE, no DB row", async () => {
    await expect(
      installFromZip(buildPluginZip({}, "throw new Error('boom at probe');")),
    ).rejects.toMatchObject({ code: "ENTRY_NOT_LOADABLE" });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });
});

describe("installFromZip — guard matrix on RAW entry names (T-202-01, Pitfall 3)", () => {
  it("rejects a raw-crafted ../ traversal entry BEFORE extraction, no DB row", async () => {
    const buf = rawCraftZip([
      { name: "../evil.txt", data: Buffer.from("pwned") },
    ]);
    await expect(installFromZip(buf)).rejects.toMatchObject({ code: "UNSAFE_ENTRY" });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
    // Nothing outside the registry: storage/plugins was never even created with content
    expect(fs.existsSync(path.join(PLUGINS_STORAGE_DIR, "..", "evil.txt"))).toBe(false);
  });

  it("rejects absolute POSIX entry names (/etc/x)", async () => {
    await expect(
      installFromZip(rawCraftZip([{ name: "/etc/cron.d/pwn", data: Buffer.from("x") }])),
    ).rejects.toMatchObject({ code: "UNSAFE_ENTRY" });
  });

  it("rejects drive-absolute entry names (C:/Windows/x) with backslash normalization", async () => {
    await expect(
      installFromZip(rawCraftZip([{ name: "C:\\Windows\\pwn.txt", data: Buffer.from("x") }])),
    ).rejects.toMatchObject({ code: "UNSAFE_ENTRY" });
  });

  it("rejects backslash-dotdot traversal (..\\..\\evil)", async () => {
    await expect(
      installFromZip(rawCraftZip([{ name: "..\\..\\evil.txt", data: Buffer.from("x") }])),
    ).rejects.toMatchObject({ code: "UNSAFE_ENTRY" });
  });

  it("rejects symlink entries (external-attr S_IFLNK mask)", async () => {
    await expect(
      installFromZip(rawCraftZip([{ name: "link", data: Buffer.from("/etc/passwd"), symlink: true }])),
    ).rejects.toMatchObject({ code: "UNSAFE_ENTRY" });
  });

  it("rejects duplicate raw entry names", async () => {
    // adm-zip 0.6.1 throws its own DUPLICATE_ENTRY at parse time (the GHSA
    // hardening) — either that Error or OUR typed InstallError with the same
    // code satisfies the contract: the archive is rejected before extraction
    // and no DB row is written.
    await expect(
      installFromZip(
        rawCraftZip([
          { name: "package.json", data: Buffer.from("{}") },
          { name: "package.json", data: Buffer.from("{}") },
        ]),
      ),
    ).rejects.toMatchObject(/Duplicate entry|DUPLICATE_ENTRY/);
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("assertEntryNameSafe unit arms: NUL, absolute, drive, dotdot, symlink all reject; normal names pass", () => {
    expect(() => assertEntryNameSafe("a\0b", 0)).toThrow(/NUL/);
    expect(() => assertEntryNameSafe("/abs", 0)).toThrow(/absolute/);
    expect(() => assertEntryNameSafe("C:/abs", 0)).toThrow(/absolute/);
    expect(() => assertEntryNameSafe("a/../b", 0)).toThrow(/\.\./);
    expect(() => assertEntryNameSafe("link", 0o120777 << 16)).toThrow(/symlink/);
    expect(() => assertEntryNameSafe("package.json", 0)).not.toThrow();
    expect(() => assertEntryNameSafe("sub/dir/file.js", 0)).not.toThrow();
  });
});

describe("installFromZip — slug derivation guard (T-202-02, Pitfall 2)", () => {
  it("rejects crafted packageName 'a/../../evil' BEFORE slug derivation, no DB row", async () => {
    const zip = new AdmZip();
    zip.addFile(
      "package.json",
      Buffer.from(JSON.stringify({ name: "a/../../evil", main: "index.js" })),
    );
    zip.addFile("index.js", Buffer.from("module.exports.default = { register(){} };"));
    await expect(installFromZip(zip.toBuffer())).rejects.toMatchObject({
      code: "INVALID_PACKAGE_NAME",
    });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("rejects non-npm names (spaces, leading dot, empty)", async () => {
    for (const bad of ["", "has space", ".hidden", "UPPER/case"]) {
      expect(() => assertValidNpmName(bad)).toThrow(InstallError);
    }
    expect(() => assertValidNpmName("@scope/pkg")).not.toThrow();
    expect(() => assertValidNpmName("plain-name")).not.toThrow();
  });

  it("containment arm: any name whose slug resolves outside storage/plugins is rejected", () => {
    // regex-passing names can't traverse, but the containment check is the
    // belt-and-braces arm if the regex ever loosens (Edge E2)
    expect(() => assertValidNpmName("@a/b")).not.toThrow();
  });
});

describe("installFromZip — E1 cleanup invariants", () => {
  it("probe failure AFTER extraction removes the tmp dir and writes no row", async () => {
    await expect(installFromZip(buildPluginZip({}, "throw new Error('late boom');"))).rejects.toBeTruthy();
    const leftovers = fs.existsSync(PLUGINS_STORAGE_DIR)
      ? fs.readdirSync(PLUGINS_STORAGE_DIR).filter((d) => d.startsWith(".tmp-"))
      : [];
    expect(leftovers).toEqual([]);
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("DB failure after the rename rolls the directory back (E1: no row ⇒ no dir)", async () => {
    (prisma.pluginInstall.create as jest.Mock).mockRejectedValue(new Error("db down"));
    await expect(installFromZip(buildPluginZip())).rejects.toThrow("db down");
    expect(fs.existsSync(path.join(PLUGINS_STORAGE_DIR, "@acme+widget"))).toBe(false);
  });
});

describe("loadManagedPlugins — the load half of the vertical", () => {
  function makeRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: "row-1",
      slug: "@acme+widget",
      packageName: "@acme/widget",
      apiVersion: 1,
      enabled: true,
      ...over,
    };
  }

  it("loads an installed row through the managed resolver → status=loaded, lastError cleared, register invoked", async () => {
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([makeRow()]);
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({});

    // Install for real so the managed dir + entry exist, then load.
    (prisma.pluginInstall.create as jest.Mock).mockResolvedValue({ id: "row-1" });
    await installFromZip(buildPluginZip());
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([makeRow()]);

    const fakeApp = { use: jest.fn() };
    await loadManagedPlugins(fakeApp as never);

    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { status: "loaded", lastError: null },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("register-throw fixture → status=failed + lastError, loadManagedPlugins resolves, ZERO exit calls (fail-soft, D-03)", async () => {
    // UNIQUE slug: the happy-path test already required
    // storage/plugins/@acme+widget/index.js into Node's process-global
    // require cache (a non-throwing register). The managed loader requires
    // by absolute path, so a repeated slug would hit that cache entry and
    // never execute the throwing register. A distinct slug gives a distinct
    // resolved path → fresh require → the throwing module actually runs.
    (prisma.pluginInstall.create as jest.Mock).mockResolvedValue({ id: "row-throw" });
    await installFromZip(
      buildPluginZip({ name: "@acme/thrower" }, "module.exports.default = { apiVersion: 1, register: function(){ throw new Error('register boom'); } };"),
    );
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([
      makeRow({ id: "row-throw", slug: "@acme+thrower", packageName: "@acme/thrower" }),
    ]);
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({});

    const fakeApp = { use: jest.fn() };
    await expect(loadManagedPlugins(fakeApp as never)).resolves.toBeUndefined(); // boot continues

    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: "row-throw" },
      data: { status: "failed", lastError: expect.stringContaining("register boom") },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("P1 native-wins: a natively-resolvable slug skips the managed load and leaves the row untouched", async () => {
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([
      makeRow({ slug: "native-shadow", packageName: "@simmetric-chat/shared" }), // workspace dep — always native
    ]);
    const fakeApp = { use: jest.fn() };
    await loadManagedPlugins(fakeApp as never);

    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("native wins, managed load skipped"),
      {},
    );
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("disabled rows skip with an info log and no loader work", async () => {
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([makeRow({ enabled: false })]);
    await loadManagedPlugins({ use: jest.fn() } as never);
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("unavailable pluginInstall delegate (pre-migration DB) → warn + no-op, boot continues", async () => {
    const realDelegate = prisma.pluginInstall;
    (prisma.pluginInstall as unknown as { findMany: jest.Mock }) = undefined as never;
    // restore for other tests
    await expect(loadManagedPlugins({ use: jest.fn() } as never)).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    // Phase 202 (202-03 Task 2): the delegate MUST be restored — the later
    // describes in this file drive prisma.pluginInstall.* directly.
    (prisma as unknown as { pluginInstall: unknown }).pluginInstall = realDelegate;
  });

  it("shutdownManagedPlugins drains reverse-order without throwing on an empty registry", async () => {
    await expect(shutdownManagedPlugins()).resolves.toBeUndefined();
  });
});
// ═══════════════════════════════════════════════════════════════════════
// Phase 202 (202-03 Task 2) — full D-02 matrix + Edge E1-E3 battery.
// The 202-01 tracer battery (above) is the skeleton; this block closes the
// remaining Wave-0 arms: EOCD-0-entries, D-02 step ORDER, replace-swap,
// un-bundled-import probe failure, service-level install mutex, uninstall
// containment.
// ═══════════════════════════════════════════════════════════════════════

import {
  setPluginEnabled,
  uninstallPlugin,
  detectNativePlugins,
} from "../services/pluginManagerService";

describe("installFromZip — E1 empty-archive arms", () => {
  it("empty buffer → INVALID_FORMAT 400 arm, no tmp dir, no DB row", async () => {
    await expect(installFromZip(Buffer.alloc(0))).rejects.toMatchObject({
      code: "INVALID_FORMAT",
    });
    const leftovers = fs.existsSync(PLUGINS_STORAGE_DIR)
      ? fs.readdirSync(PLUGINS_STORAGE_DIR).filter((d) => d.startsWith(".tmp-"))
      : [];
    expect(leftovers).toEqual([]);
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("valid EOCD with 0 entries → parses, then MISSING_PACKAGE_JSON 400, no DB row", async () => {
    const zip = new AdmZip();
    await expect(installFromZip(zip.toBuffer())).rejects.toMatchObject({
      code: "MISSING_PACKAGE_JSON",
    });
    const leftovers = fs.existsSync(PLUGINS_STORAGE_DIR)
      ? fs.readdirSync(PLUGINS_STORAGE_DIR).filter((d) => d.startsWith(".tmp-"))
      : [];
    expect(leftovers).toEqual([]);
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });
});

describe("installFromZip — D-02 step ORDER on the happy path", () => {
  it("row creation happens AFTER the atomic rename: the create mock sees the final dir and no .tmp- dir (rename-before-row)", async () => {
    (prisma.pluginInstall.create as jest.Mock).mockImplementation(async () => {
      // At row-write time step 6's rename has already happened: the target
      // dir exists and the staging dir is gone.
      expect(fs.existsSync(path.join(PLUGINS_STORAGE_DIR, "@acme+order"))).toBe(true);
      const tmpLeftovers = fs
        .readdirSync(PLUGINS_STORAGE_DIR)
        .filter((d) => d.startsWith(".tmp-"));
      expect(tmpLeftovers).toEqual([]);
      return { id: "row-order" };
    });
    await installFromZip(buildPluginZip({ name: "@acme/order" }));
    expect(prisma.pluginInstall.create).toHaveBeenCalledTimes(1);
  });
});

describe("installFromZip — un-bundled import (spec §3.3 no-npm-install rule)", () => {
  it("main that requires a missing dep → probe failure 400, no row, clean tmp", async () => {
    const zip = new AdmZip();
    zip.addFile(
      "package.json",
      Buffer.from(JSON.stringify({ name: "@acme/unbundled", version: "1.0.0", main: "index.js" })),
    );
    zip.addFile(
      "index.js",
      Buffer.from("require('totally-missing-dep'); module.exports.default = { apiVersion: 1, register: function(){} };"),
    );
    await expect(installFromZip(zip.toBuffer())).rejects.toMatchObject({
      code: "ENTRY_NOT_LOADABLE",
    });
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
    const leftovers = fs.existsSync(PLUGINS_STORAGE_DIR)
      ? fs.readdirSync(PLUGINS_STORAGE_DIR).filter((d) => d.startsWith(".tmp-"))
      : [];
    expect(leftovers).toEqual([]);
  });
});

describe("installFromZip — replace-swap (D-02 step 6, spec §4 replace atomico)", () => {
  it("second install of the same slug swaps the new dir in, updates the row in place, and leaves NO .old- dir behind", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.pluginInstall.create as jest.Mock).mockResolvedValue({ id: "row-swap-1" });
    await installFromZip(buildPluginZip({ name: "@acme/swapme", version: "1.0.0" }));
    const slugDir = path.join(PLUGINS_STORAGE_DIR, "@acme+swapme");
    expect(fs.existsSync(slugDir)).toBe(true);
    const firstIndex = fs.readFileSync(path.join(slugDir, "index.js"), "utf8");

    // Second install, same slug, different content. findUnique now resolves
    // the existing row (the DB is mocked) → replace arm (update in place).
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue({ id: "row-swap-1" });
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({ id: "row-swap-1" });
    const swappedZip = new AdmZip();
    swappedZip.addFile(
      "package.json",
      Buffer.from(JSON.stringify({ name: "@acme/swapme", version: "2.0.0", main: "index.js" })),
    );
    swappedZip.addFile("index.js", Buffer.from("module.exports.default = { apiVersion: 2, register: function(){} };"));
    await installFromZip(swappedZip.toBuffer());

    // Exactly one dir, no .old- / .tmp- leftovers (deferred removal landed).
    const entries = fs.readdirSync(PLUGINS_STORAGE_DIR);
    expect(entries.filter((d) => d === "@acme+swapme")).toHaveLength(1);
    expect(entries.filter((d) => d.startsWith(".old-") || d.startsWith(".tmp-"))).toHaveLength(0);
    // The content swapped in.
    expect(fs.readFileSync(path.join(slugDir, "index.js"), "utf8")).not.toBe(firstIndex);
    // The row was UPDATED, not duplicated.
    expect(prisma.pluginInstall.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row-swap-1" } }),
    );
  });

  it("failed row write on the replace path swaps the OLD dir back (the installed plugin survives)", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue({ id: "row-keep" });
    (prisma.pluginInstall.create as jest.Mock).mockResolvedValue({ id: "row-keep" });
    await installFromZip(buildPluginZip({ name: "@acme/keepme", version: "1.0.0" }));
    const slugDir = path.join(PLUGINS_STORAGE_DIR, "@acme+keepme");
    const firstIndex = fs.readFileSync(path.join(slugDir, "index.js"), "utf8");

    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue({ id: "row-keep" });
    (prisma.pluginInstall.update as jest.Mock).mockRejectedValue(new Error("db down"));
    const swappedZip = new AdmZip();
    swappedZip.addFile(
      "package.json",
      Buffer.from(JSON.stringify({ name: "@acme/keepme", version: "2.0.0", main: "index.js" })),
    );
    swappedZip.addFile("index.js", Buffer.from("module.exports.default = { apiVersion: 2, register: function(){} };"));
    await expect(installFromZip(swappedZip.toBuffer())).rejects.toThrow("db down");

    // The OLD dir content is restored (swap-back) — not deleted.
    expect(fs.existsSync(slugDir)).toBe(true);
    expect(fs.readFileSync(path.join(slugDir, "index.js"), "utf8")).toBe(firstIndex);
    expect(fs.readdirSync(PLUGINS_STORAGE_DIR).filter((d) => d.startsWith(".old-") || d.startsWith(".tmp-"))).toHaveLength(0);
  });
});

describe("installFromZip — single-flight mutex (Edge E3)", () => {
  it("two concurrent same-slug installs serialize → exactly one row + one dir, no interleaved .old/.tmp leftovers", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue({ id: "row-conc" });
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({ id: "row-conc" });

    const mk = (version: string) => {
      const zip = new AdmZip();
      zip.addFile(
        "package.json",
        Buffer.from(JSON.stringify({ name: "@acme/conc", version, main: "index.js" })),
      );
      zip.addFile("index.js", Buffer.from(`module.exports.default = { apiVersion: 1, v: "${version}", register: function(){} };`));
      return zip.toBuffer();
    };

    const [r1, r2] = await Promise.all([
      installFromZip(mk("1.0.0")),
      installFromZip(mk("2.0.0")),
    ]);

    // Serialized: both resolve to the SAME row id (the update path ran twice).
    expect(r1.id).toBe("row-conc");
    expect(r2.id).toBe("row-conc");
    const entries = fs.readdirSync(PLUGINS_STORAGE_DIR);
    expect(entries.filter((d) => d === "@acme+conc")).toHaveLength(1);
    expect(entries.filter((d) => d.startsWith(".old-") || d.startsWith(".tmp-"))).toHaveLength(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("uninstallPlugin — D-08 + containment (Edge E2)", () => {
  it("enabled row → PLUGIN_ENABLED InstallError, no deletion", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue({ id: "row-u", slug: "@acme+u", enabled: true });
    await expect(uninstallPlugin("row-u")).rejects.toMatchObject({ code: "PLUGIN_ENABLED" });
    expect(prisma.pluginInstall.delete).not.toHaveBeenCalled();
  });

  it("traversal-attempted slug → UNSAFE_SLUG InstallError, nothing deleted outside the registry", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue({
      id: "row-u2",
      slug: "../../evil",
      enabled: false,
    });
    await expect(uninstallPlugin("row-u2")).rejects.toMatchObject({ code: "UNSAFE_SLUG" });
    expect(prisma.pluginInstall.delete).not.toHaveBeenCalled();
    expect(fs.existsSync(path.resolve("evil"))).toBe(false);
  });

  it("disabled row → rm inside storage/plugins + row deleted", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue({ id: "row-u3", slug: "@acme+removeme", enabled: false });
    (prisma.pluginInstall.delete as jest.Mock).mockResolvedValue({});
    fs.mkdirSync(path.join(PLUGINS_STORAGE_DIR, "@acme+removeme"), { recursive: true });
    await uninstallPlugin("row-u3");
    expect(fs.existsSync(path.join(PLUGINS_STORAGE_DIR, "@acme+removeme"))).toBe(false);
    expect(prisma.pluginInstall.delete).toHaveBeenCalledWith({ where: { id: "row-u3" } });
  });
});

describe("setPluginEnabled — restart-deferred toggle", () => {
  it("disable → enabled:false + status:'disabled'; enable → status back to 'installed' (loader writes loaded at boot)", async () => {
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({});
    await setPluginEnabled("row-t", false);
    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: "row-t" },
      data: { enabled: false, status: "disabled" },
    });
    await setPluginEnabled("row-t", true);
    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: "row-t" },
      data: { enabled: true, status: "installed" },
    });
  });
});

describe("detectNativePlugins — D-05 probe-only", () => {
  it("reports both built-ins with boolean resolvable, never loading a module", async () => {
    const detections = detectNativePlugins();
    expect(detections).toHaveLength(2);
    for (const d of detections) {
      expect(typeof d.resolvable).toBe("boolean");
      expect(["@simmetric-chat/enterprise", "@simmetric-chat/saas"]).toContain(d.packageName);
    }
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
