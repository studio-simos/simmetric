// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Provider preset catalog API integration tests (quick task 260723-ps2).
 *
 * Covers: GET /api/provider-presets (list with isInstalled), GET /:presetId
 * (404 for unknown), POST /:presetId/install (OpenAI-compatible success,
 * OAuth 422, 409 on duplicate name, native-type 201 with lastError).
 */
import "./helpers/setupEnv";

jest.mock("uuid", () => ({
  v4: jest.fn(() => "preset-uuid-" + Math.random().toString(36).slice(2)),
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
  initLicense: jest.fn(() => ({ tier: "enterprise", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "enterprise", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => true),
  getFeatureLimit: jest.fn(() => Infinity),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

// Auth middleware: admin token gets provider:read + provider:write perms
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.userId = "admin-001";
    req.user = {
      id: "admin-001",
      roles: [{
        role: {
          name: "admin",
          permissions: [
            { permissionName: "provider:read" },
            { permissionName: "provider:write" },
          ],
        },
      }],
    };
    next();
  },
  apiKeyMiddleware: (_req: any, res: any, _next: any) => {
    res.status(401).json({ error: "Missing API key" });
  },
}));

jest.mock("../services/encryptionService", () => ({
  encrypt: jest.fn((text: string) => `enc:${text}`),
  decrypt: jest.fn((s: string) => s.replace("enc:", "")),
  maskApiKey: jest.fn((k: string | null) => (k ? "****" : null)),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn(() => Promise.resolve()),
}));

// Mock providerService.refreshModels + isNativeHandlerPending. refreshModels
// default resolves (OpenAI-compatible path, now including Gemini which shipped
// its native handler in quick 260723-uzf); individual tests override it.
// isNativeHandlerPending is now true only for xiaomi/minimax (gemini shipped).
jest.mock("../services/providerService", () => ({
  refreshModels: jest.fn(() => Promise.resolve(0)),
  isNativeHandlerPending: jest.fn((type: string) =>
    type === "xiaomi" || type === "minimax"),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";
import { refreshModels, isNativeHandlerPending } from "../services/providerService";
import { logEvent } from "../services/eventLogService";
import { encrypt } from "../services/encryptionService";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

const openaiPreset = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  slug: "deepseek",
  name: "DeepSeek",
  type: "openai",
  baseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-chat",
  authMethod: "bearer",
  docsUrl: "https://api-docs.deepseek.com/",
  requiresOAuth: false,
  category: "OpenAI-compatible",
  description: "DeepSeek chat & reasoning models.",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const oauthPreset = {
  id: "550e8400-e29b-41d4-a716-446655440002",
  slug: "github-copilot",
  name: "GitHub Copilot",
  type: "openai",
  baseUrl: null,
  defaultModel: null,
  authMethod: "oauth",
  docsUrl: "https://docs.github.com/copilot",
  requiresOAuth: true,
  category: "OAuth (manual)",
  description: "OAuth — manual.",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const nativePreset = {
  id: "550e8400-e29b-41d4-a716-446655440003",
  slug: "gemini",
  name: "Gemini (Google native)",
  type: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  defaultModel: "gemini-1.5-pro",
  authMethod: "bearer",
  docsUrl: "https://ai.google.dev/gemini-api/docs",
  requiresOAuth: false,
  category: "Native",
  description: "Google Gemini via the native Generative Language API.",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

// xiaomi preset — native handler STILL pending (quick 260723-uzf shipped
// Gemini only). Install stores the record with lastError set.
const xiaomiPreset = {
  id: "550e8400-e29b-41d4-a716-446655440010",
  slug: "xiaomi-mimo",
  name: "Xiaomi MiMo",
  type: "xiaomi",
  baseUrl: "https://api.xiaomi.com/mimo/v1",
  defaultModel: "mimo-7b",
  authMethod: "bearer",
  docsUrl: "https://www.xiaomi.com/mimo",
  requiresOAuth: false,
  category: "Native",
  description: "Native handler pending.",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const installedProvider = {
  id: "prov-installed-001",
  name: "DeepSeek",
  type: "openai",
  baseUrl: "https://api.deepseek.com",
  apiKey: "enc:sk-test",
  isEnabled: true,
  isDefault: false,
  lastError: null,
  lastSyncAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  models: [],
};

describe("Provider preset catalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===== GET /api/provider-presets =====

  describe("GET /api/provider-presets", () => {
    it("returns 20 presets augmented with isInstalled flag", async () => {
      // Build 20 mock presets
      const presets = Array.from({ length: 20 }, (_, i) => ({
        ...openaiPreset,
        id: `p-${i}`,
        slug: `preset-${i}`,
        name: i === 0 ? "DeepSeek" : `Preset ${i}`,
      }));
      (prisma.providerPreset.findMany as jest.Mock).mockResolvedValue(presets);
      // Only "DeepSeek" is installed
      (prisma.provider.findMany as jest.Mock).mockResolvedValue([{ name: "DeepSeek" }]);

      const res = await request(app)
        .get("/api/provider-presets")
        .set(adminAuth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(20);
      expect(res.body[0].isInstalled).toBe(true);
      expect(res.body[1].isInstalled).toBe(false);
    });

    it("returns empty array when no presets exist", async () => {
      (prisma.providerPreset.findMany as jest.Mock).mockResolvedValue([]);
      const res = await request(app).get("/api/provider-presets").set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ===== GET /api/provider-presets/:presetId =====

  describe("GET /api/provider-presets/:presetId", () => {
    it("returns 404 for unknown UUID", async () => {
      (prisma.providerPreset.findUnique as jest.Mock).mockResolvedValue(null);
      const res = await request(app)
        .get("/api/provider-presets/550e8400-e29b-41d4-a716-446655440099")
        .set(adminAuth());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Provider preset not found");
    });

    it("returns 400 for invalid UUID", async () => {
      const res = await request(app)
        .get("/api/provider-presets/not-a-uuid")
        .set(adminAuth());
      expect(res.status).toBe(400);
    });

    it("returns the preset for a valid UUID", async () => {
      (prisma.providerPreset.findUnique as jest.Mock).mockResolvedValue(openaiPreset);
      const res = await request(app)
        .get("/api/provider-presets/550e8400-e29b-41d4-a716-446655440001")
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe("deepseek");
    });
  });

  // ===== POST /api/provider-presets/:presetId/install =====

  describe("POST /api/provider-presets/:presetId/install", () => {
    it("creates a Provider for an OpenAI-compatible preset and returns 201", async () => {
      (prisma.providerPreset.findUnique as jest.Mock).mockResolvedValue(openaiPreset);
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(null);
      const created = { ...installedProvider, id: "prov-new-001", models: [] };
      (prisma.provider.create as jest.Mock).mockResolvedValue(created);
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(created);
      (refreshModels as jest.Mock).mockResolvedValue(5);

      const res = await request(app)
        .post("/api/provider-presets/550e8400-e29b-41d4-a716-446655440001/install")
        .set(adminAuth())
        .send({ apiKey: "sk-test-secret" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("prov-new-001");
      expect(res.body.apiKey).toBe("masked"); // apiKey stripped, never leaked
      expect(prisma.provider.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          name: "DeepSeek",
          type: "openai",
          baseUrl: "https://api.deepseek.com",
          apiKey: "enc:sk-test-secret",
        }),
      }));
      expect(encrypt).toHaveBeenCalledWith("sk-test-secret");
      expect(refreshModels).toHaveBeenCalledWith("prov-new-001");
      expect(logEvent).toHaveBeenCalledWith(
        "provider",
        "prov-new-001",
        "provider.installed_from_preset",
        "admin-001",
        expect.objectContaining({ presetSlug: "deepseek" }),
      );
    });

    it("returns 422 for an OAuth preset", async () => {
      (prisma.providerPreset.findUnique as jest.Mock).mockResolvedValue(oauthPreset);

      const res = await request(app)
        .post("/api/provider-presets/550e8400-e29b-41d4-a716-446655440002/install")
        .set(adminAuth())
        .send({});

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("OAuth");
      expect(res.body.docsUrl).toBe(oauthPreset.docsUrl);
      expect(prisma.provider.create).not.toHaveBeenCalled();
    });

    it("returns 409 when a Provider with the same name already exists", async () => {
      (prisma.providerPreset.findUnique as jest.Mock).mockResolvedValue(openaiPreset);
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(installedProvider);

      const res = await request(app)
        .post("/api/provider-presets/550e8400-e29b-41d4-a716-446655440001/install")
        .set(adminAuth())
        .send({ apiKey: "sk-test" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already exists");
      expect(prisma.provider.create).not.toHaveBeenCalled();
    });

    it("returns 201 and refreshes models when installing the Gemini preset (native handler shipped)", async () => {
      (prisma.providerPreset.findUnique as jest.Mock).mockResolvedValue(nativePreset);
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(null);
      const created = {
        ...installedProvider,
        id: "prov-gemini-001",
        name: "Gemini (Google native)",
        type: "gemini",
        models: [],
        lastError: null,
      };
      (prisma.provider.create as jest.Mock).mockResolvedValue(created);
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(created);
      (refreshModels as jest.Mock).mockResolvedValue(3);
      (isNativeHandlerPending as jest.Mock).mockReturnValue(false);

      const res = await request(app)
        .post("/api/provider-presets/550e8400-e29b-41d4-a716-446655440003/install")
        .set(adminAuth())
        .send({ apiKey: "sk-gemini" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("prov-gemini-001");
      expect(refreshModels).toHaveBeenCalledWith("prov-gemini-001");
    });

    it("returns 201 with lastError set when installing a still-pending native-type preset (xiaomi)", async () => {
      (prisma.providerPreset.findUnique as jest.Mock).mockResolvedValue(xiaomiPreset);
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(null);
      const created = {
        ...installedProvider,
        id: "prov-xiaomi-001",
        name: "Xiaomi MiMo",
        type: "xiaomi",
        models: [],
      };
      (prisma.provider.create as jest.Mock).mockResolvedValue(created);
      const withError = { ...created, lastError: "Native handler for xiaomi not yet implemented" };
      (prisma.provider.update as jest.Mock).mockResolvedValue(withError);
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(withError);
      (refreshModels as jest.Mock).mockRejectedValue(
        new Error("Native handler for xiaomi not yet implemented — install the OpenAI-compatible variant or wait for the handler follow-up task"),
      );
      (isNativeHandlerPending as jest.Mock).mockReturnValue(true);

      const res = await request(app)
        .post("/api/provider-presets/550e8400-e29b-41d4-a716-446655440010/install")
        .set(adminAuth())
        .send({ apiKey: "sk-xiaomi" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("prov-xiaomi-001");
      expect(res.body.lastError).toContain("Native handler for xiaomi");
      expect(prisma.provider.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "prov-xiaomi-001" },
        data: expect.objectContaining({ lastError: expect.stringContaining("Native handler") }),
      }));
    });

    it("returns 404 for unknown preset UUID on install", async () => {
      (prisma.providerPreset.findUnique as jest.Mock).mockResolvedValue(null);
      const res = await request(app)
        .post("/api/provider-presets/550e8400-e29b-41d4-a716-446655440099/install")
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Provider preset not found");
    });
  });
});