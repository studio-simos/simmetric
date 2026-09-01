// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 150 — MCP-01 (multi-client SSE) + MCP-03 (Bearer auth + loopback
 * fallback + IDOR principal) unit tests.
 *
 * Mounts the REAL `mountMCPServer` onto a fresh Express app and drives it
 * with a real `http.Server` + raw `http.get`/`http.request` so the SDK's
 * `SSEServerTransport` runs unmocked (per plan: "Use the real SDK
 * SSEServerTransport — no mock"). `axios` is mocked so `rag_query`'s
 * collector call is deterministic; `prisma` is mocked for `list_workspaces`.
 *
 * Auth behaviour under test:
 *  - MCP_API_KEY set  → Bearer token required on /sse + /message.
 *  - MCP_API_KEY unset → loopback (127.0.0.1/::1) allowed, remote 401,
 *    and a single `logger.warn` fires at mount time.
 *
 * Multi-session (MCP-01): two concurrent GET /sse connections each get a
 * distinct sessionId; a POST /message routes to the correct transport only.
 *
 * IDOR principal (D-07): with MCP_API_KEY set, `list_workspaces` ignores
 * client `toolArgs.userId` and returns ALL non-deleted workspaces (admin
 * principal). With MCP_API_KEY unset (loopback), `toolArgs.userId` IS
 * honored.
 */
// @ts-nocheck
import "./helpers/setupEnv";

// Mock axios so rag_query's collector call is deterministic.
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn(() => Promise.resolve({ data: { results: [] } })) },
}));

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    withSoftDelete: (where: unknown) => where,
  };
});

// Use the REAL env module so clearEnvCache/getEnv drive the auth check. We
// manipulate process.env.MCP_API_KEY + call clearEnvCache() before each
// mount to re-parse. The setupEnv.ts fallback sets JWT_SECRET etc.
import { clearEnvCache } from "../config/env";

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mountMCPServer } from "../agent/mcpServer";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

// SSE connections keep the http.Server alive; force jest to exit after the
// suite rather than waiting on lingering keep-alive sockets.
jest.setTimeout(15000);

// ─── helpers ──────────────────────────────────────────────────────────────

/** Start an Express app on an ephemeral port; returns { server, url }. */
function startApp(app: express.Express): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on("error", reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    // Forcefully drop all keep-alive SSE connections so close() completes.
    // Node 18.2+: closeAllConnections(); fall back to destroying sockets.
    if (typeof (server as any).closeAllConnections === "function") {
      (server as any).closeAllConnections();
    }
    server.close(() => resolve());
    // Hard timeout: if sockets linger, resolve anyway.
    setTimeout(() => resolve(), 1000);
  });
}

/**
 * Open a GET /sse connection and read SSE events until the `endpoint` event
 * is received. Returns the full `data` payload (e.g. `/api/mcp/message?sessionId=<uuid>`)
 * plus the parsed sessionId. The request is kept open unless `close` is true.
 */
function openSse(
  url: string,
  headers: Record<string, string> = {},
  opts: { closeAfterEndpoint?: boolean } = {},
): Promise<{ status: number; sessionId: string | null; endpointData: string | null; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${url}/api/mcp/sse`, { headers }, (res) => {
      let buf = "";
      let sessionId: string | null = null;
      let endpointData: string | null = null;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        // Parse complete SSE events (terminated by \n\n)
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const rawEvent = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (rawEvent.startsWith("event: endpoint")) {
            const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              endpointData = dataLine.slice("data: ".length);
              const m = endpointData.match(/[?&]sessionId=([^&]+)/);
              sessionId = m ? decodeURIComponent(m[1]) : null;
            }
          }
        }
        if (endpointData) {
          if (opts.closeAfterEndpoint) {
            res.destroy();
            req.destroy();
          }
          resolve({ status: res.statusCode ?? 0, sessionId, endpointData, res });
        }
      });
      res.on("error", reject);
      // If the response is short (e.g. 401 JSON), resolve with no endpoint.
      res.on("end", () => {
        if (!endpointData) resolve({ status: res.statusCode ?? 0, sessionId: null, endpointData: null, res });
      });
    });
    req.on("error", (e) => {
      // If we already resolved (destroy), ignore.
      reject(e);
    });
  });
}

/** POST /api/mcp/message with a JSON body + optional sessionId query param. */
function postMessage(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  sessionId?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const req = http.request(
      `${url}/api/mcp/message${qs}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": payload.length, ...headers },
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0, body: null, res });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Set or clear MCP_API_KEY in process.env + clear the env cache so getEnv() re-parses. */
function setMcpApiKey(value: string | undefined): void {
  if (value === undefined) delete process.env.MCP_API_KEY;
  else process.env.MCP_API_KEY = value;
  clearEnvCache();
}

