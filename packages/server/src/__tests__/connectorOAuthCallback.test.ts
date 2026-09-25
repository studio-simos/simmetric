// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * Phase 200 (ECCO-06, Plan 03) — connector OAuth callback + start route tests.
 *
 * Covers (research Option A):
 *  - GET /api/connectors/oauth/callback (PUBLIC, no auth header): valid signed
 *    CONNECTOR-audience state + stubbed Slack token response → row write
 *    (botTokenEncrypted + MERGED configEncrypted preserving a pre-existing
 *    signingSecret) + redirect ?oauth=authorized.
 *  - NO tokenExpiresAt write (A2 — Slack tokens do not expire).
 *  - BLOCKER-2: the exchange receives redirect_uri = the connector callback
 *    constant (same value the start route's authorize URL carries).
 *  - Fail-closed arms: wrong-audience state (MCP-audience), missing row,
 *    replayed callback (verifier consumed), non-slack platform, no client
 *    configured, malformed query, exchange failure.
 *  - POST /api/connectors/:id/oauth/start (admin): 200 { authorizeUrl } with
 *    the CONNECTOR-audience state + connector redirect_uri; 404 cross-org;
 *    400 non-slack platform; 400 no client; 403 missing permission.
 *
 * Pattern: connectorsRoutes.test.ts heavy-mock (mock prisma via
 * createMockPrisma + chatConnector delegates, mocked rbac pass-through).
 * The oauthStateService is NOT mocked (the real audience seam is the unit
 * under test); fetch is stubbed globally for the exchange.
 */
import "./helpers/setupEnv";

jest.mock("uuid", () => ({
  v4: jest.fn(() => "550e8400-e29b-41d4-a716-446655440000"),
  validate: jest.fn(() => true),
}));

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  (mock.prisma as any).chatConnector = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  };
  return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    SERVER_URL: "http://localhost:3000",
    SLACK_CLIENT_ID: "test-slack-client-id",
    SLACK_CLIENT_SECRET: "test-slack-client-secret",
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
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn(() => Promise.resolve()) }));
jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
        roles: [{
          role: {
            name: "admin",
            permissions: [{ permissionName: "admin:settings" }, { permissionName: "connector:manage" }, { permissionName: "connector:view" }],
          },
        }],
      };
      next();
    },
    apiKeyMiddleware: (req: any, res: any, next: any) => {
      req.userId = "service-account-001";
      next();
    },
  };
});

jest.mock("../middleware/rbac", () => {
  const { __mockRbac } = require("../middleware/auth") as { __mockRbac: { deny: boolean } };
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
    requireProjectAccess: (_req: any, _res: any, next: any) => next(),
    requireWorkspaceRead: () => (_req: any, _res: any, next: any) => next(),
    requireWorkspaceWriteAccess: () => (_req: any, _res: any, next: any) => next(),
    requireWorkspaceAccess: (_req: any, _res: any, next: any) => next(),
    resolveWorkspaceRole: jest.fn(),
  };
});

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";
import { encrypt, decrypt } from "../services/encryptionService";
import { signOAuthState, CONNECTOR_OAUTH_STATE_AUDIENCE } from "../services/oauthStateService";

const { __mockRbac } = require("../middleware/auth") as { __mockRbac: { deny: boolean } };

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440021";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440010";

/** A slack connector row matching the fake auth middleware's org. */
function slackConnectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR_ID,
    organizationId: "org-default",
    platform: "slack",
    name: "Slack Connector",
    botTokenEncrypted: null,
    configEncrypted: null,
    workspaceId: WORKSPACE_ID,
    archiveId: null,
    isEnabled: true,
    pollMode: "polling",
    pollOffset: 0n,
    healthStatus: "unknown",
    lastWebhookAt: null,
    lastPollAt: null,
    lastError: null,
    createdBy: "admin-001",
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Valid CONNECTOR-audience state minted by the REAL signOAuthState — binds
 * the PKCE verifier to the state's nonce (WR-01) and carries the WR-03
 * connector audience the callback verify pins. */
function connectorState(connectionId: string = CONNECTOR_ID): string {
  const { state } = signOAuthState(connectionId, CONNECTOR_OAUTH_STATE_AUDIENCE);
  return state;
}

/** An MCP-audience state (the WRONG audience for this callback — WR-03). */
function mcpState(connectionId: string = CONNECTOR_ID): string {
  const { state } = signOAuthState(connectionId);
  return state;
}

const SLACK_TOKEN_RESPONSE = {
  ok: true,
  access_token: "xoxb-test-bot-token",
  token_type: "bot",
  scope: "chat:write,im:history",
  bot_user_id: "U0KRQLJ9H",
  app_id: "A0KRD7HC3",
  team: { name: "Test Team", id: "T9TK3CUKW" },
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  __mockRbac.deny = false;
  (prisma.chatConnector.update as jest.Mock).mockImplementation(async (args: any) => ({
    ...slackConnectorRow(),
    ...args.data,
  }));
  globalThis.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SLACK_TOKEN_RESPONSE),
    } as unknown as Response)
  );
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ─── GET /api/connectors/oauth/callback (PUBLIC — Pitfall 2 proof) ──────

