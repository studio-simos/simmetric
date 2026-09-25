// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-01b Task 2) — connector secret-handling pins:
 * AES-256-GCM roundtrips, D-14 secret shape, and the T-198-03 backstop
 * (webhook-setup responses carry hasWebhookSecret, never the value).
 * Postgres-free — the crypto surface is pure.
 */
// @ts-nocheck
import "./helpers/setupEnv";

import { encrypt, decrypt } from "../services/encryptionService";

const BOT_TOKEN = "123456789:AAExampleTokenForUnitTests_abcdefghijk";

describe("botToken encryption roundtrip", () => {
  it("encrypt(botToken) → decrypt returns the original token", () => {
    const blob = encrypt(BOT_TOKEN);
    expect(blob).not.toContain(BOT_TOKEN);
    expect(blob.split(":")).toHaveLength(3); // iv:authTag:ciphertext
    expect(decrypt(blob)).toBe(BOT_TOKEN);
  });
});

describe("configEncrypted blob roundtrip", () => {
  it("encrypt(JSON.stringify({webhookSecret})) → decrypt → parse returns the config", () => {
    const config = { webhookSecret: "k7Q2mW9xLp4vT8zR3nB6yH1cD5fG0jS2aE9uX4qM8i" };
    const blob = encrypt(JSON.stringify(config));
    expect(blob).not.toContain("webhookSecret");
    const parsed = JSON.parse(decrypt(blob)) as { webhookSecret: string };
    expect(parsed.webhookSecret).toBe(config.webhookSecret);
  });
});

describe("D-14 webhook secret shape", () => {
  it("crypto.randomBytes(36).base64url is 48 chars in [A-Za-z0-9_-]", () => {
    const crypto = require("crypto") as typeof import("crypto");
    const secret = crypto.randomBytes(36).toString("base64url");
    expect(secret).toHaveLength(48);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    // Uniqueness sanity (probabilistic — 288 bits of entropy).
    expect(crypto.randomBytes(36).toString("base64url")).not.toBe(secret);
  });
});

describe("webhook-setup response discipline (T-198-03 backstop)", () => {
  it("responses carry hasWebhookSecret: true and NO secret value", async () => {
    jest.resetModules();

    jest.mock("../utils/prisma", () => {
      const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
      const mock = createMockPrisma();
      const existing = {
        id: "550e8400-e29b-41d4-a716-446655440011",
        organizationId: "org-default",
        platform: "telegram",
        workspaceId: "550e8400-e29b-41d4-a716-446655440010",
        isEnabled: true,
        deletedAt: null,
        pollMode: "polling",
        configEncrypted: null,
      };
      (mock.prisma as Record<string, unknown>).chatConnector = {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn(async ({ data }) => ({ ...existing, ...data })),
      };
      return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
    });

    jest.mock("../config/env", () => ({
      getEnv: jest.fn(() => ({ JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch", NODE_ENV: "test", SERVER_PORT: 3000 })),
    }));
    jest.mock("../services/licenseService", () => ({
      initLicense: jest.fn(() => ({})),
      getLicenseInfo: jest.fn(() => ({})),
      isFeatureEnabled: jest.fn(() => false),
      getFeatureLimit: jest.fn(() => 1),
    }));
    jest.mock("../agent/builtinSkills", () => {});
    jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
    jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
    jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
    jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
    jest.mock("../middleware/auth", () => ({
      authMiddleware: (req: { userId: string; organizationId: string; user: unknown }, _res: unknown, next: () => void) => {
        req.userId = "admin-001";
        req.organizationId = "org-default";
        req.user = { id: req.userId, roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }] } }] };
        next();
      },
      apiKeyMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    jest.mock("../middleware/tenantContext", () => ({
      tenantContextMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
    }));

    const request = (await import("supertest")).default;
    const express = (await import("express")).default;
    const { connectorsRoutes } = await import("../routes/connectors");
    const prismaMod = (await import("../utils/prisma")) as { default: Record<string, { update: { mock: { calls: unknown[] } } }> };
    const prisma = prismaMod.default;

    const app = express();
    app.use(express.json());
    app.use("/api/connectors", connectorsRoutes);

    const res = await request(app)
      .post("/api/connectors/550e8400-e29b-41d4-a716-446655440011/webhook-setup")
      .send({ url: "https://example.com/api/connectors/telegram/x/webhook" });

    expect(res.status).toBe(200);
    expect(res.body.hasWebhookSecret).toBe(true);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('"webhookSecret":"');
    expect(bodyStr).not.toContain("configEncrypted");
    // The persisted blob is ciphertext — decrypting it yields the secret
    // inside config (proving the secret went to configEncrypted, D-14).
    const persisted = prisma.chatConnector.update.mock.calls[0][0].data.configEncrypted as string;
    const config = JSON.parse(decrypt(persisted)) as { webhookSecret: string };
    expect(config.webhookSecret).toHaveLength(48);
  });
});