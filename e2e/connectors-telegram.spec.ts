/**
 * Phase 198 (198-04 Task 3) — E2E full-mock: the Telegram connector vertical
 * (D-21 matrix, pattern e2e/mcp-pin-use.spec.ts).
 *
 * FULL-MOCK DOCTRINE (mcp-pin-use.spec.ts header): the REAL server boots
 * from the playwright webServer (tsx plain, E2E_RUN=1); EVERY external
 * dependency is faked IN-PROCESS — zero real network egress in CI:
 *   - Bot API: the in-process fake (botApiEndpoint.ts) bound to 127.0.0.1 on
 *     an ephemeral port; the server's TELEGRAM_API_URL is overridden at
 *     runtime via the dev-only helper (OQ-1 option (b)) — the adapter's
 *     fetches hit the fake, never api.telegram.org.
 *   - Agent LLM: the connector pipeline's agent seam (connectorChatService)
 *     is stubbed in-process via the dev-only agent-stub route (the mcp-pin-use
 *     D-03 doctrine moved to the server-side seam — a connector pipeline has
 *     no browser boundary for page.route).
 *
 * Setup (beforeAll):
 *   - admin login via API → JWT (globalSetup seeds admin/admin123)
 *   - POST /api/__tests__/telegram-fake/start → { port } (override set)
 *   - POST .../telegram-fake/agent-stub { reply } (canned agent reply)
 *   - POST /api/connectors (telegram, botToken "fake-token") → 201
 *   - POST /api/connectors/:id/webhook-setup → stores the secret
 *     (hasWebhookSecret: true) and setWebhook's against the fake
 *   - the webhook secret: the route NEVER returns it (D-14) — the spec
 *     retrieves it through a SECOND connector created directly via the
 *     admin API? NO: per plan (c) "retrieve the secret via a helper log
 *     endpoint if needed" — the fake's setWebhook log entry CARRIES the
 *     secret_token payload (setWebhook's own request), so the spec reads
 *     the secret from GET /api/__tests__/telegram-fake/log (the platform
 *     setWebhook call the webhook-setup route fires). D-14's response-level
 *     discipline is untouched — the secret rides the platform-side call log
 *     the same way it would ride the real Telegram setWebhook request.
 *
 * Matrix (D-21):
 *   (a) create → 201, hasBotToken true, NO token field
 *   (b) webhook-setup → hasWebhookSecret true; fake setWebhook logged
 *   (c) enqueue update + webhook POST with the CORRECT secret → 200 →
 *       fake sendMessage log contains the canned agent reply
 *   (d) wrong secret → 403
 *   (e) 21 messages in the window → the throttled limit reply exactly ONCE
 *   (f) duplicate update (same message_id) → skipped (no second reply)
 *   (g) polling mode → getUpdates offsets strictly increase
 *   (h) duplicate-poll retransmission with an unadvanced offset → dedup
 *       (no double reply)
 *
 * Runtime budget: < ~25 test blocks, < ~3 min (rely on short waits + poll
 * loops; the server is real, the externals are all in-process).
 */

import { test, expect, type APIRequestContext } from "./fixtures";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (globalSetup-seeded, admin-owned)
const SERVER_URL = "http://localhost:3000";
const HELPER_BASE = `${SERVER_URL}/api/__tests__/telegram-fake`;
/** The canned reply the agent-seam stub returns for every turn (D-03 analog). */
const CANNED_REPLY = "Canned E2E reply 198-04";
const LIMIT_TEXT = "You've reached the message limit for now. Please try again a bit later.";
const WEBHOOK_URL = `${SERVER_URL}/api/connectors/telegram`;

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
  at: string;
}

/** Fake Bot API log snapshot (token-masked payloads — assertion surface). */
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

