// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

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
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken, adminUser, regularUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";

const app = createApp();

describe("GET /api/system/settings", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/system/settings");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(regularUser);
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns settings array for admin user", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([
      { key: "LLM_PROVIDER", value: "ollama" },
      { key: "LLM_MODEL", value: "gemma4:latest" },
    ]);

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("key");
    expect(res.body[0]).toHaveProperty("value");
    expect(res.body[0]).toHaveProperty("readOnly");
  });

  it("returns 500 when Prisma query fails", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockRejectedValue(new Error("DB connection lost"));

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});

describe("PUT /api/system/settings", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).put("/api/system/settings").send({});
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid body", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: "not-an-array" });

    expect(res.status).toBe(400);
  });

  it("updates settings and returns updated/rejected lists", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.upsert as jest.Mock).mockResolvedValue({});

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "LLM_PROVIDER", value: "openai" }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("updated");
    expect(res.body).toHaveProperty("rejected");
  });
});