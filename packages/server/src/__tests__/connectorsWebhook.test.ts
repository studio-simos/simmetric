// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-01b Task 2) — PUBLIC webhook route: the full D-06/P-3
 * fail-closed matrix. Postgres-free (prisma mocked).
 *
 * NOTE: the registry is NOT mocked here — the REAL
 * (services/connectors/registry.ts) Map is exercised directly: the 198-04
 * async-arm tests register a FAKE telegram adapter via registerAdapter()
 * (clearAdapters() in beforeEach) while the fail-closed matrix tests run
 * against an empty registry (no adapter registered — the pipeline's
 * fail-closed drop).
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

// 198-04 Task 1: the async-arm pins route through handleIncomingMessage —
// the ROUTER module is mocked (the pipeline internals are
// messageRouter.test.ts's own suite); the REAL registry stays live so the
// fake telegram adapter can be registered per-test (D-16 wiring contract).
jest.mock("../services/connectors/messageRouter", () => ({
  handleIncomingMessage: jest.fn(async () => undefined),
}));

import request from "supertest";
import express from "express";
import crypto from "crypto";
import { connectorsWebhookRouter } from "../routes/connectors";
import prisma from "../utils/prisma";
import { encrypt } from "../services/encryptionService";
import { handleIncomingMessage } from "../services/connectors/messageRouter";
import { registerAdapter, clearAdapters } from "../services/connectors/registry";
import type { PlatformAdapter } from "../services/connectors/base";

/**
 * Phase 200 (P1 consequence 4): the supertest app MUST assemble the
 * production parse order (path-filtered raw-body wrapper → global parser →
 * router mount) — a bare `app.use(express.json())` assembly would re-create
 * the dead-code path research P1 disproved and let the slack HMAC arm pass
 * against a body the wrapper never captured.
 */
const app = express();
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
app.use(express.json());
app.use("/api/connectors", connectorsWebhookRouter);

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440011";
const UNKNOWN_ID = "550e8400-e29b-41d4-a716-446655440099";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440010";
const SECRET = "k7Q2mW9xLp4vT8zR3nB6yH1cD5fG0jS2aE9uX4qM8i";

function rowWith(overrides: Record<string, unknown>) {
  return {
    id: CONNECTOR_ID,
    organizationId: "org-default",
    platform: "telegram",
    workspaceId: WORKSPACE_ID,
    isEnabled: true,
    deletedAt: null,
    pollMode: "webhook",
    configEncrypted: encrypt(JSON.stringify({ webhookSecret: SECRET })),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAdapters();
});

// ─── D-06/P-3 fail-closed matrix ─────────────────────────────────────

