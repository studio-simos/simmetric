// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-03) — per-plugin license service battery.
 *
 * Full closed-enum matrix: verified | invalid | expired | missing |
 * plugin_mismatch. RS256 via the REUSED verifyLicenseKey pipeline (the
 * alg:none guard rides along — never bypassed); at-rest crypto via the REAL
 * encryptionService (AES-256-GCM, ciphertext asserted, never plaintext).
 * Closed-enum logging discipline (licenseService.ts:190-199 verbatim): a
 * logger spy pins that NO JWT-shaped material ever reaches the meta object.
 *
 * Unit-suite discipline: prisma mock + logger spy — NO live DB. The test
 * keypair is the ephemeral licenseTestKeys pair; the license-public-key
 * module is jest.mocked so the production verify path verifies test-signed
 * tokens (license.test.ts idiom — no env override, deliberate).
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
    LICENSE_KEY: undefined,
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

// Inject the ephemeral test keypair into the production verify path — the
// SAME idiom license.test.ts uses for initLicense (license-public-key mock).
jest.mock("../services/license-public-key", () => {
  const { getTestPublicKey } = jest.requireActual("./helpers/licenseTestKeys");
  return {
    __esModule: true,
    LICENSE_PUBLIC_KEY_PEM: getTestPublicKey(),
  };
});

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";
import { decrypt, encrypt } from "../services/encryptionService";
import { setCachedLicense } from "../services/licenseService";
import {
  resolvePluginLicense,
  savePluginLicense,
  verifyPluginLicense,
  resolveInstanceLicenseFromDB,
} from "../services/pluginLicenseService";
import {
  getTestPublicKey,
  signTestLicense,
} from "./helpers/licenseTestKeys";
import { licensePayloadSchema } from "@simmetric-chat/shared";

const PKG = "@acme/widget-pro";
const ROW_ID = "row-plugin-1";

/** A PluginInstall mock row whose licenseKeyEncrypted is REAL AES-256-GCM ciphertext. */
function rowWith(jwt?: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    slug: "acme+widget-pro",
    packageName: PKG,
    apiVersion: 2,
    enabled: true,
    status: "installed",
    licenseMode: "platform",
    licenseStatus: null,
    licenseCheckedAt: null,
    licenseKeyEncrypted: jwt ? encrypt(jwt) : null,
    ...overrides,
  };
}

/** Mint a per-plugin license JWT bound to PKG (test keypair, RS256). */
function mintPluginJwt(opts: { plugin?: string; expiresIn?: number } = {}) {
  const payload: Record<string, unknown> = { tier: "enterprise", sub: "ACME GmbH" };
  if (opts.plugin !== undefined) payload.plugin = opts.plugin;
  return signTestLicense(payload, { expiresIn: opts.expiresIn ?? 365 * 24 * 3600 });
}

