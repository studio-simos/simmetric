// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * quick 260919-umx — collectorDispatchAgent contract pin.
 *
 * The 2026-09-19 Docker incident: commit 7ca47f71 added undici@^8.10.2 and
 * passed a v8 `new Agent(…)` as `dispatcher` to Node's BUILT-IN
 * globalThis.fetch. Node 24's built-in fetch runs its bundled undici 7.x and
 * invokes dispatchers with the v1 handler protocol; the v8 Agent validates
 * handlers against the NEW v2 interface (`onRequestStart`) and throws
 * INSTANTLY — a bare TypeError whose cause carries
 * `InvalidArgumentError: UND_ERR_INVALID_ARG invalid onRequestStart method`
 * — BEFORE any network I/O. Empirically confirmed at planning time
 * (Node v24.19.0):
 *   Repro A — v8 Agent + built-in global fetch + 2,583,319-byte Blob in
 *             FormData → instant TypeError (any body size).
 *   Repro B — same request via undici v8's own fetch + v8 Agent → 200 OK.
 *   Repro C — undici 7.29.1 Agent + built-in global fetch + same body → 200 OK.
 *
 * The four existing ingest suites mock globalThis.fetch entirely, so this
 * class of failure was invisible to unit tests. These tests pin the REAL
 * contract on a real loopback server:
 *   Test 1 (THE regression guard): a ~2.5MB multipart POST through
 *          globalThis.fetch + collectorDispatchAgent must actually REACH the
 *          network (resolve with 200). On undici v8 this rejects instantly.
 *   Test 2 (version pin): packages/server's undici stays on the v7 major —
 *          a drift back to v8 fails loudly, pointing at the upgrade rule in
 *          collectorDispatchAgent.ts's header comment.
 *   Test 3 (shape pin): collectorDispatchAgent IS an undici Agent instance —
 *          a plain-object replacement would silently drop the timeout-exempt
 *          transport behavior the j9m/gxs/p3h fixes depend on.
 *
 * No mocking of globalThis.fetch anywhere here: the whole point is the real
 * built-in fetch + the real dispatcher over a real (loopback) socket.
 */
import "./helpers/setupEnv";
import http from "http";
import { Agent } from "undici";
import { collectorDispatchAgent } from "../utils/collectorDispatchAgent";

let server: http.Server;
let base: string;

beforeAll((done) => {
  jest.setTimeout(30_000);
  server = http.createServer((req, res) => {
    // Consume the request body (otherwise the response can hang the client),
    // then answer like the collector's /api/ingest would.
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { address: string; port: number };
    base = `http://${addr.address}:${addr.port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

describe("collectorDispatchAgent (quick 260919-umx)", () => {
  test(
    "Test 1: 2.5MB multipart POST rides the real Agent through BUILT-IN globalThis.fetch (v8-incompatibility regression guard)",
    async () => {
      // Same construction as documents.ts: Buffer → Blob → FormData "file" part.
      const buffer = Buffer.alloc(2_583_319, 0x41);
      const blob = new Blob([buffer]);
      const formData = new FormData();
      formData.append("file", blob, "AI-ACT.pdf");

      const response = await (globalThis as { fetch: typeof fetch }).fetch(`${base}/api/ingest`, {
        method: "POST",
        body: formData,
        headers: { "X-Collector-Secret": "test" },
        dispatcher: collectorDispatchAgent,
      } as unknown as Parameters<typeof fetch>[1]);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    },
  );

  test(
    "Test 2: packages/server's undici stays on the v7 major (v8 breaks the built-in-fetch dispatcher pairing)",
    () => {
      // require() inside the test resolves through packages/server's
      // node_modules — the SAME dependency the production dispatch uses.
      const version = require("undici/package.json").version;
      expect(version.startsWith("7.")).toBe(true);
    },
  );

  test(
    "Test 3: collectorDispatchAgent is an undici Agent instance (shape pin — no plain-object silent replacement)",
    () => {
      expect(collectorDispatchAgent).toBeInstanceOf(Agent);
    },
  );
});