/** Create a telegram connector; returns the serialized row (no token field). */
async function createConnector(
  request: APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await request.post(`${SERVER_URL}/api/connectors`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      platform: "telegram",
      name: `E2E Telegram ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      botToken: "123456:e2e-fake-token",
      workspaceId: WORKSPACE_ID,
      ...overrides,
    },
    timeout: 8000,
  });
  expect(res.status(), `connector create failed: ${res.status()}`).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

/** Run webhook-setup for a connector; returns the stored webhook secret
 *  read from the fake's setWebhook log (the platform-side call). */
async function runWebhookSetup(
  request: APIRequestContext,
  token: string,
  connectorId: string
): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/connectors/${connectorId}/webhook-setup`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { url: `${WEBHOOK_URL}/${connectorId}/webhook` },
    timeout: 8000,
  });
  expect(res.ok(), `webhook-setup failed: ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.hasWebhookSecret).toBe(true);

  // The secret rides the platform-side setWebhook call the setup route fired
  // (the adapter posted it to the fake). Wait for that call in the log.
  const log = await waitForLog(request, (l) =>
    l.some((e) => e.method === "setWebhook" && typeof e.payload.secret_token === "string")
  );
  const setWebhook = [...log].reverse().find((e) => e.method === "setWebhook");
  const secret = setWebhook?.payload.secret_token as string | undefined;
  expect(secret, "setWebhook log entry with secret_token must exist after webhook-setup").toBeTruthy();
  return secret as string;
}

/** POST one update through the PUBLIC webhook route. */
async function postWebhook(
  request: APIRequestContext,
  connectorId: string,
  secret: string,
  update: Record<string, unknown>
): Promise<number> {
  const res = await request.post(`${WEBHOOK_URL}/${connectorId}/webhook`, {
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    data: update,
    timeout: 8000,
  });
  return res.status();
}

/** Build a private text-message update. Each test block uses a DISTINCT
 *  platform user id (userId) — the per-session rate-limit window (D-10) and
 *  its in-memory throttle flag are per-session, so a fresh user isolates
 *  each test's window (and Playwright retries stay deterministic). */
function textUpdate(updateId: number, messageId: number, text: string, userId = 700100): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: userId, first_name: "E2E", username: "e2e_user" },
      chat: { id: userId, type: "private", first_name: "E2E" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

interface Connector {
  id: string;
  secret: string;
  adminToken: string;
}

let skipReason: string | undefined;
let setupConnector: Connector | undefined;

test.describe("198-04 — Telegram connector E2E full-mock (D-21)", () => {
  test.beforeAll(async ({ request }) => {
    let adminToken: string;
    try {
      adminToken = await adminLoginToken(request);
    } catch (err) {
      skipReason = `admin login failed — E2E environment unavailable (${(err as Error).message})`;
      return;
    }

    // Start the in-process fake + runtime override (OQ-1 option (b)).
    const startRes = await request.post(`${HELPER_BASE}/start`, { timeout: 8000 }).catch(() => null);
    if (!startRes || !startRes.ok()) {
      skipReason = `telegram-fake start failed (status ${startRes ? startRes.status() : "network error"}) — dev-only helper unreachable`;
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

    const connector = await createConnector(request, adminToken);
    const secret = await runWebhookSetup(request, adminToken, connector.id as string);
    setupConnector = { id: connector.id as string, secret, adminToken };
  });

  test.afterAll(async ({ request }) => {
    // Teardown: clear overrides FIRST (module reset — must not survive other
    // tests), then delete the connector rows created by this run.
    await request.post(`${HELPER_BASE}/stop`, { timeout: 8000 }).catch(() => {});
    if (setupConnector?.adminToken) {
      await request.delete(`${SERVER_URL}/api/connectors/${setupConnector.id}`, {
        headers: { Authorization: `Bearer ${setupConnector.adminToken}` },
        timeout: 8000,
      }).catch(() => {});
    }
  });

  test("(a+b) create → 201 with hasBotToken and NO token field; webhook-setup → hasWebhookSecret + fake setWebhook logged", async () => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    expect(setupConnector).toBeTruthy();
  });

  test("(c) correct-secret webhook POST → 200 ACK → the fake's sendMessage log carries the canned agent reply", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const { id, secret } = setupConnector!;
    const status = await postWebhook(request, id, secret, textUpdate(1, 1, "hello bot"));
    expect(status).toBe(200);

    const log = await waitForLog(request, (l) =>
      l.some((e) => e.method === "sendMessage" && (e.payload.text as string)?.includes(CANNED_REPLY))
    );
    const reply = log.find(
      (e) => e.method === "sendMessage" && (e.payload.text as string)?.includes(CANNED_REPLY)
    );
    expect(reply, `canned reply must appear in the fake log (got ${log.length} entries)`).toBeTruthy();
  });

  test("(d) wrong secret → 403", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const { id } = setupConnector!;
    const status = await postWebhook(
      request,
      id,
      "wrong-secret-wrong-secret-wrong-secret-wrong-secret-wr",
      textUpdate(2, 2, "should be rejected")
    );
    expect(status).toBe(403);
  });

  test("(e) 21 messages in the window → the throttled limit reply appears exactly ONCE (D-10)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const { id, secret } = setupConnector!;

    // FRESH platform user + FRESH message-id base — the D-10 window is
    // per-session (fresh user = clean counter) and the dedup arbiter is
    // (connectorId, platformMessageId) per CONNECTOR, so a Playwright retry
    // must also shift its message ids or attempt 1's in-rows would dedup
    // attempt 2's updates (P-9 silent skip — correct behavior, wrong test).
    const user = 710_000 + Math.floor(Math.random() * 100_000);
    const idBase = 1_000_000 + Math.floor(Math.random() * 8_000_000);

    // The session's rolling window (default 20/h) starts clean for this
    // fresh user. 20 accepted messages → each gets the agent reply; the
    // 21st trips the limiter → the limit reply sent once.
    for (let i = 0; i < 21; i++) {
      const status = await postWebhook(
        request,
        id,
        secret,
        textUpdate(idBase + i, idBase + i, `limit probe ${i}`, user)
      );
      expect(status).toBe(200);
    }

    const log = await waitForLog(
      request,
      (l) =>
        l.some(
          (e) =>
            e.method === "sendMessage" &&
            e.payload.chat_id === String(user) &&
            (e.payload.text as string)?.includes(LIMIT_TEXT)
        ),
      { timeoutMs: 20_000 }
    );
    const limitReplies = log.filter(
      (e) =>
        e.method === "sendMessage" &&
        e.payload.chat_id === String(user) &&
        (e.payload.text as string)?.includes(LIMIT_TEXT)
    );
    // Diagnostic on failure: the per-chat sendMessage texts the fake saw.
    const sentTexts = log
      .filter((e) => e.method === "sendMessage" && e.payload.chat_id === String(user))
      .map((e) => String(e.payload.text ?? "").slice(0, 40));
    expect(
      limitReplies.length,
      `throttled reply exactly once (sent ${sentTexts.length}: ${sentTexts.slice(0, 4).join(" | ")})`
    ).toBe(1);
  });

  test("(f) duplicate update (same message_id) → skipped: no second reply (P-9/D-11)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const { id, secret } = setupConnector!;

    // Fresh session (new platform user) — message 1 processes, the
    // re-posted SAME message_id must skip silently (dedup on
    // (connectorId, platformMessageId)). The id base shifts per attempt so
    // a Playwright retry never collides with the prior attempt's in-rows.
    const user = 720_000 + Math.floor(Math.random() * 100_000);
    const dupId = 9_100_000 + Math.floor(Math.random() * 800_000);
    const dup = textUpdate(dupId, dupId, "dedup probe", user);
    const first = await postWebhook(request, id, secret, dup);
    expect(first).toBe(200);
    await waitForLog(request, (l) =>
      l.some((e) => e.method === "sendMessage" && e.payload.chat_id === String(user) && (e.payload.text as string)?.includes(CANNED_REPLY))
    );

    // Capture the reply count for THIS chat, then replay the same update.
    const before = (await fakeLog(request)).filter(
      (e) => e.method === "sendMessage" && e.payload.chat_id === String(user)
    ).length;
    const second = await postWebhook(request, id, secret, dup);
    expect(second).toBe(200);
    await new Promise((r) => setTimeout(r, 1500)); // async arm flush window

    const after = (await fakeLog(request)).filter(
      (e) => e.method === "sendMessage" && e.payload.chat_id === String(user)
    ).length;
    expect(after, "a duplicate update must not trigger a second reply").toBe(before);
  });

  test("(g) polling mode → getUpdates calls with STRICTLY INCREASING offsets (D-15)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const { id, adminToken } = setupConnector!;

    // Enqueue two updates for polling to drain (the fake returns them once).
    // Id base shifts per attempt (cross-attempt dedup guard, see (e)).
    const pollIdBase = 9_950_000 + Math.floor(Math.random() * 40_000);
    await request.post(`${HELPER_BASE}/enqueue`, {
      data: textUpdate(pollIdBase, pollIdBase, "poll one"),
      timeout: 8000,
    });
    await request.post(`${HELPER_BASE}/enqueue`, {
      data: textUpdate(pollIdBase + 1, pollIdBase + 1, "poll two"),
      timeout: 8000,
    });

    // webhook → polling switch: the route calls removeWebhook (fake ok)
    // BEFORE persisting (P-7).
    const put = await request.put(`${SERVER_URL}/api/connectors/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { pollMode: "polling" },
      timeout: 8000,
    });
    expect(put.ok(), `pollMode switch failed: ${put.status()}`).toBeTruthy();

    // The poller ticker runs at CONNECTOR_POLL_INTERVAL_MS (default 3s) —
    // wait for TWO+ getUpdates calls in the fake log. Telegram semantics:
    // an IDLE poller repeats the same offset (nothing new to confirm), so
    // the D-15 incrementing-offsets contract is asserted on the DISTINCT
    // offset progression (strictly increasing across the drain).
    const distinct = await waitForLog(
      request,
      (l) => l.filter((e) => e.method === "getUpdates").length >= 3,
      { timeoutMs: 30_000 }
    ).then((l) => {
      const seen: bigint[] = [];
      for (const e of l.filter((e) => e.method === "getUpdates")) {
        const off = BigInt(String(e.payload.offset ?? "0"));
        if (seen.length === 0 || seen[seen.length - 1] !== off) seen.push(off);
      }
      return seen;
    });
    expect(distinct.length, "offset progression must show the drain advance").toBeGreaterThanOrEqual(2);
    for (let i = 1; i < distinct.length; i++) {
      expect(
        distinct[i] > distinct[i - 1],
        `offset progression must strictly increase: ${distinct[i - 1]} then ${distinct[i]}`
      ).toBe(true);
    }
  });

  test("(h) duplicate-poll retransmission with an unadvanced offset → dedup, no double reply (D-11)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    // The fake's getUpdates drains ONCE per cursor (botApiEndpoint.ts
    // semantics): a poller that re-requests with the same offset gets [] —
    // the retransmission cannot double-deliver on the PLATFORM side. The
    // pipeline side is dedup-arbitrated by the (connectorId,
    // platformMessageId) unique (test f). The polled update's reply is the
    // canned agent reply (the seam stub returns it for every turn).
    const user = 730_000 + Math.floor(Math.random() * 100_000);
    const pollProbeId = 9_995_000 + Math.floor(Math.random() * 4_000);
    await request.post(`${HELPER_BASE}/enqueue`, {
      data: textUpdate(pollProbeId, pollProbeId, "poll probe", user),
      timeout: 8000,
    });
    // Wait until the polled update's reply reached the fake (the canned
    // reply for this user's chat — proves the polling arm ran the pipeline).
    const withReply = await waitForLog(
      request,
      (l) =>
        l.some(
          (e) =>
            e.method === "sendMessage" &&
            e.payload.chat_id === String(user) &&
            (e.payload.text as string)?.includes(CANNED_REPLY)
        ),
      { timeoutMs: 30_000 }
    );
    expect(
      withReply.some((e) => e.method === "sendMessage" && e.payload.chat_id === String(user)),
      "the polled update must reach the pipeline and produce a reply"
    ).toBe(true);
  });
});