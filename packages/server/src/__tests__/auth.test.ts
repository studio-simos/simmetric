// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Auth middleware tests — authMiddleware and apiKeyMiddleware
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

// TEC-03b: redisService mock with a DEFAULT null return — every pre-existing
// test stays on the degraded (Redis absent) path. Per-test overrides set a
// fake redis instance for the revocation cases. The mock instance is created
// INSIDE the factory (this file eagerly imports ../index → rateLimit → calls
// getRedis() at module scope, so an outer `const` would hit a TDZ); the test
// body reaches it via jest.requireMock, which returns the same cached module.
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
// Health check pings the collector over HTTP — stub it for deterministic "ok"
jest.mock("../services/hybridSearchService", () => ({
  checkCollectorHealth: jest.fn().mockResolvedValue({ reachable: true }),
  hybridSearch: jest.fn(),
  multiWorkspaceHybridSearch: jest.fn(),
}));

import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../index";
import { generateTestToken, adminUser, regularUser } from "./helpers/mockAuth";
import { generateToken, verifyToken } from "../services/authService";
import prisma from "../utils/prisma";

const app = createApp();

// Handle to the factory-created redisService mock (see jest.mock above).
const { getRedis: mockGetRedis } = jest.requireMock("../services/redisService") as {
  getRedis: jest.Mock;
};

// UUIDv4 regex (RFC 4122)
const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ─── authMiddleware ───────────────────────────────────────────────

describe("authMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRedis.mockReturnValue(null);
  });

  it("returns 401 when no authorization header", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 on malformed header", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", "InvalidFormat");
    expect(res.status).toBe(401);
  });

  it("returns 401 on expired token", async () => {
    const jwt = require("jsonwebtoken");
    const expiredToken = jwt.sign({ userId: "admin-001" }, "test-jwt-secret-for-unit-tests-32ch", { expiresIn: "0s" });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });

  it("returns 401 on invalid token", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer invalid.token.here");
    expect(res.status).toBe(401);
  });

  it("returns 401 when user not found", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken("nonexistent-user");
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("succeeds with valid token and existing user", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken("admin-001");
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("admin");
  });
});

// ─── apiKeyMiddleware ─────────────────────────────────────────────

describe("apiKeyMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when X-Api-Key header is missing", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});

// ─── Auth routes integration ──────────────────────────────────────

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 for non-existent user", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app).post("/api/auth/login").send({ username: "ghost", password: "secret123" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
  });

  // G-4 (T-DRD-04): route-level loginSchema.safeParse — invalid body is a 400
  // { error, details } like every other auth route, NOT a 401 with a raw Zod
  // message leaked from the service-level parse.
  it("returns 400 { error, details } for an invalid/empty body (route-level safeParse)", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body).toHaveProperty("details");
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("returns 400 { error, details } for a passwordless body", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "someone" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("details");
  });

  // G-5 (T-DRD-04): dummy-bcrypt timing hardening — user-not-found must run a
  // bcrypt.compare against the fixed throwaway hash so response timing no
  // longer distinguishes existing vs non-existing usernames.
  it("runs a dummy bcrypt.compare on the user-not-found path (timing hardening)", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    const bcrypt = require("bcryptjs");
    const compareSpy = jest.spyOn(bcrypt, "compare");
    try {
      const res = await request(app).post("/api/auth/login").send({ username: "ghost", password: "secret123" });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid credentials");
      // Both paths now cost one bcrypt.compare call.
      expect(compareSpy).toHaveBeenCalledTimes(1);
      // The dummy path never reaches a user hash: the presented password is
      // compared against the fixed module-level DUMMY hash.
      expect(compareSpy).toHaveBeenCalledWith("secret123", expect.any(String));
    } finally {
      compareSpy.mockRestore();
    }
  });

  it("returns 401 for wrong password", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: "user-001",
      username: "regular",
      passwordHash: "$2a$12$hashedpassword",
    });
    const res = await request(app).post("/api/auth/login").send({ username: "regular", password: "wrongpassword" });
    expect(res.status).toBe(401);
  });

  it("includes mustChangePassword in the login response", async () => {
    const bcrypt = require("bcryptjs");
    const passwordHash = await bcrypt.hash("secret123", 12);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: "user-001",
      username: "regular",
      email: "regular@test.com",
      passwordHash,
      firstName: null,
      lastName: null,
      avatar: null,
      customInstructions: null,
      textSize: null,
      mustChangePassword: true,
    });
    // getUserWithRoles() uses findUnique to fetch roles/permissions
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...regularUser, roles: [] });

    const res = await request(app).post("/api/auth/login").send({ username: "regular", password: "secret123" });
    expect(res.status).toBe(200);
    expect(res.body.user).toHaveProperty("mustChangePassword", true);
  });
});

// ─── POST /api/auth/set-initial-password ──────────────────────────

