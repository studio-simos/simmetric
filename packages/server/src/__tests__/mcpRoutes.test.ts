// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP Connection API integration tests
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
    // Identity passthrough — mcpPins.ts wraps workspace lookups with
    // withSoftDelete({ ... }); the mock has no soft-delete behavior.
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
  connectMCPServer: jest.fn(() => Promise.resolve()),
  disconnectMCPServer: jest.fn(() => Promise.resolve()),
  getConnectionStatuses: jest.fn(),
  testMCPServerConnection: jest.fn(() => Promise.resolve()),
  clearConnectionError: jest.fn(),
  // Phase 195 (MCPO-01 D-15a): the test-connection probe resolves headers
  // through resolveConnectionHeaders — the heavy-mock object gains the fn
  // (extended in place; prior jest.fn members intact). Default mirrors the
  // none/static path: parse the row's stored headers JSON.
  resolveConnectionHeaders: jest.fn((connection: { headers?: string | null }) => {
    try {
      return { ok: true, headers: connection.headers ? (JSON.parse(connection.headers) as Record<string, string>) : {} };
    } catch {
      return { ok: false, error: "Invalid headers JSON" };
    }
  }),
}));

jest.mock("../agent/skills", () => ({
  registerSkill: jest.fn(),
  unregisterSkillsForConnection: jest.fn(),
}));

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    req.user = {
      id: "admin-001",
      roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }] } }],
    };
    next();
  },
  apiKeyMiddleware: (req: any, res: any, next: any) => {
    req.userId = "service-account-001";
    next();
  },
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";
import { connectMCPServer, disconnectMCPServer, getConnectionStatuses, testMCPServerConnection } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";

jest.mock("../services/oauthTokenLifecycle", () => ({
  decryptTokenBlob: jest.fn(),
  revokeProviderToken: jest.fn(),
  encryptTokenBlob: jest.fn(),
  refreshAccessToken: jest.fn(),
  exchangeAuthorizationCode: jest.fn(),
}));

jest.mock("../services/oauthProviderRegistry", () => ({
  resolveProvider: jest.fn(),
  hasClientConfigured: jest.fn(),
  buildAuthorizeUrl: jest.fn(),
  resolveScopes: jest.fn(),
  resolveRedirectUri: jest.fn(),
}));

import { decryptTokenBlob, revokeProviderToken } from "../services/oauthTokenLifecycle";
import { resolveProvider } from "../services/oauthProviderRegistry";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const mockConnection = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  name: "Test MCP Server",
  url: "http://localhost:3001/mcp",
  transportType: "sse",
  projectId: "550e8400-e29b-41d4-a716-446655440002",
  workspaceId: null,
  headers: '{"X-Api-Key":"test-key"}',
  enabled: true,
  lastSyncAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  // Phase 185 (T-185-10): matches the membership mock's org — the route's
  // org assertion hides cross-org connections as 404.
  organizationId: "org-default",
  // Phase 195 (D-01): the oauth columns exist on the row now. The route must
  // strip credentialsEncrypted + oauthError from every response (Pitfall 1 /
  // T-195-09) — the mock row carries them to prove the strip.
  authType: "oauth",
  oauthProvider: "google",
  oauthScopes: null,
  credentialsEncrypted: "iv:tag:ciphertext-SECRET",
  tokenExpiresAt: new Date("2026-01-01T01:00:00.000Z"),
  oauthStatus: "authorized",
  oauthError: "stale provider error",
  oauthClientId: null,
};

// ─── GET /api/mcp-connections ────────────────────────────────────────

