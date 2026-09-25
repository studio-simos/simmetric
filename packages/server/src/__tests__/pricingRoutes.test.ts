// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 203 (MCC-01, 203-02 Task 2) — pricing route trio battery.
 *
 * PUT/GET/RESET /:providerId/models/:modelId/pricing — provider:write/read
 * gated, Zod-validated, cache-invalidating, audit-logged (T-203-03).
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const { prisma } = createMockPrisma();
  (prisma as any).providerModel = {
    ...(prisma as any).providerModel,
    findUnique: jest.fn(),
    update: jest.fn(),
  };
  (prisma as any).provider = {
    ...(prisma as any).provider,
    findUnique: jest.fn(),
  };
  return { __esModule: true, default: prisma };
});

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

import "./helpers/setupEnv";

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.userId = "u-admin";
    next();
  },
}));

jest.mock("../middleware/tenantContext", () => ({
  tenantContextMiddleware: (req: any, _res: any, next: any) => {
    req.organizationId = "org-default";
    next();
  },
}));

jest.mock("../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../services/modelPricingService", () => ({
  getModelPricing: jest.fn(),
  calculateCost: jest.fn(),
  invalidatePricingCache: jest.fn(),
  invalidatePricingCacheAll: jest.fn(),
}));

import express from "express";
import request from "supertest";
import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";
import { invalidatePricingCache } from "../services/modelPricingService";
import providersRoutes from "../routes/providers";

const mockGetPricing = require("../services/modelPricingService").getModelPricing as jest.Mock;
const mockInvalidate = invalidatePricingCache as jest.Mock;
const mockLogEvent = logEvent as jest.Mock;

function pricingApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/providers", providersRoutes);
  return app;
}

const MODEL_ROW = {
  id: "model-1",
  providerId: "prov-1",
  name: "gpt-x",
  inputCostPerToken: null,
  outputCostPerToken: null,
  currency: null,
  lastCostUpdated: null,
  lastCostUpdatedBy: null,
};

beforeEach(() => {
  mockGetPricing.mockReset();
  mockInvalidate.mockReset();
  mockLogEvent.mockReset();
  (prisma.providerModel.findUnique as jest.Mock).mockReset();
  (prisma.providerModel.update as jest.Mock).mockReset();
  (prisma.provider.findUnique as jest.Mock).mockReset();
});

describe("PUT /:providerId/models/:modelId/pricing (MCC-01, D3/D6)", () => {
  it("valid body → updates rates + stamps audit columns + invalidates cache + audits", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(MODEL_ROW);
    (prisma.providerModel.update as jest.Mock).mockResolvedValue({
      ...MODEL_ROW,
      inputCostPerToken: "0.0000015",
      outputCostPerToken: "0.000006",
      currency: "USD",
      lastCostUpdated: new Date(),
      lastCostUpdatedBy: "u-admin",
    });
    (prisma.providerModel.update as jest.Mock).mockResolvedValue({
      ...MODEL_ROW,
      inputCostPerToken: "0.0000015",
      outputCostPerToken: "0.000006",
      currency: "USD",
      lastCostUpdated: new Date(),
      lastCostUpdatedBy: "u-admin",
    });

    const res = await request(pricingApp())
      .put("/api/providers/prov-1/models/model-1/pricing")
      .send({ inputCostPerToken: 0.0000015, outputCostPerToken: 0.000006, currency: "USD" });

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("USD");
    expect(mockInvalidate).toHaveBeenCalledWith("prov-1", "gpt-x");
    expect(mockLogEvent).toHaveBeenCalledWith(
      "provider", "prov-1", "model.cost.updated", expect.anything(),
      expect.objectContaining({ modelId: "model-1" }),
    );
  });

  it("invalid body (negative) → 400 {error, details} (E2)", async () => {
    const res = await request(pricingApp())
      .put("/api/providers/prov-1/models/model-1/pricing")
      .send({ inputCostPerToken: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("unknown model → 404", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(pricingApp())
      .put("/api/providers/prov-1/models/model-1/pricing")
      .send({ inputCostPerToken: 0.0000015 });
    expect(res.status).toBe(404);
  });
});

describe("GET /:providerId/models/:modelId/pricing", () => {
  it("returns the current pricing surface (JSON-safe)", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue({
      ...MODEL_ROW,
      inputCostPerToken: "0.0000015",
      outputCostPerToken: "0.000006",
      currency: "USD",
      lastCostUpdated: new Date("2026-09-24T10:00:00Z"),
      lastCostUpdatedBy: "u-admin",
    });
    const res = await request(pricingApp()).get("/api/providers/prov-1/models/model-1/pricing");
    expect(res.status).toBe(200);
    expect(res.body.inputCostPerToken).toBe(0.0000015);
    expect(res.body.currency).toBe("USD");
  });
});

describe("POST /:providerId/models/:modelId/pricing/reset (E3 idempotent)", () => {
  it("nullifies rates → invalidate + audit", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue(MODEL_ROW);
    (prisma.providerModel.update as jest.Mock).mockResolvedValue({
      ...MODEL_ROW,
      inputCostPerToken: null,
      outputCostPerToken: null,
    });
    const res = await request(pricingApp())
      .post("/api/providers/prov-1/models/model-1/pricing/reset");
    expect(res.status).toBe(200);
    expect(mockInvalidate).toHaveBeenCalled();
    expect(mockLogEvent).toHaveBeenCalled();
  });

  it("reset on already-null pricing → 200 no-op (E3 idempotent)", async () => {
    (prisma.providerModel.findUnique as jest.Mock).mockResolvedValue({
      ...MODEL_ROW,
      inputCostPerToken: null,
      outputCostPerToken: null,
    });
    (prisma.providerModel.update as jest.Mock).mockResolvedValue(MODEL_ROW);
    const res = await request(pricingApp())
      .post("/api/providers/prov-1/models/model-1/pricing/reset");
    expect(res.status).toBe(200);
  });
});