describe("POST /api/connectors/telegram/:connectorId/webhook", () => {
  it("unknown connectorId → 404 (any header, P-3)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/connectors/telegram/${UNKNOWN_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(404);
  });

  it("unknown connectorId with NO secret header → 404 (cannot verify a secret — 403 only for known, P-3)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/connectors/telegram/${UNKNOWN_ID}/webhook`)
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(404);
  });

  it("known connector + WRONG secret → 403 (the ONLY 403 arm, T-198-01)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", "wrong-secret-value-wrong-secret-value-wrong-s")
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(403);
  });

  it("known connector + NO secret header → 403 (known)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(403);
  });

  it("known connector, correct secret, isEnabled=false → 404 (indistinguishable from unknown)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({ isEnabled: false }));

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(404);
  });

  it("soft-deleted connector → 404 even with the correct secret (P-3)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(
      rowWith({ deletedAt: new Date() }),
    );

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(404);
  });

  it("enabled + correct secret → 200 ACK (async path stubbed; tenant slot stashed)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-default",
      deletedAt: null,
    });

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 1, message: { message_id: 1, text: "hello" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Tenant slot stashed BEFORE the ACK (WR-05) — asserted via the workspace
    // lookup the slot performs (DB-resolved, never body).
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: WORKSPACE_ID },
      select: { organizationId: true, deletedAt: true },
    });
  });

  it("malformed connectorId → 400 (pre-DB)", async () => {
    const res = await request(app)
      .post("/api/connectors/telegram/not-a-uuid/webhook")
      .send({ update_id: 1 });

    expect(res.status).toBe(400);
    expect(prisma.chatConnector.findUnique).not.toHaveBeenCalled();
  });

  it("edited_message update → 200 + no processing (D-18 parse-boundary guard)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-default",
      deletedAt: null,
    });

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 2, edited_message: { message_id: 1, text: "edit" } });

    expect(res.status).toBe(200);
  });

  it("channel_post + callback_query updates → 200 + skip (D-18)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-default",
      deletedAt: null,
    });

    const res1 = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 3, channel_post: { message_id: 1 } });
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 4, callback_query: { id: "cb1" } });
    expect(res2.status).toBe(200);
  });

  it("polling-mode connector (no webhook surface) → 404 even with the correct secret (D-14)", async () => {
    // A polling-mode row that still carries a stale secret would fail the
    // pollMode gate — but per D-14, the polling-mode 404 is fail-closed.
    // (webhook-setup flips pollMode to "webhook", so this arm guards drift.)
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(
      rowWith({ pollMode: "polling" }),
    );

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(404);
  });

  it("tombstoned workspace → fail-closed 404 (widget slot precedent)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(404);
  });

  it("DB resolution failure → fail-closed 404 (widget catch-arm precedent, WR-02)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockRejectedValue(new Error("db down"));

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 1, message: { message_id: 1 } });

    expect(res.status).toBe(404);
  });

  it("NO RBAC on the webhook route — no auth header needed (D-06: platform signature is the only auth)", async () => {
    // The route above never consulted Authorization — the enabled+secret 200
    // case already proves the JWT-free surface. This pin makes it explicit:
    // a request WITHOUT any Authorization header (but with the secret) hits
    // the same 200 arm.
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-default",
      deletedAt: null,
    });

    const res = await request(app)
      .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
      .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
      .send({ update_id: 5, message: { message_id: 2, text: "no-jwt" } });

    expect(res.status).toBe(200);
  });

  // ─── 198-04 Task 1: the async arm (D-16) ────────────────────────────

  /** Minimal fake adapter — only parseIncomingWebhook is consulted by the
   *  webhook async arm; the rest of the contract exists for the type. */
  function fakeTelegramAdapter(parseImpl: (u: unknown) => unknown) {
    return {
      parseIncomingWebhook: jest.fn(parseImpl),
      pollUpdates: jest.fn(async () => []),
      sendMessage: jest.fn(async () => ({ platformMessageId: "out-1" })),
      sendTypingIndicator: jest.fn(async () => undefined),
      validateBotToken: jest.fn(async () => ({ valid: true })),
      getBotInfo: jest.fn(async () => ({})),
      setWebhook: jest.fn(async () => undefined),
      removeWebhook: jest.fn(async () => undefined),
    } as unknown as PlatformAdapter;
  }

  /** Flush the route's setImmediate(...) async arm + microtask chain so the
   *  fire-and-forget pipeline work is observable deterministically. */
  async function flushAsyncArm(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }

  describe("async arm (198-04, D-16): parse → handleIncomingMessage + lastWebhookAt", () => {
    it("correct-secret private message → 200 ACK, then handleIncomingMessage invoked with the parsed IncomingMessage inside the tenant window", async () => {
      registerAdapter("telegram", fakeTelegramAdapter((update) => {
        const m = (update as { message?: { message_id: number; text: string; from?: { id: number }; chat?: { id: number } } }).message;
        if (!m || m.chat?.type !== "private") return null;
        return {
          platformMessageId: String(m.message_id),
          platformUserId: String(m.from?.id ?? m.chat?.id),
          text: m.text ?? null,
          chatType: "private" as const,
        };
      }));
      (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
      (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
        organizationId: "org-default",
        deletedAt: null,
      });
      (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 10,
          message: {
            message_id: 11,
            text: "hello pipeline",
            from: { id: 42, first_name: "Alice" },
            chat: { id: 42, type: "private" },
          },
        });

      // ACK 200 BEFORE the pipeline runs (D-16).
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      await flushAsyncArm();

      // The parsed message reached the D-16 pipeline.
      expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
      const [calledConnector, calledMsg] = (handleIncomingMessage as jest.Mock).mock.calls[0];
      expect(calledConnector.id).toBe(CONNECTOR_ID);
      expect(calledMsg).toMatchObject({
        platformMessageId: "11",
        platformUserId: "42",
        text: "hello pipeline",
        chatType: "private",
      });

      // lastWebhookAt stamped on acceptance (non-blocking update, D-01).
      expect(prisma.chatConnector.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONNECTOR_ID },
          data: expect.objectContaining({ lastWebhookAt: expect.any(Date) }),
        }),
      );
    });

    it("null parse (edited_message slips the type guard) → 200 and handleIncomingMessage NEVER called", async () => {
      // The route's updateType guard keys on the top-level key — an update
      // whose top-level key IS message but whose payload the adapter rejects
      // (e.g. a group chat) exercises the adapter-boundary drop (D-18).
      registerAdapter("telegram", fakeTelegramAdapter(() => null));
      (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
      (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
        organizationId: "org-default",
        deletedAt: null,
      });
      (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 11,
          message: { message_id: 12, text: "group chatter", chat: { id: -100, type: "group" } },
        });

      expect(res.status).toBe(200);
      await flushAsyncArm();
      expect(handleIncomingMessage).not.toHaveBeenCalled();
    });

    it("lastWebhookAt stamp failure does not fail the ACK or the pipeline (swallowed, analytics-only)", async () => {
      registerAdapter("telegram", fakeTelegramAdapter((update) => {
        const m = (update as { message?: { message_id: number; text: string; from?: { id: number }; chat?: { type: string } } }).message;
        if (!m || m.chat?.type !== "private") return null;
        return {
          platformMessageId: String(m.message_id),
          platformUserId: String(m.from?.id ?? 1),
          text: m.text ?? null,
          chatType: "private" as const,
        };
      }));
      (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
      (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
        organizationId: "org-default",
        deletedAt: null,
      });
      (prisma.chatConnector.update as jest.Mock).mockRejectedValue(new Error("stamp write failed"));

      const res = await request(app)
        .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 12,
          message: { message_id: 13, text: "stamp-fail", from: { id: 7 }, chat: { id: 7, type: "private" } },
        });

      expect(res.status).toBe(200);
      await flushAsyncArm();
      // The pipeline STILL ran — the stamp is analytics-only.
      expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    });

    it("pipeline rejection is caught by the async arm's logging catch (no unhandled rejection)", async () => {
      registerAdapter("telegram", fakeTelegramAdapter((update) => {
        const m = (update as { message?: { message_id: number; chat?: { type: string } } }).message;
        if (!m || m.chat?.type !== "private") return null;
        return { platformMessageId: String(m.message_id), platformUserId: "9", text: "boom", chatType: "private" as const };
      }));
      (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(rowWith({}));
      (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
        organizationId: "org-default",
        deletedAt: null,
      });
      (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});
      (handleIncomingMessage as jest.Mock).mockRejectedValueOnce(new Error("pipeline exploded"));

      const res = await request(app)
        .post(`/api/connectors/telegram/${CONNECTOR_ID}/webhook`)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 13,
          message: { message_id: 14, text: "boom", from: { id: 9 }, chat: { id: 9, type: "private" } },
        });

      // The ACK was already sent — a pipeline failure must not retro-fail it.
      expect(res.status).toBe(200);
      await flushAsyncArm();
      expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Phase 200 (200-01, D-03): the Slack webhook route gate matrix ────