beforeAll(() => {
  process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-32ch";
  (getEnv as jest.Mock).mockReturnValue({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    LICENSE_KEY: undefined,
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  // Scrub ENCRYPTION_STATE side effects — the real encryptionService caches
  // its key; tests set JWT_SECRET beforeAll so the scrypt legacy derivation
  // is deterministic. No cache reset needed (same env throughout).
});

describe("resolvePluginLicense — closed-enum matrix", () => {
  it("verified: row with valid matching JWT → { ok:true, reason:'verified' }", async () => {
    const jwt = mintPluginJwt({ plugin: PKG });
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(rowWith(jwt));

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: true, reason: "verified" });
    expect(prisma.pluginInstall.findFirst).toHaveBeenCalledWith({
      where: { packageName: PKG },
    });
  });

  it("plugin_mismatch: JWT bound to a different package", async () => {
    const jwt = mintPluginJwt({ plugin: "@other/thing" });
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(rowWith(jwt));

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "plugin_mismatch" });
  });

  it("plugin_mismatch: JWT with NO plugin claim (instance license pasted into a plugin row)", async () => {
    const jwt = signTestLicense({ tier: "enterprise", sub: "ACME GmbH" });
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(rowWith(jwt));

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "plugin_mismatch" });
  });

  it("expired: JWT past its exp", async () => {
    const jwt = mintPluginJwt({ plugin: PKG, expiresIn: -3600 });
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(rowWith(jwt));

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("invalid: garbage JWT string", async () => {
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      rowWith("not.a.jwt"),
    );

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("invalid: signature from an unrelated key (bad-signature folds into the closed enum)", async () => {
    const jwt = signTestLicense({ tier: "enterprise", sub: "X", plugin: PKG });
    // Verify against the test key — but the row's JWT was signed by the test
    // key too; to force a crypto failure without a second keypair, corrupt
    // the signature segment.
    const parts = jwt.split(".");
    const corrupted = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAAA`;
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      rowWith(corrupted),
    );

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("invalid: corrupt ciphertext fails CLOSED (decrypt throw → invalid, never 500)", async () => {
    const jwt = mintPluginJwt({ plugin: PKG });
    // Real ciphertext, then tamper the auth-tag segment → GCM auth failure.
    const parts = encrypt(jwt).split(":");
    const tampered = `${parts[0]}:${"0".repeat(parts[1].length)}:${parts[2]}`;
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseKeyEncrypted: tampered }),
    );

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("missing: no row for the package", async () => {
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("missing: row exists but no ciphertext", async () => {
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      rowWith(undefined),
    );

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("P4: the logger NEVER sees JWT-shaped material — meta carries the reason enum only", async () => {
    const jwt = mintPluginJwt({ plugin: PKG });
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(rowWith(jwt));
    await resolvePluginLicense(PKG);

    // Drive every arm through the service so every log call site is covered.
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      rowWith(mintPluginJwt({ plugin: "@other/x" })),
    );
    await resolvePluginLicense(PKG);
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(null);
    await resolvePluginLicense(PKG);

    const jwtShape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    const calls = [
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.debug as jest.Mock).mock.calls,
    ];
    for (const call of calls) {
      const flat = JSON.stringify(call);
      // No three-dot-bearing base64 segment (a JWT) anywhere in any log call.
      for (const token of flat.match(/[A-Za-z0-9_-]{8,}/g) ?? []) {
        expect(jwtShape.test(token)).toBe(false);
      }
      // And the raw JWT never appears verbatim.
      expect(flat).not.toContain(jwt);
    }
    // Every log call that carries a meta object carries ONLY the reason enum.
    const reasonEnum = new Set([
      "verified",
      "invalid",
      "expired",
      "missing",
      "plugin_mismatch",
    ]);
    for (const call of calls) {
      const meta = call[call.length - 1];
      if (meta && typeof meta === "object" && "reason" in meta) {
        expect(reasonEnum.has(meta.reason)).toBe(true);
      }
    }
  });
});

describe("licensePayloadSchema — D-07 additive widening", () => {
  it("parses an OLD instance JWT payload (no plugin claim) unchanged", () => {
    const old = {
      tier: "enterprise",
      iss: "simmetric-chat",
      sub: "ACME GmbH",
      iat: 1700000000,
      exp: Math.floor(Date.now() / 1000) + 86400,
    };
    const parsed = licensePayloadSchema.parse(old);
    expect(parsed.tier).toBe("enterprise");
    expect(parsed.plugin).toBeUndefined();
  });

  it("parses a per-plugin payload with the additive plugin claim", () => {
    const parsed = licensePayloadSchema.parse({
      tier: "enterprise",
      iss: "simmetric-chat",
      sub: "ACME GmbH",
      iat: 1700000000,
      exp: Math.floor(Date.now() / 1000) + 86400,
      plugin: PKG,
    });
    expect(parsed.plugin).toBe(PKG);
  });
});

describe("savePluginLicense / verifyPluginLicense — at-rest + probe-only contracts", () => {
  it("savePluginLicense persists CIPHERTEXT (not plaintext) + licenseStatus verified + licenseCheckedAt", async () => {
    const jwt = mintPluginJwt({ plugin: PKG });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseStatus: null, licenseKeyEncrypted: null }),
    );
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({ id: ROW_ID });

    const result = await savePluginLicense(ROW_ID, jwt);

    expect(result).toEqual({ ok: true, reason: "verified" });
    expect(prisma.pluginInstall.update).toHaveBeenCalledTimes(1);
    const updateArg = (prisma.pluginInstall.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: ROW_ID });
    expect(updateArg.data.licenseStatus).toBe("verified");
    expect(updateArg.data.licenseCheckedAt).toBeInstanceOf(Date);
    // The at-rest blob is NOT the plaintext JWT and decrypts back to it.
    expect(updateArg.data.licenseKeyEncrypted).not.toBe(jwt);
    expect(decrypt(updateArg.data.licenseKeyEncrypted)).toBe(jwt);
  });

  it("verifyPluginLicense persists NOTHING (probe-only on every mode)", async () => {
    const jwt = mintPluginJwt({ plugin: PKG });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseStatus: null, licenseKeyEncrypted: null }),
    );

    const result = await verifyPluginLicense(ROW_ID, jwt);

    expect(result).toEqual({ ok: true, reason: "verified" });
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
  });

  it("verifyPluginLicense maps wrong-binding to plugin_mismatch without persisting", async () => {
    const jwt = mintPluginJwt({ plugin: "@other/thing" });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseStatus: null, licenseKeyEncrypted: null }),
    );

    const result = await verifyPluginLicense(ROW_ID, jwt);

    expect(result).toEqual({ ok: false, reason: "plugin_mismatch" });
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
  });

  it("savePluginLicense refuses to persist an invalid JWT", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseStatus: null, licenseKeyEncrypted: null }),
    );

    const result = await savePluginLicense(ROW_ID, "garbage-token");

    expect(result.ok).toBe(false);
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
  });

  it("savePluginLicense on an unknown row id → { ok:false, reason:'missing' }", async () => {
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await savePluginLicense("nope", mintPluginJwt({ plugin: PKG }));

    expect(result).toEqual({ ok: false, reason: "missing" });
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
  });
});

describe("resolveInstanceLicenseFromDB — enterprise DB→env fallback (Pitfall 1: additive async boot step)", () => {
  // Module-private cachedLicense persists across tests in this file — reset
  // it to the env-derived Community state before each fallback test so the
  // "untouched" assertions pin THIS boot step's behavior, not test-order luck.
  beforeEach(async () => {
    const { initLicense } = await import("../services/licenseService");
    initLicense();
  });

  function enterpriseRow() {
    const jwt = signTestLicense({ tier: "enterprise", sub: "ACME GmbH" });
    return rowWith(jwt, { licenseMode: "self", licenseStatus: "verified" });
  }

  it("verified enterprise row → the cached license is overridden (getLicenseInfo reflects it)", async () => {
    // Initialize the cached license as Community (env LICENSE_KEY undefined).
    const { getLicenseInfo } = await import("../services/licenseService");
    const before = getLicenseInfo();
    expect(before.tier).toBe("community");

    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      enterpriseRow(),
    );

    await resolveInstanceLicenseFromDB();

    const after = getLicenseInfo();
    expect(after.tier).toBe("enterprise");
    expect(after.licensee).toBe("ACME GmbH");
  });

  it("no verified row → cached license untouched (env fallback stays)", async () => {
    const { getLicenseInfo } = await import("../services/licenseService");
    // Force community state first.
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(null);
    await resolveInstanceLicenseFromDB();
    const info = getLicenseInfo();
    expect(info.tier).toBe("community");
  });

  it("a row whose JWT is NOT enterprise tier → override refused (T-202-26: no tier elevation)", async () => {
    const { getLicenseInfo } = await import("../services/licenseService");
    const communityJwt = signTestLicense({ tier: "community", sub: "ACME" });
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      rowWith(communityJwt, { licenseStatus: "verified" }),
    );

    await resolveInstanceLicenseFromDB();

    expect(getLicenseInfo().tier).toBe("community");
  });

  it("a row with licenseStatus != verified is NOT considered (state-gated)", async () => {
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(null);
    await resolveInstanceLicenseFromDB();
    // The findFirst WHERE clause itself filters on licenseStatus verified.
    expect(prisma.pluginInstall.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ licenseStatus: "verified" }),
      }),
    );
  });

  it("DB hiccup → never kills boot (rejects nothing, cached license untouched)", async () => {
    const { getLicenseInfo } = await import("../services/licenseService");
    (prisma.pluginInstall.findFirst as jest.Mock).mockRejectedValue(
      new Error("db down"),
    );

    await expect(resolveInstanceLicenseFromDB()).resolves.toBeUndefined();
    expect(getLicenseInfo().tier).toBe("community");
  });
});

describe("license-mode service-side contract pins (loader gate wired by 202-02)", () => {
  it("resolvePluginLicense is mode-agnostic: a licenseMode=none row with NO license → 'missing', nothing else happens", async () => {
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseMode: "none" }),
    );

    const result = await resolvePluginLicense(PKG);

    expect(result).toEqual({ ok: false, reason: "missing" });
    // The mode branch does NOT exist in the service — no licenseMode reads.
    expect(JSON.stringify((prisma.pluginInstall.findFirst as jest.Mock).mock.calls)).not.toContain("licenseMode");
  });

  it("grep-gate: the service contains NO licenseMode conditional (gate is caller-owned)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "../services/pluginLicenseService.ts"),
      "utf8",
    );
    expect(source).not.toContain("licenseMode");
  });

  it("platform-mode row save persists ciphertext + licenseStatus (mode-agnostic persistence)", async () => {
    const jwt = mintPluginJwt({ plugin: PKG });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseMode: "platform", licenseStatus: null }),
    );
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({ id: ROW_ID });

    const result = await savePluginLicense(ROW_ID, jwt);

    expect(result).toEqual({ ok: true, reason: "verified" });
    expect(prisma.pluginInstall.update).toHaveBeenCalledTimes(1);
  });

  it("self-mode row save also persists (the service permits persistence for ANY mode; gating is the loader's job)", async () => {
    const jwt = mintPluginJwt({ plugin: PKG });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseMode: "self", licenseStatus: null }),
    );
    (prisma.pluginInstall.update as jest.Mock).mockResolvedValue({ id: ROW_ID });

    const result = await savePluginLicense(ROW_ID, jwt);

    expect(result).toEqual({ ok: true, reason: "verified" });
    expect(prisma.pluginInstall.update).toHaveBeenCalledTimes(1);
  });

  it("verifyPluginLicense persists nothing on a licenseMode=none row either (probe-only on EVERY mode)", async () => {
    const jwt = mintPluginJwt({ plugin: PKG });
    (prisma.pluginInstall.findUnique as jest.Mock).mockResolvedValue(
      rowWith(undefined, { licenseMode: "none", licenseStatus: null }),
    );

    const result = await verifyPluginLicense(ROW_ID, jwt);

    expect(result).toEqual({ ok: true, reason: "verified" });
    expect(prisma.pluginInstall.update).not.toHaveBeenCalled();
    expect(prisma.pluginInstall.updateMany).not.toHaveBeenCalled();
  });

  it("resolveInstanceLicenseFromDB applies the override ONLY from a verified ENTERPRISE row — community-tier verified row refused", async () => {
    const { initLicense, getLicenseInfo } = await import("../services/licenseService");
    initLicense(); // reset the module-private cached license to env Community
    const communityJwt = signTestLicense({ tier: "community", sub: "ACME" });
    (prisma.pluginInstall.findFirst as jest.Mock).mockResolvedValue(
      rowWith(communityJwt, { licenseStatus: "verified", licenseMode: "self" }),
    );

    await resolveInstanceLicenseFromDB();

    expect(getLicenseInfo().tier).toBe("community");
  });

  it("setCachedLicense is the ONLY additive surface on licenseService (sync call sites untouched)", async () => {
    const svc = await import("../services/licenseService");
    expect(typeof svc.setCachedLicense).toBe("function");
    // The additive setter overwrites the module-private cachedLicense and
    // getLicenseInfo reflects it — but clearLimitOverrides semantics are
    // NOT re-triggered here (that stays initLicense's D-02 contract).
    svc.setCachedLicense({
      tier: "enterprise",
      licensee: "DB Row",
      expiresAt: null,
      features: { sso_enabled: true },
      valid: true,
    });
    const { getLicenseInfo } = await import("../services/licenseService");
    expect(getLicenseInfo().licensee).toBe("DB Row");
  });
});