describe("GET /api/mcp-connections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with empty array when no connections exist", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/mcp-connections")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 200 with connections list with deserialized headers", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([mockConnection]);

    const res = await request(app)
      .get("/api/mcp-connections")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].headers).toEqual({ "X-Api-Key": "test-key" });
  });

  it("returns 401 without auth header", async () => {
    const res = await request(app)
      .get("/api/mcp-connections");

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/mcp-connections/statuses ────────────────────────────────

describe("GET /api/mcp-connections/statuses", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with enriched status list", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([mockConnection]);
    const statusMap = new Map();
    statusMap.set("550e8400-e29b-41d4-a716-446655440001", { liveStatus: "connected", toolCount: 5, lastError: null });
    (getConnectionStatuses as jest.Mock).mockReturnValue(statusMap);

    const res = await request(app)
      .get("/api/mcp-connections/statuses")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].liveStatus).toBe("connected");
    expect(res.body[0].toolCount).toBe(5);
    expect(res.body[0].id).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(res.body[0].name).toBe("Test MCP Server");
  });

  it("returns disconnected for connections not in runtime", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([mockConnection]);
    (getConnectionStatuses as jest.Mock).mockReturnValue(new Map());

    const res = await request(app)
      .get("/api/mcp-connections/statuses")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body[0].liveStatus).toBe("disconnected");
    expect(res.body[0].toolCount).toBe(0);
  });

  it("returns error status for failed connection", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([mockConnection]);
    const statusMap = new Map();
    statusMap.set("550e8400-e29b-41d4-a716-446655440001", { liveStatus: "error", toolCount: 0, lastError: "Connection refused" });
    (getConnectionStatuses as jest.Mock).mockReturnValue(statusMap);

    const res = await request(app)
      .get("/api/mcp-connections/statuses")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body[0].liveStatus).toBe("error");
    expect(res.body[0].lastError).toBe("Connection refused");
  });
});

// ─── POST /api/mcp-connections ────────────────────────────────────────

describe("POST /api/mcp-connections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 201 with valid data and projectId", async () => {
    (prisma.mCPConnection.create as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({ name: "Test MCP Server", url: "http://localhost:3001/mcp", projectId: "550e8400-e29b-41d4-a716-446655440001" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(res.body.headers).toEqual({ "X-Api-Key": "test-key" });
    expect(connectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
  });

  it("returns 400 with missing required fields", async () => {
    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 with invalid URL", async () => {
    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({ name: "Test", url: "not-a-url" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });
});

// ─── PUT /api/mcp-connections/:connectionId ────────────────────────────

describe("PUT /api/mcp-connections/:connectionId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with valid update and reconnects enabled connection", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({
      ...mockConnection,
      name: "Updated Name",
    });

    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth())
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
    expect(disconnectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
    expect(unregisterSkillsForConnection).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
    expect(connectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
  });

  it("returns 404 for nonexistent connection", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440099")
      .set(adminAuth())
      .send({ name: "Updated" });

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid connectionId format", async () => {
    const res = await request(app)
      .put("/api/mcp-connections/not-a-uuid")
      .set(adminAuth())
      .send({ name: "Updated" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid connection ID");
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 with empty body", async () => {
    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });

  it("skips disconnect/reconnect cycle when connection is disabled", async () => {
    const disabledConnection = { ...mockConnection, enabled: false };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(disabledConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({
      ...disabledConnection,
      name: "Updated Name",
    });

    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth())
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(disconnectMCPServer).not.toHaveBeenCalled();
    expect(unregisterSkillsForConnection).not.toHaveBeenCalled();
  });

  it("returns warning when reconnect fails", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);
    (connectMCPServer as jest.Mock).mockRejectedValue(new Error("Connection refused"));

    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth())
      .send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body._warning).toContain("Reconnect failed");
  });
});

// ─── DELETE /api/mcp-connections/:connectionId ─────────────────────────

describe("DELETE /api/mcp-connections/:connectionId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 and disconnects + unregisters skills before deleting", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .delete("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("MCP connection deleted");
    expect(disconnectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
    expect(unregisterSkillsForConnection).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
    expect(prisma.mCPConnection.delete).toHaveBeenCalledWith({ where: { id: "550e8400-e29b-41d4-a716-446655440001" } as any });
  });

  it("returns 404 for nonexistent connection", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440099")
      .set(adminAuth());

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid connectionId format", async () => {
    const res = await request(app)
      .delete("/api/mcp-connections/not-a-uuid")
      .set(adminAuth());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid connection ID");
  });
});

