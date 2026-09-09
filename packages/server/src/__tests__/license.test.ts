// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    workspace: { count: jest.fn() },
    project: { count: jest.fn() },
    synthesisRun: { count: jest.fn() },
    widget: { count: jest.fn() },
    backupDestination: { count: jest.fn() },
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

// Phase 185 (SAAS-04c, D-06/D-07): every counter counts WHERE
// organizationId = req.organizationId (TenantContext-resolved upstream in
// the chain). Org-a at its limit never consumes org-b's allowance (DoS +
// Info-Disclosure mitigations T-185-12..15). The 402 body keys stay
// byte-identical ({error, feature, limit, current, tier}); current is now
// the per-org count. Org-unresolvable → 404 fail-closed BEFORE the try
// block (D-07); transient count failures keep the pre-existing fail-open
// catch arm.
describe("requireFeatureLimit middleware", () => {
  const ORG_A = "org-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ORG_B = "org-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  let prisma: any;

  // Minimal req/res/next harness mirroring the pre-185 shape.
  function makeHarness(reqExtra: Record<string, unknown> = {}) {
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
    const req = { ...reqExtra } as unknown as Request;
    const next = jest.fn();
    return { req, res, next, state };
  }

  beforeEach(() => {
    prisma = require("../utils/prisma").default;
    jest.clearAllMocks();
  });

  it("counts workspaces scoped to req.organizationId (exact where arg)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockResolvedValue(1);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
    expect(prisma.workspace.count).toHaveBeenCalledWith({
      where: { organizationId: ORG_A, deletedAt: null },
    });
  });

  it("per-org independence: org-a at limit → 402; org-b below limit → next() (same request shapes)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count
      .mockResolvedValueOnce(3) // org-a: at limit
      .mockResolvedValueOnce(1); // org-b: below

    const middleware = requireFeatureLimit("max_workspaces", "workspace");

    const orgA = makeHarness({ organizationId: ORG_A });
    await middleware(orgA.req, orgA.res, orgA.next);
    expect(orgA.state.statusCode).toBe(402);
    expect(orgA.state.body.current).toBe(3);
    expect(orgA.next).not.toHaveBeenCalled();

    const orgB = makeHarness({ organizationId: ORG_B });
    await middleware(orgB.req, orgB.res, orgB.next);
    expect(orgB.state.statusCode).toBe(200);
    expect(orgB.next).toHaveBeenCalled();

    // Both orgs' counts were queried independently with their own org id.
    expect(prisma.workspace.count.mock.calls[0][0].where.organizationId).toBe(ORG_A);
    expect(prisma.workspace.count.mock.calls[1][0].where.organizationId).toBe(ORG_B);
  });

  it("boundary matrix: limit-1 → next(), limit → 402, limit+1 → 402", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    // Community max_projects = 3: one below → pass, exactly at → block, above → block.
    prisma.project.count
      .mockResolvedValueOnce(2) // limit-1
      .mockResolvedValueOnce(3) // limit (exactly at)
      .mockResolvedValueOnce(4); // limit+1

    const middleware = requireFeatureLimit("max_projects", "project");

    const below = makeHarness({ organizationId: ORG_A });
    await middleware(below.req, below.res, below.next);
    expect(below.state.statusCode).toBe(200);
    expect(below.next).toHaveBeenCalled();

    const at = makeHarness({ organizationId: ORG_A });
    await middleware(at.req, at.res, at.next);
    expect(at.state.statusCode).toBe(402);
    expect(at.next).not.toHaveBeenCalled();

    const above = makeHarness({ organizationId: ORG_A });
    await middleware(above.req, above.res, above.next);
    expect(above.state.statusCode).toBe(402);
    expect(above.next).not.toHaveBeenCalled();
  });

  it("synthesisRun count where is { organizationId } exactly — deletedAt ABSENT (Pitfall 4: the column does not exist)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.synthesisRun.count.mockResolvedValue(0);

    const middleware = requireFeatureLimit("max_projects", "synthesisRun");
    const { req, res, next } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    const arg = prisma.synthesisRun.count.mock.calls[0][0];
    expect(arg).toEqual({ where: { organizationId: ORG_A } });
    expect(Object.keys(arg.where)).not.toContain("deletedAt");
  });

  it("unresolvable org → 404 fail-closed and the count delegate NEVER called (D-07)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({}); // no organizationId

    await middleware(req, res, next);
    expect(state.statusCode).toBe(404);
    expect(state.body.error).toBe("Not found");
    expect(next).not.toHaveBeenCalled();
    expect(prisma.workspace.count).not.toHaveBeenCalled();
    expect(prisma.project.count).not.toHaveBeenCalled();
    expect(prisma.synthesisRun.count).not.toHaveBeenCalled();
    expect(prisma.widget.count).not.toHaveBeenCalled();
    expect(prisma.backupDestination.count).not.toHaveBeenCalled();
  });

  it("count query throws → next() still called (pre-existing fail-open catch preserved for transient errors)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockRejectedValue(new Error("DB transient"));

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(state.statusCode).toBe(200);
    // WR-03 (185-05): the swallowed error is logged with the flag — a
    // sustained count failure leaves a server-side signal before any
    // circuit-breaker policy lands (accept-as-debt, 185-05 dispositions).
    expect(logger.warn).toHaveBeenCalledWith(
      "[license] count query failed — allowing request",
      { error: "DB transient", flag: "max_workspaces" },
    );
  });

  it("402 body keys exactly {error, feature, limit, current, tier} — byte-identical shape (D-06)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.widget.count.mockResolvedValue(1); // community max_widgets = 1

    const middleware = requireFeatureLimit("max_widgets", "widget");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(402);
    expect(Object.keys(state.body).sort()).toEqual(
      ["current", "error", "feature", "limit", "tier"],
    );
    expect(state.body.feature).toBe("max_widgets");
    expect(state.body.limit).toBe(1);
    expect(state.body.current).toBe(1);
    expect(state.body.tier).toBe("community");
    expect(next).not.toHaveBeenCalled();
  });

  it("backupDestination count org-scoped { organizationId, deletedAt: null } (enterprise-consumed case, unit-covered — community build 404s the enterprise routes per A2)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.backupDestination.count.mockResolvedValue(0);

    const middleware = requireFeatureLimit("max_backup_destinations", "backupDestination");
    const { req, res, next } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(prisma.backupDestination.count).toHaveBeenCalledWith({
      where: { organizationId: ORG_A, deletedAt: null },
    });
  });

  it("Enterprise Infinity short-circuits BEFORE the org guard (no count, no 404 on missing org)", async () => {
    const licenseKey = signTestLicense({ tier: "enterprise", sub: "Test Corp" });
    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    initLicense();
    prisma.workspace.count.mockResolvedValue(100);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({}); // deliberately no org — Infinity must not need it

    await middleware(req, res, next);
    expect(state.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
    expect(prisma.workspace.count).not.toHaveBeenCalled();
  });
});

