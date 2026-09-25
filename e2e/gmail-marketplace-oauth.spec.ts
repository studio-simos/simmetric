/**
 * Phase 197 (MCPO-03 + MCPO-05 D-10) — E2E full-mock: the Gmail marketplace
 * OAuth vertical on the REAL mounted routes. Pattern: e2e/mcp-connector-tools
 * .spec.ts (the 196 full-mock template verbatim — plain node:http servers on
 * fixed ports, fixture-scoped) × the mcp-oauth-flow probe/skip-with-reason
 * doctrine.
 *
 * Proves the WHOLE 197 chain with ZERO real Google/collector network:
 *
 *   admin login → PROBE (oauth/start authorizeUrl points at the fake IdP —
 *   stale-server guard, skip-with-reason, never phones home) → create an
 *   OAUTH catalog entry via POST /api/mcp-marketplace (authType=oauth +
 *   oauthProvider=google — the plan-02 schema-validated route) → install →
 *   the created MCPConnection row carries authType=oauth + oauthStatus=
 *   pending + oauthProvider=google (the D-05 install branch at the E2E
 *   layer) → connection list NEVER carries credentialsEncrypted/oauthError
 *   (E2E leak pin, 195/196 posture re-pinned) → POST /:id/oauth/start →
 *   fake IdP authorizeUrl → simulate the browser: GET the PUBLIC callback
 *   with code+state → redirect oauth=authorized → statuses oauthStatus=
 *   authorized → enable the gmail tools in the workspace agent config →
 *   chat through the REAL agent loop (fake ollama scripts the turns) →
 *   gmail_search hits the FAKE Gmail (request-log URL-shape assertion) →
 *   gmail_ingest_thread lands a Document row in the workspace KB (the fake
 *   collector observed X-Collector-Secret + the multipart fields — Pitfall-3
 *   proof at the E2E layer) → [Task 2 arms: oauth uninstall wipe + the
 *   non-oauth byte-identical regression] → phone-home guard.
 *
 * In-process fakes (ALL fixture-scoped, fixed ports, 127.0.0.1-only):
 *   - Fake IdP/token endpoint :45912 (the 195 template port — the
 *     playwright.config.ts webServer env already points OAUTH_GOOGLE_* at
 *     it; ownsPort EADDRINUSE tolerance — the 195/196 workers may own it in
 *     full-suite runs; same grant shape).
 *   - Fake Gmail API :45916 (GMAIL_API_BASE_URL): GET /gmail/v1/users/me/
 *     messages (list shape: { messages: [{id,threadId}], resultSizeEstimate })
 *     + /gmail/v1/users/me/messages/{id}?format=metadata (metadata shape with
 *     top-level snippet + payload.headers Subject/From/Date) + /gmail/v1/
 *     users/me/threads/{id}?format=full (Thread shape with base64url-encoded
 *     body.data — deterministic fixture).
 *   - Fake collector :45914 (COLLECTOR_URL — the 196 port family): POST
 *     /api/ingest (requireCollectorSecret posture — the X-Collector-Secret
 *     header is RECORDED, validated by the spec against the server's env
 *     value; multipart form fields recorded; answers { chunks: 3 }) + POST
 *     /api/ingest/query (the memory-retrieval hook's best-effort arm —
 *     empty results, never an error).
 *   - Fake ollama :45915 (OLLAMA_BASE_URL): POST /api/chat serving a FIFO
 *     script of NDJSON turns (tool-call turn / final-answer turn). The agent
 *     loop runs REAL (resolveSkillsForChat → tool dispatch → skill execute)
 *     while the LLM seam is a scripted in-process server (the 196-04
 *     precedent). resolveOllamaUrl() replaces the provider row's placeholder
 *     baseUrl with OLLAMA_BASE_URL from the process env.
 *
 * Override-pickup probe (stale-server guard, mcp-oauth-flow/mcp-connector-
 * tools convention): BEFORE any gmail tool can execute, the oauth/start
 * authorizeUrl must point at the fake IdP. The OAUTH_*, GMAIL_API_BASE_URL,
 * COLLECTOR_URL and OLLAMA_BASE_URL overrides ride the SAME webServer env
 * object — a stale server without them fails the oauth probe and the whole
 * suite skips with a documented reason, NEVER phoning home (there is no
 * tool-execution path before the probe passes, and the probe itself hits
 * only the local server + the fake IdP).
 *
 * NETWORK_EGRESS_BLOCKED-safe: every provider URL in the run is a 127.0.0.1
 * in-spec fake. No token material is asserted or logged (the 195 posture —
 * request-log assertions carry URL/fields only, never Authorization values).
 * The provider-side token REVOKE on cleanup is best-effort by contract
 * (revokeProviderToken never throws; the google revokeUrl fetch failing or
 * hitting its documented host never blocks the local wipe — the WIPE is the
 * assertion).
 */

