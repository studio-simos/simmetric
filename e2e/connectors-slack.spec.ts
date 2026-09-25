/**
 * Phase 200 (200-05 Task 2, D-15) — E2E full-mock: the Slack connector
 * vertical (pattern e2e/connectors-telegram.spec.ts, the 198-04 doctrine).
 *
 * FULL-MOCK DOCTRINE (mcp-pin-use.spec.ts header): the REAL server boots
 * from the playwright webServer (tsx plain, E2E_RUN=1); EVERY external
 * dependency is faked IN-PROCESS — zero real network egress in CI:
 *   - Slack Web API: the in-process fake (slackApiEndpoint.ts) bound to
 *     127.0.0.1 on an ephemeral port; the server's SLACK_API_URL is
 *     overridden at runtime via the dev-only helper (the
 *     setSlackApiBaseOverride seam, 200-01). The adapter's chat.postMessage
 *     fetches hit the fake, never slack.com/api.
 *   - Slack-to-US direction (Events API deliveries): produced BY THE SPEC
 *     hitting the REAL server webhook route (/api/connectors/slack/
 *     <connectorId>/webhook) with locally-computed X-Slack-Signature HMAC
 *     headers — the production signature gate runs for real (tampered/
 *     stale arms prove the boundary), never bypassed by the fixture.
 *   - Agent LLM: the connector pipeline's agent seam (connectorChatService)
 *     is stubbed in-process via the dev-only agent-stub route (D-03).
 *
 * Setup (beforeAll):
 *   - admin login via API → JWT (globalSetup seeds admin/admin123)
 *   - POST /api/__tests__/slack-fake/start → { port } (override set)
 *   - POST .../slack-fake/agent-stub { reply } (canned agent reply)
 *   - POST /api/connectors (slack, botToken + signingSecret payload — the
 *     200-01 create fields persisted into configEncrypted) → 201
 *
 * Matrix (D-15, plan action 1):
 *   (a)   create → 201, hasBotToken true, hasSigningSecret true, NO secret
 *         field material
 *   (b)   signed url_verification POST → 200 { challenge } echo
 *   (c)   tampered body (valid signature over DIFFERENT bytes) → 403
 *   (d)   stale timestamp (ts = now-400, valid sig over it) → 403
 *   (e)   valid signed event_callback im message → 200 ACK → the fake's
 *         /chat.postMessage call log records the canned agent reply with
 *         channel = the inbound D-id (the pipeline ran REAL)
 *   (f)   duplicate delivery (same event_id) → single session message —
 *         ONE chat.postMessage in the log (dedup on the envelope event_id)
 *   (g)   21st message → the throttled limit reply exactly once
 *   (h)   unknown connectorId → 404
 *
 * Runtime budget: 6 test blocks, < ~2.5 min (short waits + poll loops; the
 * server is real, the externals are all in-process).
 *
 * Retry determinism: fresh D-id (channel) + per-attempt event-id bases per
 * block (the dedup arbiter is per-connector on platformMessageId =
 * event_id; the session window is per-channel) — a Playwright retry never
 * collides with a prior attempt's rows.
 */

import { test, expect, type APIRequestContext } from "./fixtures";
import crypto from "crypto";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (globalSetup-seeded, admin-owned)
const SERVER_URL = "http://localhost:3000";
const HELPER_BASE = `${SERVER_URL}/api/__tests__/slack-fake`;
/** The canned reply the agent-seam stub returns for every turn (D-03 analog). */
const CANNED_REPLY = "Canned E2E reply 200-05";
const LIMIT_TEXT = "You've reached the message limit for now. Please try again a bit later.";
/** The signing secret the spec's connector is created with (create-time field). */
const SIGNING_SECRET = "e2e-slack-signing-secret-200-05-0000";
/** The bot token value the spec's connector is created with (fake — never leaves). */
const BOT_TOKEN = "xoxb-e2e-fake-token-200-05";

/** Sign a body the way Slack does: v0=<hex> over "v0:<ts>:<body>". */
function slackSig(secret: string, body: string, ts: string): string {
  return "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
}

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
  path: string;
  hasAuthorization: boolean;
  body: Record<string, unknown>;
  at: string;
}

/** Fake Slack Web API log snapshot (Authorization presence-only — assertion surface). */
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

