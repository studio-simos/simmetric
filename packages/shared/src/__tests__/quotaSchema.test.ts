// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 207 (Plan 01 Task 2 / VALIDATION W0): quota schema contracts.

import {
  quotaKindSchema,
  quotaBreachPayloadSchema,
  updateQuotaInputSchema,
  manualResetSchema,
  quotaPresetSchema,
  quotaUsageSchema,
  configKeySchema,
  CONFIG_DEFAULTS,
} from "../index";

describe("Phase 207 quota schemas", () => {
  describe("quotaKindSchema", () => {
    it("accepts tokens and storage", () => {
      expect(quotaKindSchema.safeParse("tokens").success).toBe(true);
      expect(quotaKindSchema.safeParse("storage").success).toBe(true);
    });
    it("rejects unknown kinds (users is NOT a resettable kind)", () => {
      expect(quotaKindSchema.safeParse("users").success).toBe(false);
      expect(quotaKindSchema.safeParse("cpu").success).toBe(false);
    });
  });

  describe("quotaBreachPayloadSchema (D-04 family)", () => {
    it("accepts the tokens breach payload", () => {
      const parsed = quotaBreachPayloadSchema.safeParse({
        error: "Token quota reached",
        quota: "tokens",
        limit: 100000,
        used: 100000,
        windowStart: new Date().toISOString(),
      });
      expect(parsed.success).toBe(true);
    });
    it("accepts the 206 users family member (one contract)", () => {
      expect(quotaBreachPayloadSchema.safeParse({ error: "User ceiling reached", quota: "users" }).success).toBe(true);
    });
    it("rejects a payload without the quota field", () => {
      expect(quotaBreachPayloadSchema.safeParse({ error: "Something" }).success).toBe(false);
    });
    it("rejects an empty error string", () => {
      expect(quotaBreachPayloadSchema.safeParse({ error: "", quota: "tokens" }).success).toBe(false);
    });
  });

  describe("updateQuotaInputSchema (D-07 admin column writes)", () => {
    const valid = {
      tokenQuotaLimit: 500000,
      storageQuotaGb: 1.5,
      tokenQuotaUnlimited: false,
      storageQuotaUnlimited: false,
      resetAnchorDate: new Date().toISOString(),
    };
    it("accepts a full config with fractional GB", () => {
      expect(updateQuotaInputSchema.safeParse(valid).success).toBe(true);
    });
    it("accepts nulls (blank = inherit, D-08)", () => {
      expect(
        updateQuotaInputSchema.safeParse({
          tokenQuotaLimit: null,
          storageQuotaGb: null,
          tokenQuotaUnlimited: false,
          storageQuotaUnlimited: false,
          resetAnchorDate: null,
        }).success,
      ).toBe(true);
    });
    it("rejects negative token quota", () => {
      expect(updateQuotaInputSchema.safeParse({ ...valid, tokenQuotaLimit: -1 }).success).toBe(false);
    });
    it("rejects non-integer token quota", () => {
      expect(updateQuotaInputSchema.safeParse({ ...valid, tokenQuotaLimit: 10.5 }).success).toBe(false);
    });
    it("rejects absurd token quota (> 1e12)", () => {
      expect(updateQuotaInputSchema.safeParse({ ...valid, tokenQuotaLimit: 2_000_000_000_000 }).success).toBe(false);
    });
    it("rejects negative storage GB", () => {
      expect(updateQuotaInputSchema.safeParse({ ...valid, storageQuotaGb: -0.5 }).success).toBe(false);
    });
  });

  describe("manualResetSchema (D-09/D-12)", () => {
    it("accepts kind tokens only", () => {
      expect(manualResetSchema.safeParse({ kind: "tokens" }).success).toBe(true);
    });
    it("rejects storage — storage never resets (D-12)", () => {
      expect(manualResetSchema.safeParse({ kind: "storage" }).success).toBe(false);
    });
  });

  describe("quotaPresetSchema (D-08 install presets)", () => {
    it("accepts unset sentinels (empty and 0)", () => {
      expect(quotaPresetSchema.safeParse({ QUOTA_TOKEN_DEFAULT: "0", QUOTA_STORAGE_GB_DEFAULT: "" }).success).toBe(true);
    });
    it("accepts a positive integer token preset and fractional GB preset", () => {
      expect(quotaPresetSchema.safeParse({ QUOTA_TOKEN_DEFAULT: "500000", QUOTA_STORAGE_GB_DEFAULT: "1.5" }).success).toBe(true);
    });
    it("rejects negative or garbage presets", () => {
      expect(quotaPresetSchema.safeParse({ QUOTA_TOKEN_DEFAULT: "-5", QUOTA_STORAGE_GB_DEFAULT: "" }).success).toBe(false);
      expect(quotaPresetSchema.safeParse({ QUOTA_TOKEN_DEFAULT: "abc", QUOTA_STORAGE_GB_DEFAULT: "" }).success).toBe(false);
      expect(quotaPresetSchema.safeParse({ QUOTA_TOKEN_DEFAULT: "0", QUOTA_STORAGE_GB_DEFAULT: "1.999" }).success).toBe(false);
    });
  });

  describe("quotaUsageSchema (admin read / Phase 209 contract)", () => {
    it("accepts a full usage payload", () => {
      const parsed = quotaUsageSchema.safeParse({
        userId: "00000000-0000-4000-8000-000000000000",
        tokens: {
          limit: 100000,
          used: 4200,
          windowStart: new Date().toISOString(),
          nextResetAt: new Date().toISOString(),
          source: "override",
        },
        storage: { limitGb: 5, usedBytes: 1024, source: "preset" },
      });
      expect(parsed.success).toBe(true);
    });
    it("accepts null storage block and null limit (unlimited)", () => {
      const parsed = quotaUsageSchema.safeParse({
        userId: "00000000-0000-4000-8000-000000000000",
        tokens: {
          limit: null,
          used: 0,
          windowStart: new Date().toISOString(),
          nextResetAt: null,
          source: "unset",
        },
        storage: null,
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("CONFIG_DEFAULTS + config keys (D-08 preset tier)", () => {
    it("exposes the QUOTA_* keys as config keys", () => {
      expect(configKeySchema.safeParse("QUOTA_TOKEN_DEFAULT").success).toBe(true);
      expect(configKeySchema.safeParse("QUOTA_STORAGE_GB_DEFAULT").success).toBe(true);
    });
    it("defaults both presets to the unset sentinel (fail-open)", () => {
      expect(CONFIG_DEFAULTS.QUOTA_TOKEN_DEFAULT).toBe("0");
      expect(CONFIG_DEFAULTS.QUOTA_STORAGE_GB_DEFAULT).toBe("");
    });
  });
});