// ─── DELETE /:connectionId — oauth revoke+wipe hook (Phase 197, MCPO-03 D-08) ──

describe("DELETE /api/mcp-connections/:connectionId — revoke+wipe hook (Phase 197 D-08)", () => {
  const googleDef = { id: "google", revokeUrl: "https://oauth2.googleapis.com/revoke" };

  beforeEach(() => {
    jest.clearAllMocks();
    (resolveProvider as jest.Mock).mockReturnValue(googleDef);
    (revokeProviderToken as jest.Mock).mockResolvedValue({ ok: true });
  });

  it("generic DELETE on an oauth row calls revoke (with the decrypted token) then delete — order pinned", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "at-token", scope: "s", obtainedAt: new Date().toISOString() },
    });

    const res = await request(app)
      .delete("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(resolveProvider).toHaveBeenCalledWith("google");
    expect(revokeProviderToken).toHaveBeenCalledTimes(1);
    expect(revokeProviderToken).toHaveBeenCalledWith(googleDef, "at-token");
    // Revoke BEFORE delete — the blob dies with the row.
    expect((revokeProviderToken as jest.Mock).mock.invocationCallOrder[0]!).toBeLessThan(
      (prisma.mCPConnection.delete as jest.Mock).mock.invocationCallOrder[0]!,
    );
  });

  it("non-oauth row: revoke NOT called, delete proceeds unchanged", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      ...mockConnection,
      authType: "none",
      oauthProvider: null,
      credentialsEncrypted: null,
    });
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .delete("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(decryptTokenBlob).not.toHaveBeenCalled();
    expect(revokeProviderToken).not.toHaveBeenCalled();
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
  });

  it("decrypt-failure row: revoke NOT called AND delete STILL called (fail-open-to-wipe pin)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);
    (decryptTokenBlob as jest.Mock).mockReturnValue({ ok: false, errorDescription: "undecryptable" });

    const res = await request(app)
      .delete("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(revokeProviderToken).not.toHaveBeenCalled();
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
  });

  it("unknown oauthProvider: revoke NOT called, delete STILL called (registry consumes fail-closed)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      ...mockConnection,
      oauthProvider: "dropbox",
    });
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);
    (resolveProvider as jest.Mock).mockReturnValue(null);
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "at", scope: "s", obtainedAt: new Date().toISOString() },
    });

    const res = await request(app)
      .delete("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(revokeProviderToken).not.toHaveBeenCalled();
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
  });

  it("microsoft row: revoke called with skipped:true arm — delete proceeds (D-14 local wipe primary)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      ...mockConnection,
      oauthProvider: "microsoft",
    });
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);
    (resolveProvider as jest.Mock).mockReturnValue({ id: "microsoft", revokeUrl: null });
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "ms-token", scope: "s", obtainedAt: new Date().toISOString() },
    });
    (revokeProviderToken as jest.Mock).mockResolvedValue({ ok: true, skipped: true });

    const res = await request(app)
      .delete("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(revokeProviderToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: "microsoft" }),
      "ms-token",
    );
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /api/mcp-connections/:connectionId/toggle ────────────────────

