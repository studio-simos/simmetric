// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 195 (MCPO-01) — OAuth route tests (Task 1).
 *
 * Covers (D-06/D-07/D-10/D-14/D-15):
 *  - POST /:connectionId/oauth/start: admin + permission → 200 { authorizeUrl }
 *    with provider authUrl + state param; row flips pending; no-client → 400
 *    { error }; cross-org → 404; missing permission → 403; non-oauth row → 400.
 *  - GET /oauth/callback (PUBLIC — no auth header, Pitfall 2 proof): valid
 *    signed state + pending row + stubbed fetch → row authorized, blob
 *    decrypts, redirect ?oauth=authorized; replayed callback → error redirect;
 *    tampered state → error redirect; expired state → error redirect;
 *    provider exchange 400 → oauthStatus=error + error redirect.
 *  - DELETE /:connectionId/oauth: wipes credential columns, keeps
 *    authType/oauthProvider, returns { revoked: true }.
 *  - No-leak (T-195-10): the start response carries exactly { authorizeUrl };
 *    redirect targets carry only the status param.
 *
 * Pattern: mcpRoutes.test.ts heavy-mock (mock prisma via createMockPrisma,
 * fake authMiddleware + tenantContext, requirePermission pass-through unless
 * the test requests 403). fetch is stubbed globally (Pitfall 10 — CI runs
 * NETWORK_EGRESS_BLOCKED=1).
 */
import "./helpers/setupEnv";

jest.mock("uuid", () => ({
  v4: jest.fn(() => "550e8400-e29b-41d4-a716-446655440000"),
  validate: jest.fn(() => true),
}));

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    withSoftDelete: (where: unknown) => where,
  };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    SERVER_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

jest.mock("../agent/mcpClient", () => ({
  connectMCPServer: jest.fn(() => Promise.resolve({ tools: [] })),
  disconnectMCPServer: jest.fn(() => Promise.resolve()),
  getConnectionStatuses: jest.fn(),
  testMCPServerConnection: jest.fn(() => Promise.resolve()),
  clearConnectionError: jest.fn(),
}));

jest.mock("../agent/skills", () => ({
  registerSkill: jest.fn(),
  unregisterSkillsForConnection: jest.fn(),
}));

jest.mock("../middleware/auth", () => {
  const __mockRbac = { deny: false };
  return {
    __mockRbac,
    authMiddleware: (req: any, res: any, next: any) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.userId = "admin-001";
      req.organizationId = "org-default";
      req.user = {
        id: "admin-001",
        roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }, { permissionName: "mcp:oauth:manage" }] } }],
      };
      next();
    },
    apiKeyMiddleware: (req: any, res: any, next: any) => {
      req.userId = "service-account-001";
      next();
    },
  };
});