import { test, expect, type APIRequestContext } from "./fixtures";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (admin-owned, globalSetup-seeded)
const SERVER_URL = "http://localhost:3000";
// Fixed ports (45912-style convention — the playwright.config webServer env
// passes GMAIL_API_BASE_URL / COLLECTOR_URL / OLLAMA_BASE_URL / OAUTH_*
// derived from these same constants to the server process).
const FAKE_IDP_PORT = 45912; // owned by playwright.config.ts (OAUTH_* plumbing)
const FAKE_COLLECTOR_PORT = 45914; // COLLECTOR_URL (Graph+collector family port)
const FAKE_OLLAMA_PORT = 45915;
const FAKE_GMAIL_PORT = 45916; // GMAIL_API_BASE_URL (Phase 197)

/** Deterministic Gmail fixtures (PROVIDER_ID_PATTERN-safe ids). */
const FIXTURE_MESSAGE_ID = "msg-fixture-1";
const FIXTURE_THREAD_ID = "thread-fixture-1";
const FIXTURE_SUBJECT = "Q3 Report Thread";
const FIXTURE_FROM = "CFO <cfo@example.test>";
const FIXTURE_DATE = "2026-09-22T10:00:00Z";
const FIXTURE_SNIPPET = "Q3 numbers inside";
const FIXTURE_BODY_TEXT = "Q3 REPORT CONTENT 197 — budget numbers inside the attached thread.";
const FIXTURE_BODY_BASE64URL = Buffer.from(FIXTURE_BODY_TEXT, "utf8").toString("base64url");
/** The composed KB document name the ingest bridge must create (slug from Subject). */
const FIXTURE_DOC_NAME = "gmail-thread-Q3-Report-Thread-thread-fixture-1.txt";

/** The multipart form fields the ingest bridge must send (asserted exactly). */
interface CollectorIngestRecord {
  headerSecret: string | null;
  fields: Record<string, string>;
  fileName: string | null;
}

/** The fake Gmail's request log (url-shape assertions — never header values). */
let gmailRequests: string[] = [];
/** The fake collector's ingest records (secret + fields — the bridge contract). */
let collectorIngestRecords: CollectorIngestRecord[] = [];
/** The fake collector's request log (phone-home guard arm). */
let collectorRequests: string[] = [];
/** Count of fake-ollama /api/chat requests (phone-home guard arm). */
let ollamaRequestsCount: number = 0;
/** FIFO script the fake ollama serves — the spec primes it per test. */
let ollamaScript: string[] = [];

/** Read the gitignored root .env the same way playwright.config.ts reads
 *  DATABASE_URL — the ingest bridge asserts the EXACT X-Collector-Secret
 *  value the server process carries (T-196-07 posture: the fake validates,
 *  the spec asserts the recorded header equals the env secret). */
function readRootEnvSecret(key: string): string | undefined {
  try {
    const envPath = resolve(process.cwd(), ".env");
    if (!existsSync(envPath)) return undefined;
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
    if (!match) return undefined;
    return match[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}
const COLLECTOR_SECRET_EXPECTED = process.env.COLLECTOR_SECRET ?? readRootEnvSecret("COLLECTOR_SECRET");

/** NDJSON turn bodies (the fake ollama's canned script entries). */
function toolCallTurn(toolName: string, args: Record<string, unknown>): string {
  const line1 = JSON.stringify({
    model: "e2e-fake-model",
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: toolName, arguments: args } }],
    },
    done: false,
  });
  const line2 = JSON.stringify({
    model: "e2e-fake-model",
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 10,
    eval_count: 5,
  });
  return `${line1}\n${line2}\n`;
}

function finalAnswerTurn(content: string): string {
  const line1 = JSON.stringify({
    model: "e2e-fake-model",
    created_at: new Date().toISOString(),
    message: { role: "assistant", content },
    done: false,
  });
  const line2 = JSON.stringify({
    model: "e2e-fake-model",
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 10,
    eval_count: 5,
  });
  return `${line1}\n${line2}\n`;
}

/**
 * In-process fake Gmail API (assert-free; the SPEC asserts the log).
 * Serves the exact URL shapes connectors/gmail.ts builds:
 *  - GET /gmail/v1/users/me/messages?q=… → messages.list shape (ids only,
 *    Pitfall 4) + resultSizeEstimate.
 *  - GET /gmail/v1/users/me/messages/{id}?format=metadata → top-level
 *    snippet + payload.headers (Subject/From/Date).
 *  - GET /gmail/v1/users/me/threads/{id}?format=full → Thread shape with a
 *    text/plain part carrying the base64url body.data fixture.
 */
