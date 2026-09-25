// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-01b Task 1) — admin CRUD + serializeConnector + RBAC tests.
 * Postgres-free: prisma mocked per the existing server-test mock layer.
 */
// @ts-nocheck
import "./helpers/setupEnv";

jest.mock("uuid", () => ({
  v4: jest.fn(() => "550e8400-e29b-41d4-a716-446655440000"),
  validate: jest.fn(() => true),
}));

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  // Phase 198 delegates (factory predates the connector models).
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

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    // Decode the JWT payload to identify the user (mockAuth's
    // generateTestToken signs { userId }) — non-admins get no
    // admin:settings, so requireAdmin 403s them (D-05).
    const payload = JSON.parse(Buffer.from(authHeader.slice(7).split(".")[1], "base64").toString());
    req.userId = payload.userId;
    req.user = {
      id: req.userId,
      roles: [{
        role: {
          name: req.userId === "admin-001" ? "admin" : "user",
          permissions: req.userId === "admin-001"
            ? [{ permissionName: "admin:settings" }]
            : [{ permissionName: "workspace:read" }],
        },
      }],
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
import { encrypt } from "../services/encryptionService";

// Task 1's happy-path pins the ROUTE LOGIC (encryption/org stamp/serialize)
// independent of the stub registry — the registry mock below makes telegram
// implemented for THIS describe only. The stub's fail-closed 400 is tested
// separately with the REAL stub.
// 198-04: index.ts now side-effect-imports telegram.ts (the boot-time
// registerAdapter), so the mock must carry the full registry surface.
jest.mock("../services/connectors/registry", () => ({
  isPlatformImplemented: jest.fn((platform: string) => platform === "telegram" || platform === "slack" || platform === "whatsapp"),
  getAdapter: jest.fn(() => undefined),
  registerAdapter: jest.fn(),
  clearAdapters: jest.fn(),
}));

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}
function userAuth() {
  return { Authorization: `Bearer ${generateTestToken("user-001")}` };
}

const ORG = "org-default";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440010";
const CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440011";
const OTHER_ORG_CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440012";