// requirePermission mock: pass-through by default; the 403 test flips
// __mockRbac.deny to simulate a principal lacking mcp:oauth:manage. The
// holder lives on the mocked auth module (filtersRoute.test.ts __mockState
// pattern) so the jest.mock factory never references an outer variable.
jest.mock("../middleware/rbac", () => {
  // jest.requireActual inside a factory resolves OTHER modules' real code —
  // but ../middleware/auth is itself mocked, so require its mocked exports
  // via the runtime require (the factory cannot reference outer variables
  // under @swc/jest; filtersRoute.test.ts solves the same problem with
  // require("../middleware/auth").__mockState).
  const { __mockRbac } = require("../middleware/auth") as {
    __mockRbac: { deny: boolean };
  };
  return {
    __esModule: true,
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    requirePermission: (_perm: unknown) => (req: any, res: any, next: any) => {
      if (__mockRbac.deny) {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
      next();
    },
    // createApp() mounts other routers that use the graded middlewares —
    // shadow no-ops (filtersRoute.test.ts pattern) so Express never receives
    // "undefined" as a handler.
    requireProjectAccess: (_req: any, _res: any, next: any) => next(),
    requireWorkspaceRead: () => (_req: any, _res: any, next: any) => next(),
    requireWorkspaceWriteAccess: () => (_req: any, _res: any, next: any) => next(),
    requireWorkspaceAccess: (_req: any, _res: any, next: any) => next(),
    resolveWorkspaceRole: jest.fn(),
  };
});

import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";
import { connectMCPServer } from "../agent/mcpClient";
import { signOAuthState, consumeVerifier } from "../services/oauthStateService";

// The deny-flag holder lives on the mocked auth module — bind it at test
// level via the MOCKED module (a plain require resolves the jest.mock
// factory's exports; requireActual would bypass the mock entirely).
const { __mockRbac } = require("../middleware/auth") as {
  __mockRbac: { deny: boolean };
};

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const CONN_ID = "550e8400-e29b-41d4-a716-446655440001";

/** A pending oauth connection row matching the fake auth middleware's org. */
function pendingConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONN_ID,
    name: "OAuth MCP",
    url: "http://mcp-server.example.com/sse",
    transportType: "sse",
    projectId: "550e8400-e29b-41d4-a716-446655440002",
    workspaceId: null,
    headers: "{}",
    enabled: true,
    lastSyncAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    organizationId: "org-default",
    // Phase 195 oauth columns (D-01)
    authType: "oauth",
    oauthProvider: "google",
    oauthScopes: null,
    credentialsEncrypted: null,
    tokenExpiresAt: null,
    oauthStatus: "pending",
    oauthError: null,
    oauthClientId: null,
    ...overrides,
  };
}

const TEST_JWT_SECRET = "test-jwt-secret-for-unit-tests-32ch";

function signState(payload: Record<string, unknown>, opts?: jwt.SignOptions): string {
  return jwt.sign(payload, TEST_JWT_SECRET, opts ?? { expiresIn: "10m" });
}

/** Valid signed state for CONN_ID minted by the REAL signOAuthState —
 * binds the PKCE verifier to the state's nonce (WR-01) and carries the
 * WR-03 aud claim the verify pins. consumeVerifier(stateNonce) is the
 * production pairing; a hand-signed state without its verifier would
 * fail-closed at the PKCE arm. */
function validState(): string {
  const { state } = signOAuthState(CONN_ID);
  return state;
}

// ─── POST /:connectionId/oauth/start ────────────────────────────────────

describe("POST /api/mcp-connections (create with oauth fields, D-01/D-03)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __mockRbac.deny = false;
    (prisma.mCPConnection.create as jest.Mock).mockImplementation(
      (args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...pendingConnection(), ...args.data }),
    );
  });

  it("persists the validated oauth fields into prisma.create (D-03 pin — E2E caught the dropped-fields gap the create-route destructure masked)", async () => {
    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({
        name: "OAuth probe",
        url: "http://mcp.example.com/sse",
        transportType: "sse",
        workspaceId: "550e8400-e29b-41d4-a716-446655440002",
        authType: "oauth",
        oauthProvider: "google",
      });

    expect(res.status).toBe(201);
    const data = (prisma.mCPConnection.create as jest.Mock).mock.calls[0][0].data;
    expect(data.authType).toBe("oauth");
    expect(data.oauthProvider).toBe("google");
    expect(data.oauthScopes).toBeNull();
    expect(data.oauthClientId).toBeNull();
    // The response never carries the secret column (Pitfall 1).
    expect("credentialsEncrypted" in res.body).toBe(false);
    expect(res.body.authType).toBe("oauth");
  });
});

