// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 84 — Plan 84-01 Task 4.
 *
 * Unit tests (supertest) for `PUT /api/system/chat-retention` covering D-08:
 *   - Test 1: confirmDataLoss=false → 400, no write, no logEvent.
 *   - Test 2: confirmDataLoss=true → 200, persists value, emits audit.
 *   - Test 3: retentionDays=null → 200, persists "" (OFF), audit with null.
 *   - Test 4: no JWT → 401 (authMiddleware rejects).
 *   - Test 5: authenticated non-admin → 403 (requirePermission rejects).
 *   - Test 6: wrong-type retentionDays ("30" string) → 400 with details.
 *
 * Strategy: mount ONLY the chatRetention router on a minimal Express app with
 * mocked middleware so auth/RBAC behavior is controllable per-test. This
 * isolates route logic from the full createApp() machinery.
 */
import "./helpers/setupEnv";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

// --- Prisma mock ----------------------------------------------------------
// NOTE: mock object/fn live INSIDE factories to avoid TDZ under @swc/jest.
// Phase 183 (SAAS-02): upsertSystemConfigRow's find-first surface — the route
// no longer issues keyed writes.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    // Phase 185 (185-02): tenantContextMiddleware (D-09) resolves the org via
    // organizationMember.findFirst — live default-org membership keeps the
    // single-org suite responses byte-identical.
    organizationMember: {
      findFirst: jest.fn().mockResolvedValue({ organizationId: "org-default" }),
    },
    systemConfig: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));
const mockPrisma = require("../utils/prisma").default;

// --- systemConfigService mock ---------------------------------------------
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ key: "chat_message_retention_days", value: "", readOnly: false }),
  upsertSystemConfigRow: jest.fn(),
  updateSettings: jest.fn(),
  seedConfigDefaults: jest.fn(),
}));

// --- eventLogService mock -------------------------------------------------
jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));
const mockLogEvent = require("../services/eventLogService").logEvent as jest.Mock;

// --- logger mock ----------------------------------------------------------
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// --- auth/rbac mocks (controllable per-test via mockState) ----------------
// mockState lives inside the auth factory and is shared with the rbac factory
// via require(); both factories and tests mutate the SAME object reference.
type AuthMode = "ok" | "no-auth" | "no-permission";

jest.mock("../middleware/auth", () => {
  const mockState: { authMode: AuthMode; userId: string | null } = {
    authMode: "ok",
    userId: "admin-user-id",
  };
  return {
    authMiddleware: (req: Request, res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-auth") {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.userId = mockState.userId ?? undefined;
      (req as unknown as { user: unknown }).user = { id: mockState.userId };
      next();
    },
    __mockState: mockState,
  };
});

jest.mock("../middleware/rbac", () => {
  const mockState = require("../middleware/auth").__mockState;
  return {
    requirePermission: (_perm: string) => (req: Request, res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-permission") {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
      next();
    },
    requireAdmin: (req: Request, res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-permission") {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      next();
    },
  };
});
const mockState: { authMode: AuthMode; userId: string | null } = require("../middleware/auth").__mockState;

import chatRetentionRoutes from "../routes/chatRetention";
import { getSetting, upsertSystemConfigRow } from "../services/systemConfigService";
// TS: the import binds the real function type; the jest.mock factory above
// replaces it at runtime — cast through unknown for the mock surface.
const mockUpsertHelper = upsertSystemConfigRow as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/system", chatRetentionRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.authMode = "ok";
  mockState.userId = "admin-user-id";
  (getSetting as jest.Mock).mockResolvedValue({
    key: "chat_message_retention_days",
    value: "",
    readOnly: false,
  });
  mockPrisma.systemConfig.findFirst.mockResolvedValue(null);
  mockPrisma.systemConfig.update.mockResolvedValue({});
  mockPrisma.systemConfig.create.mockResolvedValue({});
  mockLogEvent.mockResolvedValue(undefined);
});