// ─── Phase 186 (SAAS-05, D-06) — QuotaEnforcer precedence matrix ──────
// The enforcer consult sits AFTER the core 402 arm and AFTER the transient
// count-catch (structurally outside it): core deny is FINAL (a plugin can
// never widen a core deny, T-186-04); core pass → the enforcer decides;
// no enforcer → byte-identical 185 behavior. An enforcer throw responds 500
// and returns — NEVER swallowed into the transient-catch fail-open next()
// (Pitfall 5). The 402 body keys stay the frozen 185 D-06 shape
// {error, feature, limit, current, tier} — the enforcer supplies
// current/limit only.
describe("requireFeatureLimit — QuotaEnforcer precedence (Phase 186 D-06)", () => {
  const ORG_A = "org-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  let prisma: any;
  let setQuotaEnforcer: (fn: unknown) => void;

  function makeHarness(reqExtra: Record<string, unknown> = {}) {
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
    const req = { ...reqExtra } as unknown as Request;
    const next = jest.fn();
    return { req, res, next, state };
  }

  beforeEach(() => {
    prisma = require("../utils/prisma").default;
    ({ setQuotaEnforcer } = require("../middleware/license"));
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Single-slot registry: reset so other suites stay 185-identical.
    setQuotaEnforcer(null);
  });

  it("(a) core deny wins: count >= core limit → 402 EVEN IF the enforcer would allow (T-186-04)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense(); // community max_workspaces = 3
    prisma.workspace.count.mockResolvedValue(3); // at limit

    const enforcer = jest.fn().mockResolvedValue({ allowed: true });
    setQuotaEnforcer(enforcer);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(402);
    expect(state.body.current).toBe(3);
    expect(state.body.limit).toBe(3);
    expect(next).not.toHaveBeenCalled();
    // The enforcer was NEVER consulted — the core deny is unskippable.
    expect(enforcer).not.toHaveBeenCalled();
  });

  it("(b) core pass + enforcer deny → 402 with the ENFORCER's current/limit, keys {error, feature, limit, current, tier}", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense(); // community max_workspaces = 3
    prisma.workspace.count.mockResolvedValue(1); // below core limit

    const enforcer = jest.fn().mockResolvedValue({ allowed: false, current: 1, limit: 1 });
    setQuotaEnforcer(enforcer);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(402);
    // Frozen 185 D-06 shape — the enforcer supplies current/limit only.
    expect(Object.keys(state.body).sort()).toEqual(
      ["current", "error", "feature", "limit", "tier"],
    );
    expect(state.body.feature).toBe("max_workspaces");
    expect(state.body.limit).toBe(1);
    expect(state.body.current).toBe(1);
    expect(state.body.tier).toBe("community");
    expect(next).not.toHaveBeenCalled();
    expect(enforcer).toHaveBeenCalledWith({
      organizationId: ORG_A,
      flag: "max_workspaces",
      current: 1,
    });
  });

  it("(c) core pass + enforcer allow → next()", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockResolvedValue(1);

    const enforcer = jest.fn().mockResolvedValue({ allowed: true, current: 1, limit: 10 });
    setQuotaEnforcer(enforcer);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
    expect(enforcer).toHaveBeenCalledTimes(1);
  });

  it("(d) core pass + NO enforcer → next() (byte-identical 185 behavior)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockResolvedValue(1);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
  });

  it("(e) enforcer THROW → logger.error with org/flag + 500 response, NEVER the fail-open next() (Pitfall 5)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockResolvedValue(1);

    const enforcer = jest.fn().mockRejectedValue(new Error("enforcer exploded"));
    setQuotaEnforcer(enforcer);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(500);
    expect(state.body.error).toBe("Quota check failed");
    expect(next).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "[license] quota enforcer failed",
      expect.objectContaining({ organizationId: ORG_A, flag: "max_workspaces" }),
    );
  });

  it("(f) limit === Infinity → next() BEFORE anything — enforcer not consulted even if registered", async () => {
    const licenseKey = signTestLicense({ tier: "enterprise", sub: "Test Corp" });
    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    initLicense(); // enterprise max_workspaces = Infinity
    prisma.workspace.count.mockResolvedValue(100);

    const enforcer = jest.fn().mockResolvedValue({ allowed: false });
    setQuotaEnforcer(enforcer);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
    expect(enforcer).not.toHaveBeenCalled();
  });

  it("(b-sync) sync enforcer verdict (non-Promise) is honored (A4 — verdict union)", async () => {
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    prisma.workspace.count.mockResolvedValue(1);

    const enforcer = jest.fn(() => ({ allowed: false, current: 1, limit: 1 }));
    setQuotaEnforcer(enforcer);

    const middleware = requireFeatureLimit("max_workspaces", "workspace");
    const { req, res, next, state } = makeHarness({ organizationId: ORG_A });

    await middleware(req, res, next);
    expect(state.statusCode).toBe(402);
    expect(state.body.limit).toBe(1);
    expect(next).not.toHaveBeenCalled();
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