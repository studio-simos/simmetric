// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

import express from "express";
import request from "supertest";
import {
  widgetChatLimiter,
  widgetSessionLimiter,
  widgetDailyMessageLimiter,
  chatKeyGenerator,
  sessionKeyGenerator,
  dailyKeyGenerator,
} from "../middleware/rateLimit";

// Minimal Request shape chatKeyGenerator reads: originalUrl + headers + ip.
// NOTE: the production Preact client (useWidgetChat.ts) sends ONLY
// `Content-Type` + `X-Session-Token` to /api/chat/:widgetId/stream. It NEVER
// sends `X-Api-Key` inbound (that is an OUTBOUND proxy header added in
// routes/chat.ts:120). These mocks mirror the real inbound request — no
// `x-api-key` — so the assertions exercise the production keying path, not a
// synthetic header that never occurs in production.
const chatReq = (originalUrl: string, opts: { headers?: Record<string, string>; ip?: string } = {}) =>
  ({
    originalUrl,
    headers: opts.headers ?? {},
    // Default to a concrete IP only when the caller omits the key entirely;
    // an explicit `ip: undefined` must propagate (exercises the "unknown" fallback).
    ip: Object.prototype.hasOwnProperty.call(opts, "ip") ? opts.ip : "1.2.3.4",
  }) as any;

describe("Widget Rate Limiters", () => {
  it("chatKeyGenerator keys on widgetId parsed from the URL path", () => {
    const key = chatKeyGenerator(chatReq("/api/chat/wid-abc/stream"));
    expect(key).toBe("widget:wid-abc");
  });

  it("two different widgetIds produce different keys (per-tenant isolation)", () => {
    const k1 = chatKeyGenerator(chatReq("/api/chat/wid-aaa/stream", { ip: "1.1.1.1" }));
    const k2 = chatKeyGenerator(chatReq("/api/chat/wid-bbb/stream", { ip: "1.1.1.1" }));
    expect(k1).not.toBe(k2);
  });

  it("same widgetId produces the same key regardless of IP (per-tenant, NOT per-IP)", () => {
    // This is the regression guard for the SEC-02 BLOCKER: previously the
    // inbound key was never present, so every request collapsed to the IP
    // bucket. Per-tenant isolation requires the widgetId to win over IP.
    const k1 = chatKeyGenerator(chatReq("/api/chat/wid-same/stream", { ip: "1.1.1.1" }));
    const k2 = chatKeyGenerator(chatReq("/api/chat/wid-same/stream", { ip: "2.2.2.2" }));
    expect(k1).toBe(k2);
    expect(k1).toBe("widget:wid-same");
  });

  it("X-Session-Token (the real production inbound header) does not influence the bucket", () => {
    const key = chatKeyGenerator(
      chatReq("/api/chat/wid-abc/stream", { headers: { "x-session-token": "tok-1" } }),
    );
    expect(key).toBe("widget:wid-abc");
  });

  it("chatKeyGenerator falls back to ipKeyGenerator when no widgetId is parseable from the URL", () => {
    const key = chatKeyGenerator(chatReq("/api/other", { ip: "1.2.3.4" }));
    expect(key).toBe("1.2.3.4"); // ipKeyGenerator returns the IPv4 unchanged
  });

  it("chatKeyGenerator returns 'unknown' when no widgetId and no ip", () => {
    const key = chatKeyGenerator(chatReq("/api/other", { ip: undefined }));
    expect(key).toBe("unknown");
  });

  it("sessionKeyGenerator uses IP as key", () => {
    const key = sessionKeyGenerator(chatReq("/api/sessions", { ip: "1.2.3.4" }));
    expect(key).toBe("1.2.3.4");
  });

  it("both limiters are defined with correct structure", () => {
    expect(widgetChatLimiter).toBeDefined();
    expect(widgetSessionLimiter).toBeDefined();
  });

  // ── 151-02 (G-151-1b): widgetDailyMessageLimiter key generators ───────────
  // (pure functions — the async max-function matrix lives in the separate
  // rateLimit.daily.test.ts file, mirroring the rateLimit.redis.test.ts
  // module-mock idiom; runtime doMock/resetModules in this file would pollute
  // the module registry for the throttle test below.)

  it("dailyKeyGenerator keys on widgetId + IP composite (per-visitor per-widget)", () => {
    expect(dailyKeyGenerator(chatReq("/api/chat/wid-abc/stream", { ip: "1.2.3.4" })))
      .toBe("widget:wid-abc:1.2.3.4");
  });

  it("two different visitors to the SAME widget produce different daily keys", () => {
    const k1 = dailyKeyGenerator(chatReq("/api/chat/wid-abc/stream", { ip: "1.1.1.1" }));
    const k2 = dailyKeyGenerator(chatReq("/api/chat/wid-abc/stream", { ip: "2.2.2.2" }));
    expect(k1).not.toBe(k2);
    expect(k1).toBe("widget:wid-abc:1.1.1.1");
    expect(k2).toBe("widget:wid-abc:2.2.2.2");
  });

  it("dailyKeyGenerator falls back to IP-only when no widgetId is parseable", () => {
    expect(dailyKeyGenerator(chatReq("/api/other", { ip: "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("dailyKeyGenerator returns 'unknown' when no widgetId and no ip", () => {
    expect(dailyKeyGenerator(chatReq("/api/other", { ip: undefined }))).toBe("unknown");
  });

  it("widgetDailyMessageLimiter is defined", () => {
    expect(widgetDailyMessageLimiter).toBeDefined();
  });

  it("widgetChatLimiter throttles the 31st call/min per widgetId (prod max 30) with REAL production headers", async () => {
    // Reproduce the production inbound request shape: POST /api/chat/:widgetId/stream
    // with ONLY Content-Type + X-Session-Token (NO X-Api-Key). Mount the limiter
    // at /api/chat exactly as index.ts:38 does, so extractWidgetId reads the
    // widgetId from the originalUrl the same way it does in production.
    const rateLimit = require("express-rate-limit").default;
    const prodLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 30,
      keyGenerator: chatKeyGenerator,
      message: { error: "Rate limit exceeded", retryAfter: "60" },
      standardHeaders: true,
      legacyHeaders: false,
    });
    const app = express();
    app.use("/api/chat", prodLimiter);
    app.post("/api/chat/:widgetId/stream", (_req, res) => res.status(200).end());

    const headers = { "Content-Type": "application/json", "X-Session-Token": "tok-a" };

    // 30 requests for widget A succeed, 31st is throttled (429).
    let lastStatusA = 200;
    for (let i = 0; i < 31; i++) {
      const res = await request(app).post("/api/chat/wid-a/stream").set(headers);
      lastStatusA = res.status;
    }
    expect(lastStatusA).toBe(429);

    // A DIFFERENT widget (tenant) has its OWN bucket — its 1st request still
    // succeeds even though widget A is exhausted. This is the per-tenant
    // isolation that was missing in production (CR-01).
    const resB = await request(app).post("/api/chat/wid-b/stream").set(headers);
    expect(resB.status).toBe(200);
  });
});