describe("PUT /api/system/chat-retention — D-08 route contract", () => {
  it("Test 1: confirmDataLoss=false → 400, no write, no logEvent", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/system/chat-retention")
      .send({ retentionDays: 30, confirmDataLoss: false });

    expect(res.status).toBe(400);
    expect(mockPrisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.systemConfig.update).not.toHaveBeenCalled();
    expect(mockPrisma.systemConfig.create).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("Test 2: confirmDataLoss=true → 200, persists '30', emits audit", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/system/chat-retention")
      .send({ retentionDays: 30, confirmDataLoss: true });

    // Helper-mediated write (bypasses updateSettings per D-09): assert the
    // helper's call surface — the mocked upsertSystemConfigRow receives the
    // mock prisma as its db param and the global-row write args.
    expect(mockUpsertHelper).toHaveBeenCalledTimes(1);
    const [dbArg, writeArg] = mockUpsertHelper.mock.calls[0];
    expect(writeArg).toEqual({ key: "chat_message_retention_days", value: "30" });
    expect(dbArg).toBe(mockPrisma);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Chat retention updated", retentionDays: 30 });

    // Audit emission with previousRetentionDays (prior value was "" → null).
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const [entityType, entityId, action, userId, metadata] = mockLogEvent.mock.calls[0];
    expect(entityType).toBe("chat");
    expect(entityId).toBe("system");
    expect(action).toBe("retention.updated");
    expect(userId).toBe("admin-user-id");
    expect(metadata).toEqual({ retentionDays: 30, previousRetentionDays: null });
  });

  it("Test 3: retentionDays=null → 200, persists '' (OFF), audit with null", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/system/chat-retention")
      .send({ retentionDays: null, confirmDataLoss: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Chat retention updated", retentionDays: null });

    // Helper-mediated write: the OFF value rides the same helper surface.
    expect(mockUpsertHelper).toHaveBeenCalledTimes(1);
    const [, offWriteArg] = mockUpsertHelper.mock.calls[0];
    expect(offWriteArg).toEqual({ key: "chat_message_retention_days", value: "" });

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const metadata = mockLogEvent.mock.calls[0][4];
    expect(metadata).toEqual({ retentionDays: null, previousRetentionDays: null });
  });

  it("Test 4: no JWT → 401", async () => {
    mockState.authMode = "no-auth";
    const app = buildApp();
    const res = await request(app)
      .put("/api/system/chat-retention")
      .send({ retentionDays: 30, confirmDataLoss: true });

    expect(res.status).toBe(401);
    expect(mockPrisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.systemConfig.update).not.toHaveBeenCalled();
    expect(mockPrisma.systemConfig.create).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("Test 5: authenticated non-admin (no admin:settings) → 403", async () => {
    mockState.authMode = "no-permission";
    const app = buildApp();
    const res = await request(app)
      .put("/api/system/chat-retention")
      .send({ retentionDays: 30, confirmDataLoss: true });

    expect(res.status).toBe(403);
    expect(mockPrisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.systemConfig.update).not.toHaveBeenCalled();
    expect(mockPrisma.systemConfig.create).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("Test 6: wrong-type retentionDays ('30' string) → 400 with details", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/system/chat-retention")
      .send({ retentionDays: "30", confirmDataLoss: true });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Invalid request body");
    expect(res.body).toHaveProperty("details");
    expect(mockPrisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.systemConfig.update).not.toHaveBeenCalled();
    expect(mockPrisma.systemConfig.create).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("audit includes previousRetentionDays when prior value was numeric", async () => {
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "7",
      readOnly: false,
    });
    const app = buildApp();
    const res = await request(app)
      .put("/api/system/chat-retention")
      .send({ retentionDays: 30, confirmDataLoss: true });

    expect(res.status).toBe(200);
    const metadata = mockLogEvent.mock.calls[0][4];
    expect(metadata).toEqual({ retentionDays: 30, previousRetentionDays: 7 });
  });
});