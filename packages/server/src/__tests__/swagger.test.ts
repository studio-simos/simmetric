// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Swagger / API documentation endpoint tests
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
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

import request from "supertest";
import { createApp } from "../index";

const app = createApp();

describe("Swagger API Documentation", () => {
  it("GET /api-docs/json returns a valid OpenAPI spec", async () => {
    const res = await request(app).get("/api-docs/json");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("openapi", "3.0.0");
    expect(res.body).toHaveProperty("info");
    expect(res.body.info).toHaveProperty("title", "Simmetric Chat API");
    expect(res.body.info).toHaveProperty("version", "1.0.0");
  });

  it("OpenAPI spec contains security schemes", async () => {
    const res = await request(app).get("/api-docs/json");

    expect(res.body.components).toHaveProperty("securitySchemes");
    expect(res.body.components.securitySchemes).toHaveProperty("bearerAuth");
    expect(res.body.components.securitySchemes).toHaveProperty("apiKeyAuth");
  });

  it("OpenAPI spec contains documented paths", async () => {
    const res = await request(app).get("/api-docs/json");

    expect(res.body).toHaveProperty("paths");
    const paths = Object.keys(res.body.paths);
    expect(paths.length).toBeGreaterThan(0);
  });

  it("OpenAPI spec documents SSE streaming endpoint", async () => {
    const res = await request(app).get("/api-docs/json");

    const streamPath = res.body.paths["/workspaces/{workspaceId}/chat/stream"];
    expect(streamPath).toBeDefined();
    expect(streamPath.post).toBeDefined();

    const desc = streamPath.post.description || "";
    expect(desc).toContain("token");
    expect(desc).toContain("status");
    expect(desc).toContain("citations");
    expect(desc).toContain("done");
    expect(desc).toContain("error");
  });

  it("GET /api-docs serves swagger-ui HTML", async () => {
    const res = await request(app).get("/api-docs/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});