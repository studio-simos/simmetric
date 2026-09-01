// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WID-04 / 65-03 — push HTTP cache-bust on PUT /api/widgets/:id.
 *
 * Server-side unit tests for the fire-and-forget widgetCacheBustService hook
 * wired into the PUT handler. Mirrors the widgetCrud.test.ts mock pattern
 * (mocked prisma + env + license + auth) and adds a mock for axios so we can
 * assert the internal cache-bust POST is dispatched with the right URL and
 * X-Api-Key header, and that PUT never blocks on a rejected dispatch.
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
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
    WIDGET_SERVICE_URL: "http://localhost:3211",
    WIDGET_API_KEY: "test-key",
  })),
  clearEnvCache: jest.fn(),
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

// Mock axios so we can assert the cache-bust dispatch. Default impl resolves
// so the .then branch fires; tests that need rejection override the mock.
jest.mock("axios", () => ({
  post: jest.fn().mockImplementation(() => Promise.resolve({ status: 200 })),
  get: jest.fn().mockImplementation(() => Promise.resolve({ status: 200 })),
  put: jest.fn().mockImplementation(() => Promise.resolve({ status: 200 })),
}));

// Mock auth middleware: accept Bearer tokens, set admin user on request.
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
      roles: [{
        role: {
          name: "admin",
          permissions: [{ permissionName: "admin:settings" }],
        },
      }],
    };
    next();
  },
  apiKeyMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import request from "supertest";
import axios from "axios";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const mockWidget = {
  id: "widget-1",
  name: "Test Widget",
  welcomeMessage: "Hello!",
  fallbackMessage: "Sorry.",
  position: "bottom-right",
  isActive: true,
  primaryColor: "#4c6ef5",
  botName: "AI Assistant",
  logoUrl: null,
  avatarUrl: null,
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
  workspaces: [{ workspaceId: "workspace-001" }],
  _count: { sessions: 0 },
  creator: { id: "admin-001", name: "Admin User" },
};

describe("WID-04 PUT /api/widgets/:id cache-bust dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axios.post as jest.Mock).mockImplementation(() => Promise.resolve({ status: 200 }));
  });

  it("PUT /api/widgets/:id fires cache-bust to widget service with X-Api-Key", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockResolvedValue({
      ...mockWidget,
      primaryColor: "#00ff00",
    });

    const res = await request(app)
      .put("/api/widgets/widget-1")
      .set(adminAuth())
      .send({ primaryColor: "#00ff00" });

    expect(res.status).toBe(200);

    // Assert axios.post was called at least once with the cache-bust URL + key.
    const bustCall = (axios.post as jest.Mock).mock.calls.find(
      ([url]: [string]) => url === "http://localhost:3211/api/config/widget-1/cache-bust",
    );
    expect(bustCall).toBeDefined();
    const [, , opts] = bustCall as [string, unknown, { headers: Record<string, string> }];
    expect(opts.headers["X-Api-Key"]).toBe("test-key");
  });

  it("PUT still returns 200 when widget service is unreachable (non-blocking)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockResolvedValue(mockWidget);
    (axios.post as jest.Mock).mockImplementation(() =>
      Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:3211")),
    );

    const res = await request(app)
      .put("/api/widgets/widget-1")
      .set(adminAuth())
      .send({ botName: "Updated Bot" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("widget-1");
  });
});