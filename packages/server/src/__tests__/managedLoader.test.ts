// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (202-02, Wave-0 gap closure) — managedLoader battery.
 *
 * Resolver chain + fail-soft/fail-loud matrix + the per-row license gate
 * (PLGM-03 D4/D6/P3):
 *
 * - P1 native-wins: a natively-resolvable package shadows the managed row.
 * - D-03 fail-soft: a managed register/load throw records status=failed +
 *   lastError and boot CONTINUES — ZERO process.exit calls on the managed
 *   path (mutually exclusive with the fail-loud arm below).
 * - P2 fail-loud: the NATIVE loader arm (no managedResolver, no failureMode)
 *   keeps process.exit(1) byte-identically — pinned via createPluginLoader
 *   + the __pluginResolver save/restore idiom (saasLoader.test.ts :123-136).
 * - P3/D6: licenseMode none/self rows NEVER consult resolvePluginLicense —
 *   the gate is caller-owned and the mock spy asserts ZERO calls.
 * - D4: a platform row without a verified license stays status=installed —
 *   never loaded, never failed; the reason enum is logged (P4), never the
 *   license material.
 *
 * Real-fixture idiom (202-01 tracer battery): installFromZip writes REAL
 * plugin dirs under PLUGINS_STORAGE_DIR; the battery wipes it per-test.
 * resolvePluginLicense is MOCKED here — the service's own matrix lives in
 * pluginLicense.test.ts (202-05); this battery pins the LOADER's use of it.
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

// The loader battery controls the license verdicts directly — the SERVICE
// matrix (closed enum, crypto, P4) is pinned in pluginLicense.test.ts.
jest.mock("../services/pluginLicenseService", () => ({
  resolvePluginLicense: jest.fn(),
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
import { installFromZip, PLUGINS_STORAGE_DIR } from "../services/pluginManagerService";
import {
  loadManagedPlugins,
  shutdownManagedPlugins,
} from "../services/managedLoader";
import {
  createPluginLoader,
  __pluginResolver,
} from "../services/pluginLoaderCore";
import { resolvePluginLicense } from "../services/pluginLicenseService";

let testRoot: string;
let realCwd: string;

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mloader-"));
  realCwd = process.cwd();
  process.chdir(testRoot);
});

afterAll(() => {
  process.chdir(realCwd);
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/** Exit spy — the managed-path tests assert ZERO calls; the fail-loud pin asserts ONE. */
let exitSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  fs.rmSync(PLUGINS_STORAGE_DIR, { recursive: true, force: true });
  (resolvePluginLicense as jest.Mock).mockReset();
});

afterEach(() => {
  exitSpy.mockRestore();
});

/** Build a valid plugin zip in-memory: package.json + CJS entry module. */
function buildPluginZip(
  name: string,
  mainBody = "module.exports.default = { apiVersion: 1, register: function(){} };",
): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "package.json",
    Buffer.from(JSON.stringify({ name, version: "1.0.0", main: "index.js" })),
  );
  zip.addFile("index.js", Buffer.from(mainBody));
  return zip.toBuffer();
}

/** Install a fixture for real, then point findMany at its row. */
async function installFixture(name: string, mainBody?: string): Promise<Record<string, unknown>> {
  const slug = name.replace("/", "+");
  (prisma.pluginInstall.create as jest.Mock).mockResolvedValue({ id: `row-${slug}` });
  await installFromZip(buildPluginZip(name, mainBody));
  return {
    id: `row-${slug}`,
    slug,
    packageName: name,
    apiVersion: 1,
    enabled: true,
    licenseMode: "none",
  };
}