/** Create a slack connector; returns the serialized row (no secret field). */
async function createConnector(
  request: APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await request.post(`${SERVER_URL}/api/connectors`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      platform: "slack",
      name: `E2E Slack ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      workspaceId: WORKSPACE_ID,
      ...overrides,
    },
    timeout: 8000,
  });
  expect(res.status(), `connector create failed: ${res.status()}`).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * POST a signed Slack delivery through the REAL webhook route (platform-
 * prefixed path per the 200-01 route). Returns the raw status + body.
 */
async function postSlackEvent(
  request: APIRequestContext,
  connectorId: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await request.post(
    `${SERVER_URL}/api/connectors/slack/${connectorId}/webhook`,
    {
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Signature": slackSig(SIGNING_SECRET, payload, ts),
        "X-Slack-Request-Timestamp": ts,
      },
      data: body,
      timeout: 8000,
    }
  );
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** A signed im message event_callback envelope (fresh event id per call). */
function imEnvelope(
  eventId: string,
  channelId: string,
  text: string,
  userId = "U20005E2EUSER"
): Record<string, unknown> {
  return {
    type: "event_callback",
    event_id: eventId,
    team_id: "T20005",
    event: {
      type: "message",
      channel: channelId,
      channel_type: "im",
      user: userId,
      text,
      ts: "1735689600.000200",
    },
  };
}

/** The chat.postMessage log entries for ONE channel (the reply assertion surface). */
function postsTo(log: FakeLogEntry[], channelId: string): FakeLogEntry[] {
  return log.filter(
    (e) => e.method === "chat.postMessage" && e.body.channel === channelId
  );
}

interface Connector {
  id: string;
  adminToken: string;
}

let skipReason: string | undefined;
let setupConnector: Connector | undefined;

test.describe("200-05 — Slack connector E2E full-mock (D-15)", () => {
  test.beforeAll(async ({ request }) => {
    let adminToken: string;
    try {
      adminToken = await adminLoginToken(request);
    } catch (err) {
      skipReason = `admin login failed — E2E environment unavailable (${(err as Error).message})`;
      return;
    }

    // Start the in-process fake + runtime override (200-01 seam).
    const startRes = await request.post(`${HELPER_BASE}/start`, { timeout: 8000 }).catch(() => null);
    if (!startRes || !startRes.ok()) {
      skipReason = `slack-fake start failed (status ${startRes ? startRes.status() : "network error"}) — dev-only helper unreachable`;
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
    setupConnector = { id: connector.id as string, adminToken };
  });

  test.afterAll(async ({ request }) => {
    // Teardown: clear overrides FIRST (module reset — must not survive other
    // tests; one stop = full teardown incl. the agent seam), then delete the
    // connector row created by this run.
    await request.post(`${HELPER_BASE}/stop`, { timeout: 8000 }).catch(() => {});
    if (setupConnector?.adminToken) {
      await request.delete(`${SERVER_URL}/api/connectors/${setupConnector.id}`, {
        headers: { Authorization: `Bearer ${setupConnector.adminToken}` },
        timeout: 8000,
      }).catch(() => {});
    }
  });

  test("(a) create → 201 with hasBotToken + hasSigningSecret and NO secret material", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const res = await request.get(`${SERVER_URL}/api/connectors/${setupConnector!.id}`, {
      headers: { Authorization: `Bearer ${setupConnector!.adminToken}` },
      timeout: 8000,
    });
    expect(res.ok(), `connector detail failed: ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hasBotToken).toBe(true);
    expect(body.hasSigningSecret).toBe(true);
    expect(body.platform).toBe("slack");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("botTokenEncrypted");
    expect(serialized).not.toContain("xoxb-e2e-fake-token");
    expect(serialized).not.toContain("e2e-slack-signing-secret");
  });

  test("(b) signed url_verification → 200 { challenge } echo", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const challenge = `e2e-challenge-${Date.now()}`;
    const { status, body } = await postSlackEvent(
      request,
      setupConnector!.id,
      { type: "url_verification", challenge }
    );
    expect(status, `url_verification failed: ${status} ${JSON.stringify(body)}`).toBe(200);
    expect((body as { challenge?: string }).challenge).toBe(challenge);
  });

  test("(c) tampered body (valid signature over DIFFERENT bytes) → 403", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    // Sign the INNOCENT bytes, then send the TAMPERED bytes with that valid
    // signature — the route recomputes over the RECEIVED raw body and must
    // reject (the signature gate is never bypassed).
    const innocent = imEnvelope(`evt-tamper-${Date.now()}`, "D_tamper", "innocent");
    const innocentPayload = JSON.stringify(innocent);
    const ts = String(Math.floor(Date.now() / 1000));
    const validSig = slackSig(SIGNING_SECRET, innocentPayload, ts);
    const tampered = { ...innocent, event: { ...(innocent.event as Record<string, unknown>), text: "TAMPERED" } };
    const res = await request.post(
      `${SERVER_URL}/api/connectors/slack/${setupConnector!.id}/webhook`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Signature": validSig,
          "X-Slack-Request-Timestamp": ts,
        },
        data: tampered,
        timeout: 8000,
      }
    );
    expect(res.status(), `tampered body must 403 (got ${res.status()})`).toBe(403);
  });

  test("(d) stale timestamp (ts = now-400) → 403 (anti-replay)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const payload = JSON.stringify(imEnvelope(`evt-stale-${Date.now()}`, "D_stale", "stale probe"));
    const staleTs = String(Math.floor(Date.now() / 1000) - 400);
    const res = await request.post(
      `${SERVER_URL}/api/connectors/slack/${setupConnector!.id}/webhook`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Signature": slackSig(SIGNING_SECRET, payload, staleTs),
          "X-Slack-Request-Timestamp": staleTs,
        },
        data: payload,
        timeout: 8000,
      }
    );
    expect(res.status(), `stale timestamp must 403 (got ${res.status()})`).toBe(403);
  });

  test("(e) valid signed event_callback im message → 200 ACK + chat.postMessage log carries the canned reply to the inbound D-id", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const dmId = `D${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { status } = await postSlackEvent(
      request,
      setupConnector!.id,
      imEnvelope(`evt-${dmId}`, dmId, "hello slack bot")
    );
    expect(status, "a valid signed delivery must ACK 200").toBe(200);

    const log = await waitForLog(request, (l) =>
      postsTo(l, dmId).some((e) => (e.body.text as string)?.includes(CANNED_REPLY))
    );
    const reply = postsTo(log, dmId).find(
      (e) => (e.body.text as string)?.includes(CANNED_REPLY)
    );
    expect(
      reply,
      `the canned agent reply must be posted to the inbound D-id channel (log entries: ${log.length})`
    ).toBeTruthy();
    // The Authorization header presence rides the send (the adapter authed).
    expect(reply!.hasAuthorization).toBe(true);
  });

  test("(f) duplicate delivery (same event_id) → single session message: ONE chat.postMessage (dedup)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const dmId = `D${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const eventId = `evt-dedup-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const envelope = imEnvelope(eventId, dmId, "dedup probe");

    const first = await postSlackEvent(request, setupConnector!.id, envelope);
    expect(first.status).toBe(200);
    await waitForLog(request, (l) =>
      postsTo(l, dmId).some((e) => (e.body.text as string)?.includes(CANNED_REPLY))
    );

    // Capture the reply count for THIS channel, then replay the SAME event_id.
    const before = postsTo(await fakeLog(request), dmId).length;
    const second = await postSlackEvent(request, setupConnector!.id, envelope);
    expect(second.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500)); // async arm flush window

    const after = postsTo(await fakeLog(request), dmId).length;
    expect(after, "a duplicate event_id must not trigger a second reply").toBe(before);
  });

  test("(g) 21st message → the throttled limit reply exactly once (D-10)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");

    // FRESH D-id (channel) — the D-10 window is per-session (fresh channel =
    // clean counter) and the dedup arbiter is (connectorId, event_id) per
    // CONNECTOR, so a Playwright retry must also shift its event ids or
    // attempt 1's in-rows would dedup attempt 2's envelopes.
    const dmId = `D${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const idBase = 20_000_000 + Math.floor(Math.random() * 5_000_000);

    // The session's rolling window (default 20/h) starts clean for this
    // fresh channel. 20 accepted messages → each gets the agent reply; the
    // 21st trips the limiter → the limit reply sent once.
    //
    // ARRIVAL PACING (determinism): each message awaits its canned reply in
    // the fake's log BEFORE the next post — a fully-serialized legal arrival
    // pattern. The production withSessionLock has a release/delete gap that
    // can run two burst bodies concurrently under a piled-up burst (the
    // pre-existing 198 D-09 race, documented in the plan SUMMARY); pacing
    // sidesteps that race so the D-10 trip itself is what the block proves.
    for (let i = 0; i < 21; i++) {
      const { status } = await postSlackEvent(
        request,
        setupConnector!.id,
        imEnvelope(`evt-limit-${idBase + i}`, dmId, `limit probe ${i}`)
      );
      expect(status, `message ${i} must ACK 200`).toBe(200);
      if (i < 20) {
        // The window is per-session regardless of pacing: message i+1 posts
        // only after message i's reply reached the fake. The log
        // ACCUMULATES, so the gate keys on the COUNT of canned replies for
        // this channel (a `some` predicate would pass on the first reply
        // forever and never pace anything).
        const target = i + 1;
        await waitForLog(
          request,
          (l) =>
            postsTo(l, dmId).filter((e) => (e.body.text as string)?.includes(CANNED_REPLY))
              .length >= target
        );
      }
    }

    const log = await waitForLog(
      request,
      (l) =>
        postsTo(l, dmId).some((e) => (e.body.text as string)?.includes(LIMIT_TEXT)),
      { timeoutMs: 20_000 }
    );
    const limitReplies = postsTo(log, dmId).filter(
      (e) => (e.body.text as string)?.includes(LIMIT_TEXT)
    );
    // Diagnostic on failure: the per-channel postMessage texts the fake saw.
    const sentTexts = postsTo(log, dmId).map((e) => String(e.body.text ?? "").slice(0, 40));
    expect(
      limitReplies.length,
      `throttled reply exactly once (sent ${sentTexts.length}: ${sentTexts.slice(0, 4).join(" | ")})`
    ).toBe(1);
  });

  test("(h) unknown connectorId → 404 (pre-secret indistinguishable)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const unknownId = "550e8400-e29b-41d4-a716-44665544ff05";
    const payload = JSON.stringify(imEnvelope(`evt-404-${Date.now()}`, "D_404", "should 404"));
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request.post(
      `${SERVER_URL}/api/connectors/slack/${unknownId}/webhook`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Signature": slackSig(SIGNING_SECRET, payload, ts),
          "X-Slack-Request-Timestamp": ts,
        },
        data: payload,
        timeout: 8000,
      }
    );
    expect(res.status(), "an unknown connector id must 404 (D-15)").toBe(404);
  });
});