const SLACK_ID = "550e8400-e29b-41d4-a716-446655440021";
const SLACK_WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440022";
const SLACK_SIGNING_SECRET = "unit-test-signing-secret-00000000000000ff";

/** Sign the given body the way Slack does (v0:ts:body). */
function slackSignatureHeaders(secret: string, body: string, tsOffsetSeconds = 0): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000) + tsOffsetSeconds);
  const sig = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return { "X-Slack-Signature": sig, "X-Slack-Request-Timestamp": ts };
}

function slackRowWith(overrides: Record<string, unknown>) {
  return {
    id: SLACK_ID,
    organizationId: "org-default",
    platform: "slack",
    workspaceId: SLACK_WORKSPACE_ID,
    isEnabled: true,
    deletedAt: null,
    configEncrypted: encrypt(JSON.stringify({ signingSecret: SLACK_SIGNING_SECRET })),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("POST /api/connectors/slack/:connectorId/webhook (D-03 gate matrix)", () => {
  /** Flush the route's setImmediate(...) async arm + microtask chain (the
   *  telegram block's helper is describe-scoped — this block owns a copy). */
  async function flushAsyncArm(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }

  const dmEnvelope = {
    type: "event_callback",
    event_id: "EvWEBHOOK1",
    event: { type: "message", channel_type: "im", channel: "D1", user: "U1", text: "hi" },
  };
  const dmBody = JSON.stringify(dmEnvelope);

  it("bad UUID → 400 (pre-DB)", async () => {
    const res = await request(app)
      .post("/api/connectors/slack/not-a-uuid/webhook")
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, "{}"))
      .send({});

    expect(res.status).toBe(400);
    expect(prisma.chatConnector.findUnique).not.toHaveBeenCalled();
  });

  it("unknown connectorId → 404 pre-secret (P-3 indistinguishable)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/connectors/slack/${UNKNOWN_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody))
      .send(dmEnvelope);

    expect(res.status).toBe(404);
  });

  it("soft-deleted connector → 404 even with a valid signature (P-3)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({ deletedAt: new Date() }));

    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody))
      .send(dmEnvelope);

    expect(res.status).toBe(404);
  });

  it("known connector + tampered body (wrong HMAC) → 403", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({}));

    const tampered = { ...dmEnvelope, event: { ...dmEnvelope.event, text: "tampered" } };
    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody))
      .send(tampered);

    expect(res.status).toBe(403);
  });

  it("known connector + NO signature header → 403", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({}));

    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .send(dmEnvelope);

    expect(res.status).toBe(403);
  });

  it("connector with NO signingSecret in the blob → 403 (fail closed)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(
      slackRowWith({ configEncrypted: encrypt(JSON.stringify({ other: "field" })) })
    );

    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody))
      .send(dmEnvelope);

    expect(res.status).toBe(403);
  });

  it("stale timestamp (|now-ts|>300) → 403 even with a valid signature (anti-replay, D-03(e))", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({}));

    const headers = slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody, -400);
    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(headers)
      .send(dmEnvelope);

    expect(res.status).toBe(403);
  });

  it("disabled connector → 404 AFTER the secret gates (telegram (e) shape)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({ isEnabled: false }));

    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody))
      .send(dmEnvelope);

    expect(res.status).toBe(404);
  });

  it("correctly signed url_verification → 200 {challenge} echo SYNCHRONOUSLY (D-03(f), P3)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({}));

    const challengeEnvelope = {
      type: "url_verification",
      token: "deprecated",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    };
    const challengeBody = JSON.stringify(challengeEnvelope);
    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, challengeBody))
      .send(challengeEnvelope);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
    // The challenge arm answers INSIDE the request — the workspace slot
    // (tenant resolve) never runs for it, and the ACK shape is the
    // challenge object itself (not {ok:true}).
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("signed url_verification on an UNsigned route → 403 (the handshake IS signed too)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({}));

    const challengeEnvelope = { type: "url_verification", challenge: "abc" };
    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .send(challengeEnvelope);

    expect(res.status).toBe(403);
  });

  it("signed event_callback → 200 {ok:true} ACK, then the async arm parses via the registered slack adapter", async () => {
    registerAdapter("slack", {
      parseIncomingWebhook: jest.fn((envelope: unknown) => {
        const env = envelope as { event_id?: string; event?: { channel?: string; user?: string; text?: string } };
        if (env?.event?.channel_type_check) return null; // never — the shape below is exercised
        return {
          platformMessageId: env.event_id ?? null,
          platformUserId: env.event?.channel ?? "",
          platformUserName: env.event?.user,
          text: env.event?.text ?? null,
          chatType: "private" as const,
        };
      }),
      pollUpdates: jest.fn(async () => []),
      sendMessage: jest.fn(async () => ({})),
      sendTypingIndicator: jest.fn(async () => undefined),
      validateBotToken: jest.fn(async () => ({ valid: true })),
      getBotInfo: jest.fn(async () => ({})),
      setWebhook: jest.fn(async () => undefined),
      removeWebhook: jest.fn(async () => undefined),
    } as unknown as PlatformAdapter);
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-default",
      deletedAt: null,
    });
    (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody))
      .send(dmEnvelope);

    // ACK BEFORE the pipeline (D-03: 3s deadline).
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    await flushAsyncArm();

    // The parsed message reached the D-16 pipeline with the event_id-based
    // platformMessageId (D-04).
    expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    const [calledConnector, calledMsg] = (handleIncomingMessage as jest.Mock).mock.calls[0];
    expect(calledConnector.id).toBe(SLACK_ID);
    expect(calledMsg).toMatchObject({
      platformMessageId: "EvWEBHOOK1",
      platformUserId: "D1",
      text: "hi",
      chatType: "private",
    });

    // lastWebhookAt stamped on acceptance (non-blocking update, D-01).
    expect(prisma.chatConnector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SLACK_ID },
        data: expect.objectContaining({ lastWebhookAt: expect.any(Date) }),
      }),
    );
  });

  it("tombstoned workspace on a signed DM → fail-closed 404 (widget slot precedent)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(slackRowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody))
      .send(dmEnvelope);

    expect(res.status).toBe(404);
  });

  it("DB resolution failure → fail-closed 404 (outer catch, WR-02)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockRejectedValue(new Error("db down"));

    const res = await request(app)
      .post(`/api/connectors/slack/${SLACK_ID}/webhook`)
      .set(slackSignatureHeaders(SLACK_SIGNING_SECRET, dmBody))
      .send(dmEnvelope);

    expect(res.status).toBe(404);
  });
});

