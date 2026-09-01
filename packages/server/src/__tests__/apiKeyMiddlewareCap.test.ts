// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 163 — apiKeyMiddleware HMAC O(1) lookup (closes CSW-05/SCALE-03).
 *
 * REWRITE of the Phase 155 CSW-05 cap test. The middleware now delegates to
 * `apiKeyService.validateApiKey` (DRY) instead of inlining a bcrypt loop. The
 * CSW-05 `take: 10` cap is GONE — there is no loop to cap. This test asserts
 * the new behavioral contract: the middleware delegates to validateApiKey,
 * returns 401 on null, returns 500 (fail-loud) when validateApiKey throws
 * (e.g. missing API_KEY_HMAC_SECRET — T-163-02), and never touches prisma
 * findMany or a take cap directly.
 *
 * The prisma mock exposes findUnique + update (the middleware no longer calls
 * findMany). `validateApiKey` is mocked as a jest.fn — the test asserts the
 * delegation, not the internal HMAC (covered by apiKeyService.test.ts).
 */
import "./helpers/setupEnv";

// Mock the prisma singleton — exposes findUnique + update (no findMany).
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    apiKey: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// Mock apiKeyService — the middleware delegates to validateApiKey. We assert
// the delegation + the return-value branching, NOT the internal HMAC.
jest.mock("../services/apiKeyService", () => ({
  __esModule: true,
  validateApiKey: jest.fn(),
}));

// getCachedUserWithRoles is called after a match — stub it so a matched key
// can reach the `next()` path without pulling in the real user/role query.
jest.mock("../services/authService", () => ({
  getCachedUserWithRoles: jest.fn().mockResolvedValue({ id: "user-001", username: "owner", roles: [] }),
  // re-export the others the middleware imports (unused here but the import
  // graph at the top of auth.ts pulls them in).
  verifyToken: jest.fn(),
  getUserWithRoles: jest.fn(),
}));

jest.mock("../services/tokenRevocation", () => ({
  isTokenRevoked: jest.fn().mockResolvedValue(false),
}));

// NOTE: no bcryptjs mock — the middleware no longer imports bcryptjs.

import type { Request, Response, NextFunction } from "express";
import { apiKeyMiddleware } from "../middleware/auth";
import prisma from "../utils/prisma";
import { validateApiKey } from "../services/apiKeyService";

const mockFindUnique = prisma.apiKey.findUnique as jest.Mock;
const mockUpdate = prisma.apiKey.update as jest.Mock;
const mockValidateApiKey = validateApiKey as jest.Mock;

// Minimal Express-like stand-ins — apiKeyMiddleware only reads
// req.headers["x-api-key"] and calls res.status().json()/next().
function makeReq(apiKey?: string): Request {
  return { headers: apiKey ? { "x-api-key": apiKey } : {} } as unknown as Request;
}
function makeRes(): Response {
  const res = { statusCode: 200, body: null as unknown } as unknown as Response;
  res.status = jest.fn((code: number) => {
    (res as any).statusCode = code;
    return res;
  }) as any;
  res.json = jest.fn((body: unknown) => {
    (res as any).body = body;
    return res;
  }) as any;
  return res;
}

// A valid-length test API key (≥8 chars). The plaintext value is irrelevant
// here because validateApiKey is mocked.
const TEST_KEY = "sk-test-apikey-0123456789";

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockResolvedValue({});
});

describe("Phase 163: apiKeyMiddleware delegates to validateApiKey (HMAC O(1))", () => {
  it("valid key: validateApiKey returns createdBy → user loaded → next() called, NOT 401", async () => {
    mockValidateApiKey.mockResolvedValue("user-001");

    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    await apiKeyMiddleware(makeReq(TEST_KEY), res, next);

    // The delegation: validateApiKey called exactly once with the raw key
    expect(mockValidateApiKey).toHaveBeenCalledTimes(1);
    expect(mockValidateApiKey).toHaveBeenCalledWith(TEST_KEY);
    // User loaded + next called (NOT 401)
    expect((res as any).statusCode).not.toBe(401);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("validateApiKey returns null → 401 'Invalid API key', next NOT called", async () => {
    mockValidateApiKey.mockResolvedValue(null);

    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    await apiKeyMiddleware(makeReq(TEST_KEY), res, next);

    expect((res as any).statusCode).toBe(401);
    expect((res as any).body).toEqual({ error: "Invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("validateApiKey throws → 500 'Internal server error', next NOT called (fail-loud on misconfiguration, T-163-02)", async () => {
    // Simulates a missing/invalid API_KEY_HMAC_SECRET — validateApiKey throws.
    mockValidateApiKey.mockRejectedValue(new Error("API_KEY_HMAC_SECRET is required"));

    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    await apiKeyMiddleware(makeReq(TEST_KEY), res, next);

    // 500, NOT 401 — hiding misconfiguration as "invalid key" is a spoofing vector
    expect((res as any).statusCode).toBe(500);
    expect((res as any).body).toEqual({ error: "Internal server error" });
    expect(next).not.toHaveBeenCalled();
  });

  it("missing x-api-key header → 401 'Missing API key', validateApiKey NOT called", async () => {
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    await apiKeyMiddleware(makeReq(undefined), res, next);

    expect((res as any).statusCode).toBe(401);
    expect((res as any).body).toEqual({ error: "Missing API key" });
    expect(mockValidateApiKey).not.toHaveBeenCalled();
  });

  it("does NOT call prisma.apiKey.findMany or pass a take cap (CSW-05 cap removed)", async () => {
    mockValidateApiKey.mockResolvedValue("user-001");

    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    await apiKeyMiddleware(makeReq(TEST_KEY), res, next);

    // The middleware delegates entirely — it never calls prisma findMany/findUnique
    // directly (validateApiKey does, internally). findUnique exists on the mock
    // but the middleware must NOT call it.
    expect(mockFindUnique).not.toHaveBeenCalled();
    // No take cap — there is no loop to cap (the old CSW-05 backstop is gone).
    // (findMany does not even exist on this mock — the middleware must not reach for it.)
  });
});