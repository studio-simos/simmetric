// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget CRUD API integration tests — admin-only widget management endpoints
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

// Mock auth middleware: accept Bearer tokens, set user on request
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    // Attach user with admin role by default
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
  apiKeyMiddleware: (req: any, res: any, next: any) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      res.status(401).json({ error: "Missing API key" });
      return;
    }
    req.userId = "service-account-001";
    req.user = { id: "service-account-001", username: "widget-service", roles: [] };
    next();
  },
}));

import request from "supertest";
import { Prisma } from "@prisma/client";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { isFeatureEnabled, getFeatureLimit } from "../services/licenseService";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

// Helper: create admin auth header
function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const mockWidget = {
  id: "widget-001",
  name: "Test Widget",
  welcomeMessage: "Hello!",
  fallbackMessage: "Sorry, I can't help with that.",
  position: "bottom-right",
  isActive: true,
  primaryColor: "#4c6ef5",
  botName: "AI Assistant",
  logoUrl: null,
  avatarUrl: null,
  credits: { enabled: true, label: "Powered by", url: "https://example.com" },
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
  workspaces: [{ workspaceId: "workspace-001" }],
  _count: { sessions: 0 },
  creator: { id: "admin-001", name: "Admin User" },
};

// ─── Widget CRUD API ──────────────────────────────────────────────

