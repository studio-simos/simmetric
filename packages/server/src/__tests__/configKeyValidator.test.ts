// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 145 (EPA-05 — D-11): config-key validator hook + D-02 fallback
 * tests. Covers SC-1: the `registerConfigKeyValidator(fn)` IoC hook and
 * the no-plugin community fallback.
 *
 * Mock strategy mirrors `systemConfigRedis.test.ts`:
 *  - prisma is mocked for systemConfig.findMany / findFirst / update / create
 *    (the updateSettings() loop reads existing settings + writes accepted
 *    ones through the 183-01 `upsertSystemConfigRow` helper — find-first,
 *    then id-anchored update-or-create). `upsert` stays mocked so suites
 *    not yet migrated keep working; rejection-path tests assert the helper
 *    never wrote (no update/create fire on rejection).
 *  - licenseService is mocked for `getLicenseInfo` (replaces
 *    `isFeatureEnabled` — Pitfall 2). The validator receives the
 *    `LicenseInfo`; the D-02 fallback ignores it (it only checks
 *    `configKeyValidators.length`).
 *  - logger is mocked to capture the `logger.warn` rejection reason.
 *  - `@simmetric-chat/shared` is real (via moduleNameMapper → dist) so the
 *    real `configKeySchema` + `CONFIG_DEFAULTS` drive the loop.
 *  - `jest.resetModules()` + `freshSystemConfig()` per test (Pitfall 5) —
 *    the module-level `configKeyValidators[]` array would otherwise leak
 *    between tests.
 *
 * Phase 145 (EPA-05) Plan 01
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

const ckvMockFindUnique = jest.fn();
const ckvMockFindFirst = jest.fn();
const ckvMockFindMany = jest.fn();
const ckvMockUpdate = jest.fn();
const ckvMockCreate = jest.fn();
const ckvMockUpsert = jest.fn();

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    systemConfig: {
      findUnique: ckvMockFindUnique,
      findFirst: ckvMockFindFirst,
      findMany: ckvMockFindMany,
      update: ckvMockUpdate,
      create: ckvMockCreate,
      upsert: ckvMockUpsert,
    },
  },
}));

const mockLicenseInfo = {
  tier: "community",
  licensee: "Test",
  expiresAt: null,
  features: {},
  valid: true,
};

jest.mock("../services/licenseService", () => ({
  getLicenseInfo: jest.fn(() => mockLicenseInfo),
}));

const mockLoggerWarn = jest.fn();
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: mockLoggerWarn,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/redisService", () => ({
  getRedis: jest.fn(() => null),
  isRedisAvailable: jest.fn(() => false),
}));

// ─── Helper: fresh module require (Pitfall 5 — module-level state leak) ──────

