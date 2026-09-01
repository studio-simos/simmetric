// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

/**
 * licenseOverride.test.ts — Phase 147 (EPA-07) D-13.
 *
 * Covers the limit-override resolver:
 *   D-13a: setLimitOverride("max_workspaces", Infinity) → getFeatureLimit returns Infinity
 *   D-13b: clearLimitOverrides() after a setLimitOverride → getFeatureLimit returns 3
 *   D-13c: initLicense() with no LICENSE_KEY AFTER a setLimitOverride →
 *          getFeatureLimit returns 3 (clearLimitOverrides at start — Pitfall 3)
 *   D-13d: getLicenseInfo() runtime-expiry path (cachedLicense.expiresAt in
 *          the past) ALSO clears overrides (SC-1 reactive mid-runtime revocation)
 *
 * Modeled on the existing `license.test.ts` — same mocks
 * (logger, license-public-key, config/env) so the production code path
 * verifies against the test RSA keypair.
 *
 * Phase 147 (EPA-07) — Plan 01 Task 1
 */

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

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/license-public-key", () => {
  const { getTestPublicKey } = jest.requireActual("./helpers/licenseTestKeys") as typeof import("./helpers/licenseTestKeys");
  return {
    __esModule: true,
    LICENSE_PUBLIC_KEY_PEM: getTestPublicKey(),
  };
});

import {
  initLicense,
  getLicenseInfo,
  getFeatureLimit,
  setLimitOverride,
  clearLimitOverrides,
} from "../services/licenseService";
import { getEnv } from "../config/env";
import {
  getTestPrivateKey,
  signTestLicense,
} from "./helpers/licenseTestKeys";

function envWith(key: string | undefined) {
  return { LICENSE_KEY: key };
}

describe("Phase 147 — license override resolver (D-13)", () => {
  beforeEach(() => {
    // Start every case from a clean map + a Community-tier cachedLicense.
    clearLimitOverrides();
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
  });

  it("D-13a: setLimitOverride(\"max_workspaces\", Infinity) → getFeatureLimit returns Infinity", () => {
    setLimitOverride("max_workspaces", Infinity);
    expect(getFeatureLimit("max_workspaces")).toBe(Infinity);
  });

  it("D-13b: clearLimitOverrides() after a setLimitOverride → getFeatureLimit returns the Community default (3)", () => {
    setLimitOverride("max_workspaces", Infinity);
    expect(getFeatureLimit("max_workspaces")).toBe(Infinity);
    clearLimitOverrides();
    expect(getFeatureLimit("max_workspaces")).toBe(3);
  });

  it("D-13c: initLicense() with no LICENSE_KEY AFTER a setLimitOverride → getFeatureLimit returns 3 (Pitfall 3 — clear at start)", () => {
    setLimitOverride("max_workspaces", Infinity);
    expect(getFeatureLimit("max_workspaces")).toBe(Infinity);
    // Community fallback (no LICENSE_KEY) — initLicense() MUST clear the
    // map at its START before rebuilding tierFeatures from COMMUNITY_FEATURE_DEFAULTS.
    (getEnv as jest.Mock).mockReturnValue(envWith(undefined));
    initLicense();
    expect(getFeatureLimit("max_workspaces")).toBe(3);
  });

  it("D-13d: getLicenseInfo() runtime-expiry path ALSO clears overrides (SC-1 reactive mid-runtime revocation)", () => {
    // Boot with a valid Enterprise token so cachedLicense.expiresAt is set.
    const licenseKey = signTestLicense({ tier: "enterprise", sub: "Expiring Corp" });
    (getEnv as jest.Mock).mockReturnValue(envWith(licenseKey));
    initLicense();

    // Inject an override as if the enterprise plugin had registered it.
    setLimitOverride("max_workspaces", Infinity);
    expect(getFeatureLimit("max_workspaces")).toBe(Infinity);

    // Simulate mid-runtime expiry: force the cached license's expiresAt
    // into the past, then call getLicenseInfo() — the runtime-expiry
    // branch should clear the overrides BEFORE rebuilding as Community.
    const cachedRef = getLicenseInfo();
    (cachedRef as any).expiresAt = new Date(Date.now() - 10000).toISOString();

    const degraded = getLicenseInfo();
    expect(degraded.tier).toBe("community");
    expect(getFeatureLimit("max_workspaces")).toBe(3);
  });
});