describe("POST /api/mcp-connections/:connectionId/toggle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("enables connection with { enabled: true }", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({ ...mockConnection, enabled: false });
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({ ...mockConnection, enabled: true });

    const res = await request(app)
      .post("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001/toggle")
      .set(adminAuth())
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(prisma.mCPConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: true }),
      })
    );
    expect(connectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
  });

  it("disables connection with { enabled: false } and unregisters skills", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({ ...mockConnection, enabled: false });

    const res = await request(app)
      .post("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001/toggle")
      .set(adminAuth())
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(disconnectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
    expect(unregisterSkillsForConnection).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
  });

  it("returns 400 with invalid body", async () => {
    const res = await request(app)
      .post("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001/toggle")
      .set(adminAuth())
      .send({ enabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });

  it("returns 404 for nonexistent connection", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440099/toggle")
      .set(adminAuth())
      .send({ enabled: true });

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid connectionId format", async () => {
    const res = await request(app)
      .post("/api/mcp-connections/not-a-uuid/toggle")
      .set(adminAuth())
      .send({ enabled: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid connection ID");
  });
});

// ─── POST /api/mcp-connections/:connectionId/test ──────────────────────

describe("POST /api/mcp-connections/:connectionId/test", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns success result with tool list", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (testMCPServerConnection as jest.Mock).mockResolvedValue({
      success: true,
      toolCount: 3,
      tools: [{ name: "tool1", description: "A tool" }],
    });

    const res = await request(app)
      .post("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001/test")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.toolCount).toBe(3);
    expect(disconnectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
    expect(connectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
  });

  it("returns failure result with error message", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (testMCPServerConnection as jest.Mock).mockResolvedValue({
      success: false,
      error: "Connection refused",
    });

    const res = await request(app)
      .post("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001/test")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Connection refused");
  });

  it("returns 404 for nonexistent connection", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440099/test")
      .set(adminAuth());

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid connectionId format", async () => {
    const res = await request(app)
      .post("/api/mcp-connections/not-a-uuid/test")
      .set(adminAuth());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid connection ID");
  });
});

// ─── Phase 63 Plan 02: Write-side headers validation (D-12) ────────────

describe("POST /api/mcp-connections headers validation (D-12 write-side)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects bad headers — hop-by-hop Connection header → 400", async () => {
    (prisma.mCPConnection.create as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({
        name: "Test MCP Server",
        url: "http://localhost:3001/mcp",
        workspaceId: "550e8400-e29b-41d4-a716-446655440002",
        headers: { Connection: "keep-alive" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid MCP headers");
    expect(res.body.details).toBeDefined();
    expect(prisma.mCPConnection.create).not.toHaveBeenCalled();
  });

  it("rejects oversize headers — 21 headers → 400", async () => {
    (prisma.mCPConnection.create as jest.Mock).mockResolvedValue(mockConnection);
    const oversize: Record<string, string> = {};
    for (let i = 0; i < 21; i++) oversize[`X-Header-${i}`] = "v";

    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({
        name: "Test MCP Server",
        url: "http://localhost:3001/mcp",
        workspaceId: "550e8400-e29b-41d4-a716-446655440002",
        headers: oversize,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid MCP headers");
  });

  it("accepts valid headers — Authorization bearer → 201", async () => {
    (prisma.mCPConnection.create as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({
        name: "Test MCP Server",
        url: "http://localhost:3001/mcp",
        workspaceId: "550e8400-e29b-41d4-a716-446655440002",
        headers: { Authorization: "Bearer x" },
      });

    expect(res.status).toBe(201);
    expect(prisma.mCPConnection.create).toHaveBeenCalled();
  });
});

describe("PUT /api/mcp-connections/:connectionId headers validation (D-12 write-side)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("PUT rejects bad headers — hop-by-hop Transfer-Encoding → 400", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth())
      .send({ headers: { "Transfer-Encoding": "chunked" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid MCP headers");
    expect(prisma.mCPConnection.update).not.toHaveBeenCalled();
  });
});
// ─── Phase 195 (MCPO-01, Pitfall 1 / T-195-09): response no-leak pins ───

describe("response shape — credentialsEncrypted/oauthError never leak (Pitfall 1, T-195-09)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("GET / list response: credentialsEncrypted + oauthError ABSENT; non-secret oauth columns MAY be present", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([mockConnection]);

    const res = await request(app)
      .get("/api/mcp-connections")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].credentialsEncrypted).toBeUndefined();
    expect(res.body[0].oauthError).toBeUndefined();
    expect("credentialsEncrypted" in res.body[0]).toBe(false);
    expect("oauthError" in res.body[0]).toBe(false);
    // Non-secret columns survive for the Phase 196 UI.
    expect(res.body[0].oauthStatus).toBe("authorized");
    expect(res.body[0].authType).toBe("oauth");
    expect(res.body[0].oauthProvider).toBe("google");
  });

  it("POST / create response: credentialsEncrypted + oauthError ABSENT", async () => {
    (prisma.mCPConnection.create as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({ name: "Test MCP Server", url: "http://localhost:3001/mcp", projectId: "550e8400-e29b-41d4-a716-446655440001" });

    expect(res.status).toBe(201);
    expect("credentialsEncrypted" in res.body).toBe(false);
    expect("oauthError" in res.body).toBe(false);
    expect(res.body.oauthStatus).toBe("authorized");
  });

  it("PUT /:connectionId update response: credentialsEncrypted + oauthError ABSENT", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({
      ...mockConnection,
      name: "Updated Name",
    });

    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth())
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect("credentialsEncrypted" in res.body).toBe(false);
    expect("oauthError" in res.body).toBe(false);
  });

  it("PUT reconnect-warning arm: credentialsEncrypted + oauthError ABSENT even with _warning", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);
    (connectMCPServer as jest.Mock).mockRejectedValue(new Error("Connection refused"));

    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth())
      .send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body._warning).toContain("Reconnect failed");
    expect("credentialsEncrypted" in res.body).toBe(false);
    expect("oauthError" in res.body).toBe(false);
  });
});