async function loadRow(row: Record<string, unknown>): Promise<void> {
  (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([row]);
  (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({});
  await loadManagedPlugins({ use: jest.fn() } as never);
}

describe("managedLoader — resolver chain + fail-soft/fail-loud (Wave-0 gap closure)", () => {
  it("P1 native-wins: a natively-resolvable package skips the managed load, row untouched, exit spy ZERO calls", async () => {
    await loadRow({
      id: "row-native",
      slug: "native-shadow",
      packageName: "@simmetric-chat/shared", // workspace dep — always native
      apiVersion: 1,
      enabled: true,
      licenseMode: "none",
    });

    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("native wins, managed load skipped"),
      {},
    );
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("native absent + managed install present → managed resolver loads the module, row flips to loaded, exit spy ZERO calls", async () => {
    const row = await installFixture("@acme/loader-happy");
    await loadRow({ ...row, licenseMode: "none" });

    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { status: "loaded", lastError: null },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("native absent + managed register-throw → row status=failed + lastError, boot continues, ZERO exit calls (fail-soft, D-03)", async () => {
    const row = await installFixture(
      "@acme/loader-thrower",
      "module.exports.default = { apiVersion: 1, register: function(){ throw new Error('register boom'); } };",
    );
    await loadRow({ ...row, licenseMode: "none" });

    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { status: "failed", lastError: expect.stringContaining("register boom") },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("native absent + managed load-throw (broken module) → status=failed, ZERO exit calls (D-03 fail-soft on the LOAD arm too)", async () => {
    // Install a CLEAN fixture (the probe rejects broken modules), then
    // corrupt the entry on disk so the managed resolver's require() throws —
    // this exercises the load arm, not the probe arm.
    const row = await installFixture("@acme/loader-broken");
    fs.writeFileSync(
      path.join(PLUGINS_STORAGE_DIR, row.slug as string, "index.js"),
      "module.exports.default = { apiVersion: 1, register: function(){} }; this is ( not valid javascript",
    );
    await loadRow({ ...row, licenseMode: "none" });

    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { status: "failed", lastError: expect.any(String) },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("P2 fail-loud: the NATIVE loader arm with a broken install calls exit(1) byte-identically (mutually exclusive with the fail-soft arms above)", async () => {
    // Save/restore idiom (saasLoader.test.ts :123-136): swap __pluginResolver
    // for a native arm whose resolve throws a NON-MODULE_NOT_FOUND error —
    // the fail-loud arm (no managedResolver, no failureMode → default).
    const realResolve = __pluginResolver.resolve.bind(__pluginResolver);
    const realLoad = __pluginResolver.load.bind(__pluginResolver);
    __pluginResolver.resolve = jest.fn(() => {
      throw new Error("EACCES: permission denied");
    }) as unknown as typeof __pluginResolver.resolve;
    try {
      const loader = createPluginLoader({
        name: "native-p2-pin",
        specifier: "@simmetric-chat/enterprise",
        acceptedApiVersions: [1],
        label: "enterprise",
        buildContext: (app, registries) => ({ app, registries }) as never,
      });
      await loader.loadPlugin({ use: jest.fn() } as never);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      __pluginResolver.resolve = realResolve;
      __pluginResolver.load = realLoad;
    }
  });

  it("disabled managed row → skipped with log info, loader not invoked, exit spy ZERO calls", async () => {
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([
      {
        id: "row-disabled",
        slug: "@acme+disabled",
        packageName: "@acme/disabled",
        apiVersion: 1,
        enabled: false,
        licenseMode: "none",
      },
    ]);
    await loadManagedPlugins({ use: jest.fn() } as never);

    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
    expect(resolvePluginLicense).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });
});

describe("managedLoader — per-row license gate (PLGM-03 D4/D6/P3)", () => {
  it("D6/P3 pin: licenseMode=none row with NO license data → resolvePluginLicense NEVER called and the row LOADS (third parties installable without a JWT)", async () => {
    const row = await installFixture("@acme/gate-none");
    await loadRow({ ...row, licenseMode: "none" });

    expect(resolvePluginLicense).not.toHaveBeenCalled();
    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { status: "loaded", lastError: null },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("D6/P3 pin: licenseMode=self row → loader NEVER calls resolvePluginLicense (no gate at all)", async () => {
    const row = await installFixture("@acme/gate-self");
    await loadRow({ ...row, licenseMode: "self" });

    expect(resolvePluginLicense).not.toHaveBeenCalled();
    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { status: "loaded", lastError: null },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("D4 pin: licenseMode=platform row WITHOUT a verified license → row stays installed (never loaded, never failed)", async () => {
    const row = await installFixture("@acme/gate-unlicensed");
    (resolvePluginLicense as jest.Mock).mockResolvedValue({ ok: false, reason: "missing" });

    await loadRow({ ...row, licenseMode: "platform" });

    expect(resolvePluginLicense).toHaveBeenCalledWith("@acme/gate-unlicensed");
    // Row stays installed — NO status write at all (never loaded, never failed).
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not licensed — row stays installed"),
      { reason: "missing" },
    );
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("D4 pin: licenseMode=platform row WITH a verified license (plugin claim matches) → row loads", async () => {
    const row = await installFixture("@acme/gate-licensed");
    (resolvePluginLicense as jest.Mock).mockResolvedValue({ ok: true, reason: "verified" });

    await loadRow({ ...row, licenseMode: "platform" });

    expect(resolvePluginLicense).toHaveBeenCalledWith("@acme/gate-licensed");
    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { status: "loaded", lastError: null },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("platform row with plugin claim MISMATCH → reason plugin_mismatch, row stays installed", async () => {
    const row = await installFixture("@acme/gate-mismatch");
    (resolvePluginLicense as jest.Mock).mockResolvedValue({ ok: false, reason: "plugin_mismatch" });

    await loadRow({ ...row, licenseMode: "platform" });

    expect(resolvePluginLicense).toHaveBeenCalledWith("@acme/gate-mismatch");
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not licensed — row stays installed"),
      { reason: "plugin_mismatch" },
    );
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("platform row that fails a probe arm BEFORE the gate (broken register) → fail-soft failed (gate never consulted for the failure path)", async () => {
    const row = await installFixture(
      "@acme/gate-thrower",
      "module.exports.default = { apiVersion: 1, register: function(){ throw new Error('gate-path boom'); } };",
    );
    (resolvePluginLicense as jest.Mock).mockResolvedValue({ ok: true, reason: "verified" });

    await loadRow({ ...row, licenseMode: "platform" });

    // The gate ran (platform row) and passed; the register throw is fail-soft.
    expect(resolvePluginLicense).toHaveBeenCalledTimes(1);
    expect(prisma.pluginInstall.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { status: "failed", lastError: expect.stringContaining("gate-path boom") },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    await shutdownManagedPlugins();
  });

  it("P4: license-gate logs carry ONLY the reason enum — never license-shaped material", async () => {
    const row = await installFixture("@acme/gate-p4");
    (resolvePluginLicense as jest.Mock).mockResolvedValue({ ok: false, reason: "expired" });

    await loadRow({ ...row, licenseMode: "platform" });

    const reasonEnum = new Set(["verified", "invalid", "expired", "missing", "plugin_mismatch"]);
    const calls = [
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
    ];
    for (const call of calls) {
      const meta = call[call.length - 1];
      if (meta && typeof meta === "object" && "reason" in meta) {
        expect(reasonEnum.has(meta.reason)).toBe(true);
      }
    }
    await shutdownManagedPlugins();
  });
});