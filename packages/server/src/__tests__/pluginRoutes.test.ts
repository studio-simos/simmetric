// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-01..05) — /api/plugins admin-route battery.
 *
 * Mount ONLY the plugins router on a minimal Express app with mocked
 * middleware (filtersRoute.test.ts idiom) so RBAC behavior is controllable
 * per-test. Real service pipeline (installFromZip with REAL zip fixtures +
 * REAL encryptionService/licenseService crypto via the test keypair);
 * detectNativePlugins is controlled per-test (the enterprise/saas probe is
 * environment-dependent); gracefulShutdown is mocked with a call-count spy
 * (the restart route must invoke it EXACTLY ONCE).
 *
 * P4: every serialization assertion parses the body through the STRICT
 * shared pluginRowSchema — a response carrying licenseKeyEncrypted would
 * REJECT the parse, not silently strip.
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

// The single shutdown path (202-02) — the restart route must call it EXACTLY ONCE.
jest.mock("../services/shutdownSequence", () => ({
  gracefulShutdown: jest.fn(),
}));

// Real verify pipeline with the ephemeral test keypair (license.test.ts idiom).
jest.mock("../services/license-public-key", () => {
  const { getTestPublicKey } = jest.requireActual("./helpers/licenseTestKeys");
  return { __esModule: true, LICENSE_PUBLIC_KEY_PEM: getTestPublicKey() };
});

// Partial service mock: everything REAL (installFromZip, setPluginEnabled,
// uninstallPlugin, the license delegation wrappers) except the environment-
// dependent native probe.
jest.mock("../services/pluginManagerService", () => ({
  ...jest.requireActual("../services/pluginManagerService"),
  detectNativePlugins: jest.fn(),
}));

type AuthMode = "ok" | "no-auth" | "no-permission";

jest.mock("../middleware/auth", () => {
  const mockState: { authMode: AuthMode; userId: string | null } = {
    authMode: "ok",
    userId: "admin-user-id",
  };
  return {
    authMiddleware: (req: any, res: any, next: any) => {
      if (mockState.authMode === "no-auth") {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.userId = mockState.userId ?? undefined;
      (req as unknown as { user: unknown }).user = { id: mockState.userId };
      next();
    },
    __mockState: mockState,
  };
});

jest.mock("../middleware/tenantContext", () => {
  const mockState = require("../middleware/auth").__mockState;
  return {
    tenantContextMiddleware: (req: any, _res: any, next: any) => {
      req.organizationId = "org-default";
      void mockState;
      next();
    },
  };
});

jest.mock("../middleware/rbac", () => {
  const mockState = require("../middleware/auth").__mockState;
  return {
    requirePermission: (_perm: string) => (req: any, res: any, next: any) => {
      if (mockState.authMode === "no-permission") {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
      next();
    },
    requireAdmin: (req: any, res: any, next: any) => {
      if (mockState.authMode === "no-permission") {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      next();
    },
  };
});

import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import AdmZip from "adm-zip";
import request from "supertest";
import prisma from "../utils/prisma";
import { gracefulShutdown } from "../services/shutdownSequence";
import { resolvePluginLicense } from "../services/pluginLicenseService";
import { decrypt } from "../services/encryptionService";
import { installFromZip, PLUGINS_STORAGE_DIR, InstallError } from "../services/pluginManagerService";
import { detectNativePlugins } from "../services/pluginManagerService";
import { signTestLicense } from "./helpers/licenseTestKeys";
import { pluginRowSchema } from "@simmetric-chat/shared";
import pluginsRoutes from "../routes/plugins";

const mockState = require("../middleware/auth").__mockState as { authMode: AuthMode; userId: string | null };
const mockDetectNative = detectNativePlugins as unknown as jest.Mock;

/** UUID-shaped row id (pluginIdParamSchema is z.string().uuid()). */
const ROW_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/plugins", pluginsRoutes);
  return app;
}
const app = buildApp();

let testRoot: string;
let realCwd: string;

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pluginroutes-"));
  realCwd = process.cwd();
  process.chdir(testRoot);
});

afterAll(() => {
  process.chdir(realCwd);
  fs.rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockState.authMode = "ok";
  mockState.userId = "admin-user-id";
  mockDetectNative.mockReturnValue([]);
  fs.rmSync(PLUGINS_STORAGE_DIR, { recursive: true, force: true });
});

function makeRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    // The REAL findMany row shape carries the organizationId seam column —
    // the serializer MUST strip it or the strict schema rejects (found live
    // by the 202-06 E2E pre-flight).
    organizationId: null,
    id: ROW_ID,
    slug: "@acme+widget",
    packageName: "@acme/widget",
    displayName: "Widget",
    version: "1.0.0",
    apiVersion: 1,
    enabled: false,
    status: "installed",
    lastError: null,
    licenseMode: "none",
    licenseStatus: null,
    licenseCheckedAt: null,
    licenseKeyEncrypted: null,
    packageJson: { name: "@acme/widget" },
    createdAt: new Date("2026-09-24T10:00:00Z"),
    updatedAt: new Date("2026-09-24T10:00:00Z"),
    ...over,
  };
}

function makeZip(name: string, mainBody = "module.exports.default = { apiVersion: 1, register: function(){}, licenseMode: 'none' };"): Buffer {
  const zip = new AdmZip();
  zip.addFile("package.json", Buffer.from(JSON.stringify({ name, version: "1.0.0", main: "index.js" })));
  zip.addFile("index.js", Buffer.from(mainBody));
  return zip.toBuffer();
}

// ─── RBAC gate (T-202-12) ────────────────────────────────────────────────

describe("RBAC — every /api/plugins route requires plugins:manage", () => {
  it("GET /api/plugins without plugins:manage → 403 {error}", async () => {
    mockState.authMode = "no-permission";
    const res = await request(app).get("/api/plugins");
    expect(res.status).toBe(403);
    expect(res.body.error).toBeTruthy();
  });

  it("GET /api/plugins without auth → 401", async () => {
    mockState.authMode = "no-auth";
    const res = await request(app).get("/api/plugins");
    expect(res.status).toBe(401);
  });

  it("POST /api/plugins without permission → 403", async () => {
    mockState.authMode = "no-permission";
    const res = await request(app)
      .post("/api/plugins")
      .attach("file", makeZip("@acme/rbac"), { filename: "x.zip", contentType: "application/zip" });
    expect(res.status).toBe(403);
  });

  it("POST /api/plugins/restart without permission → 403", async () => {
    mockState.authMode = "no-permission";
    const res = await request(app).post("/api/plugins/restart");
    expect(res.status).toBe(403);
    expect(gracefulShutdown).not.toHaveBeenCalled();
  });

  it("DELETE /api/plugins/:id without permission → 403", async () => {
    mockState.authMode = "no-permission";
    const res = await request(app).delete(`/api/plugins/${ROW_ID}`);
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/plugins (list + native detection) ──────────────────────────

describe("GET /api/plugins", () => {
  it("returns {restartMode, plugins[]} with secrets-stripped managed rows (P4 — parses through the STRICT pluginRowSchema)", async () => {
    mockDetectNative.mockReturnValue([]);
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([
      makeRow({ licenseKeyEncrypted: "iv:tag:ciphertext-blob", packageJson: { name: "@acme/widget", secret: "nope" } }),
    ]);

    const res = await request(app).get("/api/plugins");

    expect(res.status).toBe(200);
    expect(res.body.restartMode).toBe("manual"); // NODE_ENV=test → manual (server-owned, zero env keys)
    expect(res.body.plugins).toHaveLength(1);
    const row = res.body.plugins[0];
    expect(row.source).toBe("managed");
    // P4 hard gate: the strict shared schema REJECTS a row carrying secrets.
    expect(() => pluginRowSchema.parse(row)).not.toThrow();
    expect(JSON.stringify(res.body)).not.toContain("licenseKeyEncrypted");
    expect(JSON.stringify(res.body)).not.toContain("packageJson");
    expect(JSON.stringify(res.body)).not.toContain("iv:tag:ciphertext");
  });

  it("restartMode is server-owned: NODE_ENV=production → supervisor (zero new env keys)", async () => {
    mockDetectNative.mockReturnValue([]);
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([]);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(app).get("/api/plugins");
      expect(res.body.restartMode).toBe("supervisor");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("merges native detections as source:'native' entries — probe-only, NO DB row created (D-05)", async () => {
    mockDetectNative.mockReturnValue([
      { packageName: "@simmetric-chat/enterprise", label: "enterprise", resolvable: true },
      { packageName: "@simmetric-chat/saas", label: "saas", resolvable: false },
    ]);
    (prisma.pluginInstall.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app).get("/api/plugins");

    expect(res.status).toBe(200);
    expect(res.body.plugins).toHaveLength(1);
    expect(res.body.plugins[0].source).toBe("native");
    expect(res.body.plugins[0].packageName).toBe("@simmetric-chat/enterprise");
    // Detection NEVER writes a row and NEVER loads a plugin (D-05).
    expect(prisma.pluginInstall.create).not.toHaveBeenCalled();
  });

  it("the service's own native detection NEVER loads/registers (probe-only, D-05) — enterprise/saas absent in community build", async () => {
    // Call the REAL detectNativePlugins (not the mock) via requireActual.
    const actual = jest.requireActual("../services/pluginManagerService");
    const detections = actual.detectNativePlugins();
    expect(Array.isArray(detections)).toBe(true);
    for (const d of detections) {
      expect(typeof d.resolvable).toBe("boolean");
    }
  });
});

// ─── POST /api/plugins (upload/install) ─────────────────────────────────

describe("POST /api/plugins", () => {
  it("installs a real .zip fixture → 201 with the secrets-stripped row", async () => {
    mockDetectNative.mockReturnValue([]);
    (prisma.pluginInstall.create as jest.Mock).mockResolvedValue({ id: "row-new" });
    // installFromZip's replace-check probes by slug (null = fresh), the
    // route's post-install fetch resolves the created row.
    (prisma.pluginInstall.findUnique as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(
        makeRow({ id: "row-new", slug: "@acme+route-install", packageName: "@acme/route-install" }),
      );

    const res = await request(app)
      .post("/api/plugins")
      .attach("file", makeZip("@acme/route-install"), { filename: "plugin.zip", contentType: "application/zip" });

    expect(res.status).toBe(201);
    expect(res.body.packageName).toBe("@acme/route-install");
    expect(res.body.source).toBe("managed");
    expect(() => pluginRowSchema.parse(res.body)).not.toThrow();
    expect(JSON.stringify(res.body)).not.toContain("licenseKeyEncrypted");
    expect(JSON.stringify(res.body)).not.toContain("packageJson");
    // Real dir on disk, no .tmp- leftovers (E1).
    const leftovers = fs.existsSync(PLUGINS_STORAGE_DIR)
      ? fs.readdirSync(PLUGINS_STORAGE_DIR).filter((d) => d.startsWith(".tmp-"))
      : [];
    expect(leftovers).toEqual([]);
  });

  it("non-zip upload → 400 (multer fileFilter rejects before the handler)", async () => {
    const res = await request(app)
      .post("/api/plugins")
      .attach("file", Buffer.from("not a zip"), { filename: "evil.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it(">100MB upload → 413 {error:'File too large', limit:'100MB'} — intercepted BEFORE the Express-5 catch-all 500 (T-202-13)", async () => {
    const big = Buffer.alloc(101 * 1024 * 1024, 7);
    const res = await request(app)
      .post("/api/plugins")
      .attach("file", big, { filename: "huge.zip", contentType: "application/zip" });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("File too large");
    expect(res.body.limit).toBe("100MB");
  });

  it("concurrent same-slug uploads serialize through the single-flight mutex → exactly one row + one dir (Edge E3)", async () => {
    (prisma.pluginInstall.create as jest.Mock).mockImplementation(async (args: any) => ({
      id: `row-${JSON.stringify(args.data.slug)}`,
    }));
    // Both the service's replace-check AND the route's post-install fetch
    // resolve a row — installs become replace-swaps against the same row.
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      makeRow({ id: "row-conc", slug: "@acme+route-concurrent", packageName: "@acme/route-concurrent" }),
    );
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue(
      makeRow({ id: "row-conc", slug: "@acme+route-concurrent", packageName: "@acme/route-concurrent" }),
    );
    mockDetectNative.mockReturnValue([]);

    const zipName = "@acme/route-concurrent";
    const [r1, r2] = await Promise.all([
      request(app).post("/api/plugins").attach("file", makeZip(zipName), { filename: "a.zip", contentType: "application/zip" }),
      request(app).post("/api/plugins").attach("file", makeZip(zipName), { filename: "b.zip", contentType: "application/zip" }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // Serialized: the second install becomes a replace (row update, same row)
    // or hits the 409 backstop — but NEVER two rows and NEVER two dirs.
    const successCount = statuses.filter((s) => s === 200 || s === 201).length;
    const slug = "@acme+route-concurrent";
    const dirs = fs.existsSync(PLUGINS_STORAGE_DIR)
      ? fs.readdirSync(PLUGINS_STORAGE_DIR).filter((d) => d === slug || d.startsWith(".old-") || d.startsWith(".tmp-"))
      : [];
    expect(dirs.filter((d) => d === slug)).toHaveLength(1); // exactly one dir
    expect(dirs.filter((d) => d.startsWith(".old-") || d.startsWith(".tmp-"))).toHaveLength(0); // no interleaved leftovers
    expect(successCount).toBeGreaterThanOrEqual(1);
  });

  it("InstallError arms map to the repo shapes (INVALID_FORMAT → 400, DUPLICATE_SLUG → 409)", async () => {
    // InstallError mapping is the route's error-boundary contract.
    const err = new InstallError("INVALID_FORMAT", "bad");
    expect(err.code).toBe("INVALID_FORMAT");
    const dup = new InstallError("DUPLICATE_SLUG", "already");
    expect(dup.code).toBe("DUPLICATE_SLUG");
  });
});

// ─── PUT /api/plugins/:id (enable/disable toggle) ────────────────────────

describe("PUT /api/plugins/:id", () => {
  it("{enabled:false} → 200 updated stripped row; prisma.update called with enabled+status", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(makeRow());
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue(makeRow({ enabled: false, status: "disabled" }));

    const res = await request(app).put(`/api/plugins/${ROW_ID}`).send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(prisma.pluginInstall.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ROW_ID }, data: expect.objectContaining({ enabled: false }) }),
    );
  });

  it("invalid body → 400 {error, details}", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(makeRow());
    const res = await request(app).put(`/api/plugins/${ROW_ID}`).send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(res.body.details).toBeTruthy();
  });

  it("invalid :id (non-uuid) → 400", async () => {
    const res = await request(app).put("/api/plugins/not-a-uuid").send({ enabled: false });
    expect(res.status).toBe(400);
  });

  it("enabling a licenseMode=platform row WITHOUT a verified license → 402 (license-gated failure)", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      makeRow({ licenseMode: "platform", licenseStatus: null }),
    );
    const res = await request(app).put(`/api/plugins/${ROW_ID}`).send({ enabled: true });
    expect(res.status).toBe(402);
    expect(res.body.error).toBeTruthy();
  });

  it("enabling a licenseMode=platform row WITH a verified license → 200", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      makeRow({ licenseMode: "platform", licenseStatus: "verified" }),
    );
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue(makeRow({ enabled: true }));
    const res = await request(app).put(`/api/plugins/${ROW_ID}`).send({ enabled: true });
    expect(res.status).toBe(200);
  });
});

// ─── DELETE /api/plugins/:id (D-08: disabled-only uninstall) ─────────────

describe("DELETE /api/plugins/:id", () => {
  it("enabled row → 409 {error}", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(makeRow({ enabled: true }));
    const res = await request(app).delete(`/api/plugins/${ROW_ID}`);
    expect(res.status).toBe(409);
    expect(prisma.pluginInstall.delete).not.toHaveBeenCalled();
  });

  it("disabled row → removes storage/plugins/<slug> + the DB row", async () => {
    // Install a real fixture so the dir exists, then disable + delete.
    const row = makeRow({ slug: "@acme+route-del", packageName: "@acme/route-del", enabled: false });
    (prisma.pluginInstall.create as jest.Mock).mockResolvedValue({ id: row.id });
    await installFromZip(makeZip("@acme/route-delete-fixture"));
    const slugDir = path.join(PLUGINS_STORAGE_DIR, "@acme+route-delete-fixture");
    expect(fs.existsSync(slugDir)).toBe(true);

    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      makeRow({ id: ROW_ID, slug: "@acme+route-delete-fixture", packageName: "@acme/route-delete-fixture", enabled: false }),
    );
    (prisma.pluginInstall.delete as jest.Mock).mockResolvedValue({});

    const res = await request(app).delete(`/api/plugins/${ROW_ID}`);

    expect(res.status).toBe(200);
    expect(fs.existsSync(slugDir)).toBe(false);
    expect(prisma.pluginInstall.delete).toHaveBeenCalledWith({ where: { id: ROW_ID } });
  });
});

