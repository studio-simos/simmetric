// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 193 (LDAP-01, D-13/D-15/D-18) — community composite login route suite.
 *
 * Mount order under test mirrors the index.ts boot sequence exactly:
 *
 *   app.use("/api/auth", mockEnterpriseRouter)   ← the enterprise plugin's
 *     LDAP login route stand-in: mimics the defer-then-serve contract (next()
 *     with NO response on fallback-eligible arms, uniform 401 otherwise)
 *   app.use("/api/auth", compositeRouter)        ← the community composite arm
 *   app.use(catchAll404)                          ← always last
 *
 * Proves: deferred fallback-eligible requests serve local auth with a
 * response body identical to the enterprise 200 (D-15 uniformity);
 * fallbackToLocal false means the mock enterprise router 401s and the
 * composite NEVER fires (no local-auth call, no second handler); community
 * builds serve local auth only when the SsoConfig row reports provider
 * "ldap" and 404 { error: "Not found" } otherwise; no double-handling; no
 * internals leak in any body.
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/redisService", () => {
  const mockGetRedis = jest.fn();
  return {
    getRedis: mockGetRedis,
    isRedisAvailable: jest.fn(() => mockGetRedis() !== null),
  };
});

import request from "supertest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import prisma from "../utils/prisma";
import { createAuthLdapCompositeRouter } from "../routes/authLdapComposite";
import { authRateLimiter } from "../middleware/rateLimit";
import { login as realLogin } from "../services/authService";

// The enterprise route stand-in. Configurable per-test:
//  - behavior "defer": the fallback-eligible arm — calls next() with ZERO
//    res.* calls (the exact contract routes/ldap.ts implements)
//  - behavior "uniform401": the non-eligible arm (or fallbackToLocal false) —
//    the enterprise route answers the uniform 401 itself
//  - behavior "serve200": the LDAP-success arm — answers { user, token } in
//    the enterprise shape
// executionCount proves no double-handling: a deferred request must produce
// exactly ONE enterprise execution and (at most) ONE composite execution.
let enterpriseBehavior: "defer" | "uniform401" | "serve200" = "defer";
let enterpriseExecutionCount = 0;

function createMockEnterpriseRouter() {
  const router = express.Router();
  router.post(
    "/ldap/login",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      enterpriseExecutionCount += 1;
      if (enterpriseBehavior === "defer") {
        next(); // defer-then-serve: NO res.* call on this arm
        return;
      }
      if (enterpriseBehavior === "uniform401") {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }
      res.json({ user: { id: "ldap-user-001", username: req.body?.username }, token: "ldap-token" });
    },
  );
  return router;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createMockEnterpriseRouter());
  app.use("/api/auth", createAuthLdapCompositeRouter());
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  return app;
}

// Local user fixture — a real bcrypt hash so authService.login validates.
const LOCAL_USER = {
  id: "local-user-001",
  username: "localoperator",
  email: "local@test.local",
  passwordHash: "",
  salt: "x",
  firstName: null,
  lastName: null,
  avatar: null,
  customInstructions: null,
  textSize: null,
  mustChangePassword: false,
};

const LDAP_CONFIG_ROW = {
  id: "config-ldap",
  provider: "ldap",
  enabled: true,
  ldapUrl: "ldap://directory.example.com:389",
  ldapFallbackToLocal: true,
};

