/**
 * Phase 199 (199-05 Task 2, D-11) — E2E full-mock: the Discord connector
 * vertical (pattern e2e/connectors-telegram.spec.ts, the 198-04 doctrine).
 *
 * FULL-MOCK DOCTRINE (mcp-pin-use.spec.ts header): the REAL server boots
 * from the playwright webServer (tsx plain, E2E_RUN=1); EVERY external
 * dependency is faked IN-PROCESS — zero real network egress in CI:
 *   - Discord REST: the in-process fake (discordApiEndpoint.ts) bound to
 *     127.0.0.1 on an ephemeral port; the server's DISCORD_API_URL is
 *     overridden at runtime via the dev-only helper (the
 *     setTelegramApiBaseOverride pattern generalized, 199-01 seam).
 *   - Discord Gateway: the loopback fake ws endpoint
 *     (discordGatewayEndpoint.ts) + setDiscordGatewayUrlOverride — the REAL
 *     GatewayClient's 4004 close path is driven by the fake-gateway armed
 *     mode; message traffic is injected through the manager's
 *     injectDiscordConnectorMessage seam (dev-only gateway-inject route —
 *     the REAL pipeline runs: dedup → session → limit → agent).
 *   - Agent LLM: the connector pipeline's agent seam (connectorChatService)
 *     is stubbed in-process via the dev-only agent-stub route (D-03).
 *
 * Setup (beforeAll):
 *   - admin login via API → JWT (globalSetup seeds admin/admin123)
 *   - POST /api/__tests__/discord-fake/start { gatewayIdle: true } →
 *     { port, gwPort } (both overrides set; the fake gateway DISARMED —
 *     accept-and-idle — so the main connector's real client connects and
 *     stays healthy for the message rows)
 *   - POST .../discord-fake/agent-stub { reply } (canned agent reply)
 *   - POST /api/connectors (discord, botToken "fake-token", custom
 *     welcomeMessage) → 201 (sync-on-mutation arms the real gateway client
 *     against the idle fake gateway)
 *
 * Matrix (D-11, plan action 1):
 *   (a+b) start → { port, gwPort } + both fakes running; create → 201 with
 *         hasBotToken true and NO token field (serializeConnector discipline)
 *   (c)   validate valid → { valid: true, botUsername } — and the override
 *         probe: the fake's log carries "GET /users/@me" (the REST override
 *         routed the adapter to the in-process fake)
 *   (c2)  invalid-token arm → validate → { valid: false }
 *   (d)   gateway-inject a FIRST DM → the welcome reply (connector
 *         welcomeMessage) appears as POST /channels/:id/messages in the log
 *         (the 199-03 created-flag arm for a fresh platform user)
 *   (d2)  second DM (same channel — session exists) → the canned agent reply
 *   (e)   duplicate message id → dedup: no second reply (P-9)
 *   (f)   burst of 21 messages on the SAME session → the throttled limit
 *         reply appears EXACTLY once (D-10 over the discord path)
 *   (g)   guild-shaped payload → no reply, no chat row (D-03 silent guard)
 *   (h)   non-text DM → the politeness fallback reply (D-18 parity)
 *   (i)   workspace chats → the connector chat carries connectorPlatform
 *         "discord" AND a "Discord: " name prefix (§7.9-1 + Pitfall 6 fix)
 *   (c3)  a connector whose gateway client hits 4004 (the ARMED fake gateway
 *         closes after identify) → healthStatus "error" + token-free
 *         lastError via the manager's D-06 flip — the REAL protocol path
 *
 * Runtime budget: 11 test blocks, < ~3 min (the inject route awaits the full
 * pipeline, so log assertions are deterministic; only the 4004 flip polls).
 *
 * Retry determinism: fresh channel id + per-attempt message-id bases per
 * block (the dedup arbiter is per-connector; the session window is
 * per-channel) — a Playwright retry never collides with a prior attempt's
 * rows.
 */