describe("Widget CRUD API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset license mocks to default (feature disabled, limit = 1)
    (isFeatureEnabled as jest.Mock).mockReturnValue(false);
    (getFeatureLimit as jest.Mock).mockReturnValue(1);
  });

  // ─── GET /api/widgets ──────────────────────────────────────────────

  describe("GET /api/widgets", () => {
    it("returns 200 with empty array when no widgets exist", async () => {
      (prisma.widget.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/widgets")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns widgets with workspaces and session count", async () => {
      (prisma.widget.findMany as jest.Mock).mockResolvedValue([mockWidget]);

      const res = await request(app)
        .get("/api/widgets")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("Test Widget");
    });
  });

  // ─── POST /api/widgets ──────────────────────────────────────────────

  describe("POST /api/widgets", () => {
    it("creates a widget and returns 201 with branding fields", async () => {
      // Enable widget feature for this test
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.count as jest.Mock).mockResolvedValue(0);
      (prisma.widget.create as jest.Mock).mockImplementation(({ data }: any) => ({
        ...mockWidget,
        ...data,
      }));

      const res = await request(app)
        .post("/api/widgets")
        .set(adminAuth())
        .send({
          name: "My Widget",
          primaryColor: "#ff0000",
          botName: "Custom Bot",
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("My Widget");
      expect(res.body.primaryColor).toBe("#ff0000");
      expect(res.body.botName).toBe("Custom Bot");
    });

    it("returns 400 with invalid logoUrl (javascript:)", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.count as jest.Mock).mockResolvedValue(0);

      const res = await request(app)
        .post("/api/widgets")
        .set(adminAuth())
        .send({
          name: "Bad Widget",
          logoUrl: "javascript:alert(1)",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid request body/i);
    });

    it("returns 400 with invalid primaryColor (not hex)", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.count as jest.Mock).mockResolvedValue(0);

      const res = await request(app)
        .post("/api/widgets")
        .set(adminAuth())
        .send({
          name: "Bad Widget",
          primaryColor: "red",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid request body/i);
    });

    it("returns 201 with valid https logoUrl", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.count as jest.Mock).mockResolvedValue(0);
      (prisma.widget.create as jest.Mock).mockResolvedValue({
        ...mockWidget,
        logoUrl: "https://example.com/logo.png",
      });

      const res = await request(app)
        .post("/api/widgets")
        .set(adminAuth())
        .send({
          name: "Logo Widget",
          logoUrl: "https://example.com/logo.png",
        });

      expect(res.status).toBe(201);
    });

    it("returns 402 when widget_enabled is false (license gate)", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(false);

      const res = await request(app)
        .post("/api/widgets")
        .set(adminAuth())
        .send({ name: "Blocked Widget" });

      expect(res.status).toBe(402);
      expect(res.body.feature).toBe("widget_enabled");
    });

    it("returns 402 when max_widgets limit is reached", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (getFeatureLimit as jest.Mock).mockReturnValue(1);
      (prisma.widget.count as jest.Mock).mockResolvedValue(1);

      const res = await request(app)
        .post("/api/widgets")
        .set(adminAuth())
        .send({ name: "Over Limit Widget" });

      expect(res.status).toBe(402);
      expect(res.body.feature).toBe("max_widgets");
      expect(res.body.limit).toBe(1);
      expect(res.body.current).toBe(1);
    });

    // 260831-hgy: per-widget response model pin — plain String columns,
    // persisted via the route's `...parsed.data` spread (no toJsonWriteValue
    // needed, same as archiveId).
    it("creates a widget with responseProviderId + responseModel and persists both via the spread", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.count as jest.Mock).mockResolvedValue(0);
      (prisma.widget.create as jest.Mock).mockImplementation(({ data }: any) => ({
        ...mockWidget,
        ...data,
      }));

      const res = await request(app)
        .post("/api/widgets")
        .set(adminAuth())
        .send({
          name: "Pinned Widget",
          responseProviderId: "550e8400-e29b-41d4-a716-446655440000",
          responseModel: "qwen2.5:7b",
        });

      expect(res.status).toBe(201);
      // The create data spread carried both fields to prisma
      expect(prisma.widget.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            responseProviderId: "550e8400-e29b-41d4-a716-446655440000",
            responseModel: "qwen2.5:7b",
          }),
        }),
      );
      expect(res.body.responseProviderId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(res.body.responseModel).toBe("qwen2.5:7b");
    });

    it("returns 400 when responseProviderId is not a UUID", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.count as jest.Mock).mockResolvedValue(0);

      const res = await request(app)
        .post("/api/widgets")
        .set(adminAuth())
        .send({
          name: "Bad Pin Widget",
          responseProviderId: "not-a-uuid",
          responseModel: "qwen2.5:7b",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid request body/i);
    });
  });

  // ─── GET /api/widgets/:id ──────────────────────────────────────────

  describe("GET /api/widgets/:id", () => {
    it("returns widget details", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

      const res = await request(app)
        .get("/api/widgets/widget-001")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("widget-001");
    });

    it("returns 404 when widget not found", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get("/api/widgets/nonexistent")
        .set(adminAuth());

      expect(res.status).toBe(404);
    });
  });

  // ─── PUT /api/widgets/:id ──────────────────────────────────────────

  describe("PUT /api/widgets/:id", () => {
    it("updates widget branding fields", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widget.update as jest.Mock).mockResolvedValue({
        ...mockWidget,
        primaryColor: "#00ff00",
        botName: "Updated Bot",
        logoUrl: "https://example.com/new-logo.png",
        avatarUrl: "https://example.com/avatar.png",
      });

      const res = await request(app)
        .put("/api/widgets/widget-001")
        .set(adminAuth())
        .send({
          primaryColor: "#00ff00",
          botName: "Updated Bot",
          logoUrl: "https://example.com/new-logo.png",
          avatarUrl: "https://example.com/avatar.png",
        });

      expect(res.status).toBe(200);
      expect(res.body.primaryColor).toBe("#00ff00");
      expect(res.body.botName).toBe("Updated Bot");
    });

    it("returns 404 when widget not found", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .put("/api/widgets/nonexistent")
        .set(adminAuth())
        .send({ name: "Updated" });

      expect(res.status).toBe(404);
    });

    // Quick 260826-hx5 (T-hx5-01): credits write gate behind
    // `widget_credits_editing`. The gate is INLINE in the PUT handler — it
    // fires ONLY when the body's `credits` field differs from the stored
    // value. A no-op credits write (same value) or absent credits must keep
    // working so non-credits PUTs are not blocked on Community.
    it("returns 402 when credits differ and widget_credits_editing is off", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(false);
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

      const res = await request(app)
        .put("/api/widgets/widget-001")
        .set(adminAuth())
        .send({ credits: { enabled: false, label: "X", url: "" } });

      expect(res.status).toBe(402);
      expect(res.body.feature).toBe("widget_credits_editing");
      expect(res.body.tier).toBe("community");
      expect(prisma.widget.update).not.toHaveBeenCalled();
    });

    it("succeeds when credits is unchanged even if widget_credits_editing is off", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(false);
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widget.update as jest.Mock).mockResolvedValue(mockWidget);

      const res = await request(app)
        .put("/api/widgets/widget-001")
        .set(adminAuth())
        .send({ credits: { enabled: true, label: "Powered by", url: "https://example.com" } });

      expect(res.status).toBe(200);
    });

    it("succeeds when credits is absent (non-credits PUT) regardless of the flag", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(false);
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widget.update as jest.Mock).mockResolvedValue({ ...mockWidget, name: "Renamed" });

      const res = await request(app)
        .put("/api/widgets/widget-001")
        .set(adminAuth())
        .send({ name: "Renamed" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Renamed");
    });

    it("succeeds on a credits edit when widget_credits_editing is on", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widget.update as jest.Mock).mockResolvedValue({
        ...mockWidget,
        credits: { enabled: false, label: "X", url: "" },
      });

      const res = await request(app)
        .put("/api/widgets/widget-001")
        .set(adminAuth())
        .send({ credits: { enabled: false, label: "X", url: "" } });

      expect(res.status).toBe(200);
    });

    // 260831-hgy: per-widget response model pin — PUT update path.
    it("updates responseProviderId + responseModel and persists both via the spread", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
        ...mockWidget,
        ...data,
      }));

      const res = await request(app)
        .put("/api/widgets/widget-001")
        .set(adminAuth())
        .send({
          responseProviderId: "550e8400-e29b-41d4-a716-446655440000",
          responseModel: "llama3.1:8b",
        });

      expect(res.status).toBe(200);
      // The update data spread carried both fields to prisma
      expect(prisma.widget.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            responseProviderId: "550e8400-e29b-41d4-a716-446655440000",
            responseModel: "llama3.1:8b",
          }),
        }),
      );
      expect(res.body.responseProviderId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(res.body.responseModel).toBe("llama3.1:8b");
    });

    it("PUT with null clears both columns (nullable write contract → SQL NULL)", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
        ...mockWidget,
        responseProviderId: "550e8400-e29b-41d4-a716-446655440000",
        responseModel: "llama3.1:8b",
      });
      (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
        ...mockWidget,
        ...data,
      }));

      const res = await request(app)
        .put("/api/widgets/widget-001")
        .set(adminAuth())
        .send({
          responseProviderId: null,
          responseModel: null,
        });

      expect(res.status).toBe(200);
      // null flows through the spread to prisma (SQL NULL = pin cleared)
      expect(prisma.widget.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            responseProviderId: null,
            responseModel: null,
          }),
        }),
      );
    });

    it("PUT without the pair leaves both columns unchanged (partial-update semantics)", async () => {
      (isFeatureEnabled as jest.Mock).mockReturnValue(true);
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
        ...mockWidget,
        ...data,
      }));

      const res = await request(app)
        .put("/api/widgets/widget-001")
        .set(adminAuth())
        .send({ name: "Renamed Only" });

      expect(res.status).toBe(200);
      const updateData = (prisma.widget.update as jest.Mock).mock.calls[0][0].data;
      expect(updateData.responseProviderId).toBeUndefined();
      expect(updateData.responseModel).toBeUndefined();
    });
  });

  // ─── DELETE /api/widgets/:id ──────────────────────────────────────────

  describe("DELETE /api/widgets/:id", () => {
    it("soft-deletes widget (sets deletedAt)", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widget.update as jest.Mock).mockResolvedValue({
        ...mockWidget,
        deletedAt: new Date(),
      });

      const res = await request(app)
        .delete("/api/widgets/widget-001")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/deleted/i);
      expect(prisma.widget.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        })
      );
    });

    it("returns 404 when widget not found", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .delete("/api/widgets/nonexistent")
        .set(adminAuth());

      expect(res.status).toBe(404);
    });
  });

  // ─── PUT /api/widgets/:id/workspaces ──────────────────────────────

  describe("PUT /api/widgets/:id/workspaces", () => {
    it("sets workspace whitelist", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widgetWorkspace.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.widgetWorkspace.createMany as jest.Mock).mockResolvedValue({ count: 2 });
      // $transaction receives an array of Prisma operations; just resolve it
      (prisma.$transaction as jest.Mock).mockResolvedValue([{ count: 1 }, { count: 2 }]);

      const res = await request(app)
        .put("/api/widgets/widget-001/workspaces")
        .set(adminAuth())
        .send({ workspaceIds: ["workspace-001", "workspace-002"] });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/workspace whitelist updated/i);
    });

    it("returns 400 when workspaceIds is not an array", async () => {
      const res = await request(app)
        .put("/api/widgets/widget-001/workspaces")
        .set(adminAuth())
        .send({ workspaceIds: "not-an-array" });

      expect(res.status).toBe(400);
    });

    it("returns 404 when widget not found", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .put("/api/widgets/nonexistent/workspaces")
        .set(adminAuth())
        .send({ workspaceIds: ["workspace-001"] });

      expect(res.status).toBe(404);
    });
  });

  // ─── GET /api/widgets/:id/workspaces ──────────────────────────────

  describe("GET /api/widgets/:id/workspaces", () => {
    it("lists linked workspaces", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
      (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([
        { widgetId: "widget-001", workspaceId: "workspace-001", workspace: { id: "workspace-001", name: "Docs" } },
      ]);

      const res = await request(app)
        .get("/api/widgets/widget-001/workspaces")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].workspaceId).toBe("workspace-001");
    });

    it("returns 404 when widget not found", async () => {
      (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get("/api/widgets/nonexistent/workspaces")
        .set(adminAuth());

      expect(res.status).toBe(404);
    });
  });

  // ─── Authentication ──────────────────────────────────────────────

  describe("Authentication", () => {
    it("returns 401 for unauthenticated requests", async () => {
      const res = await request(app)
        .get("/api/widgets");

      expect(res.status).toBe(401);
    });

    it("returns 401 for unauthenticated POST requests", async () => {
      const res = await request(app)
        .post("/api/widgets")
        .send({ name: "Test" });

      expect(res.status).toBe(401);
    });
  });
});
// ─── 260917-mz6: systemPrompt / contactConfig / leadCaptureTiming / ────
//     leadCaptureTimeoutSeconds — create + update paths.

