// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 200 (200-01 Task 1, P1 pin / T-200-01b) — the path-filtered
 * raw-body parser wrapper: the production parse order (wrapper → global
 * 100mb parser → webhook router) pinned by supertest. Postgres-free
 * (prisma mocked at the route boundary — the suite exercises the MIDDLEWARE
 * chain, not the DB gates).
 *
 * Research P1: a route-scoped express.json({verify}) parser is DEAD CODE in
 * production (body-parser 2.3.0 short-circuits via onFinished.isFinished
 * when the global parser already consumed the stream) — this suite assembles
 * the app in the REAL production order so a regression back to the
 * dead-code shape fails here.
 */
// @ts-nocheck
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  (mock.prisma as Record<string, unknown>).chatConnector = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
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
jest.mock("../services/connectors/messageRouter", () => ({
  handleIncomingMessage: jest.fn(async () => undefined),
}));

import request from "supertest";
import express from "express";
import crypto from "crypto";
import { connectorsWebhookRouter } from "../routes/connectors";
import prisma from "../utils/prisma";
import { encrypt } from "../services/encryptionService";

const SIGNING_SECRET = "unit-test-signing-secret-00000000000000ff";

/**
 * The supertest app assembled in the REAL production order (index.ts):
 * wrapper (path-filtered raw-body parser) → global 100mb parser →
 * cookieParser → apiRateLimiter (omitted in unit) → webhook mini-router.
 * A bare-app assembly (router-only) would re-create the dead-code path the
 * research P1 probe disproved.
 */
function buildProductionOrderApp(): express.Express {
  const app = express();
  // Wrapper (index.ts — the P1 shape).
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/connectors/") && req.path.endsWith("/webhook")) {
      return express.json({
        limit: "256kb",
        verify: (rq: express.Request, _r: express.Response, buf: Buffer) => {
          (rq as express.Request & { rawBody?: Buffer }).rawBody = buf;
        },
      })(req, res, next);
    }
    next();
  });
  app.use(express.json({ limit: "100mb" })); // the global parser AFTER the wrapper
  app.use("/api/connectors", connectorsWebhookRouter);
  return app;
}

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440077";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440078";

function signedHeaders(secret: string, body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return {
    "X-Slack-Signature": sig,
    "X-Slack-Request-Timestamp": ts,
    "Content-Type": "application/json",
  };
}

const app = buildProductionOrderApp();

beforeEach(() => {
  jest.clearAllMocks();
});

