// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Test helper routes — only available in development/test environments.
 * Provides endpoints for E2E tests to manage mock MCP servers, the
 * in-process fake Telegram Bot API (198-04, OQ-1 option (b)), and the
 * in-process fake Discord REST API + Gateway loopback (199-05, D-11).
 *
 * TELEGRAM-FAKE ROUTE CONTRACT (198-04 Task 2):
 *   POST /api/__tests__/telegram-fake/start    → startFakeBotApi() + set the
 *       runtime TELEGRAM_API_URL override (setTelegramApiBaseOverride) →
 *       { port }
 *   POST /api/__tests__/telegram-fake/stop     → clear the override + stop
 *       the fake (module-level reset — the override must NOT survive into
 *       other tests) → { ok: true }
 *   POST /api/__tests__/telegram-fake/enqueue  → queue one update object
 *       (body = the Telegram update object) → { queued: n }
 *   POST /api/__tests__/telegram-fake/agent-stub → stub/clear the connector
 *       pipeline's agent seam (connectorChatService override — body
 *       { reply: string } to stub, { reply: null } to clear)
 *   GET  /api/__tests__/telegram-fake/log      → the fake's call log
 *       [{ method, payload, at }] (token-masked)
 *   GET  /api/__tests__/telegram-fake/status   → { running, port }
 *
 * DISCORD-FAKE ROUTE CONTRACT (199-05 Task 1, D-11 — the telegram family
 * extended with the gateway loopback + the injection seam):
 *   POST /api/__tests__/discord-fake/start    → startFakeDiscordApi() +
 *       startFakeDiscordGateway() + setDiscordApiBaseOverride(http://
 *       127.0.0.1:<port>) + setDiscordGatewayUrlOverride(ws://127.0.0.1:
 *       <gw-port>) → { port, gwPort }. Body flags (all optional):
 *       { invalidToken?: boolean } arms the REST fake's 401-on-@me mode;
 *       { gatewayIdle?: boolean } DISARMS the fake gateway's 4004 close
 *       (accept-and-idle — the healthy-connector shape; default ARMED).
 *   POST /api/__tests__/discord-fake/stop     → clear BOTH URL overrides +
 *       the agent-seam stub (setConnectorChatTurnOverride(null) — the
 *       shared-stop contract: one stop = full mock teardown) + stop both
 *       fakes (module reset) → { ok: true }
 *   POST /api/__tests__/discord-fake/agent-stub → the telegram route's
 *       byte-shape: { reply: string } stubs the agent seam, { reply: null }
 *       clears it
 *   POST /api/__tests__/discord-fake/gateway-inject → body
 *       { connectorId: uuid, payload: object } → injectDiscordConnectorMessage
 *       (Plan 199-03's manager seam) → { injected: true }, or 404
 *       { error: "Connector not found or disabled" } when the manager
 *       rejects (the row-state arm — the seam never bypasses row state).
 *   GET  /api/__tests__/discord-fake/log      → the REST fake's call log
 *       [{ method, payload, authHeaderPresent, at }] (Authorization
 *       presence-only — T-199-15)
 *   GET  /api/__tests__/discord-fake/status   → { running, port, gwRunning,
 *       gwPort }
 *
 * SLACK-FAKE ROUTE CONTRACT (200-05 Task 1, D-15 — the discord family
 * mirrored onto the Slack Web API fake):
 *   POST /api/__tests__/slack-fake/start    → startFakeSlackApi() +
 *       setSlackApiBaseOverride(http://127.0.0.1:<port>) → { port }.
 *       Body flags (all optional): { ratelimited?: boolean } arms the
 *       chat.postMessage {ok:false,error:"ratelimited"} + Retry-After mode;
 *       { invalidToken?: boolean } arms the auth.test invalid_auth mode.
 *   POST /api/__tests__/slack-fake/stop     → clear the Web API override +
 *       the agent-seam stub (setConnectorChatTurnOverride(null) — the
 *       shared-stop contract: one stop = full mock teardown) + stop the
 *       fake (module reset) → { ok: true }
 *   POST /api/__tests__/slack-fake/agent-stub → the telegram route's
 *       byte-shape: { reply: string } stubs the agent seam, { reply: null }
 *       clears it
 *   GET  /api/__tests__/slack-fake/log      → the fake's call log
 *       [{ method, path, hasAuthorization, body, at }] (Authorization
 *       presence-only — T-200-05)
 *   GET  /api/__tests__/slack-fake/status   → { running, port }
 *
 * WHATSAPP-FAKE ROUTE CONTRACT (200-05 Task 1, D-15 — the same family on
 * the WhatsApp Graph fake):
 *   POST /api/__tests__/whatsapp-fake/start → startFakeWhatsappApi() +
 *       setWhatsappApiBaseOverride(http://127.0.0.1:<port>) → { port }.
 *       Body flags (all optional): { arm131047?: boolean } arms the
 *       messages-send Graph-400 131047 envelope; { invalidToken?: boolean }
 *       arms the GET /me + GET /:phoneId 401 mode.
 *   POST /api/__tests__/whatsapp-fake/stop  → clear the Graph override +
 *       the agent-seam stub (setConnectorChatTurnOverride(null)) + stop
 *       the fake (module reset) → { ok: true }
 *   POST /api/__tests__/whatsapp-fake/agent-stub → the telegram route's
 *       byte-shape (the shared connectorChatService seam)
 *   GET  /api/__tests__/whatsapp-fake/log   → the fake's call log
 *       [{ method, path, hasAuthorization, body, at }] (Authorization
 *       presence-only — T-200-05)
 *   GET  /api/__tests__/whatsapp-fake/status → { running, port }
 *
 * The mount itself is dev/test-only (index.ts NODE_ENV gate — production
 * 404; T-198-15). No credential material: the fakes mask token fragments /
 * record Authorization presence only and never persist tokens (the
 * botApiEndpoint.ts + discordApiEndpoint.ts + slackApiEndpoint.ts +
 * whatsappApiEndpoint.ts fixture contracts).
 */

import { Router, type Request, type Response } from "express";
import { start, stop } from "../__tests__/helpers/echoMcpServer";
import {
  startFakeBotApi,
  stopFakeBotApi,
  enqueueUpdate,
  getFakeBotApiLog,
  isFakeBotApiRunning,
} from "../services/connectors/botApiEndpoint";
import { setTelegramApiBaseOverride } from "../services/connectors/telegram";
import { setConnectorChatTurnOverride } from "../services/connectors/connectorChatService";
// Phase 199 (199-05, D-11): the discord fake kit — REST fake, fake gateway
// ws endpoint, the adapter's REST override seam, the manager's gateway URL
// override seam, and the injection hook Plan 199-03 exported.
import {
  startFakeDiscordApi,
  stopFakeDiscordApi,
  setFakeDiscordApiInvalidTokenMode,
  getFakeDiscordApiLog,
  isFakeDiscordApiRunning,
} from "../services/connectors/discordApiEndpoint";
import {
  startFakeDiscordGateway,
  stopFakeDiscordGateway,
  setFakeDiscordGatewayArmed,
  isFakeDiscordGatewayRunning,
} from "../services/connectors/discordGatewayEndpoint";
import { setDiscordApiBaseOverride } from "../services/connectors/discord";
import {
  injectDiscordConnectorMessage,
  setDiscordGatewayUrlOverride,
  hasGatewayClient,
} from "../services/connectors/discordGateway";
// Phase 200 (200-05, D-15): the slack/whatsapp fake kits — REST/Graph fakes
// + the adapters' override seams. Same loopback-only doctrine.
import {
  startFakeSlackApi,
  stopFakeSlackApi,
  setFakeSlackApiRatelimitedMode,
  setFakeSlackApiInvalidTokenMode,
  getFakeSlackApiLog,
  isFakeSlackApiRunning,
} from "../services/connectors/slackApiEndpoint";
import {
  startFakeWhatsappApi,
  stopFakeWhatsappApi,
  setFakeWhatsappApiArm131047,
  setFakeWhatsappApiInvalidTokenMode,
  getFakeWhatsappApiLog,
  isFakeWhatsappApiRunning,
} from "../services/connectors/whatsappApiEndpoint";
import { setSlackApiBaseOverride } from "../services/connectors/slack";
import { setWhatsappApiBaseOverride } from "../services/connectors/whatsapp";
import { logger } from "../utils/logger";

const router = Router();

let echoPort: number | null = null;

router.post("/start-echo-server", async (_req: Request, res: Response) => {
  try {
    if (echoPort !== null) {
      res.json({ port: echoPort });
      return;
    }
    echoPort = await start();
    logger.info(`[e2e-helper] Echo MCP server started on port ${echoPort}`);
    res.json({ port: echoPort });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[e2e-helper] Failed to start echo server", { error: message });
    res.status(500).json({ error: message });
  }
});

router.post("/stop-echo-server", async (_req: Request, res: Response) => {
  try {
    await stop();
    echoPort = null;
    logger.info("[e2e-helper] Echo MCP server stopped");
    res.json({ ok: true });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ===== 198-04 (OQ-1 option (b)): the in-process fake Bot API =====

router.post("/telegram-fake/start", async (_req: Request, res: Response) => {
  try {
    const { port } = await startFakeBotApi();
    // Runtime override: the telegram adapter's botApi consults this BEFORE
    // getEnv().TELEGRAM_API_URL (OQ-1 option (b) override point). Trailing
    // slash stripped — the adapter composes `${base}/bot<token>/<method>`.
    setTelegramApiBaseOverride(`http://127.0.0.1:${port}`);
    logger.info(`[e2e-helper] Fake Telegram Bot API started on 127.0.0.1:${port} — TELEGRAM_API_URL override set`);
    res.json({ port });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[e2e-helper] Failed to start fake Bot API", { error: message });
    res.status(500).json({ error: message });
  }
});

router.post("/telegram-fake/stop", async (_req: Request, res: Response) => {
  try {
    await stopFakeBotApi();
    // Module-level reset: the override must NOT survive into other tests
    // (clears to env-driven production semantics). The agent-seam stub is
    // cleared here too (one stop = full mock teardown).
    setTelegramApiBaseOverride(null);
    setConnectorChatTurnOverride(null);
    logger.info("[e2e-helper] Fake Telegram Bot API stopped — overrides cleared (base URL + agent seam)");
    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /telegram-fake/agent-stub — stub the connector pipeline's agent seam
// (connectorChatService.runConnectorChatTurn → runAgent). Body:
// { reply: string } — every turn returns the canned reply; { reply: null }
// clears the stub (the real orchestrator runs again). This is the E2E
// full-mock doctrine (mcp-pin-use D-03) applied server-side: the connector
// pipeline has no browser boundary to route-mock, so the LLM seam is stubbed
// in-process via a dev-only override point.
router.post("/telegram-fake/agent-stub", (req: Request, res: Response) => {
  const reply = (req.body as { reply?: unknown } | undefined)?.reply;
  if (typeof reply === "string" && reply.length > 0) {
    setConnectorChatTurnOverride(async () => reply);
    res.json({ stubbed: true });
    return;
  }
  if (reply === null) {
    setConnectorChatTurnOverride(null);
    res.json({ stubbed: false });
    return;
  }
  res.status(400).json({ error: "Body must be { reply: string } to stub, or { reply: null } to clear" });
});

router.post("/telegram-fake/enqueue", (req: Request, res: Response) => {
  const update = req.body as Record<string, unknown> | undefined;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    res.status(400).json({ error: "Request body must be a Telegram update object" });
    return;
  }
  enqueueUpdate(update);
  const log = getFakeBotApiLog();
  res.json({ queued: log.length });
});

router.get("/telegram-fake/log", (_req: Request, res: Response) => {
  res.json(getFakeBotApiLog());
});

router.get("/telegram-fake/status", (_req: Request, res: Response) => {
  res.json(isFakeBotApiRunning());
});

// ===== 199-05 (D-11): the discord fake family (REST + gateway loopback) ====

router.post("/discord-fake/start", async (req: Request, res: Response) => {
  try {
    // Optional body flags: { invalidToken?: boolean, gatewayIdle?: boolean }.
    const body = (req.body ?? {}) as { invalidToken?: unknown; gatewayIdle?: unknown };

    const { port } = await startFakeDiscordApi();
    const { port: gwPort } = await startFakeDiscordGateway();
    // Runtime overrides: the adapter's discordApi consults
    // setDiscordApiBaseOverride BEFORE getEnv().DISCORD_API_URL; the
    // GatewayClient consults setDiscordGatewayUrlOverride BEFORE
    // getEnv().DISCORD_GATEWAY_URL at every connect/resume (199-01/199-03
    // seam contracts). Both loopback-only.
    setDiscordApiBaseOverride(`http://127.0.0.1:${port}`);
    setDiscordGatewayUrlOverride(`ws://127.0.0.1:${gwPort}`);

    // Arm flags (default: REST fake valid-token, gateway ARMED for the
    // invalid-token row). gatewayIdle disarms the 4004 close so the real
    // client's healthy connection persists for the message rows.
    setFakeDiscordApiInvalidTokenMode(body.invalidToken === true);
    const armed = body.gatewayIdle !== true;
    setFakeDiscordGatewayArmed(armed);

    logger.info(
      `[e2e-helper] Fake Discord API started on 127.0.0.1:${port} (gw 127.0.0.1:${gwPort}, armed=${armed}) — DISCORD_API_URL + DISCORD_GATEWAY_URL overrides set`
    );
    res.json({ port, gwPort });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[e2e-helper] Failed to start fake Discord API", { error: message });
    res.status(500).json({ error: message });
  }
});

router.post("/discord-fake/stop", async (_req: Request, res: Response) => {
  try {
    await stopFakeDiscordApi();
    await stopFakeDiscordGateway();
    // Module-level reset: BOTH overrides + the agent-seam stub must NOT
    // survive into other tests (one stop = full mock teardown — the shared
    // stop contract, byte-compatible with the telegram-fake stop shape).
    setDiscordApiBaseOverride(null);
    setDiscordGatewayUrlOverride(null);
    setConnectorChatTurnOverride(null);
    logger.info("[e2e-helper] Fake Discord API stopped — overrides cleared (REST + gateway + agent seam)");
    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /discord-fake/agent-stub — the telegram route's byte-shape: the same
// connectorChatService agent seam, the same { reply } body contract.
router.post("/discord-fake/agent-stub", (req: Request, res: Response) => {
  const reply = (req.body as { reply?: unknown } | undefined)?.reply;
  if (typeof reply === "string" && reply.length > 0) {
    setConnectorChatTurnOverride(async () => reply);
    res.json({ stubbed: true });
    return;
  }
  if (reply === null) {
    setConnectorChatTurnOverride(null);
    res.json({ stubbed: false });
    return;
  }
  res.status(400).json({ error: "Body must be { reply: string } to stub, or { reply: null } to clear" });
});

// POST /discord-fake/gateway-inject — feed a raw MESSAGE_CREATE payload
// through Plan 199-03's injectDiscordConnectorMessage seam into the REAL
// pipeline (dedup → session → limit → agent). Body: { connectorId: uuid,
// payload: object }. The manager's own row-state contract applies: no live
// gateway client for the connector (unknown id / disabled / tombstoned row —
// the sync-on-mutation arms keep the Map aligned) → the manager logs + skips
// the pipeline → surfaced as 404 "Connector not found or disabled" (the
// row-state arm; T-199-16 — the seam must not bypass row state). A
// guild-shaped/bot-echo payload is filtered by the normalizer the same way
// the dispatch path filters it → { injected: false }.
router.post("/discord-fake/gateway-inject", async (req: Request, res: Response) => {
  const connectorId = (req.body as { connectorId?: unknown } | undefined)?.connectorId;
  const payload = (req.body as { payload?: unknown } | undefined)?.payload;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof connectorId !== "string" || !uuidRe.test(connectorId)) {
    res.status(400).json({ error: "Body must be { connectorId: uuid, payload: object }" });
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    res.status(400).json({ error: "Body must be { connectorId: uuid, payload: object }" });
    return;
  }
  try {
    // Row-state arm: the manager rejects when no live client exists for the
    // connector (unknown id, disabled, tombstoned, never synced) — the seam
    // re-asserts platform/enabled/deletedAt server-side via the client Map
    // + the fresh-row pipeline contract, never bypassing row state.
    const hasClient = hasGatewayClient(connectorId);
    await injectDiscordConnectorMessage(connectorId, payload as Record<string, unknown>);
    if (!hasClient) {
      res.status(404).json({ error: "Connector not found or disabled" });
      return;
    }
    res.json({ injected: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[e2e-helper] discord gateway-inject failed", {
      connectorId,
      error: message,
    });
    res.status(500).json({ error: message });
  }
});

router.get("/discord-fake/log", (_req: Request, res: Response) => {
  res.json(getFakeDiscordApiLog());
});

router.get("/discord-fake/status", (_req: Request, res: Response) => {
  const rest = isFakeDiscordApiRunning();
  const gw = isFakeDiscordGatewayRunning();
  res.json({ running: rest.running, port: rest.port, gwRunning: gw.running, gwPort: gw.port });
});

// ===== 200-05 (D-15): the slack fake family (Slack Web API loopback) ======

router.post("/slack-fake/start", async (req: Request, res: Response) => {
  try {
    // Optional body flags: { ratelimited?: boolean, invalidToken?: boolean }.
    const body = (req.body ?? {}) as { ratelimited?: unknown; invalidToken?: unknown };

    const { port } = await startFakeSlackApi();
    // Runtime override: the adapter's slackApi consults setSlackApiBaseOverride
    // BEFORE getEnv().SLACK_API_URL (200-01 seam contract). Loopback-only.
    setSlackApiBaseOverride(`http://127.0.0.1:${port}`);

    // Arm flags (default: valid-token, non-ratelimited posture).
    setFakeSlackApiRatelimitedMode(body.ratelimited === true);
    setFakeSlackApiInvalidTokenMode(body.invalidToken === true);

    logger.info(
      `[e2e-helper] Fake Slack API started on 127.0.0.1:${port} (ratelimited=${body.ratelimited === true}, invalidToken=${body.invalidToken === true}) — SLACK_API_URL override set`
    );
    res.json({ port });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[e2e-helper] Failed to start fake Slack API", { error: message });
    res.status(500).json({ error: message });
  }
});

router.post("/slack-fake/stop", async (_req: Request, res: Response) => {
  try {
    await stopFakeSlackApi();
    // Module-level reset: the override + the agent-seam stub must NOT
    // survive into other tests (one stop = full mock teardown — the shared
    // stop contract). The WHATSAPP override is cleared too (defensive
    // clear — the stop must leave NO base-URL override armed on any
    // platform seam, whatever order the suites started fakes in).
    setSlackApiBaseOverride(null);
    setWhatsappApiBaseOverride(null);
    setConnectorChatTurnOverride(null);
    logger.info("[e2e-helper] Fake Slack API stopped — overrides cleared (base URL + agent seam)");
    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /slack-fake/agent-stub — the telegram route's byte-shape: the same
// connectorChatService agent seam, the same { reply } body contract.
router.post("/slack-fake/agent-stub", (req: Request, res: Response) => {
  const reply = (req.body as { reply?: unknown } | undefined)?.reply;
  if (typeof reply === "string" && reply.length > 0) {
    setConnectorChatTurnOverride(async () => reply);
    res.json({ stubbed: true });
    return;
  }
  if (reply === null) {
    setConnectorChatTurnOverride(null);
    res.json({ stubbed: false });
    return;
  }
  res.status(400).json({ error: "Body must be { reply: string } to stub, or { reply: null } to clear" });
});

router.get("/slack-fake/log", (_req: Request, res: Response) => {
  res.json(getFakeSlackApiLog());
});

router.get("/slack-fake/status", (_req: Request, res: Response) => {
  res.json(isFakeSlackApiRunning());
});

// ==== 200-05 (D-15): the whatsapp fake family (Graph API loopback) ========

router.post("/whatsapp-fake/start", async (req: Request, res: Response) => {
  try {
    // Optional body flags: { arm131047?: boolean, invalidToken?: boolean }.
    const body = (req.body ?? {}) as { arm131047?: unknown; invalidToken?: unknown };

    const { port } = await startFakeWhatsappApi();
    // Runtime override: the adapter's graphApi consults
    // setWhatsappApiBaseOverride BEFORE getEnv().WHATSAPP_API_URL (200-02
    // seam contract). Loopback-only.
    setWhatsappApiBaseOverride(`http://127.0.0.1:${port}`);

    // Arm flags (default: valid-token, no-131047 posture).
    setFakeWhatsappApiArm131047(body.arm131047 === true);
    setFakeWhatsappApiInvalidTokenMode(body.invalidToken === true);

    logger.info(
      `[e2e-helper] Fake WhatsApp API started on 127.0.0.1:${port} (arm131047=${body.arm131047 === true}, invalidToken=${body.invalidToken === true}) — WHATSAPP_API_URL override set`
    );
    res.json({ port });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[e2e-helper] Failed to start fake WhatsApp API", { error: message });
    res.status(500).json({ error: message });
  }
});

router.post("/whatsapp-fake/stop", async (_req: Request, res: Response) => {
  try {
    await stopFakeWhatsappApi();
    // Module-level reset: the override + the agent-seam stub must NOT
    // survive into other tests (one stop = full mock teardown — the shared
    // stop contract). The SLACK override is cleared too (defensive clear —
    // the same posture the slack-fake stop applies to the whatsapp seam).
    setWhatsappApiBaseOverride(null);
    setSlackApiBaseOverride(null);
    setConnectorChatTurnOverride(null);
    logger.info("[e2e-helper] Fake WhatsApp API stopped — overrides cleared (base URL + agent seam)");
    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /whatsapp-fake/agent-stub — the telegram route's byte-shape: the same
// connectorChatService agent seam, the same { reply } body contract.
router.post("/whatsapp-fake/agent-stub", (req: Request, res: Response) => {
  const reply = (req.body as { reply?: unknown } | undefined)?.reply;
  if (typeof reply === "string" && reply.length > 0) {
    setConnectorChatTurnOverride(async () => reply);
    res.json({ stubbed: true });
    return;
  }
  if (reply === null) {
    setConnectorChatTurnOverride(null);
    res.json({ stubbed: false });
    return;
  }
  res.status(400).json({ error: "Body must be { reply: string } to stub, or { reply: null } to clear" });
});

router.get("/whatsapp-fake/log", (_req: Request, res: Response) => {
  res.json(getFakeWhatsappApiLog());
});

router.get("/whatsapp-fake/status", (_req: Request, res: Response) => {
  res.json(isFakeWhatsappApiRunning());
});

export default router;