// ─── shared setup/teardown ────────────────────────────────────────────────

async function mountFresh(opts: { withLoggerSpy?: boolean } = {}): Promise<{
  app: express.Express;
  server: http.Server;
  url: string;
  warnSpy: jest.SpyInstance;
}> {
  const app = express();
  app.set("trust proxy", true);
  const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger as any);
  mountMCPServer(app);
  const { server, url } = await startApp(app);
  return { app, server, url, warnSpy };
}

// ─── tests ────────────────────────────────────────────────────────────────

describe("MCP-03: auth — MCP_API_KEY set", () => {
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    setMcpApiKey("test-secret-150");
    const m = await mountFresh();
    server = m.server;
    url = m.url;
  });

  afterAll(async () => {
    await closeServer(server);
    setMcpApiKey(undefined);
  });

  it("GET /sse without Authorization → 401", async () => {
    const r = await openSse(url, {}, { closeAfterEndpoint: false });
    // 401 closes immediately; endpointData stays null
    expect(r.status).toBe(401);
  });

  it("GET /sse with wrong token → 401", async () => {
    const r = await openSse(url, { Authorization: "Bearer wrong-token" });
    expect(r.status).toBe(401);
  });

  it("GET /sse with correct token → 200 and endpoint event with sessionId", async () => {
    const r = await openSse(url, { Authorization: "Bearer test-secret-150" }, { closeAfterEndpoint: true });
    expect(r.status).toBe(200);
    expect(r.sessionId).toBeTruthy();
    expect(r.endpointData).toContain("sessionId=");
  });

  it("POST /message without Authorization → 401", async () => {
    const r = await postMessage(url, { jsonrpc: "2.0", method: "initialize", id: 1 });
    expect(r.status).toBe(401);
  });
});

describe("MCP-03: loopback fallback — MCP_API_KEY unset", () => {
  let server: http.Server;
  let url: string;
  let warnSpy: jest.SpyInstance;

  beforeAll(async () => {
    setMcpApiKey(undefined);
    const m = await mountFresh();
    server = m.server;
    url = m.url;
    warnSpy = m.warnSpy;
  });

  afterAll(async () => {
    warnSpy.mockRestore();
    await closeServer(server);
    setMcpApiKey(undefined);
  });

  it("emits a warn log at mount time about localhost-only mode", () => {
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MCP_API_KEY not set"),
    );
  });

  it("loopback (127.0.0.1) connection → 200 and sessionId", async () => {
    // Our server is bound to 127.0.0.1, so req.ip is loopback.
    const r = await openSse(url, {}, { closeAfterEndpoint: true });
    expect(r.status).toBe(200);
    expect(r.sessionId).toBeTruthy();
  });

  it("remote IP (X-Forwarded-For: 203.0.113.5) → 401", async () => {
    // trust proxy is enabled, so X-Forwarded-For overrides req.ip.
    const r = await openSse(url, { "X-Forwarded-For": "203.0.113.5" });
    expect(r.status).toBe(401);
  });
});