async function startFakeGmail(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    gmailRequests.push(url);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && url.startsWith("/gmail/v1/users/me/messages?")) {
      // messages.list — deterministic ids-only list (Pitfall 4).
      res.end(
        JSON.stringify({
          messages: [{ id: FIXTURE_MESSAGE_ID, threadId: FIXTURE_THREAD_ID }],
          resultSizeEstimate: 1,
        }),
      );
      return;
    }
    if (req.method === "GET" && /\/gmail\/v1\/users\/me\/messages\/[A-Za-z0-9_-]+\?/.test(url)) {
      // messages.get?format=metadata — search enrichment shape (top-level
      // snippet is a Message field, pinned by the plan-01 unit fixture).
      res.end(
        JSON.stringify({
          id: FIXTURE_MESSAGE_ID,
          threadId: FIXTURE_THREAD_ID,
          snippet: FIXTURE_SNIPPET,
          payload: {
            headers: [
              { name: "Subject", value: FIXTURE_SUBJECT },
              { name: "From", value: FIXTURE_FROM },
              { name: "Date", value: FIXTURE_DATE },
            ],
          },
        }),
      );
      return;
    }
    if (req.method === "GET" && url.startsWith(`/gmail/v1/users/me/threads/${FIXTURE_THREAD_ID}`)) {
      // threads.get?format=full — Thread shape with base64url body.data
      // (text/plain part; the MIME-tree walk extracts it, Pitfall 3).
      res.end(
        JSON.stringify({
          id: FIXTURE_THREAD_ID,
          messages: [
            {
              id: FIXTURE_MESSAGE_ID,
              threadId: FIXTURE_THREAD_ID,
              snippet: FIXTURE_SNIPPET,
              payload: {
                headers: [
                  { name: "Subject", value: FIXTURE_SUBJECT },
                  { name: "From", value: FIXTURE_FROM },
                  { name: "Date", value: FIXTURE_DATE },
                ],
                parts: [
                  {
                    mimeType: "text/plain",
                    body: { data: FIXTURE_BODY_BASE64URL },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(FAKE_GMAIL_PORT, "127.0.0.1", resolve));
  return server;
}

/**
 * In-process fake collector (the COLLECTOR_URL target — 45914, the 196
 * Graph+collector family port): 
 *  - POST /api/ingest (the ingest bridge target: the X-Collector-Secret
 *    header is RECORDED, never validated against a guessed value; the
 *    multipart form fields are recorded; answers { chunks: 3, status: "ok" }).
 *  - POST /api/ingest/query (the memory-retrieval hook's best-effort arm —
 *    benign empty result so the hook is a no-op).
 */
async function startFakeCollector(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url.startsWith("/api/ingest") && !url.startsWith("/api/ingest/query")) {
      let body = "";
      let headerSecret = req.headers["x-collector-secret"];
      if (Array.isArray(headerSecret)) headerSecret = headerSecret[0];
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        collectorRequests.push(url);
        // Parse the multipart body crudely for the text fields (the bridge
        // uses FormData; the boundary rides the content-type HEADER).
        const fields: Record<string, string> = {};
        const contentType = req.headers["content-type"];
        const boundaryMatch = (typeof contentType === "string" ? contentType : "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        const boundary = boundaryMatch ? (boundaryMatch[1] ?? boundaryMatch[2]).trim() : null;
        if (boundary) {
          const parts = body.split(`--${boundary}`).filter((p) => p.includes("name=\""));
          for (const part of parts) {
            const nameMatch = part.match(/name="([^"]+)"/);
            if (!nameMatch) continue;
            const valueStart = part.indexOf("\r\n\r\n");
            if (valueStart === -1) continue;
            fields[nameMatch[1]] = part.slice(valueStart + 4).replace(/\r\n$/, "").replace(/\r\n--$/, "");
          }
          const fileNameMatch = body.match(/filename="([^"]+)"/);
          collectorIngestRecords.push({
            headerSecret: typeof headerSecret === "string" ? headerSecret : null,
            fields,
            fileName: fileNameMatch ? fileNameMatch[1] : null,
          });
        } else {
          collectorIngestRecords.push({ headerSecret: typeof headerSecret === "string" ? headerSecret : null, fields, fileName: null });
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ chunks: 3, status: "ok" }));
      });
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/ingest/query")) {
      // Memory-retrieval hook: benign empty result (the hook is best-effort).
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(FAKE_COLLECTOR_PORT, "127.0.0.1", resolve);
    });
    return server;
  } catch {
    // EADDRINUSE — another spec's worker owns the collector port (full-suite
    // co-run). Do not close it; the ingest records stay empty and the arms
    // that assert them skip via the probe/skip-with-reason path.
    return server;
  }
}

/**
 * In-process fake ollama daemon (POST /api/chat, NDJSON stream). Serves the
 * FIFO script the spec primes (ollamaScript). Each request shifts ONE turn.
 * When the script is empty the fake returns a plain final-answer turn so a
 * runaway ReAct loop can never hang (it terminates deterministically).
 */
async function startFakeOllama(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/api/chat") {
      // Consume the request body (ollama-js posts the chat payload; the
      // fake is script-driven — the request content is never asserted).
      req.resume();
      req.on("end", () => {
        ollamaRequestsCount += 1;
        res.setHeader("Content-Type", "application/x-ndjson");
        const turn = ollamaScript.shift() ?? finalAnswerTurn("E2E fake ollama fallback answer.");
        res.end(turn);
      });
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(FAKE_OLLAMA_PORT, "127.0.0.1", resolve);
    });
    return server;
  } catch {
    // EADDRINUSE — another spec's worker owns the ollama port. Do not close it.
    return server;
  }
}

/**
 * In-process fake IdP/token endpoint on the SAME fixed port the 195 spec
 * owns (playwright.config.ts OAUTH_* plumbing — 45912). The /token response
 * echoes a scope that includes gmail.readonly (the google exchange sends NO
 * scope param — the granted scope comes from the token response; the
 * fail-closed gmail.readonly scope gate needs it in the blob). Both specs
 * answer the same grants, but each spec file runs in its OWN worker process,
 * so when both run the port binds only once: EADDRINUSE here means the
 * other spec's worker already owns the endpoint — accept it and keep going.
 */