describe("Widget CRUD API — 260917-mz6 grounding + contact + timing fields", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isFeatureEnabled as jest.Mock).mockReturnValue(true);
    (getFeatureLimit as jest.Mock).mockReturnValue(Infinity);
  });

  it("POST accepts a long systemPrompt and persists it via the spread", async () => {
    (prisma.widget.count as jest.Mock).mockResolvedValue(0);
    (prisma.widget.create as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));

    const longPrompt = "x".repeat(4000);
    const res = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({ name: "Grounded", systemPrompt: longPrompt });

    expect(res.status).toBe(201);
    expect(prisma.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ systemPrompt: longPrompt }),
      }),
    );
    expect(res.body.systemPrompt).toBe(longPrompt);
  });

  it("POST rejects systemPrompt over 4000 chars (400)", async () => {
    (prisma.widget.count as jest.Mock).mockResolvedValue(0);
    const res = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({ name: "Too Long", systemPrompt: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("POST accepts a valid contactConfig blob and persists it", async () => {
    (prisma.widget.count as jest.Mock).mockResolvedValue(0);
    (prisma.widget.create as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));

    const blob = {
      formUrl: "https://example.com/contact",
      email: "owner@example.com",
    };
    const res = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({ name: "Contact Widget", contactConfig: blob });

    expect(res.status).toBe(201);
    expect(prisma.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactConfig: blob }),
      }),
    );
  });

  it("POST rejects a javascript: URL inside contactConfig (400)", async () => {
    (prisma.widget.count as jest.Mock).mockResolvedValue(0);
    const res = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({ name: "Bad Blob", contactConfig: { formUrl: "javascript:alert(1)" } });
    expect(res.status).toBe(400);
  });

  it("POST rejects a malformed contactConfig email (400)", async () => {
    (prisma.widget.count as jest.Mock).mockResolvedValue(0);
    const res = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({ name: "Bad Email", contactConfig: { email: "not-an-email" } });
    expect(res.status).toBe(400);
  });

  it("POST accepts leadCaptureTiming enum + timeout bounds; rejects out-of-bounds", async () => {
    (prisma.widget.count as jest.Mock).mockResolvedValue(0);
    (prisma.widget.create as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));

    const ok = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({ name: "Timed", leadCaptureTiming: "timeout", leadCaptureTimeoutSeconds: 45 });
    expect(ok.status).toBe(201);
    expect(ok.body.leadCaptureTiming).toBe("timeout");

    const bad = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({ name: "Bad Timing", leadCaptureTimeoutSeconds: 3 });
    expect(bad.status).toBe(400);
  });

  it("PUT persists all four fields and GET /api/widgets echoes them", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));
    (prisma.widget.findMany as jest.Mock).mockResolvedValue([
      {
        ...mockWidget,
        systemPrompt: "Be grounded",
        contactConfig: { email: "owner@example.com" },
        leadCaptureTiming: "start",
        leadCaptureTimeoutSeconds: 30,
      },
    ]);

    const update = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({
        systemPrompt: "Be grounded",
        contactConfig: { email: "owner@example.com" },
        leadCaptureTiming: "start",
        leadCaptureTimeoutSeconds: 45,
      });

    expect(update.status).toBe(200);
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          systemPrompt: "Be grounded",
          contactConfig: { email: "owner@example.com" },
          leadCaptureTiming: "start",
          leadCaptureTimeoutSeconds: 45,
        }),
      }),
    );
    expect(update.body.systemPrompt).toBe("Be grounded");
    expect(update.body.contactConfig).toEqual({ email: "owner@example.com" });
    expect(update.body.leadCaptureTiming).toBe("start");
    expect(update.body.leadCaptureTimeoutSeconds).toBe(45);

    (prisma.widget.findMany as jest.Mock).mockResolvedValue([
      { ...mockWidget, systemPrompt: "Be grounded" },
    ]);
    const list = await request(app).get("/api/widgets").set(adminAuth());
    expect(list.status).toBe(200);
    expect(list.body[0].systemPrompt).toBe("Be grounded");
  });

  it("PUT with null clears systemPrompt/contactConfig (nullable write contract → SQL NULL)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
      ...mockWidget,
      systemPrompt: "old",
      contactConfig: { email: "old@example.com" },
    });
    (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ systemPrompt: null, contactConfig: null });

    expect(res.status).toBe(200);
    // systemPrompt is a plain String? column — null flows through the spread.
    // contactConfig is a Json? column — the route translates null to
    // Prisma.DbNull (SQL NULL) via toJsonWriteValue (same as credits/blob).
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          systemPrompt: null,
          contactConfig: Prisma.DbNull,
        }),
      }),
    );
  });

  it("PUT without the four fields leaves them unchanged (partial-update semantics)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockResolvedValue({ ...mockWidget, name: "Renamed" });

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ name: "Renamed Only" });

    expect(res.status).toBe(200);
    const updateData = (prisma.widget.update as jest.Mock).mock.calls[0][0].data;
    expect(updateData.systemPrompt).toBeUndefined();
    expect(updateData.contactConfig).toBeUndefined();
    expect(updateData.leadCaptureTiming).toBeUndefined();
    expect(updateData.leadCaptureTimeoutSeconds).toBeUndefined();
  });
});

