// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

jest.mock("../services/widgetApi", () => ({
  createSession: jest.fn(),
  getWidgetConfig: jest.fn(),
  validateSession: jest.fn(),
  incrementSessionCounters: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../index";
import { createSession, getWidgetConfig } from "../services/widgetApi";

const mockedCreateSession = createSession as jest.Mock;
const mockedGetWidgetConfig = getWidgetConfig as jest.Mock;

const app = createApp();

describe("POST /api/sessions", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("returns 400 without widgetId", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({});
    expect(res.status).toBe(400);
  });

  it("creates session and returns sessionToken + expiresAt", async () => {
    mockedCreateSession.mockResolvedValue({
      sessionToken: "st-abc123",
      expiresAt: "2026-04-19T23:59:59Z",
    });

    const res = await request(app)
      .post("/api/sessions")
      .send({ widgetId: "widget-1" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("sessionToken", "st-abc123");
    expect(res.body).toHaveProperty("expiresAt");
    expect(mockedCreateSession).toHaveBeenCalledWith("widget-1", expect.any(String));
  });

  it("returns 404 if widget not found", async () => {
    const err = new Error("Not found");
    (err as any).response = { status: 404 };
    mockedCreateSession.mockRejectedValue(err);

    const res = await request(app)
      .post("/api/sessions")
      .send({ widgetId: "nonexistent" });

    expect(res.status).toBe(404);
  });

  // 151-02 (Task 7): upstream 402 = widget disabled by license (Community) —
  // the widget service must NOT crash; surface 503 { error: "Widget disabled" }.
  it("returns 503 'Widget disabled' when the server 402s (license-gated)", async () => {
    const err = new Error("This feature requires an Enterprise license");
    (err as any).response = { status: 402, data: { error: "This feature requires an Enterprise license", feature: "widget_enabled", tier: "community" } };
    mockedCreateSession.mockRejectedValue(err);

    const res = await request(app)
      .post("/api/sessions")
      .send({ widgetId: "widget-1" });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Widget disabled" });
  });
});

describe("GET /api/config/:widgetId", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("returns widget config", async () => {
    mockedGetWidgetConfig.mockResolvedValue({
      id: "widget-1",
      name: "My Widget",
      position: "bottom-right",
      primaryColor: "#4c6ef5",
      welcomeMessage: "Hello!",
      isActive: true,
      workspaceId: "ws-1",
      locale: "en",
    });

    const res = await request(app).get("/api/config/widget-1");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "widget-1");
    expect(res.body).toHaveProperty("name", "My Widget");
  });

  it("returns 404 for unknown widget", async () => {
    const err = new Error("Not found");
    (err as any).response = { status: 404 };
    mockedGetWidgetConfig.mockRejectedValue(err);

    const res = await request(app).get("/api/config/unknown-widget");

    expect(res.status).toBe(404);
  });

  // 151-02 (Task 7): upstream 402 = widget disabled by license (Community).
  // The widget service must surface it gracefully — 503 { error: "Widget
  // disabled" }, never a 500 crash path. Fresh widgetId: the config route's
  // module-level in-memory cache persists across tests in this file.
  it("returns 503 'Widget disabled' when the server 402s (license-gated)", async () => {
    const err = new Error("This feature requires an Enterprise license");
    (err as any).response = { status: 402, data: { error: "This feature requires an Enterprise license", feature: "widget_enabled", tier: "community" } };
    mockedGetWidgetConfig.mockRejectedValue(err);

    const res = await request(app).get("/api/config/widget-disabled-402");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Widget disabled" });
  });
});

describe("POST /api/config/:widgetId/cache-bust (WID-04)", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("deletes the cache entry so the next GET re-fetches from server", async () => {
    // Use a fresh widgetId so prior tests' cached entries don't mask the
    // getWidgetConfig call (configCache is module-level; clearAllMocks does
    // not clear it).
    const widgetId = "widget-bust-fresh";
    // First GET primes the cache (calls getWidgetConfig once).
    mockedGetWidgetConfig.mockResolvedValue({
      id: widgetId,
      name: "Cached Widget",
      position: "bottom-right",
      primaryColor: "#4c6ef5",
      welcomeMessage: "Hi!",
      isActive: true,
      workspaceId: "ws-1",
      locale: "en",
    });

    const firstGet = await request(app).get(`/api/config/${widgetId}`);
    expect(firstGet.status).toBe(200);
    expect(mockedGetWidgetConfig).toHaveBeenCalledTimes(1);

    // POST cache-bust with the correct X-Api-Key (matches setupEnv WIDGET_API_KEY).
    const bust = await request(app)
      .post(`/api/config/${widgetId}/cache-bust`)
      .set("x-api-key", "sk-test-widget-key");

    expect(bust.status).toBe(200);
    expect(bust.body).toEqual({ busted: true, widgetId });

    // Second GET must re-fetch (cache was busted) → getWidgetConfig called again.
    mockedGetWidgetConfig.mockResolvedValue({
      id: widgetId,
      name: "Refreshed Widget",
      position: "bottom-right",
      primaryColor: "#000000",
      welcomeMessage: "Hi!",
      isActive: true,
      workspaceId: "ws-1",
      locale: "en",
    });

    const secondGet = await request(app).get(`/api/config/${widgetId}`);
    expect(secondGet.status).toBe(200);
    expect(secondGet.body.name).toBe("Refreshed Widget");
    expect(mockedGetWidgetConfig).toHaveBeenCalledTimes(2);
  });

  it("returns 401 when X-Api-Key is missing or mismatched", async () => {
    const res = await request(app)
      .post("/api/config/widget-1/cache-bust")
      .set("x-api-key", "wrong-key");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  // G-3 (T-DRD-03): pins the length-guard branch of the timing-safe helper —
  // crypto.timingSafeEqual throws on length mismatch, so the guard is
  // load-bearing. A same-length wrong key and a different-length wrong key
  // must BOTH 401 with the same shape.
  it("returns 401 when X-Api-Key has a different length than WIDGET_API_KEY", async () => {
    // setupEnv pins WIDGET_API_KEY="sk-test-widget-key" (18 chars) — use a
    // wrong key of a different length (and a prefix that matches, so a
    // naive byte-by-byte compare would also walk several equal bytes).
    const res = await request(app)
      .post("/api/config/widget-1/cache-bust")
      .set("x-api-key", "sk-test-widget-key-with-extra-bytes");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it("is idempotent — returns 200 even if the entry is absent", async () => {
    const res = await request(app)
      .post("/api/config/never-cached-widget/cache-bust")
      .set("x-api-key", "sk-test-widget-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ busted: true, widgetId: "never-cached-widget" });
  });
});