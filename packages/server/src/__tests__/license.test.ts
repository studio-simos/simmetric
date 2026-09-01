// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    workspace: { count: jest.fn() },
    project: { count: jest.fn() },
  },
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(),
}));

// Mock the structured logger so the new verifyLicenseKey / initLicense
// diagnostics can be asserted without writing to console/log files. The mock
// is shared across the file; the new describe block clears the relevant spies
// in beforeEach so each test captures only its own calls.
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the embedded public key module so initLicense() verifies test-signed
// tokens. The test keypair is generated at module load by licenseTestKeys.ts.
// This mock is how tests inject the test public key into the production code
// path WITHOUT an env override (the env override was removed deliberately —
// it would allow self-signing in real deployments).
jest.mock("../services/license-public-key", () => {
  const { getTestPublicKey } = jest.requireActual("./helpers/licenseTestKeys") as typeof import("./helpers/licenseTestKeys");
  return {
    __esModule: true,
    LICENSE_PUBLIC_KEY_PEM: getTestPublicKey(),
  };
});

import { initLicense, getLicenseInfo, isFeatureEnabled, getFeatureLimit, verifyLicenseKey } from "../services/licenseService";
import { getEnv } from "../config/env";
import { requireFeature, requireFeatureLimit } from "../middleware/license";
import { logger } from "../utils/logger";
import {
  getTestPublicKey,
  getTestPrivateKey,
  getOtherPublicKey,
  signTestLicense,
} from "./helpers/licenseTestKeys";
import type { Request } from "express";

// Helper: build the env mock object for initLicense tests. Only LICENSE_KEY
// is needed — the public key is injected via the license-public-key mock above.
function envWith(key: string | undefined) {
  return { LICENSE_KEY: key };
}

describe("licenseService — Community Edition", () => {
  beforeAll(() => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
  });

  it("falls back to Community when LICENSE_KEY is absent", () => {
    const info = initLicense();
    expect(info.tier).toBe("community");
    expect(info.licensee).toBe("Community Edition");
    expect(info.expiresAt).toBeNull();
  });

  it("sets all boolean feature flags to false in Community", () => {
    const info = initLicense();
    expect(info.features.sso_enabled).toBe(false);
    expect(info.features.audit_log_immutable).toBe(false);
    expect(info.features.white_label).toBe(false);
  });

  it("sets numeric limits to Community values", () => {
    const info = initLicense();
    expect(info.features.max_workspaces).toBe(3);
    expect(info.features.max_projects).toBe(3);
    expect(info.features.custom_agents).toBe(3);
  });
});

describe("licenseService — invalid LICENSE_KEY", () => {
  beforeAll(() => {
    (getEnv as jest.Mock).mockReturnValue(envWith("not-a-valid-jwt"));
  });

  it("falls back to Community when LICENSE_KEY is invalid", () => {
    const info = initLicense();
    expect(info.tier).toBe("community");
    expect(info.licensee).toBe("Community Edition");
  });
});

describe("isFeatureEnabled", () => {
  it("returns false for disabled Community features", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    expect(isFeatureEnabled("sso_enabled")).toBe(false);
    expect(isFeatureEnabled("white_label")).toBe(false);
  });

  it("returns false for numeric features (not boolean)", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    expect(isFeatureEnabled("max_workspaces")).toBe(false);
  });
});

describe("getFeatureLimit", () => {
  it("returns the numeric limit for Community", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    expect(getFeatureLimit("max_workspaces")).toBe(3);
    expect(getFeatureLimit("max_projects")).toBe(3);
  });

  it("returns 0 for boolean-only features", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    expect(getFeatureLimit("sso_enabled")).toBe(0);
  });
});

describe("requireFeature middleware", () => {
  let requireFeatureFn: (flag: any) => any;

  beforeAll(() => {
    requireFeatureFn = require("../middleware/license").requireFeature;
  });

  it("returns 402 when feature is disabled", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();

    const middleware = requireFeatureFn("sso_enabled");
    const req = {};
    const state: any = { statusCode: 200, body: {} };
    const res: any = {
      status(code: number) {
        state.statusCode = code;
        return res;
      },
      json(data: any) {
        state.body = data;
        return res;
      },
    };
    const next = jest.fn();

    middleware(req, res, next);
    expect(state.statusCode).toBe(402);
    expect(state.body.feature).toBe("sso_enabled");
    expect(state.body.tier).toBe("community");
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks audit_log_immutable without enterprise license", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();

    const middleware = requireFeatureFn("audit_log_immutable");
    const state: any = { statusCode: 200, body: {} };
    const res: any = {
      status(code: number) { state.statusCode = code; return res; },
      json(data: any) { state.body = data; return res; },
    };
    const next = jest.fn();

    middleware({}, res, next);
    expect(state.statusCode).toBe(402);
    expect(state.body.feature).toBe("audit_log_immutable");
  });

  it("blocks custom_agents without enterprise license", () => {
    // Phase 148 D-09: custom_agents is now numeric (3 community / Infinity enterprise).
    // isFeatureEnabled("custom_agents") returns false (numeric !== boolean) per
    // licenseService.ts:263-267, so requireFeature returns 402. This test documents
    // the legacy boolean-gate behavior; the future custom-agents UI will use
    // requireFeatureLimit("custom_agents", "customAgent") (the model union needs a
    // new customAgent case — F-15, follow-up for the custom-agents UI milestone).
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();

    const middleware = requireFeatureFn("custom_agents");
    const state: any = { statusCode: 200, body: {} };
    const res: any = {
      status(code: number) { state.statusCode = code; return res; },
      json(data: any) { state.body = data; return res; },
    };
    const next = jest.fn();

    middleware({}, res, next);
    expect(state.statusCode).toBe(402);
    expect(state.body.feature).toBe("custom_agents");
  });
});