import { test, expect, type APIRequestContext } from "./fixtures";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (globalSetup-seeded, admin-owned)
const SERVER_URL = "http://localhost:3000";
const HELPER_BASE = `${SERVER_URL}/api/__tests__/discord-fake`;
/** The canned reply the agent-seam stub returns for every turn (D-03 analog). */
const CANNED_REPLY = "Canned E2E reply 199-05";
/** The main connector's explicit welcomeMessage (connector column wins). */
const WELCOME_TEXT = "Welcome to the E2E Discord fake 199-05";
/** The throttled limit reply (messageRouter LIMIT_REACHED_TEXT — D-10). */
const LIMIT_TEXT = "You've reached the message limit for now. Please try again a bit later.";
/** The politeness fallback (messageRouter ATTACHMENTS_NOT_SUPPORTED — D-18). */
const POLITE_TEXT = "Attachments are not supported in this version — please send your question as text.";
/** The fake's bot identity (discordApiEndpoint FAKE_BOT_USERNAME). */
const FAKE_BOT_USERNAME = "fake_discord_bot";
const FAKE_BOT_DISPLAY = "Fake Discord Bot";

/** Admin login via API → JWT (mcp-pin-use pattern). */
async function adminLoginToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  expect(res.ok(), `admin login failed: ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { token: string };
  return body.token;
}

interface FakeLogEntry {
  method: string;
  payload: Record<string, unknown>;
  authHeaderPresent: boolean;
  at: string;
}

/** Fake Discord REST log snapshot (Authorization presence-only — assertion surface). */
async function fakeLog(request: APIRequestContext): Promise<FakeLogEntry[]> {
  const res = await request.get(`${HELPER_BASE}/log`, { timeout: 8000 });
  expect(res.ok(), `fake log fetch failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as FakeLogEntry[];
}

/** waitFor-style poll: run `probe` against a fresh log until it passes. */
async function waitForLog(
  request: APIRequestContext,
  predicate: (log: FakeLogEntry[]) => boolean,
  opts: { timeoutMs?: number } = {}
): Promise<FakeLogEntry[]> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let last: FakeLogEntry[] = [];
  while (Date.now() < deadline) {
    last = await fakeLog(request);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last; // let the caller's assertion fail with the final log state
}

