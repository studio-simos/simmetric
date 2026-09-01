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
// ─── POST /api/chats/:chatId/pins (MCP pinning) ─────────────────────

describe("POST /api/chats/:chatId/pins (D-14 global + workspace scope)", () => {
  const CHAT_ID = "660e8400-e29b-41d4-a716-446655440100";
  const WS_ID = "770e8400-e29b-41d4-a716-446655440100";

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.chat.findUnique as jest.Mock).mockResolvedValue({ id: CHAT_ID, workspaceId: WS_ID });
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