function freshSystemConfigForValidators() {
  jest.resetModules();
  return require("../services/systemConfigService");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 145 (EPA-05) — configKeyValidator hook + D-02 fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    ckvMockFindMany.mockResolvedValue([]);
    ckvMockFindUnique.mockResolvedValue(null);
    // 183-01: updateSettings writes via upsertSystemConfigRow (find-first →
    // update) — the probe's write-through surface is now findFirst + update.
    // findFirst returns null by default → the helper takes the create arm;
    // Tests 3/4 re-wire it to the update-path row below.
    ckvMockFindFirst.mockResolvedValue(null);
    ckvMockUpdate.mockResolvedValue({});
    ckvMockCreate.mockResolvedValue({});
    ckvMockUpsert.mockResolvedValue({});
    mockLoggerWarn.mockReset();
  });

  it("Test 1: no validators + BRANDING_APP_NAME → rejected (D-02 fallback)", async () => {
    const { updateSettings } = freshSystemConfigForValidators();
    const result = await updateSettings([{ key: "BRANDING_APP_NAME", value: "My Brand" }]);

    expect(result.rejected).toContain("BRANDING_APP_NAME");
    expect(result.updated).toEqual([]);
    expect(ckvMockUpdate).not.toHaveBeenCalled();
    expect(ckvMockCreate).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[config] BRANDING_* key rejected (no enterprise plugin loaded)",
      expect.objectContaining({ key: "BRANDING_APP_NAME" }),
    );
  });

  it("Test 2: validator returning {allowed:false, reason} → rejected + reason logged (D-01)", async () => {
    const { updateSettings, registerConfigKeyValidator } = freshSystemConfigForValidators();
    registerConfigKeyValidator(() => ({
      allowed: false,
      reason: "test reason — white_label off",
    }));

    const result = await updateSettings([{ key: "BRANDING_APP_NAME", value: "My Brand" }]);

    expect(result.rejected).toContain("BRANDING_APP_NAME");
    expect(result.updated).toEqual([]);
    expect(ckvMockUpdate).not.toHaveBeenCalled();
    expect(ckvMockCreate).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[config] Config key rejected by validator",
      expect.objectContaining({
        key: "BRANDING_APP_NAME",
        reason: "test reason — white_label off",
      }),
    );
  });

  it("Test 3: validator returning {allowed:true} for BRANDING_* → persisted (D-01)", async () => {
    const { updateSettings, registerConfigKeyValidator } = freshSystemConfigForValidators();
    registerConfigKeyValidator(() => ({ allowed: true }));
    // Update-path probe: an existing global row → the helper issues the
    // id-anchored update (not create).
    ckvMockFindFirst.mockResolvedValue({ id: "row-branding", key: "BRANDING_APP_NAME", value: "old" });

    const result = await updateSettings([{ key: "BRANDING_APP_NAME", value: "My Brand" }]);

    expect(result.rejected).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].key).toBe("BRANDING_APP_NAME");
    // 183-01: the write routes through upsertSystemConfigRow — find-first on
    // the global row, then an id-anchored update (existing-row path).
    expect(ckvMockFindFirst).toHaveBeenCalledWith({
      where: { key: "BRANDING_APP_NAME", organizationId: null },
    });
    expect(ckvMockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row-branding" },
        data: { value: "My Brand" },
      }),
    );
  });

  it("Test 4: validator returns null for non-BRANDING key → passes through to persist", async () => {
    const { updateSettings, registerConfigKeyValidator } = freshSystemConfigForValidators();
    // Validator returns null (no opinion) for non-BRANDING keys.
    registerConfigKeyValidator(() => null);
    // Update-path probe: an existing global row → id-anchored update.
    ckvMockFindFirst.mockResolvedValue({ id: "row-llm", key: "LLM_PROVIDER", value: "ollama" });

    const result = await updateSettings([{ key: "LLM_PROVIDER", value: "openai" }]);

    expect(result.rejected).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].key).toBe("LLM_PROVIDER");
    // 183-01: helper-mediated shape — findFirst probe then id-anchored update.
    expect(ckvMockFindFirst).toHaveBeenCalledWith({
      where: { key: "LLM_PROVIDER", organizationId: null },
    });
    expect(ckvMockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row-llm" },
        data: { value: "openai" },
      }),
    );
  });

  it("Test 5: validator rejects BRANDING_* → D-02 fallback does NOT also fire (validator wins)", async () => {
    const { updateSettings, registerConfigKeyValidator } = freshSystemConfigForValidators();
    registerConfigKeyValidator(() => ({ allowed: false, reason: "off" }));

    const result = await updateSettings([{ key: "BRANDING_APP_NAME", value: "My Brand" }]);

    // Rejected exactly once — not twice (the validator short-circuits the
    // D-02 fallback via the `validatorDecision === "reject"` → `continue`).
    expect(result.rejected).toEqual(["BRANDING_APP_NAME"]);
    expect(result.rejected).toHaveLength(1);
    expect(ckvMockUpdate).not.toHaveBeenCalled();
    expect(ckvMockCreate).not.toHaveBeenCalled();
    // The validator-rejection log fired; the fallback log did NOT.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[config] Config key rejected by validator",
      expect.anything(),
    );
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      "[config] BRANDING_* key rejected (no enterprise plugin loaded)",
      expect.anything(),
    );
  });
});