/** Create a discord connector; returns the serialized row (no token field). */
async function createConnector(
  request: APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await request.post(`${SERVER_URL}/api/connectors`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      platform: "discord",
      name: `E2E Discord ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      botToken: "fake-token",
      workspaceId: WORKSPACE_ID,
      ...overrides,
    },
    timeout: 8000,
  });
  expect(res.status(), `connector create failed: ${res.status()}`).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

/** POST /api/connectors/discord/validate — returns the raw status + body. */
async function validateToken(
  request: APIRequestContext,
  token: string,
  botToken: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request.post(`${SERVER_URL}/api/connectors/discord/validate`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { platform: "discord", botToken },
    timeout: 8000,
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/**
 * POST /api/__tests__/discord-fake/gateway-inject — feed a raw MESSAGE_CREATE
 * payload through the manager's injection seam into the REAL pipeline. The
 * route AWAITS the pipeline, so when this resolves the reply (if any) is
 * already in the fake's REST log (deterministic — no race window).
 */
async function injectDm(
  request: APIRequestContext,
  connectorId: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request.post(`${HELPER_BASE}/gateway-inject`, {
    data: { connectorId, payload },
    timeout: 15000,
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** A fresh snowflake-ish id (per-attempt uniqueness for dedup/retry safety). */
function snowflake(): string {
  return (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
}

/** A DM MESSAGE_CREATE payload the gateway normalizer accepts (channel_type 1). */
function dmPayload(
  messageId: string,
  channelId: string,
  text: string | null,
  opts: { guildId?: string; userName?: string } = {}
): Record<string, unknown> {
  return {
    id: messageId,
    channel_id: channelId,
    ...(opts.guildId ? { guild_id: opts.guildId } : {}),
    channel_type: 1,
    content: text,
    author: {
      id: `user-${channelId}`,
      username: opts.userName ?? "e2e_discord_user",
      global_name: opts.userName ?? "E2E Discord User",
      bot: false,
    },
  };
}

/** The message-send log entries for ONE channel (the reply assertion surface). */
function sendsTo(log: FakeLogEntry[], channelId: string): FakeLogEntry[] {
  return log.filter(
    (e) => e.method === `POST /channels/${channelId}/messages`
  );
}

interface Setup {
  adminToken: string;
  connectorId: string;
}

let skipReason: string | undefined;
let setup: Setup | undefined;
/** Extra connectors created by individual rows (health-flip row) — teardown. */
const createdConnectorIds: string[] = [];

test.describe("199-05 — Discord connector E2E full-mock (D-11)", () => {
  test.beforeAll(async ({ request }) => {
    let adminToken: string;
    try {
      adminToken = await adminLoginToken(request);
    } catch (err) {
      skipReason = `admin login failed — E2E environment unavailable (${(err as Error).message})`;
      return;
    }

    // Start BOTH fakes + both runtime overrides. gatewayIdle DISARMS the fake
    // gateway's 4004 close so the main connector's real client connects and
    // idles (healthy shape) — the invalid-token arm is exercised by (c3)
    // with its own connector.
    const startRes = await request
      .post(`${HELPER_BASE}/start`, { data: { gatewayIdle: true }, timeout: 8000 })
      .catch(() => null);
    if (!startRes || !startRes.ok()) {
      skipReason = `discord-fake start failed (status ${startRes ? startRes.status() : "network error"}) — dev-only helper unreachable`;
      return;
    }
    const startBody = (await startRes.json()) as { port: number; gwPort: number };
    if (typeof startBody.port !== "number" || typeof startBody.gwPort !== "number") {
      skipReason = "discord-fake start returned no ports";
      return;
    }

    // Stub the agent seam with the canned reply (D-03 server-side analog).
    const stubRes = await request.post(`${HELPER_BASE}/agent-stub`, {
      data: { reply: CANNED_REPLY },
      timeout: 8000,
    });
    if (!stubRes.ok()) {
      skipReason = `agent-stub failed (${stubRes.status()})`;
      return;
    }

    const connector = await createConnector(request, adminToken, {
      welcomeMessage: WELCOME_TEXT,
    });
    setup = { adminToken, connectorId: connector.id as string };
  });

  test.afterAll(async ({ request }) => {
    // Teardown: clear overrides + stop fakes FIRST (module reset — must not
    // survive other tests), then delete the connector rows created by this run.
    await request.post(`${HELPER_BASE}/stop`, { timeout: 8000 }).catch(() => {});
    if (setup?.adminToken) {
      for (const id of [setup.connectorId, ...createdConnectorIds]) {
        await request
          .delete(`${SERVER_URL}/api/connectors/${id}`, {
            headers: { Authorization: `Bearer ${setup.adminToken}` },
            timeout: 8000,
          })
          .catch(() => {});
      }
    }
  });

  test("(a+b) start → both fakes running; create → 201 with hasBotToken and NO token field", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    // (a) the start probe: both fakes listen (the REST override is proven by
    // (c)'s @me call reaching the fake's log — the behavior-level probe).
    const statusRes = await request.get(`${HELPER_BASE}/status`, { timeout: 8000 });
    expect(statusRes.ok()).toBeTruthy();
    const status = (await statusRes.json()) as {
      running: boolean;
      port: number | null;
      gwRunning: boolean;
      gwPort: number | null;
    };
    expect(status.running, "the REST fake must be running").toBe(true);
    expect(status.port, "the REST fake port must be an ephemeral port").toBeGreaterThan(0);
    expect(status.gwRunning, "the fake gateway must be running").toBe(true);
    expect(status.gwPort).toBeGreaterThan(0);

    // (b) serializeConnector discipline: hasBotToken true, NO token material.
    const res = await request.get(`${SERVER_URL}/api/connectors/${setup!.connectorId}`, {
      headers: { Authorization: `Bearer ${setup!.adminToken}` },
      timeout: 8000,
    });
    expect(res.ok(), `connector detail failed: ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hasBotToken).toBe(true);
    expect(body.platform).toBe("discord");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("botTokenEncrypted");
    expect(serialized).not.toContain("fake-token");
  });

  test("(c) validate valid → { valid, botUsername } + the override probe (GET /users/@me reached the in-process fake)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    const { status, body } = await validateToken(request, setup!.adminToken, "valid-fake-token");
    expect(status, `validate failed: ${status} ${JSON.stringify(body)}`).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.botUsername).toBe(FAKE_BOT_USERNAME);
    expect(body.botDisplayName).toBe(FAKE_BOT_DISPLAY);

    // D-05: validate is side-effect-free — NOTHING persists.
    const detail = await request.get(`${SERVER_URL}/api/connectors/${setup!.connectorId}`, {
      headers: { Authorization: `Bearer ${setup!.adminToken}` },
      timeout: 8000,
    });
    const detailBody = (await detail.json()) as Record<string, unknown>;
    expect(detailBody.botUsername, "validate must not persist botUsername").toBeNull();

    // (a) override probe: the adapter's fetch hit the IN-PROCESS fake.
    const log = await waitForLog(request, (l) =>
      l.some((e) => e.method === "GET /users/@me")
    );
    const me = log.find((e) => e.method === "GET /users/@me");
    expect(me, "GET /users/@me must appear in the fake's log (REST override routed)").toBeTruthy();
    expect(me!.authHeaderPresent, "the Authorization header presence must be recorded").toBe(true);
  });

  test("(c2) invalid-token arm → validate → { valid: false } (deterministic 401)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    // Arm the fake's 401-on-@me mode (idempotent start re-arms without
    // resetting the log; gatewayIdle keeps the gateway posture unchanged).
    const armRes = await request.post(`${HELPER_BASE}/start`, {
      data: { invalidToken: true, gatewayIdle: true },
      timeout: 8000,
    });
    expect(armRes.ok(), `re-arm start failed: ${armRes.status()}`).toBeTruthy();

    const { status, body } = await validateToken(request, setup!.adminToken, "definitely-invalid-token");
    expect(status).toBe(200); // validate NEVER throws — it maps (D-02)
    expect(body.valid).toBe(false);

    // Disarm (restore the valid-token posture for later rows).
    const disarmRes = await request.post(`${HELPER_BASE}/start`, {
      data: { gatewayIdle: true },
      timeout: 8000,
    });
    expect(disarmRes.ok()).toBeTruthy();
  });

  test("(d) FIRST DM via gateway-inject → the welcome reply in the fake's REST log (created-flag arm)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    const chan = `dm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await injectDm(request, setup!.connectorId, dmPayload(snowflake(), chan, "hello bot"));
    expect(
      res.status,
      `gateway-inject failed: ${res.status} ${JSON.stringify(res.body)}`
    ).toBe(200);
    expect((res.body as { injected?: boolean }).injected).toBe(true);

    const log = await waitForLog(request, (l) =>
      sendsTo(l, chan).some((e) => (e.payload.content as string) === WELCOME_TEXT)
    );
    const welcome = sendsTo(log, chan).find((e) => (e.payload.content as string) === WELCOME_TEXT);
    expect(
      welcome,
      `the welcome reply must appear as a POST /channels/${chan}/messages entry (log entries for the channel: ${sendsTo(log, chan).length})`
    ).toBeTruthy();
    // The welcome is the ONLY reply for this first contact (no agent turn).
    expect(sendsTo(log, chan).length).toBe(1);
  });

  test("(d2) SECOND DM (same channel — session exists) → the canned agent reply (real pipeline)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    const chan = `dm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // First contact (welcome) then the agent turn on the SAME channel —
    // the session now exists (created false) so the agent arm runs.
    const first = await injectDm(request, setup!.connectorId, dmPayload(snowflake(), chan, "first"));
    expect(first.status).toBe(200);
    const second = await injectDm(request, setup!.connectorId, dmPayload(snowflake(), chan, "second"));
    expect(second.status).toBe(200);

    const log = await waitForLog(request, (l) =>
      sendsTo(l, chan).some((e) => (e.payload.content as string) === CANNED_REPLY)
    );
    const canned = sendsTo(log, chan).filter((e) => (e.payload.content as string) === CANNED_REPLY);
    expect(canned.length, `the canned agent reply must appear verbatim (sends: ${sendsTo(log, chan).map((e) => String(e.payload.content).slice(0, 30)).join(" | ")})`).toBe(1);
    // D-07 verbatim: the reply content is sent VERBATIM (single short
    // segment — no conversion layer); the typing post fired too (D-19).
    expect(sendsTo(log, chan).some((e) => (e.payload.content as string) === WELCOME_TEXT)).toBe(true);
  });

  test("(e) duplicate message id → dedup: no second reply (P-9)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    const chan = `dm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const dupId = snowflake();
    const first = await injectDm(request, setup!.connectorId, dmPayload(dupId, chan, "dedup probe"));
    expect(first.status).toBe(200);
    await waitForLog(request, (l) =>
      sendsTo(l, chan).some((e) => (e.payload.content as string) === WELCOME_TEXT)
    );

    // Capture the reply count for THIS channel, then replay the SAME id.
    const before = sendsTo(await fakeLog(request), chan).length;
    const replay = await injectDm(request, setup!.connectorId, dmPayload(dupId, chan, "dedup probe"));
    expect(replay.status).toBe(200);
    // The inject route awaits the pipeline — the dedup decision is already
    // made when it resolves (no flush window needed).
    const after = sendsTo(await fakeLog(request), chan).length;
    expect(after, "a duplicate message id must not trigger a second reply").toBe(before);
  });

  test("(f) burst of 21 messages on the SAME session → the throttled limit reply EXACTLY once (D-10)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    // The session user from (d2)'s shape: first contact via a text DM (the
    // welcome consumes its own turn), then 21 burst messages — every burst
    // message runs the agent arm until the 20/h window trips.
    const chan = `dm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const first = await injectDm(request, setup!.connectorId, dmPayload(snowflake(), chan, "warmup"));
    expect(first.status).toBe(200);

    for (let i = 0; i < 21; i++) {
      const res = await injectDm(
        request,
        setup!.connectorId,
        dmPayload(snowflake(), chan, `limit probe ${i}`)
      );
      expect(
        res.status,
        `burst message ${i} failed: ${res.status}`
      ).toBe(200);
    }

    const log = await waitForLog(
      request,
      (l) =>
        sendsTo(l, chan).some((e) => (e.payload.content as string)?.includes(LIMIT_TEXT)),
      { timeoutMs: 20_000 }
    );
    const limitReplies = sendsTo(log, chan).filter(
      (e) => (e.payload.content as string)?.includes(LIMIT_TEXT)
    );
    // Diagnostic on failure: the per-channel sendMessage texts the fake saw.
    const sentTexts = sendsTo(log, chan).map((e) => String(e.payload.content ?? "").slice(0, 40));
    expect(
      limitReplies.length,
      `throttled reply exactly once (sent ${sentTexts.length}: ${sentTexts.slice(0, 4).join(" | ")})`
    ).toBe(1);
  });

  test("(g) guild-shaped payload → NO reply and no chat row (D-03 silent guard)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    const chan = `guild-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await injectDm(
      request,
      setup!.connectorId,
      dmPayload(snowflake(), chan, "guild probe", {
        guildId: "g-199-05",
        userName: "E2E Guild User",
      })
    );
    // The injection seam accepts the call (the client exists) but the
    // normalizer's guild guard drops the payload BEFORE any DB write —
    // nothing replies, no session, no chat.
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 1000)); // guard flush window
    const log = await fakeLog(request);
    expect(
      log.some((e) => e.method.includes(`/channels/${chan}/`)),
      "a guild message must never reach the REST fake (no reply)"
    ).toBe(false);

    const chatsRes = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chats`, {
      headers: { Authorization: `Bearer ${setup!.adminToken}` },
      timeout: 8000,
    });
    expect(chatsRes.ok()).toBeTruthy();
    const chats = (await chatsRes.json()) as Array<{ name?: string }>;
    expect(
      chats.some((c) => (c.name ?? "").includes("E2E Guild User")),
      "a guild message must never create a connector chat"
    ).toBe(false);
  });

  test("(h) non-text DM → the politeness fallback reply (D-18 parity)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    const chan = `dm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // First contact (welcome arm consumes the created turn), then the
    // empty-content DM → the politeness fallback.
    const first = await injectDm(request, setup!.connectorId, dmPayload(snowflake(), chan, "hi"));
    expect(first.status).toBe(200);
    const empty = await injectDm(request, setup!.connectorId, dmPayload(snowflake(), chan, ""));
    expect(empty.status).toBe(200);

    const log = await waitForLog(request, (l) =>
      sendsTo(l, chan).some((e) => (e.payload.content as string) === POLITE_TEXT)
    );
    const polite = sendsTo(log, chan).filter((e) => (e.payload.content as string) === POLITE_TEXT);
    expect(polite.length, "the politeness fallback must be sent for a non-text DM").toBe(1);
  });

  test("(i) chat list → the connector chat carries connectorPlatform 'discord' + the 'Discord: ' name prefix", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    // The (d) row's chat already exists — assert on the workspace chat list.
    const res = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chats`, {
      headers: { Authorization: `Bearer ${setup!.adminToken}` },
      timeout: 8000,
    });
    expect(res.ok(), `chat list failed: ${res.status()}`).toBeTruthy();
    const chats = (await res.json()) as Array<{
      name?: string;
      connectorPlatform?: string | null;
    }>;
    const connectorChats = chats.filter((c) => c.connectorPlatform === "discord");
    expect(connectorChats.length, "at least one connector chat must exist").toBeGreaterThan(0);
    for (const chat of connectorChats) {
      expect(
        (chat.name ?? "").startsWith("Discord: "),
        `connector chat name must carry the platform prefix (got "${chat.name}")`
      ).toBe(true);
    }
    // Shape check on the remaining chats: connectorPlatform is a nullable
    // field — human chats serialize null, and PRIOR-PHASE connector chats
    // (e.g. the seeded telegram connectors' sessions from 198 runs) carry
    // their own platform string. A non-discord chat must therefore never
    // read "discord" — that is the only cross-platform invariant.
    const humanChats = chats.filter((c) => c.connectorPlatform !== "discord");
    for (const chat of humanChats) {
      expect(
        chat.connectorPlatform === "discord",
        `a non-discord chat must never carry connectorPlatform "discord" (got ${JSON.stringify(chat.connectorPlatform)} on "${chat.name}")`
      ).toBe(false);
    }
  });

  test("(c3) gateway 4004 → healthStatus 'error' + token-free lastError (the REAL close path)", async ({ request }) => {
    test.skip(!setup, skipReason ?? "setup incomplete");
    // Re-arm the fake gateway (default armed posture — 4004 after identify).
    const armRes = await request.post(`${HELPER_BASE}/start`, { timeout: 8000 });
    expect(armRes.ok(), `armed start failed: ${armRes.status()}`).toBeTruthy();

    // A fresh connector whose real GatewayClient identifies against the
    // ARMED fake → the fake closes with 4004 → the REAL close handler flips
    // health (D-06) — no mock of the manager, the protocol path is real.
    const connector = await createConnector(request, setup!.adminToken, {
      botToken: "invalid-gateway-token",
      name: `E2E Discord 4004 ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
    const connectorId = connector.id as string;
    createdConnectorIds.push(connectorId);

    const deadline = Date.now() + 15_000;
    let flipped: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const res = await request.get(`${SERVER_URL}/api/connectors/${connectorId}`, {
        headers: { Authorization: `Bearer ${setup!.adminToken}` },
        timeout: 8000,
      });
      if (res.ok()) {
        const body = (await res.json()) as Record<string, unknown>;
        if (body.healthStatus === "error") {
          flipped = body;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(flipped, "the 4004 close must flip healthStatus to 'error'").toBeTruthy();
    expect(
      String(flipped!.lastError ?? ""),
      "lastError must name the gateway auth failure"
    ).toContain("4004");
    // T-199-11: the token NEVER appears in lastError.
    expect(String(flipped!.lastError)).not.toContain("invalid-gateway-token");
    // D-06: the connector stays ENABLED (no auto-disable).
    expect(flipped!.isEnabled).toBe(true);

    // Restore the idle posture for the teardown (the armed fake 4004s any
    // new identify — the afterAll delete's sync must not matter, but keep
    // the module state clean anyway).
    const disarmRes = await request.post(`${HELPER_BASE}/start`, {
      data: { gatewayIdle: true },
      timeout: 8000,
    });
    expect(disarmRes.ok()).toBeTruthy();
  });
});