// ─── Phase 200 (200-02, D-07): the WhatsApp webhook route gate matrix ──

const WA_ID = "550e8400-e29b-41d4-a716-446655440031";
const WA_WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440032";
const WA_VERIFY_TOKEN = "unit-test-verify-token-0123456789abcdef";
const WA_APP_SECRET = "unit-test-app-secret-0000000000000000ff";

/** Sign the given body the way Meta does (X-Hub-Signature-256: sha256=<hex> over raw body). */
function waSignatureHeaders(secret: string, body: string): Record<string, string> {
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return { "X-Hub-Signature-256": sig };
}

function waRowWith(overrides: Record<string, unknown>) {
  return {
    id: WA_ID,
    organizationId: "org-default",
    platform: "whatsapp",
    workspaceId: WA_WORKSPACE_ID,
    isEnabled: true,
    deletedAt: null,
    configEncrypted: encrypt(JSON.stringify({ verifyToken: WA_VERIFY_TOKEN, appSecret: WA_APP_SECRET, phoneNumberId: "109876543210987" })),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

/** The inbound signed text-message body (shared by the POST tests). */
const waEnvelope = {
  object: "whatsapp_business_account",
  entry: [{
    changes: [{
      value: {
        contacts: [{ profile: { name: "Alice" }, wa_id: "491234567890" }],
        messages: [{ from: "491234567890", id: "wamid.WEBHOOK1", type: "text", text: { body: "hi" } }],
      },
    }],
  }],
};
const waBody = JSON.stringify(waEnvelope);

describe("GET+POST /api/connectors/whatsapp/:connectorId/webhook (D-07 gate matrix)", () => {
  /** Flush the route's setImmediate(...) async arm + microtask chain (the
   *  telegram block's helper is describe-scoped — this block owns a copy). */
  async function flushAsyncArm(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }

  it("bad UUID → 400 (pre-DB, GET arm)", async () => {
    const res = await request(app).get("/api/connectors/whatsapp/not-a-uuid/webhook");
    expect(res.status).toBe(400);
    expect(prisma.chatConnector.findUnique).not.toHaveBeenCalled();
  });

  it("bad UUID → 400 (pre-DB, POST arm)", async () => {
    const res = await request(app)
      .post("/api/connectors/whatsapp/not-a-uuid/webhook")
      .set(waSignatureHeaders(WA_APP_SECRET, "{}"))
      .send({});
    expect(res.status).toBe(400);
    expect(prisma.chatConnector.findUnique).not.toHaveBeenCalled();
  });

  it("unknown connectorId → 404 pre-secret (P-3 indistinguishable)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/connectors/whatsapp/${UNKNOWN_ID}/webhook`)
      .set(waSignatureHeaders(WA_APP_SECRET, waBody))
      .send(waEnvelope);

    expect(res.status).toBe(404);
  });

  it("GET handshake with the correct verify token → challenge echo 200 (D-07, parseInt echo)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));

    const res = await request(app)
      .get(`/api/connectors/whatsapp/${WA_ID}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WA_VERIFY_TOKEN)}&hub.challenge=1158201444`);

    expect(res.status).toBe(200);
    expect(res.text).toBe("1158201444");
  });

  it("GET handshake with a WRONG verify token → 404 (indistinguishable, D-07)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));

    const res = await request(app)
      .get(`/api/connectors/whatsapp/${WA_ID}/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=1158201444`);

    expect(res.status).toBe(404);
  });

  it("GET handshake with hub.mode ≠ subscribe → 404 even with a correct token (D-07)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));

    const res = await request(app)
      .get(`/api/connectors/whatsapp/${WA_ID}/webhook?hub.mode=denied&hub.verify_token=${encodeURIComponent(WA_VERIFY_TOKEN)}&hub.challenge=1158201444`);

    expect(res.status).toBe(404);
  });

  it("GET handshake on a connector with no verifyToken in the blob → 404 (fail closed)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(
      waRowWith({ configEncrypted: encrypt(JSON.stringify({ appSecret: WA_APP_SECRET })) })
    );

    const res = await request(app)
      .get(`/api/connectors/whatsapp/${WA_ID}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WA_VERIFY_TOKEN)}&hub.challenge=1`);

    expect(res.status).toBe(404);
  });

  it("GET handshake on a DISABLED connector → 404 AFTER the token gate (row-state gate 2)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({ isEnabled: false }));

    const res = await request(app)
      .get(`/api/connectors/whatsapp/${WA_ID}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WA_VERIFY_TOKEN)}&hub.challenge=1158201444`);

    expect(res.status).toBe(404);
  });

  it("GET handshake does NOT run the pipeline (the handshake IS the response — no ACK-and-defer)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));

    const res = await request(app)
      .get(`/api/connectors/whatsapp/${WA_ID}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WA_VERIFY_TOKEN)}&hub.challenge=7`);

    expect(res.status).toBe(200);
    expect(res.text).toBe("7");
    await flushAsyncArm();
    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });

  it("POST tampered body (wrong HMAC) → 403", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));

    const tampered = JSON.stringify({ ...waEnvelope, entry: [{ changes: [{ value: { messages: [{ from: "1", id: "wamid.TAMPER", type: "text", text: { body: "tampered" } }] } }] }] });
    const res = await request(app)
      .post(`/api/connectors/whatsapp/${WA_ID}/webhook`)
      .set(waSignatureHeaders(WA_APP_SECRET, waBody))
      .send(JSON.parse(tampered));

    expect(res.status).toBe(403);
  });

  it("POST with NO signature header → 403", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));

    const res = await request(app)
      .post(`/api/connectors/whatsapp/${WA_ID}/webhook`)
      .send(waEnvelope);

    expect(res.status).toBe(403);
  });

  it("POST on a connector with NO appSecret in the blob → 403 (fail closed)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(
      waRowWith({ configEncrypted: encrypt(JSON.stringify({ verifyToken: WA_VERIFY_TOKEN })) })
    );

    const res = await request(app)
      .post(`/api/connectors/whatsapp/${WA_ID}/webhook`)
      .set(waSignatureHeaders(WA_APP_SECRET, waBody))
      .send(waEnvelope);

    expect(res.status).toBe(403);
  });

  it("POST on a DISABLED connector → 404 AFTER the secret gate (telegram (e) shape)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({ isEnabled: false }));

    const res = await request(app)
      .post(`/api/connectors/whatsapp/${WA_ID}/webhook`)
      .set(waSignatureHeaders(WA_APP_SECRET, waBody))
      .send(waEnvelope);

    expect(res.status).toBe(404);
  });

  it("POST valid signed text message → 200 ACK, then the async arm parses via the registered whatsapp adapter", async () => {
    registerAdapter("whatsapp", {
      parseIncomingWebhook: jest.fn((body: unknown) => {
        const b = body as {
          entry?: { changes?: { value?: { messages?: { from?: string; id?: string; text?: { body?: string } }[] } }[] }[];
        };
        const m = b?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!m) return null;
        return {
          platformMessageId: m.id ?? null,
          platformUserId: m.from ?? "",
          text: m.text?.body ?? null,
          chatType: "private" as const,
        };
      }),
      pollUpdates: jest.fn(async () => []),
      sendMessage: jest.fn(async () => ({})),
      sendTypingIndicator: jest.fn(async () => undefined),
      validateBotToken: jest.fn(async () => ({ valid: true })),
      getBotInfo: jest.fn(async () => ({})),
      setWebhook: jest.fn(async () => undefined),
      removeWebhook: jest.fn(async () => undefined),
    } as unknown as PlatformAdapter);
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-default",
      deletedAt: null,
    });
    (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/connectors/whatsapp/${WA_ID}/webhook`)
      .set(waSignatureHeaders(WA_APP_SECRET, waBody))
      .send(waEnvelope);

    // ACK 200 BEFORE the pipeline (Meta retries non-2xx deliveries).
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    await flushAsyncArm();

    // The parsed message reached the D-16 pipeline with the wamid-based
    // platformMessageId and the VERBATIM bare-digit platformUserId (P10).
    expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    const [calledConnector, calledMsg] = (handleIncomingMessage as jest.Mock).mock.calls[0];
    expect(calledConnector.id).toBe(WA_ID);
    expect(calledMsg).toMatchObject({
      platformMessageId: "wamid.WEBHOOK1",
      platformUserId: "491234567890",
      text: "hi",
      chatType: "private",
    });

    // lastWebhookAt stamped on acceptance (non-blocking update, D-01 parity).
    expect(prisma.chatConnector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WA_ID },
        data: expect.objectContaining({ lastWebhookAt: expect.any(Date) }),
      }),
    );
  });

  it("POST statuses-only payload → 200 ACK and NO pipeline call (D-06 silent drop at the adapter boundary)", async () => {
    registerAdapter("whatsapp", {
      parseIncomingWebhook: jest.fn(() => null),
      pollUpdates: jest.fn(async () => []),
      sendMessage: jest.fn(async () => ({})),
      sendTypingIndicator: jest.fn(async () => undefined),
      validateBotToken: jest.fn(async () => ({ valid: true })),
      getBotInfo: jest.fn(async () => ({})),
      setWebhook: jest.fn(async () => undefined),
      removeWebhook: jest.fn(async () => undefined),
    } as unknown as PlatformAdapter);
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-default",
      deletedAt: null,
    });
    (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});

    const statusesBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.S1", status: "delivered" }] } }] }],
    });
    const res = await request(app)
      .post(`/api/connectors/whatsapp/${WA_ID}/webhook`)
      .set(waSignatureHeaders(WA_APP_SECRET, statusesBody))
      .send(JSON.parse(statusesBody));

    expect(res.status).toBe(200);
    await flushAsyncArm();
    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });

  it("tombstoned workspace on a signed message → fail-closed 404 (widget slot precedent)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue(waRowWith({}));
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/connectors/whatsapp/${WA_ID}/webhook`)
      .set(waSignatureHeaders(WA_APP_SECRET, waBody))
      .send(waEnvelope);

    expect(res.status).toBe(404);
  });

  it("DB resolution failure → fail-closed 404 (outer catch, WR-02)", async () => {
    (prisma.chatConnector.findUnique as jest.Mock).mockRejectedValue(new Error("db down"));

    const res = await request(app)
      .post(`/api/connectors/whatsapp/${WA_ID}/webhook`)
      .set(waSignatureHeaders(WA_APP_SECRET, waBody))
      .send(waEnvelope);

    expect(res.status).toBe(404);
  });
});