// ─── 260917-qoh: per-widget privacyUrl CRUD ─────────────────────────────

describe("Widget CRUD API — 260917-qoh privacyUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isFeatureEnabled as jest.Mock).mockReturnValue(true);
    (getFeatureLimit as jest.Mock).mockReturnValue(Infinity);
  });

  it("PUT accepts a valid http(s) privacyUrl and persists it via the spread", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ privacyUrl: "https://example.com/privacy" });

    expect(res.status).toBe(200);
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ privacyUrl: "https://example.com/privacy" }),
      }),
    );
    expect(res.body.privacyUrl).toBe("https://example.com/privacy");
  });

  it("PUT accepts an http:// privacyUrl (both schemes allowed)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ privacyUrl: "http://example.com/privacy" });

    expect(res.status).toBe(200);
    expect(res.body.privacyUrl).toBe("http://example.com/privacy");
  });

  it("PUT rejects a javascript: privacyUrl (400 — the mandatory isHttpUrl refine)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ privacyUrl: "javascript:alert(1)" });

    expect(res.status).toBe(400);
    expect(prisma.widget.update).not.toHaveBeenCalled();
  });

  it("PUT rejects a data: privacyUrl (400)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ privacyUrl: "data:text/html,<script>alert(1)</script>" });

    expect(res.status).toBe(400);
  });

  it("PUT with null clears privacyUrl (nullable write contract → SQL NULL)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
      ...mockWidget,
      privacyUrl: "https://example.com/privacy",
    });
    (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ privacyUrl: null });

    expect(res.status).toBe(200);
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ privacyUrl: null }),
      }),
    );
  });

  it("PUT without privacyUrl leaves it unchanged (partial-update semantics)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockResolvedValue({ ...mockWidget, name: "Renamed" });

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ name: "Renamed Only" });

    expect(res.status).toBe(200);
    const updateData = (prisma.widget.update as jest.Mock).mock.calls[0][0].data;
    expect(updateData.privacyUrl).toBeUndefined();
  });
});
