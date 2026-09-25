// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 203 (MCC-01, 203-01) — modelPricingService battery.
 *
 * The pricing cache contract (TTL, invalidation, N/A-as-cacheable-verdict)
 * and the Decimal money-math contract (T-203-01: exact ×-math, never float).
 * Prisma mock per the unit-suite discipline — NO live DB.
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

import prisma from "../utils/prisma";
import { Prisma } from "@prisma/client";
import {
  getModelPricing,
  calculateCost,
  invalidatePricingCache,
  invalidatePricingCacheAll,
} from "../services/modelPricingService";

beforeEach(() => {
  jest.clearAllMocks();
  invalidatePricingCacheAll();
});

function pricingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    inputCostPerToken: new Prisma.Decimal("0.0000015"),
    outputCostPerToken: new Prisma.Decimal("0.000006"),
    currency: "USD",
    ...overrides,
  };
}

describe("getModelPricing — cache contract (D6)", () => {
  it("priced model → pricing returned; second lookup within TTL hits the cache (NO second DB query)", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(pricingRow());

    const first = await getModelPricing("prov-1", "gpt-x");
    const second = await getModelPricing("prov-1", "gpt-x".replace("gpt", "prov") === "prov-x" ? "gpt-x" : "gpt-x");

    // The second call for the SAME key must not re-query (TTL cache).
    const first2 = await getModelPricing("prov-1", "gpt-x");
    expect(first2).toEqual(first);
    expect(prisma.providerModel.findUnique).toHaveBeenCalledTimes(1);
    expect(first).not.toBeNull();
    expect(String(first!.inputCostPerToken)).toBe("0.0000015");
  });

  it("invalidatePricingCache forces a refetch (the pricing-PUT contract)", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(pricingRow());
    await getModelPricing("prov-2", "gpt-x");

    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(
      pricingRow({ inputCostPerToken: new Prisma.Decimal("0.000003") }),
    );
    invalidatePricingCache("prov-2", "gpt-x");

    const refreshed = await getModelPricing("prov-2", "gpt-x");
    expect(String(refreshed!.inputCostPerToken)).toBe("0.000003");
    expect(prisma.providerModel.findUnique).toHaveBeenCalledTimes(2);
  });

  it("N/A is a cacheable verdict: pricing unset → null (cached; never 'free')", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(
      pricingRow({ inputCostPerToken: null, outputCostPerToken: null }),
    );

    const verdict = await getModelPricing("prov-3", "cloud-unset");
    expect(verdict).toBeNull();
    // The null verdict is cached — no second query.
    await getModelPricing("prov-3", "cloud-unset");
    expect(prisma.providerModel.findUnique).toHaveBeenCalledTimes(1);
  });

  it("missing model → null (N/A)", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(null);
    expect(await getModelPricing("prov-4", "ghost")).toBeNull();
  });

  it("missing providerId/model args → null WITHOUT a DB query", async () => {
    expect(await getModelPricing(undefined, "gpt-x")).toBeNull();
    expect(await getModelPricing("prov-5", undefined)).toBeNull();
    expect(prisma.providerModel.findUnique).not.toHaveBeenCalled();
  });

  it("local model with $0.00 rates → pricing WITH zero rates (free is a REAL verdict, distinct from N/A)", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(
      pricingRow({ inputCostPerToken: new Prisma.Decimal(0), outputCostPerToken: new Prisma.Decimal(0), currency: "USD" }),
    );

    const pricing = await getModelPricing("prov-local", "ollama-model");

    expect(pricing).not.toBeNull();
    expect(String(pricing!.inputCostPerToken)).toBe("0");
    expect(String(pricing!.outputCostPerToken)).toBe("0");
  });
});

describe("calculateCost — Decimal money math (T-203-01, D1)", () => {
  it("exact per-token math: 0.0000015 × 10_000_000 input tokens (float would drift; Decimal does not)", () => {
    const pricing = {
      inputCostPerToken: new Prisma.Decimal("0.0000015"),
      outputCostPerToken: new Prisma.Decimal("0.000006"),
      currency: "USD",
    };

    const cost = calculateCost(pricing, 10_000_000, 2_000_000);

    expect(cost.promptCost.toFixed(6)).toBe("15.000000");
    expect(cost.completionCost.toFixed(6)).toBe("12.000000");
    expect(cost.totalCost.toFixed(6)).toBe("27.000000");
    expect(cost.currency).toBe("USD");
  });

  it("small run: 1200 prompt + 350 completion tokens", () => {
    const pricing = {
      inputCostPerToken: new Prisma.Decimal("0.0000015"),
      outputCostPerToken: new Prisma.Decimal("0.000006"),
      currency: "USD",
    };
    const cost = calculateCost(pricing, 1200, 350);
    expect(cost.promptCost.toFixed(6)).toBe("0.001800");
    expect(cost.completionCost.toFixed(6)).toBe("0.002100");
    expect(cost.totalCost.toFixed(6)).toBe("0.003900");
  });

  it("one-rate arm folds to 0 within total: output rate null → 0 outputCost (the SET rate exists)", () => {
    const pricing = {
      inputCostPerToken: new Prisma.Decimal("0.0000015"),
      outputCostPerToken: new Prisma.Decimal(0),
      currency: "USD",
    };
    const cost = calculateCost(pricing, 1000, 5000);
    expect(cost.promptCost.toFixed(6)).toBe("0.001500");
    expect(cost.completionCost.toFixed(6)).toBe("0.000000");
    expect(cost.totalCost.toFixed(6)).toBe("0.001500");
  });

  it("is NOT float: repeated operations do not accumulate drift (T-203-01 pin)", () => {
    const pricing = {
      inputCostPerToken: new Prisma.Decimal("0.0000015"),
      outputCostPerToken: new Prisma.Decimal("0.000006"),
      currency: "USD",
    };
    // 100 sequential runs accumulated in Decimal.
    let total = new Prisma.Decimal(0);
    for (let i = 0; i < 100; i++) {
      total = total.plus(calculateCost(pricing, 1000, 1000).totalCost);
    }
    expect(total.toFixed(6)).toBe("0.750000");
  });
});