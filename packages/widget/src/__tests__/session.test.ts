// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

jest.mock("../services/widgetApi", () => ({
  validateSession: jest.fn(),
  getWidgetConfig: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../index";
import { validateSession, getWidgetConfig } from "../services/widgetApi";

const mockedValidateSession = validateSession as jest.Mock;
const mockedGetWidgetConfig = getWidgetConfig as jest.Mock;

const app = createApp();

describe("Widget Session Middleware", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("returns 401 without X-Session-Token header", async () => {
    const { sessionMiddleware } = require("../middleware/session");
    const mockReq = { headers: {} } as any;
    const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const mockNext = jest.fn();

    await sessionMiddleware(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it("returns 401 when session validation fails with 401", async () => {
    const { sessionMiddleware } = require("../middleware/session");
    const mockReq = { headers: { "x-session-token": "invalid-token" } } as any;
    const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const mockNext = jest.fn();

    const err = new Error("Unauthorized");
    (err as any).response = { status: 401 };
    mockedValidateSession.mockRejectedValue(err);

    await sessionMiddleware(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it("passes through with valid session and attaches widgetSession + widgetConfig", async () => {
    const { sessionMiddleware } = require("../middleware/session");
    const mockReq = { headers: { "x-session-token": "valid-token" } } as any;
    const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const mockNext = jest.fn();

    mockedValidateSession.mockResolvedValue({ widgetId: "w-1", messageCount: 5 });
    mockedGetWidgetConfig.mockResolvedValue({ id: "w-1", name: "Test", workspaceId: "ws-1" });

    await sessionMiddleware(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockReq.widgetSession).toBeDefined();
    expect(mockReq.widgetConfig).toBeDefined();
  });
});

describe("Widget Health Check", () => {
  it("returns 200 with ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});