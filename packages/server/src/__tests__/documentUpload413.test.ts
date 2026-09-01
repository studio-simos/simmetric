// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    withSoftDelete: (where: any) => where,
  };
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
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn(() => ({ value: "Xenova/all-MiniLM-L6-v2" })),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

// Mock multer to simulate LIMIT_FILE_SIZE error (T-61-04)
jest.mock("multer", () => {
  const multerErrorFn = function (this: any, message: string, code?: string, field?: string) {
    this.message = message;
    this.code = code;
    this.field = field;
    this.name = "MulterError";
  } as any;
  const mockUpload = {
    single: jest.fn(() => (req: any, res: any, next: any) => {
      // Simulate LIMIT_FILE_SIZE error
      const err = new (multerErrorFn as any)("File too large", "LIMIT_FILE_SIZE", "file");
      next(err);
    }),
    array: jest.fn(() => (req: any, res: any, next: any) => next()),
    fields: jest.fn(() => (req: any, res: any, next: any) => next()),
    none: jest.fn(() => (req: any, res: any, next: any) => next()),
  };
  const multerFn: any = () => mockUpload;
  multerFn.diskStorage = () => ({});
  multerFn.memoryStorage = () => ({});
  multerFn.MulterError = multerErrorFn;
  return { __esModule: true, default: multerFn, MulterError: multerErrorFn };
});

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken, regularUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    if (args?.where?.id === regularUser.id) return Promise.resolve(regularUser);
    return Promise.resolve(null);
  });
});

describe("POST /api/documents/upload — 413 handler (T-61-04)", () => {
  it("returns 413 on LIMIT_FILE_SIZE with { error: 'File too large' }", async () => {
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("workspaceId", "ws-1");

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/file too large/i);
  });

  it("returns 400 on other multer errors (non-LIMIT_FILE_SIZE)", async () => {
    // Override multer mock for this test to throw a different error code
    const multerMock = require("multer");
    const originalSingle = multerMock.default().single;
    multerMock.default().single = jest.fn(() => (req: any, res: any, next: any) => {
      const err = new (multerMock.MulterError as any)("Unexpected field", "LIMIT_UNEXPECTED_FILE", "file");
      next(err);
    });

    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("workspaceId", "ws-1");

    expect(res.status).toBe(400);

    // Restore original mock
    multerMock.default().single = originalSingle;
  });
});