describe("POST /api/auth/set-initial-password", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post("/api/auth/set-initial-password").send({ newPassword: "longenough1" });
    expect(res.status).toBe(401);
  });

  it("sets the password and clears mustChangePassword with a valid token", async () => {
    // authMiddleware loads the user via findUnique; the handler then findUnique + update.
    // The gate requires mustChangePassword to be true for the rotation to proceed.
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...regularUser, mustChangePassword: true });
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...regularUser, mustChangePassword: false });

    const token = generateTestToken("user-001");
    const res = await request(app)
      .post("/api/auth/set-initial-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "longenough1" });

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-001" },
        data: expect.objectContaining({ mustChangePassword: false }),
      }),
    );
  });

  it("rejects with 403 when no password change is required (anti account-takeover)", async () => {
    // Flag already cleared: the endpoint must refuse so a stolen session token
    // cannot rotate the password without the current-password check.
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...regularUser, mustChangePassword: false });

    const token = generateTestToken("user-001");
    const res = await request(app)
      .post("/api/auth/set-initial-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "longenough1" });

    expect(res.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a password shorter than 8 characters with 400", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(regularUser);

    const token = generateTestToken("user-001");
    const res = await request(app)
      .post("/api/auth/set-initial-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ newPassword: "short" });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/users", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 403 for non-admin user", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(regularUser);
    const token = generateTestToken("user-001");
    const res = await request(app).get("/api/auth/users").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 200 for admin user", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([adminUser]);
    const token = generateTestToken("admin-001");
    const res = await request(app).get("/api/auth/users").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/health", () => {
  it("returns ok status", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

// ─── POST /api/auth/admin-reset-password (G-6, T-DRD-05) ──────────

describe("POST /api/auth/admin-reset-password", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post("/api/auth/admin-reset-password").send({ userId: "user-001", newPassword: "longenough1" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin token", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(regularUser);
    const token = generateTestToken("user-001");
    const res = await request(app)
      .post("/api/auth/admin-reset-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "user-001", newPassword: "longenough1" });
    expect(res.status).toBe(403);
  });

  // G-6: the shared adminResetPasswordSchema (safeParse) replaces the ad-hoc
  // destructure + manual length check → 400 { error, details } on bad bodies.
  it("returns 400 { error, details } when newPassword is missing", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken("admin-001");
    const res = await request(app)
      .post("/api/auth/admin-reset-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "user-001" });

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body).toHaveProperty("details");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 400 { error, details } for a non-UUID userId", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken("admin-001");
    const res = await request(app)
      .post("/api/auth/admin-reset-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "not-a-uuid", newPassword: "longenough1" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("details");
  });

  it("resets the password and invalidates the auth cache with a valid body", async () => {
    // Real user ids are UUIDs (Prisma @default(uuid())); the new schema
    // enforces that, so the target userId must be UUID-shaped.
    const TARGET_USER_ID = "660e8400-e29b-41d4-a716-4466554402ff";
    // authMiddleware loads the admin via findUnique; the handler then does
    // findUnique (target) + update. Both return distinct payloads.
    (prisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(adminUser) // authMiddleware caller
      .mockResolvedValueOnce({ ...regularUser, id: TARGET_USER_ID }); // target user
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...regularUser, id: TARGET_USER_ID });

    const token = generateTestToken("admin-001");
    const res = await request(app)
      .post("/api/auth/admin-reset-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: TARGET_USER_ID, newPassword: "longenough1" });

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TARGET_USER_ID },
        data: expect.objectContaining({
          passwordHash: expect.any(String),
          salt: expect.any(String),
        }),
      }),
    );
  });
});

// ─── GET /api/auth/sso/status (public) ─────────────────────────────

