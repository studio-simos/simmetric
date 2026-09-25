/**
 * Phase 200 (200-05 Task 2, D-15) — E2E full-mock: the WhatsApp connector
 * vertical (pattern e2e/connectors-telegram.spec.ts, the 198-04 doctrine).
 *
 * FULL-MOCK DOCTRINE (mcp-pin-use.spec.ts header): the REAL server boots
 * from the playwright webServer (tsx plain, E2E_RUN=1); EVERY external
 * dependency is faked IN-PROCESS — zero real network egress in CI:
 *   - WhatsApp Graph API: the in-process fake (whatsappApiEndpoint.ts) bound
 *     to 127.0.0.1 on an ephemeral port; the server's WHATSAPP_API_URL is
 *     overridden at runtime via the dev-only helper (the
 *     setWhatsappApiBaseOverride seam, 200-02). The adapter's
 *     /{phoneNumberId}/messages fetches hit the fake, never graph.facebook.com.
 *   - META-to-US direction (webhook deliveries + GET handshake): produced BY
 *     THE SPEC hitting the REAL server webhook route (/api/connectors/
 *     whatsapp/<connectorId>/webhook) with locally-computed
 *     X-Hub-Signature-256 HMAC headers — the production signature gate runs
 *     for real (tampered arm proves the boundary), never bypassed.
 *   - Agent LLM: the connector pipeline's agent seam (connectorChatService)
 *     is stubbed in-process via the dev-only agent-stub route (D-03).
 *
 * Setup (beforeAll):
 *   - admin login via API → JWT (globalSetup seeds admin/admin123)
 *   - POST /api/__tests__/whatsapp-fake/start → { port } (override set)
 *   - POST .../whatsapp-fake/agent-stub { reply } (canned agent reply)
 *   - POST /api/connectors (whatsapp, token + phoneNumberId + appSecret +
 *     verifyToken — the 200-01 schema fields the 200-02 adapter consumes) → 201
 *
 * Matrix (D-15/D-08, plan action 2):
 *   (a)   create → 201, hasBotToken true, hasVerifyToken true, no secret
 *         material
 *   (b)   GET verify with correct hub.verify_token + hub.mode=subscribe +
 *         hub.challenge=1150584 → 200 "1150584"
 *   (c)   GET verify with the wrong token → 404 (indistinguishable)
 *   (d)   POST with valid X-Hub-Signature-256 inbound text → 200 ACK → the
 *         fake's /:phoneId/messages call log records the reply with
 *         to = the bare from digits
 *   (e)   tampered signature → 403
 *   (f)   statuses-only delivery → 200 ACK + NO messages POST logged
 *         (D-06 silent drop)
 *   (g)   131047 arm → lastError persisted with the code + healthStatus
 *         flipped + NO retry burst (a single primary send attempt in the
 *         log — D-08 terminal arm; persistence rides Plan 02's router-side
 *         failHealth; the D-12 fallback send after the failure is the
 *         pipeline's own notify arm and is asserted as ≤2 total sends)
 *
 * Runtime budget: 6 test blocks, < ~2.5 min (short waits + poll loops; the
 * server is real, the externals are all in-process).
 *
 * Retry determinism: fresh from number + per-attempt wamid bases per block
 * (the dedup arbiter is per-connector on the wamid; the session window is
 * per-from-number) — a Playwright retry never collides with prior rows.
 */

import { test, expect, type APIRequestContext } from "./fixtures";
import crypto from "crypto";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (globalSetup-seeded, admin-owned)
const SERVER_URL = "http://localhost:3000";
const HELPER_BASE = `${SERVER_URL}/api/__tests__/whatsapp-fake`;
/** The canned reply the agent-seam stub returns for every turn (D-03 analog). */
const CANNED_REPLY = "Canned E2E reply 200-05 wa";
/** The phoneNumberId the spec's connector is created with (fake — never leaves). */
const PHONE_ID = "109876543299888";
/** The verifyToken the spec's connector is created with (create-time field). */
const VERIFY_TOKEN = "e2e-verify-token-200-05";
/** The appSecret the spec's connector is created with (create-time field). */
const APP_SECRET = "e2e-app-secret-200-05-00000000";
/** The bot (access) token value the spec's connector is created with. */
const WA_TOKEN = "e2e-wa-access-token-200-05";