describe("path-filtered raw-body parser (P1 — production parse order)", () => {
  it("captures rawBody for a signed slack webhook and reaches the signature gate (200 ACK on a valid DM)", async () => {
    const row = {
      id: CONNECTOR_ID,
      organizationId: "org-200",
      platform: "slack",
      workspaceId: WORKSPACE_ID,
      isEnabled: true,
      deletedAt: null,
      configEncrypted: encrypt(JSON.stringify({ signingSecret: SIGNING_SECRET })),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(row);
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-200",
      deletedAt: null,
    });
    (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});

    const envelope = {
      type: "event_callback",
      event_id: "EvPARSE1",
      event: { type: "message", channel_type: "im", channel: "D1", user: "U1", text: "hi" },
    };
    const body = JSON.stringify(envelope);
    const res = await request(app)
      .post(`/api/connectors/slack/${CONNECTOR_ID}/webhook`)
      .set(signedHeaders(SIGNING_SECRET, body))
      .send(envelope);

    // The signature verified over the captured RAW bytes — the ACK fired.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("a tampered body fails the HMAC → 403 (rawBody is the pre-JSON bytes, so edits break the signature)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue({
      id: CONNECTOR_ID,
      organizationId: "org-200",
      platform: "slack",
      workspaceId: WORKSPACE_ID,
      isEnabled: true,
      deletedAt: null,
      configEncrypted: encrypt(JSON.stringify({ signingSecret: SIGNING_SECRET })),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const envelope = {
      type: "event_callback",
      event_id: "EvTAMPER",
      event: { type: "message", channel_type: "im", channel: "D1", user: "U1", text: "hi" },
    };
    const body = JSON.stringify(envelope);
    const headers = signedHeaders(SIGNING_SECRET, body);
    // Sign a DIFFERENT body than the one sent — the recomputed HMAC over the
    // captured raw bytes must mismatch.
    const tamperedEnvelope = { ...envelope, event: { ...envelope.event, text: "tampered" } };

    const res = await request(app)
      .post(`/api/connectors/slack/${CONNECTOR_ID}/webhook`)
      .set(headers)
      .send(tamperedEnvelope);

    expect(res.status).toBe(403);
  });

  it("a 300kb webhook body → 413 at the path-filtered parser (WR-07 restored — the limit is REAL in production order)", async () => {
    const big = { type: "event_callback", event: { type: "message", channel_type: "im", text: "x".repeat(300 * 1024) } };

    const res = await request(app)
      .post(`/api/connectors/slack/${CONNECTOR_ID}/webhook`)
      .set(signedHeaders(SIGNING_SECRET, JSON.stringify(big)))
      .send(big);

    expect(res.status).toBe(413);
    // Pre-gates: the oversized body never reached the DB row resolve.
    expect(prisma.chatConnector.findUnique).not.toHaveBeenCalled();
  });

  it("a NON-webhook path is NOT rawBody-captured and the global limit applies (wrapper scope pin)", async () => {
    let captured = false;
    const probe = express();
    probe.use((req, res, next) => {
      if (req.path.startsWith("/api/connectors/") && req.path.endsWith("/webhook")) {
        return express.json({
          limit: "256kb",
          verify: (rq: express.Request, _r: express.Response, buf: Buffer) => {
            (rq as express.Request & { rawBody?: Buffer }).rawBody = buf;
          },
        })(req, res, next);
      }
      next();
    });
    probe.use(express.json({ limit: "100mb" }));
    probe.post("/api/other/route", (req: express.Request & { rawBody?: Buffer }, res) => {
      captured = req.rawBody !== undefined;
      res.json({ captured });
    });

    const res = await request(probe).post("/api/other/route").send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.body.captured).toBe(false);
  });

  it("the telegram path inherits the wrapper without behavior change (200 ACK on a valid secret-gated update)", async () => {
    const TG_SECRET = "k7Q2mW9xLp4vT8zR3nB6yH1cD5fG0jS2aE9uX4qM8i";
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue({
      id: CONNECTOR_ID,
      organizationId: "org-200",
      platform: "telegram",
      workspaceId: WORKSPACE_ID,
      isEnabled: true,
      deletedAt: null,
      pollMode: "webhook",
      configEncrypted: encrypt(JSON.stringify({ webhookSecret: TG_SECRET })),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-200",
      deletedAt: null,
    });
    (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", TG_SECRET)
      .send({ update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, text: "hi" } });

    // The wrapper parsed the body BEFORE the global parser; the route's own
    // webhookJson short-circuits harmlessly ("body already parsed") and the
    // telegram gate chain behaves byte-identically.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("the telegram path still rejects a wrong secret under the wrapper (403 — behavior unchanged)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue({
      id: CONNECTOR_ID,
      organizationId: "org-200",
      platform: "telegram",
      workspaceId: WORKSPACE_ID,
      isEnabled: true,
      deletedAt: null,
      pollMode: "webhook",
      configEncrypted: encrypt(JSON.stringify({ webhookSecret: "k7Q2mW9xLp4vT8zR3nB6yH1cD5fG0jS2aE9uX4qM8i" })),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", "wrong-secret-value-wrong-secret-value-wrong-s")
      .send({ update_id: 2, message: { message_id: 2 } });

    expect(res.status).toBe(403);
  });
});