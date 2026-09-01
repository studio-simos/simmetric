// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP Marketplace API integration tests
 *
 * Tests install (MCP-03) and uninstall (MCP-05) endpoints.
 * MCP-04 (enable/disable toggle) is covered by the existing
 * POST /api/mcp-connections/:connectionId/toggle endpoint -- see mcpRoutes.test.ts.
 */
import "./helpers/setupEnv";

jest.mock("uuid", () => ({
  v4: jest.fn(() => "550e8400-e29b-41d4-a716-446655440000"),
  validate: jest.fn(() => true),
}));

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

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn(() => Promise.resolve()),
}));

// Conditional auth middleware: supports admin and non-admin tokens
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const token = authHeader.slice(7);

    // Decode JWT payload (base64url) to determine userId
    let userId: string | null = null;
    try {
      const payload = token.split(".")[1];
      if (payload) {
        const decoded = Buffer.from(payload, "base64url").toString("utf-8");
        const parsed = JSON.parse(decoded);
        userId = parsed.userId || null;
      }
    } catch {
      userId = null;
    }
    if (userId === "admin-001") {
      req.userId = "admin-001";
      req.user = {
        id: "admin-001",
        roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }] } }],
      };
    } else {
      req.userId = "user-001";
      req.user = {
        id: "user-001",
        roles: [{ role: { name: "user", permissions: [{ permissionName: "chat:write" }] } }],
      };
    }
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
import { connectMCPServer, disconnectMCPServer } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";
import { logEvent } from "../services/eventLogService";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

function nonAdminAuth() {
  return { Authorization: `Bearer ${generateTestToken("user-001")}` };
}

const mockCatalogEntry = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  name: "Example MCP Server",
  url: "http://localhost:3001/mcp/sse",
  transportType: "sse",
  headers: '{"X-Api-Key":"my-secret-token"}',
  description: "An example MCP server for testing",
  category: "utilities",
  version: "1.0.0",
  author: "Test Author",
  verified: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const mockConnection = {
  id: "550e8400-e29b-41d4-a716-446655440002",
  name: "Example MCP Server",
  url: "http://localhost:3001/mcp/sse",
  transportType: "sse",
  projectId: null,
  workspaceId: "550e8400-e29b-41d4-a716-446655440003",
  headers: '{"X-Api-Key":"my-secret-token"}',
  enabled: true,
  lastSyncAt: null,
  catalogEntryId: "550e8400-e29b-41d4-a716-446655440001",
  source: "marketplace",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

// ====================================================================
// POST /api/mcp-marketplace/:entryId/install (MCP-03)
// ====================================================================

describe("POST /api/mcp-marketplace/:entryId/install", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without auth header", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/install")
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required");
  });

  it("returns 403 with non-admin token", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/install")
      .set(nonAdminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Admin access required");
  });

  it("returns 400 for invalid UUID in :entryId param", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/not-a-uuid/install")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 for missing workspaceId in body", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/install")
      .set(adminAuth())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 for invalid workspaceId UUID in body", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/install")
      .set(adminAuth())
      .send({ workspaceId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  it("returns 404 for non-existent catalog entry", async () => {
    (prisma.mcpCatalogEntry.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440099/install")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Catalog entry not found");
  });

  it("returns 201 with connection data on success", async () => {
    (prisma.mcpCatalogEntry.findUnique as jest.Mock).mockResolvedValue(mockCatalogEntry);
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null); // no duplicate
    (prisma.mCPConnection.create as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/install")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("550e8400-e29b-41d4-a716-446655440002");
    expect(res.body.source).toBe("marketplace");
    expect(res.body.catalogEntryId).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(res.body.headers).toEqual({ "X-Api-Key": "my-secret-token" });
    expect(connectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440002");
    expect(logEvent).toHaveBeenCalledWith(
      "mcp_connection",
      expect.any(String),
      "mcp.installed",
      "admin-001",
      expect.objectContaining({
        catalogEntryId: expect.any(String),
        workspaceId: expect.any(String),
        serverName: expect.any(String),
      })
    );
  });

  it("overrides connection name from request body", async () => {
    (prisma.mcpCatalogEntry.findUnique as jest.Mock).mockResolvedValue(mockCatalogEntry);
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.mCPConnection.create as jest.Mock).mockResolvedValue({
      ...mockConnection,
      name: "Custom Name",
    });

    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/install")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003", name: "Custom Name" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Custom Name");
  });

  it("returns 409 on duplicate install", async () => {
    (prisma.mcpCatalogEntry.findUnique as jest.Mock).mockResolvedValue(mockCatalogEntry);
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(mockConnection); // duplicate found

    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/install")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already installed");
  });
});

// ====================================================================
// POST /api/mcp-marketplace/:entryId/uninstall (MCP-05)
// ====================================================================

describe("POST /api/mcp-marketplace/:entryId/uninstall", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 without auth header", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/uninstall")
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required");
  });

  it("returns 403 with non-admin token", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/uninstall")
      .set(nonAdminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Admin access required");
  });

  it("returns 400 for invalid UUID in :entryId param", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/not-a-uuid/uninstall")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 for missing workspaceId in body", async () => {
    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/uninstall")
      .set(adminAuth())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  it("returns 404 when no marketplace connection exists", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/uninstall")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("No installed connection found");
  });

  it("returns 200 with success message on uninstall", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);

    const res = await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/uninstall")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("MCP server uninstalled");
    expect(logEvent).toHaveBeenCalledWith(
      "mcp_connection",
      expect.any(String),
      "mcp.uninstalled",
      "admin-001",
      expect.objectContaining({
        catalogEntryId: expect.any(String),
        workspaceId: expect.any(String),
        serverName: expect.any(String),
      })
    );
  });

  it("disconnects runtime and unregisters skills before deleting", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);

    await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/uninstall")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    expect(disconnectMCPServer).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440002");
    expect(unregisterSkillsForConnection).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440002");
    expect(prisma.mCPConnection.delete).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "550e8400-e29b-41d4-a716-446655440002" },
    }));
  });

  it("verifies connection record is deleted from DB after uninstall", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue(mockConnection);

    await request(app)
      .post("/api/mcp-marketplace/550e8400-e29b-41d4-a716-446655440001/uninstall")
      .set(adminAuth())
      .send({ workspaceId: "550e8400-e29b-41d4-a716-446655440003" });

    // The delete function should have been called (hard delete, not soft delete)
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
  });
});

// ====================================================================
// MCP-04: Enable/Disable Toggle (already covered by mcpRoutes.test.ts)
// ====================================================================
//
// MCP-04 requires that an admin can enable or disable an MCP server connection.
// This is already satisfied by the existing endpoint:
//
//   POST /api/mcp-connections/:connectionId/toggle  { enabled: boolean }
//
// Route file: packages/server/src/routes/mcp.ts (line 197, "Route 6: POST /:connectionId/toggle")
// Tests:     packages/server/src/__tests__/mcpRoutes.test.ts ("POST /api/mcp-connections/:connectionId/toggle")
//
// The toggle endpoint:
//   - Accepts { enabled: true }  connects the MCP server
//   - Accepts { enabled: false }  disconnects and unregisters skills
//   - Validates body with toggleMcpConnectionSchema (Zod)
//   - Returns 401/403 for unauthenticated/non-admin requests
//   - Returns 404 for nonexistent connections
//
// No new code is needed for MCP-04 -- the marketplace install/uninstall
// endpoints complement but do not replace the toggle functionality.