describe("GET /api/connectors/oauth/callback (public, Option A)", () => {
  it("completes the exchange with NO auth header (public mount proof): row write + merged config + redirect oauth=authorized", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(
      slackConnectorRow({
        configEncrypted: encrypt(JSON.stringify({ signingSecret: "prior-signing-secret" })),
      }),
    );

    const res = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state: connectorState() });
    // Deliberately NO Authorization header — the browser redirect carries none.

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.location).toContain("oauth=authorized");

    const updateArg = (prisma.chatConnector.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: CONNECTOR_ID });
    expect(typeof updateArg.data.botTokenEncrypted).toBe("string");
    // The row write decrypts back to the exchanged Slack bot token:
    expect(decrypt(updateArg.data.botTokenEncrypted)).toBe("xoxb-test-bot-token");

    // A-11 coexistence: the config merge preserves the prior signingSecret
    // AND carries the OAuth metadata (slackScope/team/botUserId).
    const merged = JSON.parse(decrypt(updateArg.data.configEncrypted)) as Record<string, unknown>;
    expect(merged.signingSecret).toBe("prior-signing-secret");
    expect(merged.slackScope).toBe("chat:write,im:history");
    expect(merged.slackTeamId).toBe("T9TK3CUKW");
    expect(merged.slackTeamName).toBe("Test Team");
    expect(merged.botUserId).toBe("U0KRQLJ9H");
  });

  it("carries NO tokenExpiresAt field on the row write (A2 — Slack tokens do not expire)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackConnectorRow());

    const res = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state: connectorState() });

    expect(res.headers.location).toContain("oauth=authorized");
    const data = (prisma.chatConnector.update as jest.Mock).mock.calls[0][0].data;
    expect("tokenExpiresAt" in data).toBe(false);
    expect(Object.keys(data).sort()).toEqual(["botTokenEncrypted", "configEncrypted", "lastError"]);
  });

  it("sends redirect_uri = the connector callback constant to the exchange (BLOCKER-2 consistency pin)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackConnectorRow());

    const res = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state: connectorState() });

    expect(res.headers.location).toContain("oauth=authorized");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const body = String((globalThis.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body).toContain(`redirect_uri=${encodeURIComponent("http://localhost:3000/api/connectors/oauth/callback")}`);
    // The MCP callback value never appears (the connector constant is THE
    // exchange redirect):
    expect(body).not.toContain("mcp-connections");
    expect(body).toContain("code=slack-code-1");
    expect(body).toContain("client_id=test-slack-client-id");
    expect(body).toContain("client_secret=test-slack-client-secret");
  });

  it("REJECTS an MCP-audience state → fail-closed error redirect (WR-03 cross-audience pin)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackConnectorRow());

    const res = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state: mcpState() });

    expect(res.headers.location).toContain("oauth=error");
    // No exchange attempted — fetch never called, row never written.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
  });

  it("fail-closed on a MISSING row (replay or unknown state)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state: connectorState() });

    expect(res.headers.location).toContain("oauth=error");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fail-closed on a SOFT-DELETED row", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(
      slackConnectorRow({ deletedAt: new Date("2026-01-02T00:00:00.000Z") }),
    );

    const res = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state: connectorState() });

    expect(res.headers.location).toContain("oauth=error");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("REJECTS a REPLAYED callback (verifier already consumed) → error redirect (single-use pin)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackConnectorRow());
    const state = connectorState();

    const first = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state });
    expect(first.headers.location).toContain("oauth=authorized");

    const replay = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state });
    expect(replay.headers.location).toContain("oauth=error");
    // The exchange ran exactly once:
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("fail-closed on a NON-SLACK platform row", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(
      slackConnectorRow({ platform: "telegram" }),
    );

    const res = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state: connectorState() });

    expect(res.headers.location).toContain("oauth=error");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fail-closed on malformed/missing query params", async () => {
    const res = await request(app).get("/api/connectors/oauth/callback");
    expect(res.headers.location).toContain("oauth=error");
    expect(prisma.chatConnector.findUnique).not.toHaveBeenCalled();
  });

  it("fail-closed on the exchange error arm (provider 400) — no row write", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackConnectorRow());
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ ok: false, error: "invalid_code", error_description: "bad code" }),
      } as unknown as Response)
    );

    const res = await request(app)
      .get("/api/connectors/oauth/callback")
      .query({ code: "slack-code-1", state: connectorState() });

    expect(res.headers.location).toContain("oauth=error");
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
    // The failure metadata carries the error text only — never a token field:
    const warnCalls = (jest.requireMock("../utils/logger") as any).logger.warn.mock.calls;
    const exchangeWarn = warnCalls.find((c: unknown[]) => String(c[0]).includes("token exchange failed"));
    expect(exchangeWarn).toBeDefined();
    expect(JSON.stringify(exchangeWarn![1])).not.toContain("access_token");
  });
});

