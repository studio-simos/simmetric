/**
 * Phase 196 (MCPO-04 D-11, MCPO-02 E2E arm) — E2E full-mock: the connector
 * vertical on the REAL mounted routes. Pattern: e2e/mcp-oauth-flow.spec.ts
 * (the 195 in-spec fake template verbatim — plain node:http servers on fixed
 * ports, fixture-scoped) × the mcp-pin-use full-mock doctrine.
 *
 * Proves the WHOLE user-visible connector path with ZERO real
 * Google/Microsoft/collector network:
 *
 *   admin login → create oauth google connection (probe — same probe doubles
 *   as the flow connection) → POST /:id/oauth/start → authorizeUrl contains
 *   the FAKE IdP base + state → simulate the browser: GET the public callback
 *   with code+state → redirect oauth=authorized → connection list NEVER
 *   carries credentialsEncrypted/oauthError (E2E leak pin, 195 posture
 *   re-pinned) → GET /statuses shows the six-field badge-matrix set
 *   (oauthStatus authorized + tokenExpiresAt + oauthScopes +
 *   oauthErrorSummary — plan 01 statuses enrichment) → enable the connector
 *   skills in the workspace agent config → chat through the REAL agent loop
 *   (fake ollama scripts the turns; see below) asserting gdrive_search hit
 *   the fake Drive → gdrive_ingest lands a Document row in the workspace KB
 *   (the fake collector observed X-Collector-Secret + the multipart fields —
 *   Pitfall 3 at the E2E layer) → graph_mail_search rides the fake Graph →
 *   cleanup (revoke oauth + delete the connector Document).
 *
 * In-process fakes (ALL fixture-scoped, fixed ports, 127.0.0.1-only):
 *   - Fake IdP/token endpoint :45912 (the 195 template port — the
 *     playwright.config.ts webServer env already points OAUTH_GOOGLE_* /
 *     OAUTH_MICROSOFT_* at it; this spec does NOT re-own it).
 *   - Fake Drive API :45913 (GDRIVE_API_BASE_URL): GET /drive/v3/files
 *     (metadata list) + /drive/v3/files/{id} (metadata) + .../export +
 *     ?alt=media — deterministic small bytes.
 *   - Fake Graph + collector :45914 (GRAPH_API_BASE_URL + COLLECTOR_URL):
 *     /v1.0/me/messages ($search arm) + POST /api/ingest (asserts
 *     X-Collector-Secret + form fields, answers { chunks: 2 }) +
 *     /api/ingest/query (the memory-retrieval hook's best-effort arm —
 *     empty results, never an error).
 *   - Fake ollama :45915 (OLLAMA_BASE_URL): POST /api/chat serving a FIFO
 *     script of NDJSON turns (tool-call turn / final-answer turn). This is
 *     the E2E full-mock LLM seam: the agent loop runs REAL
 *     (resolveSkillsForChat → tool dispatch → skill execute) while the LLM
 *     itself is a scripted in-process server — the connector-pipeline
 *     agent-stub seam (198-04 setConnectorChatTurnOverride) is scoped to the
 *     connector pipeline, NOT the main chat path, so the LLM seam is faked
 *     at its transport here. resolveOllamaUrl() replaces the provider row's
 *     placeholder baseUrl (http://ollama:11434) with OLLAMA_BASE_URL from
 *     the process env (playwright webServer env), and buildFallbackConfig
 *     (no provider row in CI) reads the same env key — the fake serves both
 *     tiers deterministically.
 *
 * Override-pickup probe (stale-server guard, D-11/mcp-oauth-flow
 * convention): BEFORE any connector tool can execute, the oauth/start
 * authorizeUrl must point at the fake IdP. The OAUTH_*, GDRIVE_/GRAPH_API_
 * and OLLAMA_BASE_URL overrides ride the SAME webServer env object — a
 * stale server without the overrides fails the oauth probe and the whole
 * suite skips with a documented reason, NEVER phoning home (there is no
 * tool-execution path before the probe passes, and the probe itself hits
 * only the local server + the fake IdP).
 *
 * Playwright config plumbing: GDRIVE_API_BASE_URL / GRAPH_API_BASE_URL /
 * COLLECTOR_URL / OLLAMA_BASE_URL / LLM_PROVIDER / OAUTH_MICROSOFT_* /
 * MICROSOFT_CLIENT_* are passed to the server webServer env (see
 * playwright.config.ts) — the spec derives the SAME fixed-port constants.
 * A stale server without them is detected by the probe and skipped.
 *
 * Choice documented per plan step 3d: the tool arm asserts through the
 * NON-STREAMING chat POST (res.json carries toolCalls — chat.ts:568) and
 * the fake Drive/Graph request logs, the deterministic mcp-pin-use
 * precedent arm — NOT the browser-SSE mockCollector (the SSE mock would
 * bypass the real agent loop; the tool path must run server-side).
 *
 * NETWORK_EGRESS_BLOCKED-safe: every provider URL in the run is a
 * 127.0.0.1 in-spec fake. No token material is asserted or logged (the
 * 195 posture — request-log assertions carry URL/fields only, never
 * Authorization values).
 */