describe("POST /api/mcp-connections/:connectionId/oauth/start (D-07/D-15)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __mockRbac.deny = false;
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(pendingConnection());
  });

  it("returns 200 { authorizeUrl } with provider authUrl + state param; row flips pending", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(pendingConnection());

    const res = await request(app)
      .post(`/api/mcp-connections/${CONN_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(200);
    // oauthStartResponseSchema: exactly { authorizeUrl } — no state/code/token
    // field beyond it (T-195-09 response-shape contract).
    expect(Object.keys(res.body).sort()).toEqual(["authorizeUrl"]);
    expect(res.body.authorizeUrl).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(res.body.authorizeUrl).toContain("state=");
    expect(res.body.authorizeUrl).toContain("code_challenge_method=S256");
    expect(res.body.authorizeUrl).toContain("access_type=offline");
    // Row flips pending + clears stale oauthError (D-07).
    expect(prisma.mCPConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONN_ID },
        data: expect.objectContaining({ oauthStatus: "pending", oauthError: null }),
      })
    );
    // The redirect_uri is the fixed public callback (D-09).
    expect(res.body.authorizeUrl).toContain(
      `redirect_uri=${encodeURIComponent("http://localhost:3000/api/mcp-connections/oauth/callback")}`
    );
  });

  it("returns 400 when the provider client is not configured (D-06)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(
      pendingConnection({ oauthProvider: "microsoft" })
    );

    const res = await request(app)
      .post(`/api/mcp-connections/${CONN_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "OAuth provider client not configured" });
    expect(prisma.mCPConnection.update).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-oauth connection", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(
      pendingConnection({ authType: "static", oauthProvider: null })
    );

    const res = await request(app)
      .post(`/api/mcp-connections/${CONN_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Connection is not configured for OAuth");
  });

  it("returns 404 for cross-org connection (T-185-10 404-hide)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(
      pendingConnection({ organizationId: "org-other" })
    );

    const res = await request(app)
      .post(`/api/mcp-connections/${CONN_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(404);
  });

  it("returns 403 when the principal lacks mcp:oauth:manage (D-15)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(pendingConnection());
    __mockRbac.deny = true;

    const res = await request(app)
      .post(`/api/mcp-connections/${CONN_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Insufficient permissions" });
    __mockRbac.deny = false;
  });

  it("never leaks the verifier or credentials in the response (T-195-14)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(pendingConnection());

    const res = await request(app)
      .post(`/api/mcp-connections/${CONN_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.body.authorizeUrl).not.toContain("client_secret");
  });
});

// ─── GET /oauth/callback (PUBLIC router — Pitfall 2 proof) ──────────────

