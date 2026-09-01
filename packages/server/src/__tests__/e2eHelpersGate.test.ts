// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * G-1 (T-DRD-01): the E2E helper router (/api/__tests__) must NOT be mounted
 * when the server runs with NODE_ENV=production. e2eHelpers.ts's own header
 * doc comment promises "only available in development/test environments" —
 * this gate pins that promise: an unauthenticated process-spawn endpoint
 * must be unreachable in production (404, router never mounted).
 *
 * Only the production path is unit-tested: asserting the mounted/happy path
 * would bind a real port (start() boots the echo MCP server). The mounted
 * path is covered by e2e/marketplace-lifecycle.spec.ts.
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

// Production env — mirrors the auth.test.ts env-mock scaffold with NODE_ENV
// pinned to "production" so createApp() evaluates the mount gate CLOSED.
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "production",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

// Mirrors auth.test.ts: rateLimit calls getRedis() at module scope (this file
// eagerly imports ../index), so the factory-created mock keeps it null.
jest.mock("../services/redisService", () => {
  const mockGetRedis = jest.fn();
  return {
    getRedis: mockGetRedis,
    isRedisAvailable: jest.fn(() => mockGetRedis() !== null),
  };
});

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
// Health check pings the collector over HTTP — stub it for determinism.
jest.mock("../services/hybridSearchService", () => ({
  checkCollectorHealth: jest.fn().mockResolvedValue({ reachable: true }),
  hybridSearch: jest.fn(),
  multiWorkspaceHybridSearch: jest.fn(),
}));

import request from "supertest";
import { createApp, mountCatchAlls } from "../index";

const app = createApp();
// The 404 catch-all is mounted by the boot sequence after the enterprise
// plugin loader — tests asserting 404 must mount it explicitly (index.ts
// comment at the mountCatchAlls export).
mountCatchAlls(app);

describe("G-1: /api/__tests__ is not mounted in production (T-DRD-01)", () => {
  it("returns 404 for POST /api/__tests__/start-echo-server when NODE_ENV=production", async () => {
    const res = await request(app).post("/api/__tests__/start-echo-server");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not found");
  });

  it("returns 404 for POST /api/__tests__/stop-echo-server when NODE_ENV=production", async () => {
    const res = await request(app).post("/api/__tests__/stop-echo-server");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not found");
  });
});