// ─── Phase 196 (MCPO-02 D-03a): oauthErrorSummary sanitized field pins ──

describe("response shape — oauthErrorSummary sanitized field (D-03a)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("list response: oauthErrorSummary = first ≤200 chars of provider prose oauthError; oauthError + credentialsEncrypted ABSENT", async () => {
    const longProse = "Rate limit exceeded: quota project misconfigured. ".repeat(10) + "TRAILING-DETAIL";
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([
      { ...mockConnection, oauthError: longProse },
    ]);

    const res = await request(app)
      .get("/api/mcp-connections")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect("oauthError" in res.body[0]).toBe(false);
    expect("credentialsEncrypted" in res.body[0]).toBe(false);
    expect(res.body[0].oauthErrorSummary).toBe(longProse.slice(0, 200));
    expect((res.body[0].oauthErrorSummary as string).length).toBeLessThanOrEqual(200);
  });

  it("create response: oauthErrorSummary present-and-bounded, secrets stripped", async () => {
    (prisma.mCPConnection.create as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .post("/api/mcp-connections")
      .set(adminAuth())
      .send({ name: "Test MCP Server", url: "http://localhost:3001/mcp", projectId: "550e8400-e29b-41d4-a716-446655440001" });

    expect(res.status).toBe(201);
    expect(res.body.oauthErrorSummary).toBe("stale provider error");
    expect("oauthError" in res.body).toBe(false);
    expect("credentialsEncrypted" in res.body).toBe(false);
  });

  it("clean row (oauthError null) → oauthErrorSummary: null", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([
      { ...mockConnection, oauthError: null },
    ]);

    const res = await request(app)
      .get("/api/mcp-connections")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body[0].oauthErrorSummary).toBeNull();
    expect("oauthError" in res.body[0]).toBe(false);
  });

  it("PUT update response: oauthErrorSummary derived, secrets stripped", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .put("/api/mcp-connections/550e8400-e29b-41d4-a716-446655440001")
      .set(adminAuth())
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.oauthErrorSummary).toBe("stale provider error");
    expect("oauthError" in res.body).toBe(false);
    expect("credentialsEncrypted" in res.body).toBe(false);
  });

  it("GET /statuses payload: every row carries the six sanitized non-secret oauth fields (badge-matrix field set)", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([mockConnection]);
    (getConnectionStatuses as jest.Mock).mockReturnValue(new Map());

    const res = await request(app)
      .get("/api/mcp-connections/statuses")
      .set(adminAuth());

    expect(res.status).toBe(200);
    const row = res.body[0];
    // Exactly the six added non-secret oauth fields:
    expect(row.authType).toBe("oauth");
    expect(row.oauthProvider).toBe("google");
    expect(row.oauthStatus).toBe("authorized");
    expect(row.tokenExpiresAt).toBe("2026-01-01T01:00:00.000Z");
    expect(row.oauthScopes).toBeNull();
    expect(row.oauthErrorSummary).toBe("stale provider error");
    // Secrets never ride the statuses payload either:
    expect("credentialsEncrypted" in row).toBe(false);
    expect("oauthError" in row).toBe(false);
  });

  it("GET /statuses: clean row → oauthErrorSummary null", async () => {
    (prisma.mCPConnection.findMany as jest.Mock).mockResolvedValue([
      { ...mockConnection, oauthError: null },
    ]);
    (getConnectionStatuses as jest.Mock).mockReturnValue(new Map());

    const res = await request(app)
      .get("/api/mcp-connections/statuses")
      .set(adminAuth());

    expect(res.body[0].oauthErrorSummary).toBeNull();
  });
});