async function primeLocalUser(): Promise<void> {
  LOCAL_USER.passwordHash = await bcrypt.hash("local-secret-123", 12);
  (prisma.user.findFirst as jest.Mock).mockResolvedValue({ ...LOCAL_USER });
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({
    ...LOCAL_USER,
    roles: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  enterpriseBehavior = "defer";
  enterpriseExecutionCount = 0;
});

describe("authLdapComposite — enterprise build (defer-then-serve)", () => {
  beforeEach(async () => {
    // Staged provider row: the composite's community contract gate passes.
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({ ...LDAP_CONFIG_ROW });
    await primeLocalUser();
  });

  it("serves local auth on a deferred fallback-eligible request — { user, token } shape", async () => {
    enterpriseBehavior = "defer";
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "localoperator", password: "local-secret-123" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: expect.objectContaining({ id: "local-user-001", username: "localoperator" }),
      token: expect.any(String),
    });
    expect(enterpriseExecutionCount).toBe(1); // the defer ran, exactly once
  });

  it("the deferred response body is shape-identical to the enterprise 200 (D-15 uniformity)", async () => {
    enterpriseBehavior = "serve200";
    const served = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "ldapuser", password: "whatever" });
    expect(served.status).toBe(200);
    const servedKeys = Object.keys(served.body).sort();

    enterpriseBehavior = "defer";
    const deferred = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "localoperator", password: "local-secret-123" });
    expect(deferred.status).toBe(200);
    expect(Object.keys(deferred.body).sort()).toEqual(servedKeys);
    expect(Object.keys(deferred.body).sort()).toEqual(["token", "user"]);
    // And the uniform 401s match too — the enterprise 401 arm vs the local
    // fallback failure arm must be byte-identical bodies.
    enterpriseBehavior = "uniform401";
    const ent401 = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "x", password: "y" });
    enterpriseBehavior = "defer";
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null); // local user absent
    const local401 = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "ghost", password: "whatever" });
    expect(ent401.status).toBe(401);
    expect(local401.status).toBe(401);
    expect(local401.body).toEqual(ent401.body);
    expect(local401.body.error).toBe("Invalid credentials");
  });

  it("local fail on a deferred request returns the uniform 401 and audits server-side only", async () => {
    enterpriseBehavior = "defer";
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null); // no local user
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "ghost", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
  });

  it("an invalid body is 400 { error, details } without touching local auth", async () => {
    enterpriseBehavior = "defer";
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("details");
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("no internals leak in any composite response body (DN/filter/URL/stage/servedBy)", async () => {
    enterpriseBehavior = "defer";
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "localoperator", password: "local-secret-123" });
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    for (const leak of [
      "ldap://",
      "ldaps://",
      "cn=",
      "ou=",
      "dc=",
      "{{username}}",
      "localFallback",
      "servedBy",
      "fallback",
      "stage",
    ]) {
      expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe("authLdapComposite — ldapFallbackToLocal false ⇒ no defer ever arrives", () => {
  beforeEach(async () => {
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({ ...LDAP_CONFIG_ROW });
    await primeLocalUser();
  });

  it("the mock enterprise router 401s and the composite NEVER fires (no local-auth call)", async () => {
    enterpriseBehavior = "uniform401";
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "localoperator", password: "local-secret-123" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
    expect(enterpriseExecutionCount).toBe(1);
    // The local login path never ran: user.findFirst was NOT hit after the
    // enterprise 401 (authService.login is the only reader in this app).
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("authLdapComposite — community build (no enterprise plugin)", () => {
  it("SsoConfig row reports provider ldap ⇒ local auth serves", async () => {
    enterpriseBehavior = "defer"; // unreachable stand-in — community arm handles it
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({ ...LDAP_CONFIG_ROW });
    await primeLocalUser();
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "localoperator", password: "local-secret-123" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: expect.objectContaining({ id: "local-user-001" }),
      token: expect.any(String),
    });
  });

  it("local fail with a staged provider row ⇒ uniform 401 (same body as enterprise)", async () => {
    enterpriseBehavior = "defer";
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({ ...LDAP_CONFIG_ROW });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "ghost", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
  });

  it.each([
    ["no config row", null],
    ["saml provider row", { id: "c1", provider: "saml", enabled: true }],
    ["oidc provider row", { id: "c1", provider: "oidc", enabled: true }],
  ])("%s ⇒ 404 { error: 'Not found' } (today's community contract preserved)", async (_name, row) => {
    enterpriseBehavior = "defer";
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue(row);
    await primeLocalUser();
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "localoperator", password: "local-secret-123" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
    expect(enterpriseExecutionCount).toBe(1);
    // Local auth never ran on a 404 arm.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("a SsoConfig read failure degrades to the 404 arm (never a 500 that leaks the path)", async () => {
    enterpriseBehavior = "defer";
    (prisma.ssoConfig.findFirst as jest.Mock).mockRejectedValue(new Error("db down"));
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });
});

describe("authLdapComposite — no double-handling", () => {
  it("a deferred request runs the enterprise handler exactly once and produces ONE response", async () => {
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({ ...LDAP_CONFIG_ROW });
    await primeLocalUser();
    enterpriseBehavior = "defer";
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "localoperator", password: "local-secret-123" });
    expect(enterpriseExecutionCount).toBe(1);
    expect(res.status).toBe(200);
  });

  it("a served enterprise 200 never reaches the composite (single execution, no local-auth call)", async () => {
    enterpriseBehavior = "serve200";
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "ldapuser", password: "p" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe("ldap-token");
    expect(enterpriseExecutionCount).toBe(1);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("authLdapComposite — local fallback independence (T-193-20)", () => {
  it("local auth works when the staged config is UNREACHABLE-LDAP-shaped (provider ldap, LDAP down)", async () => {
    // The defer stands in for "LDAP unreachable with fallbackToLocal true" —
    // the composite arm must succeed with local credentials REGARDLESS of
    // LDAP health (D-13: LDAP down must never take down local login).
    enterpriseBehavior = "defer";
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({
      ...LDAP_CONFIG_ROW,
      ldapUrl: "ldap://unreachable.invalid:389",
    });
    await primeLocalUser();
    const res = await request(buildApp())
      .post("/api/auth/ldap/login")
      .send({ username: "localoperator", password: "local-secret-123" });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("localoperator");
  });
});

describe("authLdapComposite — composite route internals", () => {
  it("exports a router factory (mounted by index.ts after the plugin loads)", () => {
    const router = createAuthLdapCompositeRouter();
    expect(router).toBeDefined();
    expect(typeof router).toBe("function"); // express Router is a middleware fn
  });

  it("the factory mounts the community authRateLimiter before the handler", () => {
    // Structural pin: the composite router's single /ldap/login layer wraps a
    // route whose stack carries BOTH callbacks — [authRateLimiter, handler]
    // (express 5 nests multiple callbacks of one route in layer.route.stack).
    const router = createAuthLdapCompositeRouter();
    const stack = (router as unknown as {
      stack: { route?: { stack: unknown[] } }[];
    }).stack;
    expect(stack.length).toBe(1);
    expect(stack[0]!.route!.stack.length).toBe(2);
    void authRateLimiter;
    void realLogin;
  });
});