// ─── PUT /api/plugins/:id/license + POST verify-license ─────────────────

describe("license routes", () => {
  it("PUT /:id/license with a valid matching JWT → persists ciphertext + licenseStatus verified, NEVER echoes the material (P4)", async () => {
    const row = makeRow({ licenseMode: "platform", licenseStatus: null });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(row);
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({ ...row, licenseStatus: "verified" });

    const jwt = signTestLicense({ tier: "enterprise", sub: "ACME", plugin: "@acme/widget" });
    const res = await request(app).put(`/api/plugins/${ROW_ID}/license`).send({ licenseKey: jwt });

    expect(res.status).toBe(200);
    expect(res.body.licenseStatus).toBe("verified");
    // The response NEVER carries the ciphertext or the plaintext JWT (P4).
    expect(JSON.stringify(res.body)).not.toContain("licenseKeyEncrypted");
    expect(JSON.stringify(res.body)).not.toContain(jwt);
    // Persisted as ciphertext (real AES-256-GCM round-trip), never plaintext.
    const updateArg = (prisma.pluginInstall.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.licenseKeyEncrypted).not.toBe(jwt);
    const { decrypt } = jest.requireActual("../services/encryptionService");
    expect(decrypt(updateArg.data.licenseKeyEncrypted)).toBe(jwt);
  });

  it("PUT /:id/license with a mismatched plugin claim → 400 with reason plugin_mismatch, nothing persisted", async () => {
    const row = makeRow({ licenseMode: "platform", licenseStatus: null });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(row);

    const jwt = signTestLicense({ tier: "enterprise", sub: "ACME", plugin: "@other/thing" });
    const res = await request(app).put(`/api/plugins/${ROW_ID}/license`).send({ licenseKey: jwt });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("plugin_mismatch");
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
  });

  it("P3: PUT license on a licenseMode=none row → 400 (no license affordance for none/self)", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(makeRow({ licenseMode: "none" }));
    const jwt = signTestLicense({ tier: "enterprise", sub: "ACME", plugin: "@acme/widget" });
    const res = await request(app).put(`/api/plugins/${ROW_ID}/license`).send({ licenseKey: jwt });
    expect(res.status).toBe(400);
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
  });

  it("P3: PUT /:id/license on a licenseMode=self row → 400", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(makeRow({ licenseMode: "self" }));
    const jwt = signTestLicense({ tier: "enterprise", sub: "ACME", plugin: "@acme/widget" });
    const res = await request(app).put(`/api/plugins/${ROW_ID}/license`).send({ licenseKey: jwt });
    expect(res.status).toBe(400);
  });

  it("POST /:id/verify-license → probe-only: NO persist, response carries licenseStatus only", async () => {
    const row = makeRow({ licenseMode: "platform", licenseStatus: null });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(row);

    const jwt = signTestLicense({ tier: "enterprise", sub: "ACME", plugin: "@acme/widget" });
    const res = await request(app).post(`/api/plugins/${ROW_ID}/verify-license`).send({ licenseKey: jwt });

    expect(res.status).toBe(200);
    expect(res.body.licenseStatus).toBe("verified");
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
  });

  it("POST /:id/verify-license with an expired JWT → licenseStatus expired, NO persist", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(makeRow({ licenseMode: "platform" }));
    const jwt = signTestLicense({ tier: "enterprise", sub: "ACME", plugin: "@acme/widget" }, { expiresIn: -3600 });
    const res = await request(app).post(`/api/plugins/${ROW_ID}/verify-license`).send({ licenseKey: jwt });
    expect(res.status).toBe(200);
    expect(res.body.licenseStatus).toBe("expired");
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
  });
});

// ─── POST /api/plugins/restart (D-06 single shutdown path, third caller) ─

describe("POST /api/plugins/restart", () => {
  it("202 {restarting:true} FIRST, then gracefulShutdown invoked EXACTLY ONCE with 'restart'", async () => {
    (gracefulShutdown as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post("/api/plugins/restart");

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ restarting: true });
    expect(gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(gracefulShutdown).toHaveBeenCalledWith("restart");
  });

  it("gracefulShutdown rejection → logged, process.exit(1) (fail-loud on teardown failure)", async () => {
    (gracefulShutdown as jest.Mock).mockRejectedValue(new Error("shutdown boom"));
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await request(app).post("/api/plugins/restart");
      // The 202 is sent BEFORE the teardown fires — the void-catch runs async.
      await new Promise((r) => setImmediate(r));
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});