// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 203 (MCC-01/02, D6) — per-model pricing service.
 *
 * `getModelPricing(providerId, modelName)` is consumed by the orchestrator's
 * `finally` usage-write seams (fire-and-forget — Pitfall 4: a cache/lookup
 * throw NEVER fails the run or the usage row; it fails open to no-cost).
 * `calculateCost` does ALL money math in `Prisma.Decimal` (never float —
 * Pitfall 5). `invalidatePricingCache` is called by the pricing PUT/RESET
 * routes (203-02).
 *
 * Cache: in-memory `Map` keyed `providerId:modelName`, TTL 5 min (spec
 * §2.3/§3 Fase 1). N/A verdicts (pricing unset) are cached too — "not
 * configured" is a cacheable answer. Single-instance doctrine (RESEARCH A3).
 */

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

export interface ModelPricing {
  inputCostPerToken: Prisma.Decimal;
  outputCostPerToken: Prisma.Decimal;
  currency: string;
}

export interface ComputedCost {
  promptCost: Prisma.Decimal;
  completionCost: Prisma.Decimal;
  totalCost: Prisma.Decimal;
  currency: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // spec §2.3 — 5 min TTL
const cache = new Map<string, { pricing: ModelPricing | null; fetchedAt: number }>();

function cacheKey(providerId: string, modelName: string): string {
  return `${providerId}:${modelName}`;
}

/**
 * Pricing lookup for one model (cache-first, 5-min TTL). Returns null when
 * the model does not exist OR has no pricing configured (N/A — a cached
 * verdict). NEVER throws for a clean miss; a DB throw propagates to the
 * caller's fail-open catch (Pitfall 4).
 */
export async function getModelPricing(
  providerId: string | undefined,
  modelName: string | undefined,
): Promise<ModelPricing | null> {
  if (!providerId || !modelName) return null;

  const key = cacheKey(providerId, modelName);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.pricing;
  }

  const model = await prisma.providerModel.findUnique({
    where: { providerId_name: { providerId, name: modelName } },
    select: { inputCostPerToken: true, outputCostPerToken: true, currency: true },
  });

  let pricing: ModelPricing | null = null;
  if (model && (model.inputCostPerToken !== null || model.outputCostPerToken !== null)) {
    pricing = {
      inputCostPerToken: model.inputCostPerToken ?? new Prisma.Decimal(0),
      outputCostPerToken: model.outputCostPerToken ?? new Prisma.Decimal(0),
      currency: model.currency ?? "USD",
    };
  }
  // else: pricing unset → null verdict, cached (N/A semantics, D2)

  cache.set(key, { pricing, fetchedAt: Date.now() });
  return pricing;
}

/** Invalidate the cached pricing for one model (pricing PUT/RESET contract). */
export function invalidatePricingCache(providerId: string, modelName: string): void {
  cache.delete(cacheKey(providerId, modelName));
}

/** Invalidate the ENTIRE pricing cache (operator/migration convenience). */
export function invalidatePricingCacheAll(): void {
  cache.clear();
}

/**
 * THE cost formula: promptCost = tokens × rate. ALL money math in Decimal
 * (T-203-01 — never float). `totalCost = promptCost + completionCost` with a
 * null one-rate arm folding to 0 (the SET rate exists; the other arm is
 * simply unpriced).
 */
export function calculateCost(
  pricing: ModelPricing,
  promptTokens: number,
  completionTokens: number,
): ComputedCost {
  const promptCost = pricing.inputCostPerToken.times(promptTokens);
  const completionCost = pricing.outputCostPerToken.times(completionTokens);
  const totalCost = promptCost.plus(completionCost);
  return { promptCost, completionCost, totalCost, currency: pricing.currency };
}