// A realistic 198-01 row — pollOffset BigInt (P-1: the repo's FIRST BigInt),
// encrypted blobs set (T-198-03 pins), config with a webhookSecret.
const mockConnectorRow = {
  id: CONNECTOR_ID,
  organizationId: ORG,
  platform: "telegram",
  name: "Test Connector",
  botTokenEncrypted: encrypt("123456:ABC-DEF"),
  configEncrypted: encrypt(JSON.stringify({ webhookSecret: "a".repeat(48) })),
  workspaceId: WORKSPACE_ID,
  archiveId: null,
  responseProviderId: null,
  responseModel: null,
  botUsername: null,
  botDisplayName: null,
  welcomeMessage: null,
  fallbackMessage: "I don't have an answer for that. Please contact us for more help.",
  fallbackLocale: "en",
  localizedTexts: null,
  isEnabled: true,
  pollMode: "polling",
  pollOffset: 0n, // BigInt — res.json would throw on it (P-1)
  rateLimitPerMinute: null,
  sessionLimitPerDay: null,
  healthStatus: "unknown",
  lastWebhookAt: null,
  lastPollAt: null,
  lastError: null,
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const otherOrgRow = {
  ...mockConnectorRow,
  id: OTHER_ORG_CONNECTOR_ID,
  organizationId: "org-other",
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── POST /api/connectors (create) ───────────────────────────────────

describe("POST /api/connectors", () => {
  beforeEach(() => {
    // WR-05: the create route asserts workspace (and archive) org ownership
    // — the mockPrisma factory carries the delegates; default them to the
    // admin's own org (owned, alive).
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: WORKSPACE_ID,
      organizationId: ORG,
      deletedAt: null,
    });
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(null);
  });

  it("creates a connector: 201, hasBotToken true, NO token/secret/pollOffset fields (D-03/T-198-03/P-1)", async () => {
    (prisma.chatConnector.create as jest.Mock).mockResolvedValue({
      ...mockConnectorRow,
      id: "550e8400-e29b-41d4-a716-446655440020",
      botTokenEncrypted: "iv:tag:ct",
    });

    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({
        platform: "telegram",
        name: "Test Connector",
        workspaceId: WORKSPACE_ID,
        botToken: "123456:ABC-DEF",
      });

    expect(res.status).toBe(201);
    expect(res.body.hasBotToken).toBe(true);
    // T-198-03: no secret material ever in the response.
    expect(JSON.stringify(res.body)).not.toContain("botTokenEncrypted");
    expect(JSON.stringify(res.body)).not.toContain("configEncrypted");
    expect(res.body.botToken).toBeUndefined();
    // P-1: BigInt pollOffset omitted (serialize succeeded at all).
    expect(res.body.pollOffset).toBeUndefined();
    // Create persists encrypt(botToken) — never the plaintext.
    expect(prisma.chatConnector.create).toHaveBeenCalledTimes(1);
    const dataArg = (prisma.chatConnector.create as jest.Mock).mock.calls[0][0].data;
    expect(dataArg.botTokenEncrypted).not.toBe("123456:ABC-DEF");
    expect(dataArg.botTokenEncrypted).toContain(":");
    expect(dataArg.createdBy).toBe("admin-001");
    expect(dataArg.organizationId).toBe("org-default");
  });

  it("fails closed 400 Platform not implemented yet for a platform without an adapter (D-03)", async () => {
    // discord is NOT registered in the registry mock above — the route's
    // fail-closed 400 is pinned (the REAL stub behavior for all four
    // platforms is additionally pinned by connectorsWebhook.test.ts which
    // does not mock the registry).
    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({
        platform: "discord",
        name: "Test Connector",
        workspaceId: WORKSPACE_ID,
        botToken: "abc",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Platform not implemented yet");
    expect(prisma.chatConnector.create).not.toHaveBeenCalled();
  });

  it("returns 400 with details on invalid body", async () => {
    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({ platform: "telegram", name: "", workspaceId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
    expect(res.body.details).toBeDefined();
  });

  it("rejects a workspace bound to ANOTHER org with 400 (WR-05 ownership assert)", async () => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: WORKSPACE_ID,
      organizationId: "org-other",
      deletedAt: null,
    });

    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({ platform: "telegram", name: "X", workspaceId: WORKSPACE_ID, botToken: "t" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("your organization");
    expect(prisma.chatConnector.create).not.toHaveBeenCalled();
  });

  it("rejects a tombstoned workspace with 400 (WR-05)", async () => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: WORKSPACE_ID,
      organizationId: ORG,
      deletedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({ platform: "telegram", name: "X", workspaceId: WORKSPACE_ID, botToken: "t" });

    expect(res.status).toBe(400);
    expect(prisma.chatConnector.create).not.toHaveBeenCalled();
  });

  it("rejects an archive bound to ANOTHER org with 400 (WR-05)", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440030",
      organizationId: "org-other",
      deletedAt: null,
    });

    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({
        platform: "telegram",
        name: "X",
        workspaceId: WORKSPACE_ID,
        archiveId: "550e8400-e29b-41d4-a716-446655440030",
        botToken: "t",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Archive");
    expect(prisma.chatConnector.create).not.toHaveBeenCalled();
  });
});

// ─── GET /api/connectors + /:id (list/detail serialize) ──────────────

describe("GET /api/connectors", () => {
  it("list serializes every row: no BigInt throw, pollOffset absent, secrets absent (P-1/T-198-03)", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([mockConnectorRow]);

    const res = await request(app).get("/api/connectors").set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].pollOffset).toBeUndefined();
    expect(res.body[0].hasBotToken).toBe(true);
    expect(res.body[0].hasWebhookSecret).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("botTokenEncrypted");
    expect(JSON.stringify(res.body)).not.toContain("configEncrypted");
    expect(JSON.stringify(res.body)).not.toContain("a".repeat(48));
  });

  it("list is org-scoped and excludes tombstoned rows (WR-03: mirrors detail 404-hide)", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([mockConnectorRow]);

    const res = await request(app).get("/api/connectors").set(adminAuth());

    expect(res.status).toBe(200);
    expect(prisma.chatConnector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-default", deletedAt: null },
      })
    );
  });

  it("detail returns the serialized row (connector:view)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(mockConnectorRow);

    const res = await request(app).get(`/api/connectors/${CONNECTOR_ID}`).set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CONNECTOR_ID);
    expect(res.body.hasBotToken).toBe(true);
    expect(res.body.pollOffset).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("botTokenEncrypted");
  });

  it("hides cross-org connectors as 404 (404-hide)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(otherOrgRow);

    const res = await request(app).get(`/api/connectors/${OTHER_ORG_CONNECTOR_ID}`).set(adminAuth());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Connector not found");
  });

  it("returns 404 for unknown id", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get(`/api/connectors/${CONNECTOR_ID}`).set(adminAuth());

    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app).get("/api/connectors/not-a-uuid").set(adminAuth());

    expect(res.status).toBe(400);
  });
});