// ─── requireFeatureLimit middleware ──────────────────────────────────

describe("requireFeatureLimit middleware", () => {
  let prisma: any;

  beforeEach(() => {
    prisma = require("../utils/prisma").default;
  });

  it("allows creation when count is below limit", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockResolvedValue(1); // 1 < 3

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const state: any = { statusCode: 200, body: {} };
    const res: any = {
      status(code: number) { state.statusCode = code; return res; },
      json(data: any) { state.body = data; return res; },
    };
    const next = jest.fn();

    await middleware({} as any, res, next);
    expect(state.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
  });

  it("blocks creation when count equals limit", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockResolvedValue(3); // 3 >= 3

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const state: any = { statusCode: 200, body: {} };
    const res: any = {
      status(code: number) { state.statusCode = code; return res; },
      json(data: any) { state.body = data; return res; },
    };
    const next = jest.fn();

    await middleware({} as any, res, next);
    expect(state.statusCode).toBe(402);
    expect(state.body.feature).toBe("max_workspaces");
    expect(state.body.limit).toBe(3);
    expect(state.body.current).toBe(3);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks creation when count exceeds limit", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.project.count.mockResolvedValue(5); // 5 >= 3

    const middleware = requireFeatureLimit("max_projects", "project");
    const state: any = { statusCode: 200, body: {} };
    const res: any = {
      status(code: number) { state.statusCode = code; return res; },
      json(data: any) { state.body = data; return res; },
    };
    const next = jest.fn();

    await middleware({} as any, res, next);
    expect(state.statusCode).toBe(402);
    expect(state.body.feature).toBe("max_projects");
    expect(state.body.limit).toBe(3);
  });

  it("allows creation with unlimited limit (Enterprise)", async () => {
    const licenseKey = signTestLicense({ tier: "enterprise", sub: "Test Corp" });
    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    initLicense();
    prisma.workspace.count.mockResolvedValue(100);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const state: any = { statusCode: 200, body: {} };
    const res: any = {
      status(code: number) { state.statusCode = code; return res; },
      json(data: any) { state.body = data; return res; },
    };
    const next = jest.fn();

    await middleware({} as any, res, next);
    expect(state.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
  });

  it("calls next() if count query fails (fail-open)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockRejectedValue(new Error("DB error"));

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const state: any = { statusCode: 200, body: {} };
    const res: any = {
      status(code: number) { state.statusCode = code; return res; },
      json(data: any) { state.body = data; return res; },
    };
    const next = jest.fn();

    await middleware({} as any, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ─── Enterprise License Tests ──────────────────────────────────────

describe("licenseService — Enterprise Edition", () => {
  it("accepts a valid enterprise license JWT signed with the matching private key", () => {
    const licenseKey = signTestLicense({
      tier: "enterprise",
      sub: "Acme Corp",
      features: { sso_enabled: true, max_workspaces: 50 },
    });

    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    const info = initLicense();

    expect(info.tier).toBe("enterprise");
    expect(info.licensee).toBe("Acme Corp");
    expect(info.features.sso_enabled).toBe(true);
    expect(info.features.max_workspaces).toBe(50);
  });

  it("rejects license when verified with the wrong public key", () => {
    const licenseKey = signTestLicense({
      tier: "enterprise",
      sub: "Hacker Corp",
    });

    // Signed with the test private key, but verified against an unrelated
    // public key → signature mismatch → bad-signature verdict. (initLicense
    // uses the mocked test public key, so we exercise verifyLicenseKey
    // directly with the OTHER key to test the "wrong key" path.)
    const verdict = verifyLicenseKey(licenseKey, getOtherPublicKey());
    expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects expired enterprise license at startup", () => {
    const jwt = require("jsonwebtoken");
    const iat = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
    const exp = Math.floor(Date.now() / 1000) - 1;
    const licenseKey = jwt.sign(
      { tier: "enterprise", iss: "simmetric-chat", sub: "Old Corp", iat, exp },
      getTestPrivateKey(),
      { algorithm: "RS256" },
    );

    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    const info = initLicense();

    expect(info.tier).toBe("community");
  });

  it("enterprise features override community defaults", () => {
    const licenseKey = signTestLicense({
      tier: "enterprise",
      sub: "Test Corp",
      features: { sso_enabled: true, max_workspaces: 100 },
    });

    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    const info = initLicense();

    expect(info.features.sso_enabled).toBe(true);
    expect(info.features.max_workspaces).toBe(100);
  });
});

// ─── Graceful Degradation Tests ──────────────────────────────────────

describe("licenseService — graceful degradation on expiry", () => {
  it("degrades to Community when license expires during runtime", () => {
    const licenseKey = signTestLicense(
      { tier: "enterprise", sub: "Expiring Corp" },
      { expiresIn: 1 },
    );

    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    const info = initLicense();
    expect(info.tier).toBe("enterprise");

    // Simulate runtime expiry by setting expiresAt to a past date
    const cachedRef = getLicenseInfo();
    (cachedRef as any).expiresAt = new Date(Date.now() - 10000).toISOString();

    const degradedInfo = getLicenseInfo();
    expect(degradedInfo.tier).toBe("community");
    expect(degradedInfo.features.sso_enabled).toBe(false);
  });

  it("does not degrade if license is still valid", () => {
    const licenseKey = signTestLicense({ tier: "enterprise", sub: "Valid Corp" });
    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    initLicense();

    const info = getLicenseInfo();
    expect(info.tier).toBe("enterprise");
  });

  it("Community tier (no expiresAt) never degrades", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();

    const info = getLicenseInfo();
    expect(info.tier).toBe("community");
    expect(info.expiresAt).toBeNull();
    const info2 = getLicenseInfo();
    expect(info2.tier).toBe("community");
  });
});

// ─── White-label Settings Enforcement ──────────────────────────────────

describe("white_label enforcement in settings", () => {
  it("returns false for white_label in Community", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    expect(isFeatureEnabled("white_label")).toBe(false);
  });

  it("returns true for white_label in Enterprise", () => {
    const licenseKey = signTestLicense({ tier: "enterprise", sub: "Branded Corp" });
    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    initLicense();
    expect(isFeatureEnabled("white_label")).toBe(true);
  });
});

// ─── verifyLicenseKey (LIC-01) ──────────────────────────────────────────
// Discriminated verdict: { ok:true, payload, expiresAt } | { ok:false, reason }.
// reason is the closed enum LicenseVerifyReason:
//   "missing" | "expired" | "bad-signature" | "malformed" | "schema-mismatch".

describe("verifyLicenseKey", () => {
  // Unique sentinel fixtures so the no-secret-in-log canary can grep for them
  // unambiguously. These strings MUST NOT appear in any captured logger arg.
  // (Private keys are test-only fixtures, never used in production.)
  const PRIV = getTestPrivateKey();
  const PUB = getTestPublicKey();

  const makePayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    tier: "enterprise",
    iss: "simmetric-chat",
    sub: "Acme Corp",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    ...over,
  });

  const sign = (payload: Record<string, unknown>): string =>
    require("jsonwebtoken").sign(payload, PRIV, { algorithm: "RS256" });

  beforeEach(() => {
    (logger.info as jest.Mock).mockClear();
    (logger.warn as jest.Mock).mockClear();
  });

  it("returns { ok:false, reason:'missing' } when key is undefined", () => {
    expect(verifyLicenseKey(undefined, PUB)).toEqual({ ok: false, reason: "missing" });
  });

  it("returns { ok:true, payload, expiresAt } for a valid enterprise JWT signed with the matching private key", () => {
    const payload = makePayload();
    const token = sign(payload);
    const result = verifyLicenseKey(token, PUB);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.tier).toBe("enterprise");
      expect(result.payload.sub).toBe("Acme Corp");
      expect(result.expiresAt).toBe(new Date((payload.exp as number) * 1000).toISOString());
    }
  });

  it("returns { ok:false, reason:'bad-signature' } when the public key does not match the signing private key", () => {
    const token = sign(makePayload());
    const result = verifyLicenseKey(token, getOtherPublicKey());
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("returns { ok:false, reason:'expired' } for an expired JWT (explicit exp gate)", () => {
    const payload = makePayload({
      iat: Math.floor(Date.now() / 1000) - 365 * 24 * 3600,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const token = sign(payload);
    // jwt.verify throws TokenExpiredError for exp in the past → "expired".
    expect(verifyLicenseKey(token, PUB)).toEqual({ ok: false, reason: "expired" });
  });

  it("returns { ok:false, reason:'malformed' } for a non-JWT string", () => {
    expect(verifyLicenseKey("not-a-jwt", PUB)).toEqual({ ok: false, reason: "malformed" });
  });

  it("returns { ok:false, reason:'schema-mismatch' } for a JWT with a valid signature but wrong payload shape", () => {
    // Valid RS256 signature, but payload missing required `tier` field → ZodError
    const wrongPayload = {
      iss: "simmetric-chat",
      sub: "NoTier Corp",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = sign(wrongPayload as Record<string, unknown>);
    expect(verifyLicenseKey(token, PUB)).toEqual({ ok: false, reason: "schema-mismatch" });
  });

  it("returns { ok:false, reason:'bad-signature' } for an alg:none forgery attempt (algorithms:['RS256'] guard)", () => {
    // Sign with algorithm "none" (unsigned); jwt.verify with algorithms:
    // ["RS256"] rejects it with JsonWebTokenError → bad-signature.
    const token = require("jsonwebtoken").sign(makePayload(), "", { algorithm: "none" });
    expect(verifyLicenseKey(token, PUB)).toEqual({ ok: false, reason: "bad-signature" });
  });

  // ─── initLicense structured diagnostics (D-02) + no-secret-in-log canary ──

  it("initLicense with no LICENSE_KEY logs info-level '[license] fallback to Community' with reason 'missing' and returns Community", () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    const info = initLicense();
    expect(info.tier).toBe("community");
    expect(logger.info).toHaveBeenCalledWith("[license] fallback to Community", { reason: "missing" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("initLicense with a valid Enterprise key logs info-level '[license] loaded' with tier/licensee/expiresAt", () => {
    const payload = makePayload({ sub: "Enterprise Co" });
    const token = sign(payload);
    (getEnv as jest.Mock).mockReturnValue(envWith(token));
    const info = initLicense();
    expect(info.tier).toBe("enterprise");
    expect(info.licensee).toBe("Enterprise Co");
    expect(logger.info).toHaveBeenCalledWith("[license] loaded", expect.objectContaining({
      tier: "enterprise",
      licensee: "Enterprise Co",
    }));
    const metaArg = (logger.info as jest.Mock).mock.calls.find(
      (c: unknown[]) => c[0] === "[license] loaded",
    )?.[1];
    expect(metaArg).toHaveProperty("expiresAt");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("initLicense with an expired key logs warn-level '[license] fallback to Community' with the reason", () => {
    const payload = makePayload({
      iat: Math.floor(Date.now() / 1000) - 365 * 24 * 3600,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const token = sign(payload);
    (getEnv as jest.Mock).mockReturnValue(envWith(token));
    const info = initLicense();
    expect(info.tier).toBe("community");
    expect(logger.warn).toHaveBeenCalledWith("[license] fallback to Community", { reason: "expired" });
  });

  it("initLicense with a bad-signature key logs warn-level '[license] fallback to Community' with the reason", () => {
    // Sign with a DIFFERENT private key (not the test one). initLicense
    // verifies against the mocked test public key → signature mismatch →
    // bad-signature → Community fallback.
    const { sign } = require("jsonwebtoken");
    const { getOtherPrivateKey } = require("./helpers/licenseTestKeys") as typeof import("./helpers/licenseTestKeys");
    const token = sign(makePayload(), getOtherPrivateKey(), { algorithm: "RS256" });
    (getEnv as jest.Mock).mockReturnValue(envWith(token));
    const info = initLicense();
    expect(info.tier).toBe("community");
    expect(logger.warn).toHaveBeenCalledWith("[license] fallback to Community", { reason: "bad-signature" });
  });

  // ─── No-secret-in-log canary (T-120-01 mitigation, D-02) ───────────────
  // Asserts NONE of the captured logger.info/warn call arguments — BOTH the
  // message string (arg 0) AND the meta object (arg 1) — contain the test's
  // LICENSE_KEY fixture or the JWT body string. (There is no LICENSE_SECRET
  // under RS256 — the public key is not a secret.)

  it("no-secret-in-log canary: initLicense never logs the key or JWT body in either logger arg", () => {
    const payload = makePayload({ sub: "Canary Corp" });
    const token = sign(payload);
    const jwtBody = token.split(".")[1]; // base64 payload segment
    (getEnv as jest.Mock).mockReturnValue(envWith(token));

    initLicense();

    const forbidden = [token, jwtBody];
    const calls = [
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
    ] as unknown[][];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const msg = typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]);
      const meta = call[1] !== undefined ? JSON.stringify(call[1]) : "";
      for (const secret of forbidden) {
        expect(msg).not.toContain(secret);
        expect(meta).not.toContain(secret);
      }
    }
  });
});