describe("MCP-01: multi-client SSE — distinct sessionIds", () => {
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    setMcpApiKey("multia-test-150");
    const m = await mountFresh();
    server = m.server;
    url = m.url;
  });

  afterAll(async () => {
    await closeServer(server);
    setMcpApiKey(undefined);
  });

  it("two concurrent GET /sse each receive a distinct sessionId", async () => {
    const [a, b] = await Promise.all([
      openSse(url, { Authorization: "Bearer multia-test-150" }, { closeAfterEndpoint: false }),
      openSse(url, { Authorization: "Bearer multia-test-150" }, { closeAfterEndpoint: false }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
    // Clean up the open connections so the server can close in afterAll.
    a.res.destroy();
    b.res.destroy();
  });

  it("POST /message with unknown sessionId → 400", async () => {
    const r = await postMessage(
      url,
      { jsonrpc: "2.0", method: "initialize", id: 1 },
      { Authorization: "Bearer multia-test-150" },
      "definitely-not-a-real-session-id",
    );
    expect(r.status).toBe(400);
  });
});

describe("MCP-03: IDOR principal (D-07) — list_workspaces", () => {
  let server: http.Server;
  let url: string;

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    if (server) await closeServer(server);
    setMcpApiKey(undefined);
  });

  /**
   * `list_workspaces` is invoked through the MCP CallToolRequest handler.
   * We drive it by opening an SSE connection (to create a transport +
   * sessionId), then POSTing an initialize + tools/call JSON-RPC sequence.
   * Because the SDK Server wires `CallToolRequestSchema` to our handler,
   * a valid `tools/call` for `list_workspaces` reaches the prisma path.
   *
   * To keep the test deterministic and avoid full JSON-RPC handshake
   * complexity, we instead unit-test the handler behaviour by invoking the
   * tool through the message POST with a notification-shaped payload that
   * the SDK will route. The key assertion is at the prisma layer: in
   * authenticated mode the `where` clause must NOT contain the victim
   * userId.
   *
   * Given the SDK's full handshake (initialize → initialized notification →
   * tools/call) is heavy for a unit test, we verify the IDOR principal by
   * inspecting the prisma.workspace.findMany mock argument after a
   * tools/call round-trip. A dedicated supertest-style helper performs the
   * handshake.
   */

  it("authenticated mode (MCP_API_KEY set) — ignores toolArgs.userId, lists ALL workspaces", async () => {
    setMcpApiKey("idor-test-150");
    const m = await mountFresh();
    server = m.server;
    url = m.url;

    // Configure prisma.workspace.findMany to echo the where clause back so we
    // can assert it does NOT filter by userId.
    (prisma.workspace.findMany as jest.Mock).mockImplementation((args: any) => {
      return Promise.resolve([{ id: "ws-all-1", name: "All Workspace 1", projectId: "p1" }]);
    });

    const sse = await openSse(url, { Authorization: "Bearer idor-test-150" }, { closeAfterEndpoint: false });
    expect(sse.sessionId).toBeTruthy();

    // Full JSON-RPC handshake: initialize, then tools/call list_workspaces.
    const initBody = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
      id: 1,
    };
    await postMessage(url, initBody, { Authorization: "Bearer idor-test-150" }, sse.sessionId!);

    // Send initialized notification (no id).
    const initNotif = { jsonrpc: "2.0", method: "notifications/initialized" };
    await postMessage(url, initNotif, { Authorization: "Bearer idor-test-150" }, sse.sessionId!);

    // tools/call with a SPOOFED victim userId in toolArgs.
    const callBody = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "list_workspaces", arguments: { userId: "victim-uuid-123" } },
      id: 2,
    };
    await postMessage(url, callBody, { Authorization: "Bearer idor-test-150" }, sse.sessionId!);

    // Give the handler a tick to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(prisma.workspace.findMany).toHaveBeenCalled();
    const whereArg = (prisma.workspace.findMany as jest.Mock).mock.calls[0][0]?.where;
    // Authenticated mode: where must NOT filter by the victim userId.
    const whereJson = JSON.stringify(whereArg);
    expect(whereJson).not.toContain("victim-uuid-123");
    // And it should be the admin-principal shape (deletedAt: null only).
    expect(whereArg).toEqual({ deletedAt: null });

    sse.res.destroy();
    await closeServer(server);
    server = undefined as any;
    setMcpApiKey(undefined);
    (prisma.workspace.findMany as jest.Mock).mockReset();
  });

  it("loopback mode (MCP_API_KEY unset) — honors toolArgs.userId", async () => {
    setMcpApiKey(undefined);
    const m = await mountFresh();
    server = m.server;
    url = m.url;

    (prisma.workspace.findMany as jest.Mock).mockImplementation((args: any) => {
      return Promise.resolve([{ id: "ws-u1", name: "User WS", projectId: "p1" }]);
    });

    const sse = await openSse(url, {}, { closeAfterEndpoint: false });
    expect(sse.sessionId).toBeTruthy();

    const initBody = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
      id: 1,
    };
    await postMessage(url, initBody, {}, sse.sessionId!);
    const initNotif = { jsonrpc: "2.0", method: "notifications/initialized" };
    await postMessage(url, initNotif, {}, sse.sessionId!);
    const callBody = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "list_workspaces", arguments: { userId: "user-loopback-1" } },
      id: 2,
    };
    await postMessage(url, callBody, {}, sse.sessionId!);
    await new Promise((r) => setTimeout(r, 50));

    expect(prisma.workspace.findMany).toHaveBeenCalled();
    const whereArg = (prisma.workspace.findMany as jest.Mock).mock.calls[0][0]?.where;
    // Loopback mode: where MUST reference the client-supplied userId.
    expect(JSON.stringify(whereArg)).toContain("user-loopback-1");

    sse.res.destroy();
    await closeServer(server);
    server = undefined as any;
    setMcpApiKey(undefined);
    (prisma.workspace.findMany as jest.Mock).mockReset();
  });
});