// ─── POST /api/chats/:chatId/pins (MCP pinning) ─────────────────────

describe("POST /api/chats/:chatId/pins (D-14 global + workspace scope)", () => {
  const CHAT_ID = "660e8400-e29b-41d4-a716-446655440100";
  const WS_ID = "770e8400-e29b-41d4-a716-446655440100";

  beforeEach(() => {
    jest.clearAllMocks();
    // Phase 185 (T-185-10): the route's chat org assertion reads
    // organizationId off the select — match the membership mock's org.
    (prisma.chat.findUnique as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WS_ID, organizationId: "org-default" });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: WS_ID,
      projectId: "550e8400-e29b-41d4-a716-446655440002",
      project: { createdBy: "admin-001" },
    });
  });

  it("accepts a workspace-scoped connection", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "WS Conn",
      workspaceId: WS_ID,
      projectId: null,
    });
    (prisma.chatMCPPin.create as jest.Mock).mockResolvedValue({ id: "pin-1", chatId: CHAT_ID, connectionId: "550e8400-e29b-41d4-a716-446655440001" });

    const res = await request(app)
      .post(`/api/chats/${CHAT_ID}/pins`)
      .set(adminAuth())
      .send({ connectionId: "550e8400-e29b-41d4-a716-446655440001" });

    expect(res.status).toBe(201);
    expect(prisma.chatMCPPin.create).toHaveBeenCalled();
  });

  it("accepts a GLOBAL connection (workspaceId null, projectId null) — D-14", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Global Conn",
      workspaceId: null,
      projectId: null,
    });
    (prisma.chatMCPPin.create as jest.Mock).mockResolvedValue({ id: "pin-1", chatId: CHAT_ID, connectionId: "550e8400-e29b-41d4-a716-446655440001" });

    const res = await request(app)
      .post(`/api/chats/${CHAT_ID}/pins`)
      .set(adminAuth())
      .send({ connectionId: "550e8400-e29b-41d4-a716-446655440001" });

    expect(res.status).toBe(201);
    expect(prisma.chatMCPPin.create).toHaveBeenCalled();
  });

  it("rejects a project-scoped connection (workspaceId null, projectId set) — 404", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chats/${CHAT_ID}/pins`)
      .set(adminAuth())
      .send({ connectionId: "550e8400-e29b-41d4-a716-446655440001" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("MCP connection not found in this workspace");
    expect(prisma.chatMCPPin.create).not.toHaveBeenCalled();
  });

  it("rejects a connection from another workspace — 404", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chats/${CHAT_ID}/pins`)
      .set(adminAuth())
      .send({ connectionId: "550e8400-e29b-41d4-a716-446655440001" });

    expect(res.status).toBe(404);
    expect(prisma.chatMCPPin.create).not.toHaveBeenCalled();
  });
});