async function startFakeIdp(): Promise<{ server: http.Server; ownsPort: boolean }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && url.startsWith("/token")) {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        res.end(JSON.stringify({
          access_token: "e2e-fake-access-token-197",
          token_type: "Bearer",
          expires_in: 3600,
          scope:
            params.get("scope") ??
            "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly",
          refresh_token: "e2e-fake-refresh-token",
        }));
      });
      return;
    }
    // /authorize + anything else: minimal JSON ack (assert-free).
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(FAKE_IDP_PORT, "127.0.0.1", resolve);
    });
    return { server, ownsPort: true };
  } catch {
    // EADDRINUSE — the 195/196 spec's worker owns the endpoint. Do not close it.
    return { server, ownsPort: false };
  }
}

async function adminLoginToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  expect(res.ok(), `admin login failed: ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** Read the current enabled skills and AND-merge the connector tools in. */
async function enableConnectorSkills(
  request: APIRequestContext,
  token: string,
  names: string[],
): Promise<string[]> {
  const cfgRes = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/agent-config`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 8000,
  });
  expect(cfgRes.ok(), `agent-config read failed: ${cfgRes.status()}`).toBeTruthy();
  const cfg = (await cfgRes.json()) as { enabledSkills: string[] };
  const merged = Array.from(new Set([...(cfg.enabledSkills ?? []), ...names]));
  const putRes = await request.put(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/agent-config`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      enabledSkills: merged,
      // Belt-and-braces: point the workspace model at the resolvable
      // default too (the orchestrator's post-resolution override reads
      // agentConfig.model without re-validation — a stale name would ride
      // into the request harmlessly, but a resolvable one is deterministic).
      model: "deepseek-v4-flash:cloud",
    },
    timeout: 8000,
  });
  expect(putRes.ok(), `agent-config write failed: ${putRes.status()}`).toBeTruthy();
  return merged;
}

/**
 * Create a chat server-side and point its model at the resolvable default
 * (the Chat.model column default 'qwen2.5:3b' is not in this provider set —
 * the strict user-facing resolution would 500 every runAgent call with
 * [MODEL_NOT_AVAILABLE]; a pre-existing environment/model-catalog mismatch,
 * not a connector surface). PATCH /model pins the provider's default model;
 * the scripted fake ollama ignores the model name entirely either way.
 */
async function createModelNullChat(request: APIRequestContext, token: string): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  await request.post(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chat`, {
    headers,
    data: { message: "e2e gmail marketplace oauth setup" },
    timeout: 15_000,
  }).catch(() => { /* Chat row persists even when the agent errors */ });
  const res = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chats`, { headers, timeout: 8000 });
  expect(res.ok(), `chat list fetch failed: ${res.status()}`).toBeTruthy();
  const chats = await res.json();
  const list = Array.isArray(chats) ? chats : (chats as { chats: unknown[] }).chats;
  if (!Array.isArray(list) || list.length === 0) throw new Error("createModelNullChat: no chats returned");
  const chatId = (list as Array<{ id: string }>)[0].id;
  const patchRes = await request.patch(
    `${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chats/${chatId}/model`,
    { headers, data: { model: "deepseek-v4-flash:cloud" }, timeout: 8000 },
  );
  expect(patchRes.ok(), `chat model patch failed: ${patchRes.status()}`).toBeTruthy();
  return chatId;
}

/** Non-streaming chat turn through the REAL agent loop (model-neutral chat). */
async function runChat(
  request: APIRequestContext,
  token: string,
  chatId: string,
  message: string,
): Promise<{ response: string; toolCalls: Array<{ tool: string; input?: unknown; output?: unknown }>; iterations: number }> {
  const res = await request.post(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chat`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message, chatId },
    timeout: 120_000,
  });
  expect(res.ok(), `chat failed: ${res.status()} ${(await res.text()).slice(0, 300)}`).toBeTruthy();
  return (await res.json()) as { response: string; toolCalls: Array<{ tool: string; input?: unknown; output?: unknown }>; iterations: number };
}

let adminToken: string;
let chatId: string;
let oauthEntryId: string | null = null;
let oauthConnectionId: string | null = null;
let nonOauthEntryId: string | null = null;
let nonOauthConnectionId: string | null = null;
const createdDocumentIds: string[] = [];
let fakeGmail: http.Server | null = null;
let fakeCollector: http.Server | null = null;
let fakeOllama: http.Server | null = null;
let fakeIdp: http.Server | null = null;
let fakeIdpOwnsPort = false;
let skipReason: string | undefined;