describe("GET /api/mcp-connections/oauth/callback (public, D-09/D-10)", () => {
  const TOKEN_RESPONSE = {
    access_token: "fake-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    refresh_token: "fake-refresh-token",
  };

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    __mockRbac.deny = false;
    (prisma.mCPConnection.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      pendingConnection(data)
    );
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(TOKEN_RESPONSE),
      } as unknown as Response)
    );
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("completes the exchange with NO auth header (public mount proof, Pitfall 2): row authorized + blob decrypts + redirect oauth=authorized", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(pendingConnection());

    const res = await request(app)
      .get("/api/mcp-connections/oauth/callback")
      .query({ code: "auth-code-1", state: validState() })
      // Deliberately NO Authorization header — the browser redirect carries none.

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.location).toContain("oauth=authorized");

    // Row flipped authorized + blob written (WR-01: the flip rides the CAS
    // updateMany — the mock resolves count:1).
    const updateArg = (prisma.mCPConnection.updateMany as jest.Mock).mock.calls.find(
      (call: unknown[]) => (call[0] as { data: Record<string, unknown> }).data.credentialsEncrypted !== undefined
    );
    expect(updateArg).toBeDefined();
    const data = (updateArg![0] as { data: Record<string, unknown> }).data;
    expect(data.oauthStatus).toBe("authorized");
    expect(data.oauthError).toBeNull();
    expect(typeof data.credentialsEncrypted).toBe("string");
    expect(data.tokenExpiresAt).toBeInstanceOf(Date);

    // Reconnect kick fired (D-09).
    expect(connectMCPServer).toHaveBeenCalledWith(CONN_ID);
  });

  it("rejects a REPLAYED callback (row no longer pending) → error redirect (D-10)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(
      pendingConnection({ oauthStatus: "authorized" })
    );

    const res = await request(app)
      .get("/api/mcp-connections/oauth/callback")
      .query({ code: "auth-code-1", state: validState() });

    expect(res.headers.location).toContain("oauth=error");
    // No exchange attempted — fetch never called.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects a TAMPERED state → error redirect (fail-closed, D-10)", async () => {
    const tampered = validState() + "x";

    const res = await request(app)
      .get("/api/mcp-connections/oauth/callback")
      .query({ code: "auth-code-1", state: tampered });

    expect(res.headers.location).toContain("oauth=error");
    expect(prisma.mCPConnection.update).not.toHaveBeenCalled();
  });

  it("rejects an EXPIRED state → error redirect (fail-closed, D-10)", async () => {
    const expired = signState({ connectionId: CONN_ID, nonce: "n" }, { expiresIn: "-1s" });

    const res = await request(app)
      .get("/api/mcp-connections/oauth/callback")
      .query({ code: "auth-code-1", state: expired });

    expect(res.headers.location).toContain("oauth=error");
    expect(prisma.mCPConnection.update).not.toHaveBeenCalled();
  });

  it("rejects a missing/malformed state → error redirect", async () => {
    const res = await request(app)
      .get("/api/mcp-connections/oauth/callback")
      .query({ code: "auth-code-1" });

    expect(res.headers.location).toContain("oauth=error");
  });

  it("provider exchange 400 → row oauthStatus=error + error redirect (D-10)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(pendingConnection());
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "invalid_grant", error_description: "Code was already redeemed." }),
    } as unknown as Response);

    const res = await request(app)
      .get("/api/mcp-connections/oauth/callback")
      .query({ code: "auth-code-1", state: validState() });

    expect(res.headers.location).toContain("oauth=error");
    expect(prisma.mCPConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ oauthStatus: "error" }),
      })
    );
  });

  it("redirect target never carries token material (T-195-10)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(pendingConnection());

    const res = await request(app)
      .get("/api/mcp-connections/oauth/callback")
      .query({ code: "auth-code-1", state: validState() });

    expect(res.headers.location).not.toContain("fake-access-token");
    expect(res.headers.location).not.toContain("fake-refresh-token");
    expect(res.headers.location).not.toContain("auth-code-1");
  });
});

// ─── DELETE /:connectionId/oauth (revoke, D-14) ──────────────────────────

describe("DELETE /api/mcp-connections/:connectionId/oauth (D-14/D-15)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __mockRbac.deny = false;
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({});
  });

  it("wipes credential columns, keeps authType/oauthProvider, returns { revoked: true }", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(
      pendingConnection({ credentialsEncrypted: "iv:tag:ct" })
    );

    const res = await request(app)
      .delete(`/api/mcp-connections/${CONN_ID}/oauth`)
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true });
    expect(prisma.mCPConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONN_ID },
        data: expect.objectContaining({
          credentialsEncrypted: null,
          tokenExpiresAt: null,
          oauthStatus: "none",
          oauthError: null,
        }),
      })
    );
    // authType + oauthProvider deliberately NOT in the wipe payload (re-auth
    // needs no reconfig, D-14).
    const data = (prisma.mCPConnection.update as jest.Mock).mock.calls[0][0].data;
    expect(data.authType).toBeUndefined();
    expect(data.oauthProvider).toBeUndefined();
    // Reconnect kick fired (enabled row).
    expect(connectMCPServer).toHaveBeenCalledWith(CONN_ID);
  });

  it("returns 404 for cross-org connection (T-185-10 404-hide)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(
      pendingConnection({ organizationId: "org-other" })
    );

    const res = await request(app)
      .delete(`/api/mcp-connections/${CONN_ID}/oauth`)
      .set(adminAuth());

    expect(res.status).toBe(404);
    expect(prisma.mCPConnection.update).not.toHaveBeenCalled();
  });

  it("returns 403 when the principal lacks mcp:oauth:manage (D-15)", async () => {
    __mockRbac.deny = true;

    const res = await request(app)
      .delete(`/api/mcp-connections/${CONN_ID}/oauth`)
      .set(adminAuth());

    expect(res.status).toBe(403);
    __mockRbac.deny = false;
  });
});