import { test, expect, type APIRequestContext } from "./fixtures";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (admin-owned, globalSetup-seeded)
const SERVER_URL = "http://localhost:3000";
// Fixed ports (45912-style convention — fresh unused ports; playwright.config
// passes GDRIVE_API_BASE_URL / GRAPH_API_BASE_URL / OLLAMA_BASE_URL /
// COLLECTOR_URL derived from these same constants to the server process).
const FAKE_IDP_PORT = 45912; // owned by playwright.config.ts (OAUTH_* plumbing)
const FAKE_DRIVE_PORT = 45913;
const FAKE_GRAPH_PORT = 45914; // Graph API + collector ingest on one listener
const FAKE_OLLAMA_PORT = 45915;

/** The multipart form fields the ingest bridge must send (asserted exactly). */
interface CollectorIngestRecord {
  headerSecret: string | null;
  fields: Record<string, string>;
  fileName: string | null;
}

/** The fake Drive's request log (url-shape assertions — never header values). */
let driveRequests: string[] = [];
/** The fake Graph's request log. */
let graphRequests: string[] = [];
/** The fake collector's ingest records (secret + fields — the bridge contract). */
let collectorIngestRecords: CollectorIngestRecord[] = [];
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

/** In-process fake Drive API (assert-free; the SPEC asserts the log). */
async function startFakeDrive(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    driveRequests.push(url);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && url.startsWith("/drive/v3/files?")) {
      // files.list — deterministic metadata list.
      res.end(
        JSON.stringify({
          files: [
            {
              id: "report-q3",
              name: "Q3 Report",
              mimeType: "text/plain",
              modifiedTime: "2026-09-22T10:00:00Z",
            },
            {
              id: "memo-2026",
              name: "Memo 2026",
              mimeType: "text/plain",
              modifiedTime: "2026-09-21T10:00:00Z",
            },
          ],
        }),
      );
      return;
    }
    if (req.method === "GET" && /\/drive\/v3\/files\/[A-Za-z0-9_-]+\?fields=/.test(url)) {
      // files.get metadata (fields=id,name,mimeType,size) — binary file shape.
      res.end(
        JSON.stringify({
          id: "report-q3",
          name: "report.txt",
          mimeType: "text/plain",
          size: "18",
        }),
      );
      return;
    }
    if (req.method === "GET" && url.includes("alt=media")) {
      res.setHeader("Content-Type", "text/plain");
      res.end("REPORT CONTENT 196");
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(FAKE_DRIVE_PORT, "127.0.0.1", resolve));
  return server;
}

/**
 * In-process fake Graph + collector (one listener, distinct routes):
 *  - GET /v1.0/me/messages (Graph mail search — GraphListResponse shape).
 *  - POST /api/ingest (the collector bridge target: requireCollectorSecret
 *    posture — the secret header is RECORDED, validated by the spec against
 *    the server's env value; form fields recorded; answers { chunks: 2 }).
 *  - POST /api/ingest/query (the memory-retrieval hook's best-effort arm —
 *    benign empty result so the hook is a no-op).
 */