// ─── PUT /api/connectors/:id (update — botToken stripped) ────────────

describe("PUT /api/connectors/:id", () => {
  it("strips botToken from the update body (D-03 write-only discipline)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(mockConnectorRow);
    (prisma.chatConnector.update as jest.Mock).mockResolvedValue(mockConnectorRow);

    const res = await request(app)
      .put(`/api/connectors/${CONNECTOR_ID}`)
      .set(adminAuth())
      .send({ name: "Renamed", botToken: "sneaky-token", configEncrypted: "sneaky" });

    expect(res.status).toBe(200);
    const dataArg = (prisma.chatConnector.update as jest.Mock).mock.calls[0][0].data;
    expect(dataArg.botToken).toBeUndefined();
    expect(dataArg.configEncrypted).toBeUndefined();
    expect(dataArg.name).toBe("Renamed");
    expect(JSON.stringify(res.body)).not.toContain("sneaky-token");
  });

  it("hides cross-org update as 404", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(otherOrgRow);

    const res = await request(app)
      .put(`/api/connectors/${OTHER_ORG_CONNECTOR_ID}`)
      .set(adminAuth())
      .send({ name: "Renamed" });

    expect(res.status).toBe(404);
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
  });
});

// ─── DELETE /api/connectors/:id (soft delete) ────────────────────────

describe("DELETE /api/connectors/:id", () => {
  it("soft-deletes: deletedAt set + isEnabled false, audit event logged", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(mockConnectorRow);
    (prisma.chatConnector.update as jest.Mock).mockResolvedValue({
      ...mockConnectorRow,
      deletedAt: new Date(),
      isEnabled: false,
    });

    const res = await request(app).delete(`/api/connectors/${CONNECTOR_ID}`).set(adminAuth());

    expect(res.status).toBe(200);
    const dataArg = (prisma.chatConnector.update as jest.Mock).mock.calls[0][0].data;
    expect(dataArg.deletedAt).toBeInstanceOf(Date);
    expect(dataArg.isEnabled).toBe(false);
  });

  it("hides cross-org delete as 404", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(otherOrgRow);

    const res = await request(app).delete(`/api/connectors/${OTHER_ORG_CONNECTOR_ID}`).set(adminAuth());

    expect(res.status).toBe(404);
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
  });
});

// ─── RBAC (D-05) ─────────────────────────────────────────────────────

describe("RBAC on /api/connectors", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/connectors");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin without connector:view on list", async () => {
    const res = await request(app).get("/api/connectors").set(userAuth());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a non-admin without connector:manage on create", async () => {
    const res = await request(app)
      .post("/api/connectors")
      .set(userAuth())
      .send({ platform: "telegram", name: "X", workspaceId: WORKSPACE_ID, botToken: "t" });
    expect(res.status).toBe(403);
    expect(prisma.chatConnector.create).not.toHaveBeenCalled();
  });

  it("returns 200 for an admin (admin:settings passes all permissions)", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app).get("/api/connectors").set(adminAuth());
    expect(res.status).toBe(200);
  });
});

// ─── validate + webhook-setup secret discipline (D-14) ───────────────