// ─── POST /api/connectors/:id/oauth/start (admin, mcp.ts Route-8 shape) ──

describe("POST /api/connectors/:id/oauth/start (ECCO-06 D-05)", () => {
  it("returns 200 { authorizeUrl } with the CONNECTOR-audience state + connector redirect_uri (BLOCKER-2 + WR-03 integration)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(slackConnectorRow());

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(200);
    // oauthStartResponseSchema shape: exactly { authorizeUrl } (T-195-09).
    expect(Object.keys(res.body).sort()).toEqual(["authorizeUrl"]);
    expect(res.body.authorizeUrl).toContain("slack.com/oauth/v2/authorize");
    expect(res.body.authorizeUrl).toContain("state=");
    // BLOCKER-2: the authorize URL carries the CONNECTOR callback redirect:
    expect(res.body.authorizeUrl).toContain(
      `redirect_uri=${encodeURIComponent("http://localhost:3000/api/connectors/oauth/callback")}`
    );
    // W5: comma-joined Slack scopes on the authorize URL:
    expect(res.body.authorizeUrl).toContain(`scope=${encodeURIComponent("chat:write,im:history")}`);
    // usesPkce false → NO challenge params:
    expect(res.body.authorizeUrl).not.toContain("code_challenge");

    // WR-03 integration: the minted state carries the CONNECTOR audience and
    // the MCP-audience verifier rejects it.
    const stateParam = new URL(res.body.authorizeUrl).searchParams.get("state")!;
    const payload = jest.requireActual("jsonwebtoken").decode(stateParam) as Record<string, unknown>;
    expect(payload.aud).toBe("connector-oauth-state");

    // NO pending-status write (ChatConnector has no oauthStatus column —
    // documented contract).
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
  });

  it("returns 404 for cross-org connector (T-185-10 404-hide)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(
      slackConnectorRow({ organizationId: "org-other" }),
    );

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-slack platform", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(
      slackConnectorRow({ platform: "telegram" }),
    );

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Connector platform does not support OAuth" });
  });

  it("returns 400 when the Slack client is not configured (D-06 posture)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(slackConnectorRow());
    const { getEnv } = jest.requireMock("../config/env") as { getEnv: jest.Mock };
    const prev = getEnv.getMockImplementation();
    getEnv.mockImplementation(() => ({
      JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
      NODE_ENV: "test",
      SERVER_PORT: 3000,
      SESSION_EXPIRY: 86400000,
      ALLOW_REGISTRATION: true,
      SERVER_URL: "http://localhost:3000",
      SLACK_CLIENT_ID: undefined,
      SLACK_CLIENT_SECRET: undefined,
    }));

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "OAuth provider client not configured" });
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
    getEnv.mockImplementation(prev);
  });

  it("returns 403 when the principal lacks connector:manage (D-15)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(slackConnectorRow());
    __mockRbac.deny = true;

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Insufficient permissions" });
    __mockRbac.deny = false;
  });

  it("never leaks the verifier or credentials in the response (T-195-14 shape)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(slackConnectorRow());

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/oauth/start`)
      .set(adminAuth());

    expect(res.body.authorizeUrl).not.toContain("client_secret");
    expect(res.body.authorizeUrl).not.toContain("code_verifier");
  });
});

// ─── Source-level pins (read the route source; A2 + BLOCKER-2 hygiene) ──

describe("connectorOAuthCallback.ts source hygiene", () => {
  const { readFileSync } = require("fs") as { readFileSync: (p: string, e: string) => string };
  const path = require("path") as { resolve: (...p: string[]) => string };
  const src = readFileSync(
    path.resolve(__dirname, "../routes/connectorOAuthCallback.ts"),
    "utf-8",
  );

  it("carries NO tokenExpiresAt write (A2 — the mcpOAuthCallback 1h default must not leak)", () => {
    // Prose mentions in the A2 doc comments are fine; a WRITE would carry the
    // data-field key (`tokenExpiresAt:`) on the prisma update data object:
    expect(src).not.toMatch(/data:\s*{[^}]*tokenExpiresAt/s);
    expect(src).not.toMatch(/^\s*tokenExpiresAt/m);
  });

  it("resolves the exchange redirect through resolveConnectorRedirectUri (BLOCKER-2)", () => {
    expect(src).toContain("resolveConnectorRedirectUri()");
    expect(src).not.toContain("resolveRedirectUri()");
  });

  it("verifies the state with the CONNECTOR audience (WR-03)", () => {
    expect(src).toContain("CONNECTOR_OAUTH_STATE_AUDIENCE");
  });

  it("carries NO token material into the exchange-failure log call (T-195-05 posture)", () => {
    // The exchange-failure warn call logs { platform, errorDescription } only:
    expect(src).toContain('logger.warn("[connector-oauth-callback] token exchange failed", {\n        platform,\n        error: result.errorDescription,\n      })');
    // No token-field identifier is ever referenced in a logger call:
    expect(src).not.toMatch(/logger\.(warn|error|info)\([^)]*accessToken/s);
  });
});