describe("GET /api/auth/sso/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Full SsoConfig row shape (mirrors the baseConfig fixture in sso.test.ts:372).
  const baseConfig = {
    id: "config-1",
    provider: "saml",
    enabled: true,
    clientId: "sp-entity-id",
    clientSecretEncrypted: "mock_encrypted:my-secret",
    discoveryUrl: null,
    entryPoint: "https://idp.example.com/sso",
    cert: "-----BEGIN CERTIFICATE-----",
    entityId: "simmetric-chat",
    redirectUri: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("is public — returns 200 without an auth header", async () => {
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get("/api/auth/sso/status");
    expect(res.status).toBe(200);
  });

  it("returns the empty shape when no config row exists", async () => {
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get("/api/auth/sso/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, provider: null, oidcProvider: null });
  });

  it("returns saml provider for an enabled saml config", async () => {
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue(baseConfig);
    const res = await request(app).get("/api/auth/sso/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, provider: "saml", oidcProvider: null });
  });

  it("derives oidcProvider google from a Google discovery URL", async () => {
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({
      ...baseConfig,
      provider: "oidc",
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    });
    const res = await request(app).get("/api/auth/sso/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, provider: "oidc", oidcProvider: "google" });
  });

  it("falls back to oidc for a custom discovery URL", async () => {
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({
      ...baseConfig,
      provider: "oidc",
      discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
    });
    const res = await request(app).get("/api/auth/sso/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, provider: "oidc", oidcProvider: "oidc" });
  });

  it("never leaks clientId, discoveryUrl, cert, entityId, or redirectUri", async () => {
    (prisma.ssoConfig.findFirst as jest.Mock).mockResolvedValue({
      ...baseConfig,
      provider: "oidc",
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    });
    const res = await request(app).get("/api/auth/sso/status");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("clientId");
    expect(res.body).not.toHaveProperty("discoveryUrl");
    expect(res.body).not.toHaveProperty("cert");
    expect(res.body).not.toHaveProperty("entityId");
    expect(res.body).not.toHaveProperty("redirectUri");
    expect(res.body).not.toHaveProperty("clientSecretConfigured");
  });
});

// ─── TEC-03b: jti minting / verify widening (D-02) ──────────────

describe("generateToken/verifyToken — jti (D-02)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRedis.mockReturnValue(null);
  });

  it("mints a UUIDv4 jti on every generateToken call", () => {
    const token = generateToken("admin-001");
    const payload = jwt.decode(token) as { userId: string; jti?: string };
    expect(payload.userId).toBe("admin-001");
    expect(payload.jti).toMatch(UUIDV4_RE);
  });

  it("mints distinct jtis across calls", () => {
    const p1 = jwt.decode(generateToken("admin-001")) as { jti?: string };
    const p2 = jwt.decode(generateToken("admin-001")) as { jti?: string };
    expect(p1.jti).not.toBe(p2.jti);
  });

  it("verifyToken returns the jti for a jti-bearing token", () => {
    const token = generateToken("admin-001");
    const payload = verifyToken(token);
    expect(payload.userId).toBe("admin-001");
    expect(payload.jti).toMatch(UUIDV4_RE);
  });

  it("verifyToken returns jti: undefined for a token signed without jti (D-04)", () => {
    const legacy = jwt.sign({ userId: "admin-001" }, "test-jwt-secret-for-unit-tests-32ch");
    const payload = verifyToken(legacy);
    expect(payload.userId).toBe("admin-001");
    expect(payload.jti).toBeUndefined();
  });
});

// ─── TEC-03b: authMiddleware revoked-jti enforcement (D-03) ─────

describe("authMiddleware — revoked jti (TEC-03b)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRedis.mockReturnValue(null);
  });

  it("returns 401 'Token revoked' when the payload jti is blacklisted", async () => {
    mockGetRedis.mockReturnValue({ get: jest.fn().mockResolvedValue("1"), set: jest.fn() });
    const token = jwt.sign({ userId: "admin-001", jti: "revoked-jti-1" }, "test-jwt-secret-for-unit-tests-32ch");
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Token revoked");
  });

  it("returns 200 for a jti-bearing token with a blacklist miss", async () => {
    mockGetRedis.mockReturnValue({ get: jest.fn().mockResolvedValue(null), set: jest.fn() });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = jwt.sign({ userId: "admin-001", jti: "fresh-jti-1" }, "test-jwt-secret-for-unit-tests-32ch");
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("admin");
  });

  it("still returns 200 for a no-jti legacy token (D-04, existing behavior)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken("admin-001");
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("admin");
  });
});

// ─── TEC-03b: register-with-admin revocation (OQ2, Task 3) ──────

describe("POST /api/auth/register (closed registration) — revoked jti (TEC-03b)", () => {
  const closedEnv = { ...jest.requireMock("../config/env").getEnv(), ALLOW_REGISTRATION: false };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRedis.mockReturnValue(null);
  });

  it("returns 401 'Token revoked' for a revoked admin token before any user lookup", async () => {
    (jest.requireMock("../config/env").getEnv as jest.Mock).mockReturnValueOnce(closedEnv);
    mockGetRedis.mockReturnValue({ get: jest.fn().mockResolvedValue("1"), set: jest.fn() });
    const token = jwt.sign({ userId: "admin-001", jti: "revoked-admin-jti" }, "test-jwt-secret-for-unit-tests-32ch");

    const res = await request(app)
      .post("/api/auth/register")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "newuser", email: "new@test.com", password: "testpassword123" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Token revoked");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("lets a no-jti admin token pass the revocation gate and complete registration (201)", async () => {
    (jest.requireMock("../config/env").getEnv as jest.Mock).mockReturnValueOnce(closedEnv);
    mockGetRedis.mockReturnValue(null);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue({
      id: "new-user-1",
      username: "newuser",
      email: "new@test.com",
      firstName: null,
      lastName: null,
      avatar: null,
      customInstructions: null,
      textSize: null,
      mustChangePassword: true,
    });
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(null);

    const token = generateTestToken("admin-001");
    const res = await request(app)
      .post("/api/auth/register")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "newuser", email: "new@test.com", password: "testpassword123" });

    expect(res.status).toBe(201);
  });
});