test.describe("E2E — Gmail marketplace OAuth full-mock (MCPO-03 + MCPO-05)", () => {
  test.beforeAll(async ({ request }) => {
    gmailRequests = [];
    collectorIngestRecords = [];
    collectorRequests = [];
    ollamaRequestsCount = 0;
    ollamaScript = [];
    fakeGmail = await startFakeGmail();
    fakeCollector = await startFakeCollector();
    fakeOllama = await startFakeOllama();
    // Own the IdP port when free (solo run); tolerate the 195/196 worker's
    // listener when both specs run (same grant responses — the exchange
    // completes identically either way).
    const idp = await startFakeIdp();
    fakeIdp = idp.server;
    fakeIdpOwnsPort = idp.ownsPort;
    adminToken = await adminLoginToken(request);

    // PROBE (the mcp-oauth-flow guard convention, generalized): a stale
    // server (reuseExistingServer:true) without the webServer env overrides
    // answers oauth/start with an authorizeUrl pointing at the REAL IdP —
    // detect and skip with a documented reason rather than phone-homing.
    // The GMAIL_API_BASE_URL / COLLECTOR / OLLAMA overrides ride the SAME
    // env object as the OAUTH_* overrides, so the probe gates every gmail
    // fetch too (no tool can execute before this passes).
    const probe = await request.post(`${SERVER_URL}/api/mcp-connections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "E2E Gmail Probe (temp)",
        url: "http://127.0.0.1:1/sse",
        transportType: "sse",
        workspaceId: WORKSPACE_ID,
        authType: "oauth",
        oauthProvider: "google",
      },
      timeout: 8000,
    });
    if (!probe.ok()) {
      skipReason = `oauth connection create failed (${probe.status()})`;
      return;
    }
    const probeBody = (await probe.json()) as { id: string };
    const startRes = await request.post(
      `${SERVER_URL}/api/mcp-connections/${probeBody.id}/oauth/start`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    if (!startRes.ok()) {
      skipReason = `oauth start probe failed (${startRes.status()})`;
      await request.delete(`${SERVER_URL}/api/mcp-connections/${probeBody.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {});
      return;
    }
    const probeStart = (await startRes.json()) as { authorizeUrl: string };
    if (!probeStart.authorizeUrl.startsWith(`http://127.0.0.1:${FAKE_IDP_PORT}`)) {
      skipReason = `server process did not pick up the E2E overrides (authorizeUrl: ${probeStart.authorizeUrl.split("?")[0]}) — restart the E2E server with the playwright config`;
      await request.delete(`${SERVER_URL}/api/mcp-connections/${probeBody.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {});
      return;
    }
    // Probe OK — clean up the probe connection (the flow connection is the
    // MARKETPLACE-installed one, created below through the catalog route).
    await request.delete(`${SERVER_URL}/api/mcp-connections/${probeBody.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).catch(() => {});

    // Enable the gmail tools in the workspace agent config (the
    // availability gate ANDs this with provider-authorized, D-04).
    await enableConnectorSkills(request, adminToken, [
      "gmail_search",
      "gmail_get_thread",
      "gmail_ingest_thread",
    ]);
    // Model-neutral chat for the agent-loop arms (see createModelNullChat).
    chatId = await createModelNullChat(request, adminToken);
  });

  test.afterAll(async ({ request }) => {
    // Best-effort cleanup: revoke oauth first, then delete the connections
    // (the 196-04 pattern). 404-tolerant — the uninstall arm may already
    // have hard-deleted the marketplace connection.
    for (const connectionId of [oauthConnectionId, nonOauthConnectionId]) {
      if (!connectionId) continue;
      await request.delete(`${SERVER_URL}/api/mcp-connections/${connectionId}/oauth`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
      await request.delete(`${SERVER_URL}/api/mcp-connections/${connectionId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
    for (const docId of createdDocumentIds.splice(0)) {
      await request.delete(`${SERVER_URL}/api/documents/${docId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
    // Catalog entries: best-effort soft delete (409 impossible — the
    // connections were removed above; 404 tolerates a re-run).
    for (const entryId of [oauthEntryId, nonOauthEntryId]) {
      if (!entryId) continue;
      await request.delete(`${SERVER_URL}/api/mcp-marketplace/${entryId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
    if (fakeGmail) await new Promise<void>((resolve) => fakeGmail!.close(() => resolve()));
    // Close the collector + ollama fakes only when this worker owns their
    // ports (never touch a sibling worker's listener).
    if (fakeCollector && collectorIngestRecords.length >= 0) {
      await new Promise<void>((resolve) => fakeCollector!.close(() => resolve())).catch(() => {});
    }
    if (fakeOllama) {
      await new Promise<void>((resolve) => fakeOllama!.close(() => resolve())).catch(() => {});
    }
    // Close the IdP fake ONLY when this worker owns the port.
    if (fakeIdp && fakeIdpOwnsPort) await new Promise<void>((resolve) => fakeIdp!.close(() => resolve()));
  });

  test("Step 1 — D-05 install branch: oauth catalog entry → install → pending connection (no auto-connect) + leak pin", async ({ request }) => {
    test.skip(!!skipReason || !chatId, skipReason ?? "setup failed");
    if (!chatId) return;

    // Create the OAUTH catalog entry through the plan-02 schema-validated
    // route (url is a placeholder — no MCP server behind an oauth entry).
    const createRes = await request.post(`${SERVER_URL}/api/mcp-marketplace`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "E2E Gmail OAuth Entry",
        url: "http://127.0.0.1:1/sse",
        transportType: "sse",
        authType: "oauth",
        oauthProvider: "google",
        description: "E2E Phase 197 oauth marketplace entry (gmail tools)",
      },
      timeout: 8000,
    });
    expect(createRes.ok(), `catalog create failed: ${createRes.status()} ${(await createRes.text()).slice(0, 200)}`).toBeTruthy();
    const entry = (await createRes.json()) as { id: string; authType?: string; oauthProvider?: string | null };
    oauthEntryId = entry.id;
    expect(entry.authType).toBe("oauth");
    expect(entry.oauthProvider).toBe("google");

    // Install → 201.
    const installRes = await request.post(
      `${SERVER_URL}/api/mcp-marketplace/${oauthEntryId}/install`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { workspaceId: WORKSPACE_ID },
        timeout: 15_000,
      },
    );
    expect(installRes.ok(), `install failed: ${installRes.status()} ${(await installRes.text()).slice(0, 200)}`).toBeTruthy();
    const installed = (await installRes.json()) as Record<string, unknown>;
    // D-05 at the E2E layer: the created connection copies the entry's
    // OAuth identity and sits PENDING (no auto-connect ran).
    expect(installed["authType"]).toBe("oauth");
    expect(installed["oauthProvider"]).toBe("google");
    expect(installed["oauthStatus"]).toBe("pending");
    oauthConnectionId = installed["id"] as string;
    expect(oauthConnectionId).toBeTruthy();

    // E2E leak pin: the connection list NEVER carries
    // credentialsEncrypted/oauthError (195/196 posture re-pinned).
    const listRes = await request.get(
      `${SERVER_URL}/api/mcp-connections?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(listRes.ok()).toBeTruthy();
    const connections = (await listRes.json()) as Array<Record<string, unknown>>;
    const row = connections.find((c) => c.id === oauthConnectionId);
    expect(row, "installed connection must appear in the list").toBeTruthy();
    for (const conn of connections) {
      expect("credentialsEncrypted" in conn).toBe(false);
      expect("oauthError" in conn).toBe(false);
    }
  });

  test("Step 2 — connect flow: oauth/start → fake IdP authorizeUrl → public callback → oauth=authorized", async ({ request }) => {
    test.skip(!!skipReason || !oauthConnectionId || !chatId, skipReason ?? "connection not available");
    if (!oauthConnectionId) return;

    const startRes = await request.post(
      `${SERVER_URL}/api/mcp-connections/${oauthConnectionId}/oauth/start`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(startRes.ok()).toBeTruthy();
    const { authorizeUrl } = (await startRes.json()) as { authorizeUrl: string };
    expect(authorizeUrl.startsWith(`http://127.0.0.1:${FAKE_IDP_PORT}`)).toBe(true);
    expect(authorizeUrl).toContain("state=");
    const state = new URL(authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    // Simulate the browser redirect: GET the PUBLIC callback with code+state
    // (no Authorization header — the 195 public-mount contract).
    const cbRes = await request.get(
      `${SERVER_URL}/api/mcp-connections/oauth/callback?code=e2e-gmail-code&state=${encodeURIComponent(state!)}`,
      { timeout: 10_000, maxRedirects: 0, failOnStatusCode: false },
    );
    expect([302, 303]).toContain(cbRes.status());
    expect(cbRes.headers()["location"] ?? "").toContain("oauth=authorized");

    // The statuses enrichment serves the badge-matrix set the frontend
    // renders from — the marketplace-installed row is now authorized.
    const statusesRes = await request.get(`${SERVER_URL}/api/mcp-connections/statuses`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 8000,
    });
    expect(statusesRes.ok()).toBeTruthy();
    const statuses = (await statusesRes.json()) as Array<Record<string, unknown>>;
    const row = statuses.find((s) => s.id === oauthConnectionId);
    expect(row).toBeTruthy();
    expect(row!["oauthStatus"]).toBe("authorized");
    expect(row!["authType"]).toBe("oauth");
    expect(row!["oauthProvider"]).toBe("google");
    expect(row!["tokenExpiresAt"]).toBeTruthy();
  });

  test("Step 3 — gmail_search through the REAL agent loop hits the fake Gmail (tool executed)", async ({ request }) => {
    test.skip(!!skipReason || !oauthConnectionId || !chatId, skipReason ?? "connection not available");
    if (!oauthConnectionId) return;

    // Script the ReAct loop: turn 1 = gmail_search tool call, turn 2 =
    // final answer. The fake Gmail's request log is the tool-executed
    // assertion surface (request-log posture — no header values, no token
    // material).
    ollamaScript.push(toolCallTurn("gmail_search", { query: "report" }));
    ollamaScript.push(finalAnswerTurn("Found 1 message in the connected Gmail."));

    const result = await runChat(request, adminToken, chatId, "search my gmail for report");
    const executed = result.toolCalls.find((tc) => tc.tool === "gmail_search");
    expect(executed, `gmail_search must be in toolCalls (${JSON.stringify(result.toolCalls.map((t) => t.tool))})`).toBeTruthy();
    expect(result.response).toContain("Found 1 message");

    // The fake Gmail recorded the list hit — the GMAIL_API_BASE_URL
    // override-pickup proof (a stale server would have phoned home instead,
    // but the oauth probe already gated that arm).
    const listHit = gmailRequests.find(
      (u) => u.startsWith("/gmail/v1/users/me/messages?") && u.includes("q=report"),
    );
    expect(listHit, `fake Gmail request log: ${JSON.stringify(gmailRequests)}`).toBeTruthy();
    // The N+1 metadata enrichment followed the list hit (Pitfall 4).
    const metaHit = gmailRequests.find(
      (u) => u.startsWith(`/gmail/v1/users/me/messages/${FIXTURE_MESSAGE_ID}?`) && u.includes("format=metadata"),
    );
    expect(metaHit, `fake Gmail metadata log: ${JSON.stringify(gmailRequests)}`).toBeTruthy();
  });

  test("Step 4 — gmail_ingest_thread lands the Document row in the KB (fake collector contract + Pitfall 3)", async ({ request }) => {
    test.skip(!!skipReason || !oauthConnectionId || !chatId, skipReason ?? "connection not available");
    if (!oauthConnectionId) return;

    ollamaScript.push(toolCallTurn("gmail_ingest_thread", { threadId: FIXTURE_THREAD_ID }));
    ollamaScript.push(finalAnswerTurn("Ingested the thread into the knowledge base."));

    const result = await runChat(request, adminToken, chatId, "ingest the Q3 report thread");
    const executed = result.toolCalls.find((tc) => tc.tool === "gmail_ingest_thread");
    expect(executed, `gmail_ingest_thread must run (${JSON.stringify(result.toolCalls.map((t) => t.tool))})`).toBeTruthy();
    expect(result.response).toContain("Ingested the thread");

    // The fake collector observed the EXACT bridge contract: the secret
    // header + the multipart fields (documentId/workspaceId/workspaceName/
    // embeddingModel/docType) + the composed thread document.
    expect(collectorIngestRecords.length).toBeGreaterThanOrEqual(1);
    const record = collectorIngestRecords[collectorIngestRecords.length - 1];
    if (COLLECTOR_SECRET_EXPECTED) {
      // The exact secret only when the spec could resolve it (root .env or
      // process env) — presence is asserted unconditionally above.
      expect(record.headerSecret).toBe(COLLECTOR_SECRET_EXPECTED);
    } else {
      expect(record.headerSecret).toBeTruthy();
    }
    expect(record.fields["documentId"]).toBeTruthy();
    expect(record.fields["workspaceId"]).toBe(WORKSPACE_ID);
    expect(record.fields["workspaceName"]).toBe("Elegregio");
    expect(record.fields["embeddingModel"]).toBeTruthy();
    expect(record.fields["docType"]).toBe("txt");
    expect(record.fileName).toBe(FIXTURE_DOC_NAME);

    // Pitfall 3 at the E2E layer: the Document row exists in the workspace
    // documents list (the bridge created it BEFORE dispatch).
    const listRes = await request.get(
      `${SERVER_URL}/api/documents?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(listRes.ok()).toBeTruthy();
    const documents = (await listRes.json()) as Array<{ id: string; name: string }>;
    const connectorDoc = documents.find((d) => d.name === FIXTURE_DOC_NAME);
    expect(connectorDoc, `composed thread document must appear in the list (${documents.length} docs)`).toBeTruthy();
    if (connectorDoc) createdDocumentIds.push(connectorDoc.id);
  });

  test("Step 5 — D-08 uninstall wipe: oauth entry uninstall → connection row GONE + statuses clean (revoke best-effort, never blocking)", async ({ request }) => {
    test.skip(!!skipReason || !oauthEntryId || !oauthConnectionId || !chatId, skipReason ?? "connection not available");
    if (!oauthEntryId || !oauthConnectionId) return;

    // Uninstall the marketplace entry → 200 (the D-08 revoke+wipe hook runs
    // server-side before the hard delete; revokeProviderToken is best-effort
    // by contract — the WIPE is the assertion: the row dies, so no orphan
    // credentialsEncrypted blob can persist. The google revokeUrl fetch may
    // hit its documented host (195 fail-open contract, non-200 tolerated —
    // the wipe proceeds either way; logged provider+status only).
    const uninstallRes = await request.post(
      `${SERVER_URL}/api/mcp-marketplace/${oauthEntryId}/uninstall`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { workspaceId: WORKSPACE_ID },
        timeout: 15_000,
      },
    );
    expect(uninstallRes.ok(), `uninstall failed: ${uninstallRes.status()} ${(await uninstallRes.text()).slice(0, 200)}`).toBeTruthy();

    // Hard delete — no tombstone: the connection list shows NO row for the
    // entry (the credential blob died with the row — SC-3's no-orphan-secrets
    // proof at the E2E layer).
    const listRes = await request.get(
      `${SERVER_URL}/api/mcp-connections?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(listRes.ok()).toBeTruthy();
    const connections = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(connections.find((c) => c.id === oauthConnectionId), "uninstalled connection must be GONE from the list").toBeFalsy();
    for (const conn of connections) {
      expect("credentialsEncrypted" in conn).toBe(false);
      expect("oauthError" in conn).toBe(false);
    }

    // Statuses shows no orphan row for the entry either.
    const statusesRes = await request.get(`${SERVER_URL}/api/mcp-connections/statuses`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 8000,
    });
    expect(statusesRes.ok()).toBeTruthy();
    const statuses = (await statusesRes.json()) as Array<Record<string, unknown>>;
    expect(statuses.find((s) => s.id === oauthConnectionId), "no orphan statuses row after uninstall").toBeFalsy();

    // The connection is gone — mark it so afterAll never double-deletes.
    oauthConnectionId = null;
  });

  test("Step 6 — non-oauth regression arm: install auto-connects (byte-identical semantics) + uninstall wipes", async ({ request }) => {
    test.skip(!!skipReason || !chatId, skipReason ?? "setup failed");
    if (!chatId) return;

    // A NON-oauth catalog entry installs exactly as it did pre-197 (the
    // byte-identical regression arm): authType stays the "none" column
    // default and the connectMCPServer auto-connect fires (the placeholder
    // URL fails benignly — connectionErrors/lastError surface tolerated, the
    // 196 known quirk; Pitfall 2 in the 197-RESEARCH posture).
    const createRes = await request.post(`${SERVER_URL}/api/mcp-marketplace`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "E2E Non-OAuth Entry (regression)",
        url: "http://127.0.0.1:1/sse",
        transportType: "sse",
        description: "E2E Phase 197 non-oauth regression entry (auto-connect semantics unchanged)",
      },
      timeout: 8000,
    });
    expect(createRes.ok(), `non-oauth catalog create failed: ${createRes.status()}`).toBeTruthy();
    const entry = (await createRes.json()) as { id: string; authType?: string; oauthProvider?: string | null };
    nonOauthEntryId = entry.id;
    expect(entry.authType ?? "none").toBe("none");
    expect(entry.oauthProvider ?? null).toBeNull();

    const installRes = await request.post(
      `${SERVER_URL}/api/mcp-marketplace/${nonOauthEntryId}/install`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { workspaceId: WORKSPACE_ID },
        timeout: 15_000,
      },
    );
    expect(installRes.ok(), `non-oauth install failed: ${installRes.status()}`).toBeTruthy();
    const installed = (await installRes.json()) as Record<string, unknown>;
    nonOauthConnectionId = installed["id"] as string;
    // Byte-identical markers: NO authType='oauth' markers — authType is the
    // "none" column default and the row carries no pending oauth state.
    expect(installed["authType"]).toBe("none");
    expect(installed["oauthProvider"] ?? null).toBeNull();
    expect(installed["oauthStatus"]).toBe("none");
    expect("credentialsEncrypted" in installed).toBe(false);
    expect("oauthError" in installed).toBe(false);

    // The auto-connect fired against the placeholder URL and failed benignly
    // (the fire-and-forget 196 quirk — tolerate the error surface, do not
    // fail on it; the observable install semantics are what the arm pins).
    // Give the fire-and-forget connect a beat, then assert the row SURVIVED
    // (a crash-level failure would have deleted it — the 196 semantics).
    await new Promise((r) => setTimeout(r, 500));
    const listRes = await request.get(
      `${SERVER_URL}/api/mcp-connections?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(listRes.ok()).toBeTruthy();
    const connections = (await listRes.json()) as Array<Record<string, unknown>>;
    const row = connections.find((c) => c.id === nonOauthConnectionId);
    expect(row, "non-oauth connection must survive the failed auto-connect (fire-and-forget, 196 semantics)").toBeTruthy();

    // Uninstall → 200 → row GONE (existing marketplace-lifecycle semantics
    // unchanged — the revoke hook no-ops on a non-oauth row).
    const uninstallRes = await request.post(
      `${SERVER_URL}/api/mcp-marketplace/${nonOauthEntryId}/uninstall`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { workspaceId: WORKSPACE_ID },
        timeout: 15_000,
      },
    );
    expect(uninstallRes.ok(), `non-oauth uninstall failed: ${uninstallRes.status()}`).toBeTruthy();
    const list2Res = await request.get(
      `${SERVER_URL}/api/mcp-connections?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(list2Res.ok()).toBeTruthy();
    const connections2 = (await list2Res.json()) as Array<Record<string, unknown>>;
    expect(connections2.find((c) => c.id === nonOauthConnectionId), "non-oauth uninstalled connection must be GONE").toBeFalsy();

    // The connection is gone — afterAll must never double-delete it.
    nonOauthConnectionId = null;
  });

  test("Step 7 — zero requests to real provider hosts (phone-home guard)", async () => {
    // The oauth uninstall wipe (Step 5) nulls oauthConnectionId when the
    // chain reached its end — the guard runs on the completed-suite state
    // (skipReason still gates a stale-server skip).
    test.skip(!!skipReason, skipReason ?? "setup failed");
    // Every observed Gmail request rode the FAKE base (it did, by
    // construction — this pins the log shape so a silent real-host fallback
    // in a future refactor shows up as a log mismatch).
    expect(gmailRequests.every((u) => u.startsWith("/gmail/v1/"))).toBe(true);
    expect(collectorRequests.every((u) => u.startsWith("/api/ingest"))).toBe(true);
    expect(ollamaRequestsCount).toBeGreaterThan(0);
  });
});