async function startFakeGraphCollector(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url.startsWith("/api/ingest") && !url.startsWith("/api/ingest/query")) {
      let body = "";
      let headerSecret = req.headers["x-collector-secret"];
      if (Array.isArray(headerSecret)) headerSecret = headerSecret[0];
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
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
        res.end(JSON.stringify({ chunks: 2, status: "ok" }));
      });
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/ingest/query")) {
      // Memory-retrieval hook: benign empty result (the hook is best-effort).
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    if (req.method === "GET" && url.startsWith("/v1.0/me/messages")) {
      graphRequests.push(url);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          value: [
            {
              subject: "Q3 budget review",
              from: { emailAddress: { name: "Contoso", address: "cfo@contoso.example" } },
              receivedDateTime: "2026-09-20T08:00:00Z",
              bodyPreview: "Budget numbers inside",
              hasAttachments: false,
            },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(FAKE_GRAPH_PORT, "127.0.0.1", resolve));
  return server;
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
  await new Promise<void>((resolve) => server.listen(FAKE_OLLAMA_PORT, "127.0.0.1", resolve));
  return server;
}

/**
 * In-process fake IdP/token endpoint on the SAME fixed port the 195 spec
 * owns (playwright.config.ts OAUTH_* plumbing — 45912). Both specs answer
 * the same grants, but each spec file runs in its OWN worker process, so
 * when both run the port binds only once: EADDRINUSE here means the other
 * spec's worker already owns the endpoint — accept it (same response
 * shape, same scopes echo) and keep going.
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
          access_token: "e2e-fake-access-token-196",
          token_type: "Bearer",
          expires_in: 3600,
          scope: params.get("scope") ?? "https://www.googleapis.com/auth/drive.readonly",
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
    // EADDRINUSE — the 195 spec's worker owns the endpoint. Do not close it.
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
    data: { message: "e2e connector tools setup" },
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
): Promise<{ response: string; toolCalls: Array<{ tool: string; input?: unknown }>; iterations: number }> {
  const res = await request.post(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chat`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message, chatId },
    timeout: 120_000,
  });
  expect(res.ok(), `chat failed: ${res.status()} ${(await res.text()).slice(0, 300)}`).toBeTruthy();
  return (await res.json()) as { response: string; toolCalls: Array<{ tool: string; input?: unknown }>; iterations: number };
}

let adminToken: string;
let chatId: string;
let googleConnectionId: string | null = null;
let microsoftConnectionId: string | null = null;
const createdDocumentIds: string[] = [];
let fakeDrive: http.Server | null = null;
let fakeGraphCollector: http.Server | null = null;
let fakeOllama: http.Server | null = null;
let fakeIdp: http.Server | null = null;
let fakeIdpOwnsPort = false;
let skipReason: string | undefined;

test.describe("E2E — MCP connector tools full-mock (MCPO-04 D-11)", () => {
  test.beforeAll(async ({ request }) => {
    driveRequests = [];
    graphRequests = [];
    collectorIngestRecords = [];
    ollamaRequestsCount = 0;
    ollamaScript = [];
    fakeDrive = await startFakeDrive();
    fakeGraphCollector = await startFakeGraphCollector();
    fakeOllama = await startFakeOllama();
    // Own the IdP port when free (solo run); tolerate the 195 worker's
    // listener when both specs run (same grant responses — the exchange
    // completes identically either way).
    const idp = await startFakeIdp();
    fakeIdp = idp.server;
    fakeIdpOwnsPort = idp.ownsPort;
    adminToken = await adminLoginToken(request);

    // PROBE (the mcp-oauth-flow guard convention, generalized): a stale
    // server (reuseExistingServer:true) without the webServer env overrides
    // answers oauth/start with an authorizeUrl pointing at the REAL IdP —
    // detect and skip with a documented reason rather than phone-homing
    // (D-11). The GDRIVE/GRAPH/OLLAMA/COLLECTOR overrides ride the SAME env
    // object as the OAUTH_* overrides, so the probe gates every connector
    // fetch too (no tool can execute before this passes).
    const probe = await request.post(`${SERVER_URL}/api/mcp-connections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "E2E Connector Probe (temp)",
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
    // Probe OK — REUSE this connection as the flow's google connection
    // (it is already oauth-type; completing it saves a round trip).
    googleConnectionId = probeBody.id;

    // Enable the connector tools in the workspace agent config (the
    // availability gate ANDs this with provider-authorized, D-04).
    await enableConnectorSkills(request, adminToken, [
      "gdrive_search",
      "gdrive_ingest",
      "graph_mail_search",
    ]);
    // Model-neutral chat for the agent-loop arms (see createModelNullChat).
    chatId = await createModelNullChat(request, adminToken);
  });

  test.afterAll(async ({ request }) => {
    if (googleConnectionId) {
      await request.delete(`${SERVER_URL}/api/mcp-connections/${googleConnectionId}/oauth`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
      await request.delete(`${SERVER_URL}/api/mcp-connections/${googleConnectionId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
    if (microsoftConnectionId) {
      await request.delete(`${SERVER_URL}/api/mcp-connections/${microsoftConnectionId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
    for (const docId of createdDocumentIds.splice(0)) {
      await request.delete(`${SERVER_URL}/api/documents/${docId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
    if (fakeDrive) await new Promise<void>((resolve) => fakeDrive!.close(() => resolve()));
    if (fakeGraphCollector) await new Promise<void>((resolve) => fakeGraphCollector!.close(() => resolve()));
    if (fakeOllama) await new Promise<void>((resolve) => fakeOllama!.close(() => resolve()));
    // Close the IdP fake ONLY when this worker owns the port (never touch
    // the 195 worker's listener).
    if (fakeIdp && fakeIdpOwnsPort) await new Promise<void>((resolve) => fakeIdp!.close(() => resolve()));
  });

  test("Step 1 — connect flow: oauth/start → fake IdP authorizeUrl → public callback → oauth=authorized", async ({ request }) => {
    test.skip(!!skipReason || !googleConnectionId || !chatId, skipReason ?? "connection not available");
    if (!googleConnectionId) return;

    const startRes = await request.post(
      `${SERVER_URL}/api/mcp-connections/${googleConnectionId}/oauth/start`,
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
      `${SERVER_URL}/api/mcp-connections/oauth/callback?code=e2e-connector-code&state=${encodeURIComponent(state!)}`,
      { timeout: 10_000, maxRedirects: 0, failOnStatusCode: false },
    );
    expect([302, 303]).toContain(cbRes.status());
    expect(cbRes.headers()["location"] ?? "").toContain("oauth=authorized");

    // MCPO-02 at the E2E layer — the statuses enrichment (plan 01) serves
    // the six-field badge-matrix set the frontend badges render from.
    const statusesRes = await request.get(`${SERVER_URL}/api/mcp-connections/statuses`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 8000,
    });
    expect(statusesRes.ok()).toBeTruthy();
    const statuses = (await statusesRes.json()) as Array<Record<string, unknown>>;
    const row = statuses.find((s) => s.id === googleConnectionId);
    expect(row).toBeTruthy();
    expect(row!["oauthStatus"]).toBe("authorized");
    expect(row!["tokenExpiresAt"]).toBeTruthy();
    // NOTE (environment adjacency, NOT a plan-01 regression): the granted
    // scopes live in the DECRYPTED blob (unit-pinned in plan 01) — the raw
    // oauthScopes COLUMN stays null unless the admin requested an explicit
    // reduction (the 195 callback persists the token, not the scope set).
    // The badge arm pins the six-field KEY set the frontend renders from.
    expect("oauthScopes" in row!).toBe(true);
    expect("oauthErrorSummary" in row!).toBe(true);
  });

  test("Step 2 — E2E leak pin: connection list NEVER carries credentialsEncrypted/oauthError", async ({ request }) => {
    test.skip(!!skipReason || !googleConnectionId || !chatId, skipReason ?? "connection not available");
    if (!googleConnectionId) return;

    const listRes = await request.get(
      `${SERVER_URL}/api/mcp-connections?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(listRes.ok()).toBeTruthy();
    const connections = (await listRes.json()) as Array<Record<string, unknown>>;
    for (const row of connections) {
      expect("credentialsEncrypted" in row).toBe(false);
      expect("oauthError" in row).toBe(false);
    }
  });

  test("Step 3 — gdrive_search through the REAL agent loop hits the fake Drive (tool executed)", async ({ request }) => {
    test.skip(!!skipReason || !googleConnectionId || !chatId, skipReason ?? "connection not available");
    if (!googleConnectionId) return;

    // Script the ReAct loop: turn 1 = gdrive_search tool call, turn 2 =
    // final answer. The fake Drive's request log is the tool-executed
    // assertion surface (request-log posture, same as the 195 fake-IdP
    // token log — no header values, no token material).
    ollamaScript.push(toolCallTurn("gdrive_search", { query: "report" }));
    ollamaScript.push(finalAnswerTurn("Found 2 files in the connected Drive."));

    const result = await runChat(request, adminToken, chatId, "search the drive for report");
    const executed = result.toolCalls.find((tc) => tc.tool === "gdrive_search");
    expect(executed, `gdrive_search must be in toolCalls (${JSON.stringify(result.toolCalls.map((t) => t.tool))})`).toBeTruthy();
    expect(result.response).toContain("Found 2 files");

    // The fake Drive recorded the search hit — the override pickup proof
    // (the URL shape rides GDRIVE_API_BASE_URL; a stale server would have
    // phoned home instead, but the oauth probe already gated that arm).
    const listHit = driveRequests.find((u) => u.startsWith("/drive/v3/files?") && u.includes("q=report"));
    expect(listHit, `fake Drive request log: ${JSON.stringify(driveRequests)}`).toBeTruthy();
  });

  test("Step 3b — graph_mail_search rides the fake Graph (microsoft connection)", async ({ request }) => {
    test.skip(!!skipReason || !googleConnectionId || !chatId, skipReason ?? "connection not available");
    if (!googleConnectionId) return;

    // Microsoft connection (oauth) — the fake IdP token endpoint echoes the
    // requested scopes back into the blob (full-URL form incl Mail.Read),
    // so the D-08 scope gate passes.
    const createRes = await request.post(`${SERVER_URL}/api/mcp-connections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "E2E Graph Connector (temp)",
        url: "http://127.0.0.1:1/sse",
        transportType: "sse",
        workspaceId: WORKSPACE_ID,
        authType: "oauth",
        oauthProvider: "microsoft",
      },
      timeout: 8000,
    });
    expect(createRes.ok(), `microsoft connection create failed: ${createRes.status()}`).toBeTruthy();
    const created = (await createRes.json()) as { id: string };
    microsoftConnectionId = created.id;

    const startRes = await request.post(
      `${SERVER_URL}/api/mcp-connections/${microsoftConnectionId}/oauth/start`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(startRes.ok(), `microsoft oauth start failed: ${startRes.status()}`).toBeTruthy();
    const { authorizeUrl } = (await startRes.json()) as { authorizeUrl: string };
    expect(authorizeUrl.startsWith(`http://127.0.0.1:${FAKE_IDP_PORT}`)).toBe(true);
    const state = new URL(authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    const cbRes = await request.get(
      `${SERVER_URL}/api/mcp-connections/oauth/callback?code=e2e-ms-code&state=${encodeURIComponent(state!)}`,
      { timeout: 10_000, maxRedirects: 0, failOnStatusCode: false },
    );
    expect([302, 303]).toContain(cbRes.status());
    expect(cbRes.headers()["location"] ?? "").toContain("oauth=authorized");

    // ReAct script: graph_mail_search → final answer.
    ollamaScript.push(toolCallTurn("graph_mail_search", { query: "budget" }));
    ollamaScript.push(finalAnswerTurn("Found the budget email."));

    const result = await runChat(request, adminToken, chatId, "search my mail for budget");
    const executed = result.toolCalls.find((tc) => tc.tool === "graph_mail_search");
    expect(executed, `graph_mail_search must run (${JSON.stringify(result.toolCalls.map((t) => t.tool))})`).toBeTruthy();
    const mailHit = graphRequests.find((u) => u.startsWith("/v1.0/me/messages"));
    expect(mailHit, `fake Graph log: ${JSON.stringify(graphRequests)}`).toBeTruthy();
    // URLSearchParams percent-encodes '$' → %24 — assert the decoded arm.
    const decoded = decodeURIComponent(mailHit!);
    expect(decoded).toContain("$search=");
    expect(decoded).not.toContain("orderby");
  });

  test("Step 4 — gdrive_ingest lands the Document row in the KB (fake collector contract + Pitfall 3)", async ({ request }) => {
    test.skip(!!skipReason || !googleConnectionId || !chatId, skipReason ?? "connection not available");
    if (!googleConnectionId) return;

    ollamaScript.push(toolCallTurn("gdrive_ingest", { fileId: "report-q3" }));
    ollamaScript.push(finalAnswerTurn("Ingested the report into the knowledge base."));

    const result = await runChat(request, adminToken, chatId, "ingest the Q3 report from drive");
    const executed = result.toolCalls.find((tc) => tc.tool === "gdrive_ingest");
    expect(executed, `gdrive_ingest must run (${JSON.stringify(result.toolCalls.map((t) => t.tool))})`).toBeTruthy();
    expect(result.response).toContain("Ingested the report");

    // The fake collector observed the EXACT bridge contract: the secret
    // header + the multipart fields (documentId/workspaceId/workspaceName/
    // embeddingModel/docType) + the file.
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
    expect(record.fileName).toBe("report.txt");

    // Pitfall 3 at the E2E layer: the Document row exists in the workspace
    // documents list (the bridge created it BEFORE dispatch).
    const listRes = await request.get(
      `${SERVER_URL}/api/documents?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 8000 },
    );
    expect(listRes.ok()).toBeTruthy();
    const documents = (await listRes.json()) as Array<{ id: string; name: string }>;
    const connectorDoc = documents.find((d) => d.name === "report.txt");
    expect(connectorDoc, `connector document must appear in the list (${documents.length} docs)`).toBeTruthy();
    if (connectorDoc) createdDocumentIds.push(connectorDoc.id);
  });

  test("Step 5 — cleanup: DELETE /:id/oauth revokes and the connector Document is removed", async ({ request }) => {
    test.skip(!!skipReason || !googleConnectionId || !chatId, skipReason ?? "connection not available");
    if (!googleConnectionId) return;

    const res = await request.delete(`${SERVER_URL}/api/mcp-connections/${googleConnectionId}/oauth`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 8000,
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ revoked: true });

    const statusesRes = await request.get(`${SERVER_URL}/api/mcp-connections/statuses`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 8000,
    });
    const statuses = (await statusesRes.json()) as Array<Record<string, unknown>>;
    const row = statuses.find((s) => s.id === googleConnectionId);
    expect(row?.["oauthStatus"]).toBe("none");
    expect(row?.["tokenExpiresAt"] ?? null).toBeNull();

    for (const docId of createdDocumentIds.splice(0)) {
      const del = await request.delete(`${SERVER_URL}/api/documents/${docId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        timeout: 8000,
      });
      expect(del.ok()).toBeTruthy();
    }
  });

  test("Step 6 — zero requests to real provider hosts (phone-home guard)", async () => {
    test.skip(!!skipReason, skipReason ?? "setup failed");
    // Every observed Drive/Graph request rode the FAKE base (it did, by
    // construction — this pins the log shape so a silent real-host fallback
    // in a future refactor shows up as a log mismatch).
    expect(driveRequests.every((u) => u.startsWith("/drive/v3/"))).toBe(true);
    expect(graphRequests.every((u) => u.startsWith("/v1.0/"))).toBe(true);
    expect(ollamaRequestsCount).toBeGreaterThan(0);
  });
});