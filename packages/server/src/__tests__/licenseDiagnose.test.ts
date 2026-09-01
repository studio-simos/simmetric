// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * LIC-02 (D-01) — GET /api/license/diagnose tests.
 *
 * Strategy:
 * - mock ../middleware/auth — authMiddleware sets req.user from the Bearer
 *   token (admin → user with admin:settings permission so the REAL requireAdmin
 *   passes; non-admin → roles: [])
 * - mock ../config/env getEnv with a mutable object (LICENSE_KEY / JWT_SECRET /
 *   NODE_ENV / DATABASE_URL)
 * - keep ../services/licenseService REAL — it verifies against the embedded
 *   PRODUCTION public key (license-public-key.ts), with NO env override
 *   (an override would allow self-signing, so it is intentionally absent).
 * - mount licenseRoutes on a minimal express app via supertest
 *
 * Consequence: tokens signed with the test private key (from
 * licenseTestKeys.ts) ALWAYS verify as bad-signature against the embedded
 * production key. The "valid enterprise" path is therefore not unit-testable
 * here — it is covered by integration/smoke testing with a real vendor-issued
 * token. These tests cover: auth gating (401/403), missing key (community),
 * malformed (not-a-jwt), canary-absence, and the bad-signature path.
 */

jest.mock("../middleware/auth", () => ({
  authMiddleware: jest.fn((req: any, _res: any, next: () => void) => {
    const authHeader = req.headers?.authorization as string | undefined;
    if (!authHeader?.startsWith("Bearer ")) {
      req.user = undefined;
      return next();
    }
    const token = authHeader.substring(7);
    // Admin fixture: Bearer token literally "admin-token" → admin user
    if (token === "admin-token") {
      req.user = {
        id: "admin-1",
        roles: [{ role: { permissions: [{ permissionName: "admin:settings" }] } }],
      };
    } else {
      req.user = { id: "user-1", roles: [] };
    }
    next();
  }),
}));

jest.mock("../config/env", () => {
  const state: Record<string, unknown> = {
    LICENSE_KEY: undefined,
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  };
  return {
    getEnv: jest.fn(() => state),
    ENV_PATH: "/fake/path/.env",
    clearEnvCache: jest.fn(),
  };
});

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    backupLog: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  },
  withSoftDelete: (w: unknown) => w,
}));

import express from "express";
import request from "supertest";
import licenseRoutes from "../routes/license";
import { getEnv } from "../config/env";
import { signTestLicense } from "./helpers/licenseTestKeys";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/license", licenseRoutes);
  return app;
}

describe("GET /api/license/diagnose (LIC-02)", () => {
  beforeEach(() => {
    const env = getEnv() as Record<string, unknown>;
    env.LICENSE_KEY = undefined;
  });

  it("200 admin — missing LICENSE_KEY returns Community verdicts", async () => {
    const res = await request(buildApp())
      .get("/api/license/diagnose")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("community");
    expect(res.body.licensee).toBe("Community Edition");
    expect(res.body.expiresAt).toBeNull();
    expect(res.body.reason).toBe("missing");
    expect(res.body.env).toEqual({
      licenseKeyPresent: false,
      licensePublicKeyPresent: true,
      envPath: "/fake/path/.env",
    });
    expect(res.body.cachedTier).toBe("community");
    expect(res.body.jwt).toEqual({ isJwt: false, hasExp: false });
  });

  it("401 — no Authorization header", async () => {
    const res = await request(buildApp()).get("/api/license/diagnose");
    expect(res.status).toBe(401);
  });

  it("403 — non-admin Bearer JWT", async () => {
    const res = await request(buildApp())
      .get("/api/license/diagnose")
      .set("Authorization", "Bearer user-token");
    expect(res.status).toBe(403);
  });

  it("200 — test-signed token is bad-signature against embedded production key (no env override)", async () => {
    // A token signed with the TEST private key cannot verify against the
    // embedded PRODUCTION public key — this is the security guarantee. The
    // diagnose endpoint surfaces reason=bad-signature, tier=community.
    const token = signTestLicense({
      tier: "enterprise",
      sub: "Test Org",
    });
    (getEnv() as Record<string, unknown>).LICENSE_KEY = token;

    const res = await request(buildApp())
      .get("/api/license/diagnose")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("community");
    expect(res.body.reason).toBe("bad-signature");
    expect(res.body.cachedTier).toBe("community");
    expect(res.body.env.licenseKeyPresent).toBe(true);
    expect(res.body.env.licensePublicKeyPresent).toBe(true);
    expect(res.body.jwt.isJwt).toBe(true);
    expect(res.body.jwt.hasExp).toBe(true);
  });

  it("canary-absence — the 200 body never contains the LICENSE_KEY fixture or the JWT payload segment", async () => {
    const token = signTestLicense({ tier: "enterprise", sub: "Canary Corp" });
    const jwtBody = token.split(".")[1];
    (getEnv() as Record<string, unknown>).LICENSE_KEY = token;

    const res = await request(buildApp())
      .get("/api/license/diagnose")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    const forbidden = [token, jwtBody];
    for (const f of forbidden) {
      expect(serialized).not.toContain(f);
    }
  });

  it("garbage LICENSE_KEY — 200 with reason 'malformed' and jwt.isJwt false, no throw", async () => {
    (getEnv() as Record<string, unknown>).LICENSE_KEY = "not-a-jwt";

    const res = await request(buildApp())
      .get("/api/license/diagnose")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("malformed");
    expect(res.body.jwt).toEqual({ isJwt: false, hasExp: false });
    expect(res.body.env.licenseKeyPresent).toBe(true);
  });
});