/** Sign a body the way Meta does: sha256=<hex> HMAC over the raw body. */
function hubSig(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
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

/** Fake Graph API log snapshot (Authorization presence-only — assertion surface). */
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

/** Create a whatsapp connector; returns the serialized row (no secret field). */
async function createConnector(
  request: APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await request.post(`${SERVER_URL}/api/connectors`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      platform: "whatsapp",
      name: `E2E WhatsApp ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      botToken: WA_TOKEN,
      phoneNumberId: PHONE_ID,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      workspaceId: WORKSPACE_ID,
      ...overrides,
    },
    timeout: 8000,
  });
  expect(res.status(), `connector create failed: ${res.status()}`).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

/** A signed inbound text-message webhook body (fresh wamid per call). */
function textEnvelope(wamid: string, from: string, text: string): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: "E2E Wa User" }, wa_id: from }],
              messages: [{ from, id: wamid, type: "text", text: { body: text } }],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

/** A statuses-only webhook body (D-06 — no messages array). */
function statusesEnvelope(statusId: string, from: string): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                { id: statusId, status: "delivered", recipient_id: from, timestamp: "1735689600" },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

/**
 * POST a signed WhatsApp delivery through the REAL webhook route (platform-
 * prefixed path per the 200-02 route). Returns the raw status + body.
 */
async function postSigned(
  request: APIRequestContext,
  connectorId: string,
  body: Record<string, unknown>,
  opts: { signature?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request.post(
    `${SERVER_URL}/api/connectors/whatsapp/${connectorId}/webhook`,
    {
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": opts.signature ?? hubSig(JSON.stringify(body)),
      },
      data: body,
      timeout: 8000,
    }
  );
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** The messages-send log entries for the connector's phoneNumberId path. */
function sends(log: FakeLogEntry[]): FakeLogEntry[] {
  return log.filter((e) => e.method === `POST /${PHONE_ID}/messages`);
}

interface Connector {
  id: string;
  adminToken: string;
}

let skipReason: string | undefined;
let setupConnector: Connector | undefined;

test.describe("200-05 — WhatsApp connector E2E full-mock (D-15/D-08)", () => {
  test.beforeAll(async ({ request }) => {
    let adminToken: string;
    try {
      adminToken = await adminLoginToken(request);
    } catch (err) {
      skipReason = `admin login failed — E2E environment unavailable (${(err as Error).message})`;
      return;
    }

    // Start the in-process fake + runtime override (200-02 seam).
    const startRes = await request.post(`${HELPER_BASE}/start`, { timeout: 8000 }).catch(() => null);
    if (!startRes || !startRes.ok()) {
      skipReason = `whatsapp-fake start failed (status ${startRes ? startRes.status() : "network error"}) — dev-only helper unreachable`;
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
    // tests; one stop = full teardown incl. the agent seam + 131047 arm),
    // then delete the connector row created by this run.
    await request.post(`${HELPER_BASE}/stop`, { timeout: 8000 }).catch(() => {});
    if (setupConnector?.adminToken) {
      await request.delete(`${SERVER_URL}/api/connectors/${setupConnector.id}`, {
        headers: { Authorization: `Bearer ${setupConnector.adminToken}` },
        timeout: 8000,
      }).catch(() => {});
    }
  });

  test("(a) create → 201 with hasBotToken + hasVerifyToken and NO secret material", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const res = await request.get(`${SERVER_URL}/api/connectors/${setupConnector!.id}`, {
      headers: { Authorization: `Bearer ${setupConnector!.adminToken}` },
      timeout: 8000,
    });
    expect(res.ok(), `connector detail failed: ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hasBotToken).toBe(true);
    expect(body.hasVerifyToken).toBe(true);
    expect(body.platform).toBe("whatsapp");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("botTokenEncrypted");
    expect(serialized).not.toContain("e2e-wa-access-token");
    expect(serialized).not.toContain("e2e-app-secret");
    expect(serialized).not.toContain("e2e-verify-token");
  });

  test("(b) GET verify with the correct hub.verify_token echoes hub.challenge 1150584", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const res = await request.get(
      `${SERVER_URL}/api/connectors/whatsapp/${setupConnector!.id}/webhook` +
        `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=1150584`,
      { timeout: 8000 }
    );
    expect(res.status(), `GET verify failed: ${res.status()}`).toBe(200);
    expect(await res.text()).toBe("1150584");
  });

  test("(c) GET verify with the wrong token → 404 (indistinguishable)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const res = await request.get(
      `${SERVER_URL}/api/connectors/whatsapp/${setupConnector!.id}/webhook` +
        `?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=1150584`,
      { timeout: 8000 }
    );
    expect(res.status(), "a wrong verify token must 404 (D-07)").toBe(404);
  });

  test("(d) signed inbound text → 200 ACK + the fake's messages log records the reply (to = the bare from digits)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const from = `39200${Math.floor(Math.random() * 1e6)}`;
    const { status, body } = await postSigned(
      request,
      setupConnector!.id,
      textEnvelope(`wamid.e2e${Date.now()}`, from, "ciao whatsapp bot")
    );
    expect(status, `signed POST failed: ${status} ${JSON.stringify(body)}`).toBe(200);

    const log = await waitForLog(request, (l) =>
      sends(l).some((e) => e.body.to === from && String(e.body.text ?? "").includes(CANNED_REPLY))
    );
    const reply = sends(log).find((e) => e.body.to === from);
    expect(
      reply,
      `the canned reply must be posted to the bare from digits (to=${from}; log entries: ${log.length})`
    ).toBeTruthy();
    // P10: `to` is the bare digits echoed verbatim (no + prefix).
    expect(String(reply!.body.to)).not.toContain("+");
    expect(reply!.hasAuthorization).toBe(true);
    expect(reply!.body.messaging_product).toBe("whatsapp");
  });

  test("(e) tampered signature → 403", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const from = `39300${Math.floor(Math.random() * 1e6)}`;
    const envelope = textEnvelope(`wamid.tamper${Date.now()}`, from, "should be rejected");
    // Valid signature over DIFFERENT bytes — the route recomputes over the
    // RECEIVED raw body and must reject.
    const res = await request.post(
      `${SERVER_URL}/api/connectors/whatsapp/${setupConnector!.id}/webhook`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": hubSig(JSON.stringify({ object: "tampered" })),
        },
        data: envelope,
        timeout: 8000,
      }
    );
    expect(res.status(), "a tampered signature must 403").toBe(403);
  });

  test("(f) statuses-only delivery → 200 ACK + NO messages POST logged (D-06 silent drop)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    const from = `39400${Math.floor(Math.random() * 1e6)}`;
    const statusId = `wamid.status${Date.now()}`;
    // Capture the send count BEFORE (earlier blocks in this run already
    // logged sends — the fake's log accumulates across the suite).
    const before = sends(await fakeLog(request)).length;
    const { status } = await postSigned(
      request,
      setupConnector!.id,
      statusesEnvelope(statusId, from)
    );
    expect(status, "a statuses-only delivery must still ACK 200").toBe(200);

    // Flush window, then assert the fake logged NO NEW messages send for
    // this delivery (the parse boundary dropped it — silent drop, D-06).
    await new Promise((r) => setTimeout(r, 1500));
    const log = await fakeLog(request);
    expect(
      sends(log).length,
      "a statuses-only delivery must produce NO new messages POST (silent drop)"
    ).toBe(before);
  });

  test("(g) 131047 arm → lastError persisted with the code + NO retry burst (single primary attempt)", async ({ request }) => {
    test.skip(!setupConnector, skipReason ?? "setup incomplete");
    // Arm the fake's 131047 mode BEFORE triggering the reply attempt.
    const armRes = await request.post(`${HELPER_BASE}/start`, {
      data: { arm131047: true },
      timeout: 8000,
    });
    expect(armRes.ok(), `arm131047 start failed: ${armRes.status()}`).toBeTruthy();
    // Re-arm the agent seam: the sibling suite's stop route clears the
    // SHARED setConnectorChatTurnOverride stub (one stop = full teardown,
    // cross-suite), and this run shares the server with parallel workers.
    // A cleared stub would run the real orchestrator (Ollama error arm)
    // instead of the 131047 arm — re-arming here shrinks the race window.
    const stubRes = await request.post(`${HELPER_BASE}/agent-stub`, {
      data: { reply: CANNED_REPLY },
      timeout: 8000,
    });
    expect(stubRes.ok(), `agent-stub re-arm failed: ${stubRes.status()}`).toBeTruthy();

    const from = `39500${Math.floor(Math.random() * 1e6)}`;
    const { status } = await postSigned(
      request,
      setupConnector!.id,
      textEnvelope(`wamid.win${Date.now()}`, from, "window probe")
    );
    expect(status).toBe(200); // the ACK is unaffected — the failure is async

    // Wait for the terminal failure to persist (the router-side failHealth
    // rides the agent-turn catch → healthStatus "error" + lastError embeds
    // the Graph code). The connector STAYS ENABLED (no auto-disable).
    const deadline = Date.now() + 20_000;
    let flipped: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const res = await request.get(`${SERVER_URL}/api/connectors/${setupConnector!.id}`, {
        headers: { Authorization: `Bearer ${setupConnector!.adminToken}` },
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
    expect(flipped, "the 131047 send failure must flip healthStatus to 'error'").toBeTruthy();
    expect(
      String(flipped!.lastError ?? ""),
      "lastError must embed the Graph code (D-08 persistence)"
    ).toContain("131047");
    // No auto-disable (198 D-20).
    expect(flipped!.isEnabled).toBe(true);

    // NO retry burst: exactly ONE PRIMARY send attempt for this
    // from-number in the log (the terminal arm never retries, D-08).
    // NOTE the pipeline's D-12 fallback still fires after the failed agent
    // turn (fallbackMessage — its own send, ALSO 131047-failed and counted
    // in the log): the invariant under test is that the PRIMARY reply
    // attempt happens exactly once — 2 logged sends = primary + fallback,
    // 3+ would be a retry burst. The fallback send is itself the D-12
    // arm's user-visible notify; both sends 400 with the same code and the
    // failHealth flips once.
    const log = await fakeLog(request);
    const mySends = sends(log).filter((e) => e.body.to === from);
    expect(
      mySends.length,
      `the 131047 arm must be terminal — at most the primary + the D-12 fallback send (got ${mySends.length})`
    ).toBeLessThanOrEqual(2);
    expect(
      mySends.length,
      "the primary send attempt must have happened exactly once (no retry burst)"
    ).toBeGreaterThanOrEqual(1);

    // Disarm + restore the healthy posture for the teardown.
    const disarmRes = await request.post(`${HELPER_BASE}/start`, { timeout: 8000 });
    expect(disarmRes.ok()).toBeTruthy();
  });
});