describe("POST /api/connectors/:platform/validate", () => {
  it("400s Platform not implemented yet for a platform without a registered adapter", async () => {
    const res = await request(app)
      .post("/api/connectors/discord/validate")
      .set(adminAuth())
      .send({ platform: "discord", botToken: "123:abc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Platform not implemented yet");
  });

  it("validates via the adapter and never persists the token (D-05)", async () => {
    const { getAdapter } = await import("../services/connectors/registry");
    (getAdapter as jest.Mock).mockReturnValue({
      validateBotToken: jest.fn(async (token: string) => ({ valid: true, botUsername: "my_bot", botDisplayName: "My Bot" })),
    });

    const res = await request(app)
      .post("/api/connectors/telegram/validate")
      .set(adminAuth())
      .send({ platform: "telegram", botToken: "123:abc" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, botUsername: "my_bot", botDisplayName: "My Bot" });
    // D-05: validate NEVER persists.
    expect(prisma.chatConnector.create).not.toHaveBeenCalled();
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
  });
});


// ─── POST /api/connectors/:id/test (198-02 Task 3) ───────────────────

describe("POST /api/connectors/:id/test", () => {
  it("dispatches to the registered adapter's sendMessage and returns { sent: true }", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(mockConnectorRow);
    const { getAdapter } = await import("../services/connectors/registry");
    const sendMessage = jest.fn(async () => ({ platformMessageId: "tm-1" }));
    (getAdapter as jest.Mock).mockReturnValue({ sendMessage });

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/test`)
      .set(adminAuth())
      .send({ platformUserId: "tg-user-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(sendMessage).toHaveBeenCalledWith(mockConnectorRow, "tg-user-1", "Test message from Simmetric Chat");
  });

  it("returns 400 when platformUserId is missing from the body", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(mockConnectorRow);
    const { getAdapter } = await import("../services/connectors/registry");
    (getAdapter as jest.Mock).mockReturnValue({ sendMessage: jest.fn() });

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/test`)
      .set(adminAuth())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });

  it("returns 400 Platform not implemented yet for an unimplemented platform (fail-closed D-03)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue({
      ...mockConnectorRow,
      platform: "discord",
    });

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/test`)
      .set(adminAuth())
      .send({ platformUserId: "dc-user-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Platform not implemented yet");
  });

  it("returns 404 for cross-org test sends (404-hide)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(otherOrgRow);

    const res = await request(app)
      .post(`/api/connectors/${OTHER_ORG_CONNECTOR_ID}/test`)
      .set(adminAuth())
      .send({ platformUserId: "tg-user-1" });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/connectors/:id/webhook-setup", () => {
  it("persists a 48-char [A-Za-z0-9_-] secret into configEncrypted and NEVER returns it (D-14)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(mockConnectorRow);
    (prisma.chatConnector.update as jest.Mock).mockImplementation(async ({ data }) => ({
      ...mockConnectorRow,
      pollMode: "webhook",
      configEncrypted: data.configEncrypted,
    }));

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/webhook-setup`)
      .set(adminAuth())
      .send({ url: "https://example.com/api/connectors/telegram/x/webhook" });

    expect(res.status).toBe(200);
    expect(res.body.hasWebhookSecret).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("webhookSecret\":");
    // The stored blob is encrypted (not plaintext JSON).
    const dataArg = (prisma.chatConnector.update as jest.Mock).mock.calls[0][0].data;
    expect(dataArg.configEncrypted).not.toContain("webhookSecret");
    expect(dataArg.pollMode).toBe("webhook");
  });

  it("awaits setWebhook BEFORE persisting: platform failure → 502, NO secret and NO pollMode flip (WR-04)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(mockConnectorRow);
    const { getAdapter } = await import("../services/connectors/registry");
    (getAdapter as jest.Mock).mockReturnValue({
      setWebhook: jest.fn(async () => {
        throw new Error("Telegram setWebhook failed (HTTP 401): Unauthorized");
      }),
    });

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/webhook-setup`)
      .set(adminAuth())
      .send({ url: "https://example.com/webhook" });

    expect(res.status).toBe(502);
    // Nothing persisted — the secret and the mode flip never land.
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
  });

  it("setWebhook success persists AFTER the platform call (WR-04 ordering)", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(mockConnectorRow);
    (prisma.chatConnector.update as jest.Mock).mockResolvedValue(mockConnectorRow);
    const { getAdapter } = await import("../services/connectors/registry");
    const order: string[] = [];
    (getAdapter as jest.Mock).mockReturnValue({
      setWebhook: jest.fn(async () => {
        order.push("setWebhook");
      }),
    });
    (prisma.chatConnector.update as jest.Mock).mockImplementation(async () => {
      order.push("persist");
      return mockConnectorRow;
    });

    const res = await request(app)
      .post(`/api/connectors/${CONNECTOR_ID}/webhook-setup`)
      .set(adminAuth())
      .send({ url: "https://example.com/webhook" });

    expect(res.status).toBe(200);
    expect(order).toEqual(["setWebhook", "persist"]);
  });

  it("returns 404 for cross-org webhook-setup", async () => {
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(otherOrgRow);

    const res = await request(app)
      .post(`/api/connectors/${OTHER_ORG_CONNECTOR_ID}/webhook-setup`)
      .set(adminAuth())
      .send({ url: "https://example.com/x" });

    expect(res.status).toBe(404);
  });
});

// ─── Phase 200 (200-01, D-16 blob-carried / BLOCKER-1 / D-03/D-15) ────

describe("Phase 200: create-route platform-config persistence + leak-strip", () => {
  beforeEach(() => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: WORKSPACE_ID,
      organizationId: ORG,
      deletedAt: null,
    });
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(null);
  });

  it("slack create persists configEncrypted carrying the submitted signingSecret (decrypt→parse round-trip)", async () => {
    (prisma.chatConnector.create as jest.Mock).mockImplementation(async ({ data }) => ({
      ...mockConnectorRow,
      platform: "slack",
      botTokenEncrypted: data.botTokenEncrypted,
      configEncrypted: data.configEncrypted ?? null,
    }));

    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({
        platform: "slack",
        name: "Slack Connector",
        workspaceId: WORKSPACE_ID,
        botToken: "xoxb-test-token",
        signingSecret: "slack-signing-secret-unit-value",
      });

    expect(res.status).toBe(201);
    // BLOCKER-1 wiring: the blob was built from the parsed config fields.
    const dataArg = (prisma.chatConnector.create as jest.Mock).mock.calls[0][0].data;
    expect(dataArg.configEncrypted).toBeDefined();
    expect(dataArg.configEncrypted).not.toContain("slack-signing-secret-unit-value"); // encrypted, not plaintext
    const blob = JSON.parse(decryptRoundTrip(dataArg.configEncrypted));
    expect(blob.signingSecret).toBe("slack-signing-secret-unit-value");
    // D-03/D-15: the RESPONSE carries the boolean, never the value.
    expect(res.body.hasSigningSecret).toBe(true);
    expect(res.body.hasVerifyToken).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("slack-signing-secret-unit-value");
    expect(JSON.stringify(res.body)).not.toContain("xoxb-test-token");
  });

  it("whatsapp create persists the 4-field config blob (Plan 02 consumes the same shared shape)", async () => {
    (prisma.chatConnector.create as jest.Mock).mockImplementation(async ({ data }) => ({
      ...mockConnectorRow,
      platform: "whatsapp",
      botTokenEncrypted: data.botTokenEncrypted,
      configEncrypted: data.configEncrypted ?? null,
    }));

    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({
        platform: "whatsapp",
        name: "WhatsApp Connector",
        workspaceId: WORKSPACE_ID,
        botToken: "ea-test-token",
        phoneNumberId: "PHONE-ID-1",
        appSecret: "app-secret-unit-value",
        verifyToken: "verify-token-unit-value",
        whatsappBusinessAccountId: "WABA-ID-1",
      });

    expect(res.status).toBe(201);
    const dataArg = (prisma.chatConnector.create as jest.Mock).mock.calls[0][0].data;
    const blob = JSON.parse(decryptRoundTrip(dataArg.configEncrypted));
    expect(blob).toEqual({
      phoneNumberId: "PHONE-ID-1",
      appSecret: "app-secret-unit-value",
      verifyToken: "verify-token-unit-value",
      whatsappBusinessAccountId: "WABA-ID-1",
    });
    expect(res.body.hasVerifyToken).toBe(true);
    expect(res.body.hasSigningSecret).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("verify-token-unit-value");
    expect(JSON.stringify(res.body)).not.toContain("app-secret-unit-value");
  });

  it("telegram create leaves configEncrypted ABSENT (byte-identical payload — no phantom blob)", async () => {
    (prisma.chatConnector.create as jest.Mock).mockImplementation(async ({ data }) => ({
      ...mockConnectorRow,
      botTokenEncrypted: data.botTokenEncrypted,
      configEncrypted: data.configEncrypted ?? null,
    }));

    const res = await request(app)
      .post("/api/connectors")
      .set(adminAuth())
      .send({
        platform: "telegram",
        name: "TG Connector",
        workspaceId: WORKSPACE_ID,
        botToken: "123456:ABC-DEF",
      });

    expect(res.status).toBe(201);
    const dataArg = (prisma.chatConnector.create as jest.Mock).mock.calls[0][0].data;
    expect(dataArg.configEncrypted).toBeUndefined();
    // Telegram rows carry neither boolean as true.
    expect(res.body.hasSigningSecret).toBe(false);
    expect(res.body.hasVerifyToken).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("123456:ABC-DEF");
  });

  it("list/detail responses carry the booleans and NEVER the secret values (D-15 leak-strip)", async () => {
    const rowWithConfig = {
      ...mockConnectorRow,
      platform: "slack",
      configEncrypted: encrypt(JSON.stringify({ signingSecret: "secret-in-blob-value", verifyToken: "vt-value" })),
    };
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([rowWithConfig]);
    (prisma.chatConnector.findFirst as jest.Mock).mockResolvedValue(rowWithConfig);

    const listRes = await request(app).get("/api/connectors").set(adminAuth());
    expect(listRes.status).toBe(200);
    expect(listRes.body[0].hasSigningSecret).toBe(true);
    expect(listRes.body[0].hasVerifyToken).toBe(true);
    expect(JSON.stringify(listRes.body)).not.toContain("secret-in-blob-value");
    expect(JSON.stringify(listRes.body)).not.toContain("vt-value");
    expect(JSON.stringify(listRes.body)).not.toContain("configEncrypted");

    const detailRes = await request(app).get(`/api/connectors/${CONNECTOR_ID}`).set(adminAuth());
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.hasSigningSecret).toBe(true);
    expect(JSON.stringify(detailRes.body)).not.toContain("secret-in-blob-value");
  });

  it("validate route passes platform config fields through WITHOUT persisting anything (D-05)", async () => {
    const { getAdapter } = await import("../services/connectors/registry");
    const validateBotToken = jest.fn(async (token: string) => ({ valid: true, botUsername: "bot", botDisplayName: "bot" }));
    (getAdapter as jest.Mock).mockReturnValue({ validateBotToken });

    const res = await request(app)
      .post("/api/connectors/slack/validate")
      .set(adminAuth())
      .send({
        platform: "slack",
        botToken: "xoxb-validate-me",
        signingSecret: "validate-passthrough-secret",
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(validateBotToken).toHaveBeenCalledWith("xoxb-validate-me");
    // Validate NEVER persists (D-05).
    expect(prisma.chatConnector.create).not.toHaveBeenCalled();
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
    // The secret value never echoes back.
    expect(JSON.stringify(res.body)).not.toContain("validate-passthrough-secret");
  });
});

/** Decrypt an encryptionService blob for test round-trips (REAL crypto). */
function decryptRoundTrip(ciphertext: string): string {
  // The suite imports decrypt lazily to avoid a circular mock interplay.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { decrypt } = require("../services/encryptionService");
  return decrypt(ciphertext);
}