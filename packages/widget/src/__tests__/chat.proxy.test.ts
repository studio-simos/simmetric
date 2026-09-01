// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

jest.mock("../services/widgetApi", () => ({
  createSession: jest.fn(),
  getWidgetConfig: jest.fn(),
  validateSession: jest.fn(),
  incrementSessionCounters: jest.fn(),
  searchWidgetWorkspaces: jest.fn(),
}));

// Mock axios for upstream proxy calls
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

import request from "supertest";
import { PassThrough } from "stream";
import { createApp } from "../index";
import { validateSession, getWidgetConfig, incrementSessionCounters, searchWidgetWorkspaces } from "../services/widgetApi";
import axios from "axios";

const mockedValidateSession = validateSession as jest.Mock;
const mockedGetWidgetConfig = getWidgetConfig as jest.Mock;
const mockedIncrementSessionCounters = incrementSessionCounters as jest.Mock;
const mockedSearchWidgetWorkspaces = searchWidgetWorkspaces as jest.Mock;
const mockedAxiosPost = axios.post as jest.Mock;

const app = createApp();

describe("POST /api/chat/:widgetId/stream", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("returns 401 without X-Session-Token header", async () => {
    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .send({ message: "Hello" });
    expect(res.status).toBe(401);
  });

  it("returns 400 with invalid body", async () => {
    // Set up valid session so we get past auth
    mockedValidateSession.mockResolvedValue({
      widgetId: "widget-1",
      messageCount: 0,
      hourlyRemaining: 20,
      sessionToken: "tok-1",
    });
    mockedGetWidgetConfig.mockResolvedValue({
      id: "widget-1",
      name: "Test",
      workspaceId: "ws-1",
      workspaceIds: ["ws-1"],
      isActive: true,
    });

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({}); // no message field

    expect(res.status).toBe(400);
  });
});

describe("Widget chat pre-search (RAG-02, RAG-03)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateSession.mockResolvedValue({
      widgetId: "widget-1",
      messageCount: 0,
      hourlyRemaining: 20,
      sessionToken: "tok-1",
    });
    mockedGetWidgetConfig.mockResolvedValue({
      id: "widget-1",
      name: "Test",
      workspaceId: "ws-1",
      workspaceIds: ["ws-1", "ws-2"],
      isActive: true,
    });
    mockedIncrementSessionCounters.mockResolvedValue({});
    // Mock upstream axios to return a proper stream that ends
    mockedAxiosPost.mockImplementation(() => {
      const stream = new PassThrough();
      stream.write('event: done\ndata: {}\n\n');
      stream.end();
      return Promise.resolve({ data: stream });
    });
  });

  it("calls searchWidgetWorkspaces with config.id (widgetId), NOT workspaceIds", async () => {
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    expect(mockedSearchWidgetWorkspaces).toHaveBeenCalledWith(
      "What is RAG?",
      "widget-1"  // widgetId, NOT workspaceIds
    );
  });

  it("includes ragContext in upstream request when search returns results", async () => {
    mockedSearchWidgetWorkspaces.mockResolvedValue({
      results: [
        {
          chunkId: "c1",
          documentId: "d1",
          documentName: "doc1.pdf",
          chunkText: "RAG stands for Retrieval-Augmented Generation",
          score: 0.9,
          source: "vector",
          metadata: { sourceWorkspaceId: "ws-1" },
        },
      ],
    });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    // Find the upstream chat/stream call (not the search call)
    const upstreamCalls = mockedAxiosPost.mock.calls.filter(
      (call: unknown[]) => (call[0] as string | undefined)?.includes("/chat/stream")
    );
    expect(upstreamCalls.length).toBeGreaterThan(0);
    const upstreamBody = upstreamCalls[0][1];
    expect(upstreamBody.ragContext).toBeDefined();
    expect(upstreamBody.ragContext).toContain("RAG stands for Retrieval-Augmented Generation");
    expect(upstreamBody.ragContext).toContain("[Source: doc1.pdf");
  });

  it("continues without ragContext when search fails (non-blocking)", async () => {
    mockedSearchWidgetWorkspaces.mockRejectedValue(new Error("Search timeout"));

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    // Upstream should still be called (search failure is non-blocking)
    const upstreamCalls = mockedAxiosPost.mock.calls.filter(
      (call: unknown[]) => (call[0] as string | undefined)?.includes("/chat/stream")
    );
    expect(upstreamCalls.length).toBeGreaterThan(0);
    const upstreamBody = upstreamCalls[0][1];
    expect(upstreamBody.ragContext).toBeUndefined();
  });

  it("omits ragContext when search returns empty results", async () => {
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    const upstreamCalls = mockedAxiosPost.mock.calls.filter(
      (call: unknown[]) => (call[0] as string | undefined)?.includes("/chat/stream")
    );
    expect(upstreamCalls.length).toBeGreaterThan(0);
    const upstreamBody = upstreamCalls[0][1];
    expect(upstreamBody.ragContext).toBeUndefined();
  });

  it("proxies to the internal widget chat endpoint (API-key auth)", async () => {
    // 260809-tuw: the upstream URL is the internal widget endpoint (the only
    // server route accepting the proxy's API-key-only auth). The old
    // /api/workspaces/:workspaceId/chat/stream URL sat behind authMiddleware
    // (JWT) and 401'd — the "Upstream request failed" bug. The server now
    // resolves the target workspace from the widget's DB whitelist.
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    const upstreamCalls = mockedAxiosPost.mock.calls.filter(
      (call: unknown[]) => (call[0] as string | undefined)?.includes("/chat/stream")
    );
    expect(upstreamCalls.length).toBeGreaterThan(0);
    const [url, _body, config] = upstreamCalls[0] as [string, unknown, { headers?: Record<string, string> }];

    // Exact URL pin — the internal endpoint is API-key authenticated
    expect(url).toBe("http://localhost:3000/api/internal/widget/chat/stream");

    // The auth contract the new endpoint relies on: X-Api-Key + X-Widget-Id
    const headers = config.headers || {};
    expect(headers["X-Api-Key"]).toBeDefined();
    expect(headers["X-Api-Key"]).not.toBe("");
    expect(headers["X-Widget-Id"]).toBe("widget-1");
  });
});

describe("POST /api/sessions (via chat test suite)", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("returns 400 without widgetId", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/config/:widgetId (via chat test suite)", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("returns 404 for unknown widget", async () => {
    const err = new Error("Not found");
    (err as any).response = { status: 404 };
    const { getWidgetConfig } = require("../services/widgetApi");
    getWidgetConfig.mockRejectedValue(err);

    const res = await request(app).get("/api/config/unknown-widget");
    expect(res.status).toBe(404);
  });
});

// WID-01 D-08 + WID-02 D-01/D-02: upstream headers + rag-degraded status + disableRagSearch body
describe("Widget chat proxy — WID-01 upstream headers + WID-02 rag-degraded status/body", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateSession.mockResolvedValue({
      widgetId: "widget-1",
      messageCount: 0,
      hourlyRemaining: 20,
      sessionToken: "tok-1",
    });
    mockedGetWidgetConfig.mockResolvedValue({
      id: "widget-1",
      name: "Test",
      workspaceId: "ws-1",
      workspaceIds: ["ws-1", "ws-2"],
      isActive: true,
    });
    mockedIncrementSessionCounters.mockResolvedValue({});
    // Upstream returns a stream that ends — proxy relays bytes to client
    mockedAxiosPost.mockImplementation(() => {
      const stream = new PassThrough();
      stream.write('event: done\ndata: {}\n\n');
      stream.end();
      return Promise.resolve({ data: stream });
    });
  });

  const findUpstreamCall = () => {
    const calls = mockedAxiosPost.mock.calls.filter(
      (call: unknown[]) => (call[0] as string | undefined)?.includes("/chat/stream")
    );
    if (calls.length === 0) throw new Error("no upstream /chat/stream call recorded");
    return calls[0];
  };

  it("sends X-Accel-Buffering: no and Accept: text/event-stream on upstream request", async () => {
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    const call = findUpstreamCall();
    const headers = (call[2] as { headers?: Record<string, string> }).headers || {};
    expect(headers["X-Accel-Buffering"]).toBe("no");
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  it("emits status rag-degraded AND sets disableRagSearch when pre-search rejects", async () => {
    mockedSearchWidgetWorkspaces.mockRejectedValue(new Error("search 500"));

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    // Status event surfaced to client before upstream relay
    expect(res.text).toContain("rag-degraded");
    // 131-07 (G-131-19): the event carries a machine-readable flag, NOT the
    // hardcoded English literal — the client owns the translation.
    expect(res.text).not.toContain("Knowledge base temporarily unavailable");
    // Upstream body includes disableRagSearch: true
    const call = findUpstreamCall();
    const body = call[1] as { disableRagSearch?: boolean };
    expect(body.disableRagSearch).toBe(true);
  });

  it("emits status rag-degraded when pre-search returns 0 results", async () => {
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    expect(res.text).toContain("rag-degraded");
    expect(res.text).not.toContain("Knowledge base temporarily unavailable");
    const call = findUpstreamCall();
    const body = call[1] as { disableRagSearch?: boolean };
    expect(body.disableRagSearch).toBe(true);
  });

  it("forwards the locale from the validated body to the upstream /chat/stream request (G-131-19)", async () => {
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "Ciao", locale: "it" });

    const call = findUpstreamCall();
    const body = call[1] as { locale?: string };
    expect(body.locale).toBe("it");
  });

  it("omits locale from the upstream body when the client does not send it (additive)", async () => {
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "Hello" });

    const call = findUpstreamCall();
    const body = call[1] as { locale?: string };
    expect(body.locale).toBeUndefined();
  });

  it("does NOT emit rag-degraded and omits disableRagSearch when pre-search returns results", async () => {
    mockedSearchWidgetWorkspaces.mockResolvedValue({
      results: [
        {
          chunkId: "c1",
          documentId: "d1",
          documentName: "doc1.pdf",
          chunkText: "RAG context content",
          score: 0.9,
          metadata: { sourceWorkspaceId: "ws-1" },
        },
      ],
    });

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "What is RAG?" });

    expect(res.text).not.toContain("rag-degraded");
    const call = findUpstreamCall();
    const body = call[1] as { disableRagSearch?: boolean; ragContext?: string };
    expect(body.disableRagSearch).toBeUndefined();
    expect(body.ragContext).toBeDefined();
  });
});

// D-04 (Phase 66 E2E-03): contract extensions — byte-relay transparency,
// header pass-through, EPIPE abort path, dedup done boundary.
// These 4 tests pin the widget SSE proxy seam (WID-01/WID-02 Phase 65).
describe("Widget chat proxy — D-04 contract extensions (byte-relay, header pass-through, EPIPE abort, dedup done)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateSession.mockResolvedValue({
      widgetId: "widget-1",
      messageCount: 0,
      hourlyRemaining: 20,
      sessionToken: "tok-1",
      id: "session-uuid-1",
    });
    mockedGetWidgetConfig.mockResolvedValue({
      id: "widget-1",
      name: "Test",
      workspaceId: "ws-1",
      workspaceIds: ["ws-1"],
      isActive: true,
    });
    mockedIncrementSessionCounters.mockResolvedValue({});
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });
  });

  const findUpstreamCall = () => {
    const calls = mockedAxiosPost.mock.calls.filter(
      (call: unknown[]) => (call[0] as string | undefined)?.includes("/chat/stream")
    );
    if (calls.length === 0) throw new Error("no upstream /chat/stream call recorded");
    return calls[0];
  };

  it("byte-relay transparency: res.write receives chunk verbatim from upstream (no transformation)", async () => {
    // T-66-04: pin that the proxy is a transparent byte-relay — res.write
    // receives the exact chunk emitted by upstream, with no parsing, filtering,
    // or transformation. A dropped or modified chunk would silently drop SSE
    // events (token/citations/done) from the visitor's view.
    const exactChunk = 'event: token\ndata: "hi"\n\n';
    mockedAxiosPost.mockImplementation(() => {
      const stream = new PassThrough();
      // Write the chunk INSIDE the mock (before the proxy attaches the data
      // listener) — PassThrough buffers the data so the listener receives it
      // on attach. Same pattern as the existing WID-01 tests.
      stream.write(exactChunk);
      stream.end();
      return Promise.resolve({ data: stream });
    });

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "hello" });

    // The proxy must have relayed the chunk verbatim — no transformation,
    // no parsing, no re-serialization of the SSE event.
    expect(res.text).toContain(exactChunk);
    // The proxy must NOT alter the SSE event name or data payload.
    expect(res.text).not.toContain('event: "token"'); // no JSON-encoding of event name
    expect(res.text).not.toContain('"event":"token"'); // no re-serialization
  });

  it("header pass-through: axios.post called with X-Accel-Buffering: no + Accept: text/event-stream", async () => {
    // T-66-04: pin WID-01 header contract — the upstream REQUEST carries
    // X-Accel-Buffering: no (disables nginx buffering along server→upstream
    // path) and Accept: text/event-stream (advertises SSE intent). Without
    // these headers, intermediaries may buffer the SSE stream and break
    // token-by-token rendering on the visitor side.
    mockedAxiosPost.mockImplementation(() => {
      const stream = new PassThrough();
      stream.write('event: done\ndata: {}\n\n');
      stream.end();
      return Promise.resolve({ data: stream });
    });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "hello" });

    const call = findUpstreamCall();
    const config = call[2] as { headers?: Record<string, string> };
    const headers = config.headers || {};
    expect(headers["X-Accel-Buffering"]).toBe("no");
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  it("EPIPE abort path: axios.post receives an AbortSignal (abortController wired to req.close + res.write throw)", async () => {
    // T-66-03: pin WID-01 EPIPE guard contract — the upstream axios.post call
    // MUST receive `signal: abortController.signal` so that when the proxy
    // detects client disconnect (req "close" event OR res.write throw EPIPE),
    // `abortController.abort()` cancels the upstream request and releases the
    // upstream connection (no connection leak).
    //
    // The full EPIPE path (res.write throw → catch → abortController.abort()) is
    // a 3-line internal catch block that cannot be reliably triggered via
    // supertest (would require breaking the real HTTP socket mid-stream). We
    // pin the CONTRACT: the signal IS wired to axios.post, enabling abort.
    // The internal mechanism is verified by code inspection of chat.ts:133-141
    // (data handler try/catch → abortController.abort()).
    let capturedSignal: AbortSignal | undefined;
    mockedAxiosPost.mockImplementation((_url: string, _body: unknown, cfg: any) => {
      capturedSignal = cfg?.signal;
      const stream = new PassThrough();
      stream.write('event: done\ndata: {}\n\n');
      stream.end();
      return Promise.resolve({ data: stream });
    });

    await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "hello" });

    // The upstream axios.post call must carry an AbortSignal — this is the
    // contract that enables EPIPE-triggered abort. Without the signal, a
    // client disconnect would leave the upstream connection open (leak).
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // During normal operation (no EPIPE, no client disconnect) the signal is
    // NOT aborted — the upstream request completes normally.
    expect(capturedSignal!.aborted).toBe(false);
  });

  it("dedup done: proxy relays 2 done events verbatim — dedup is enforced at the Preact client layer (useWidgetChat.ts)", async () => {
    // D-04 dedup boundary: the widget SSE proxy is a transparent byte-relay
    // and does NOT dedup SSE events. If upstream emits 2 `event: done` events,
    // the client receives 2 `event: done` events verbatim. The actual dedup
    // (chatId+messageId) is enforced at the Preact client layer in
    // `useWidgetChat.ts`, covered by `useWidgetChat.dedup.test.ts`.
    //
    // This test pins the proxy boundary: the proxy must NOT parse or filter
    // SSE events — it relays bytes. Any dedup at this layer would require
    // parsing the stream (breaking transparency) and would couple the proxy
    // to the SSE event schema (fragile).
    const doneEvent1 = 'event: done\ndata: {"chatId":"c1","messageId":"m1"}\n\n';
    const doneEvent2 = 'event: done\ndata: {"chatId":"c1","messageId":"m1"}\n\n';
    mockedAxiosPost.mockImplementation(() => {
      const stream = new PassThrough();
      // Write 2 consecutive done events INSIDE the mock (before the proxy
      // attaches the data listener) — PassThrough buffers them so the listener
      // receives both on attach. Same pattern as existing WID-01 tests.
      stream.write(doneEvent1);
      stream.write(doneEvent2);
      stream.end();
      return Promise.resolve({ data: stream });
    });

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "hello" });

    // The proxy relays BOTH done events verbatim — dedup is NOT at this layer.
    const doneCount = (res.text.match(/event: done/g) || []).length;
    expect(doneCount).toBe(2);
    // Both events appear verbatim in the relayed bytes (no dedup, no filtering).
    expect(res.text).toContain(doneEvent1);
    expect(res.text).toContain(doneEvent2);
  });
});

// ─── Phase 94: thinking event strip defense-in-depth (D-03, Pitfall 4) ───
// The widget proxy NEVER sets include_thinking upstream AND strips
// `event: thinking` blocks defense-in-depth — even if upstream emits them
// (bug or future change), the proxy filters them before reaching cached
// Preact clients.

describe("Widget chat proxy — Phase 94 thinking event strip (D-03, Pitfall 4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateSession.mockResolvedValue({
      widgetId: "widget-1",
      messageCount: 0,
      hourlyRemaining: 20,
      sessionToken: "tok-1",
      id: "session-uuid-1",
    });
    mockedGetWidgetConfig.mockResolvedValue({
      id: "widget-1",
      name: "Test",
      workspaceId: "ws-1",
      workspaceIds: ["ws-1"],
      isActive: true,
    });
    mockedIncrementSessionCounters.mockResolvedValue({});
    mockedSearchWidgetWorkspaces.mockResolvedValue({ results: [] });
  });

  it("strips event: thinking blocks from upstream SSE (Pitfall 4 defense-in-depth)", async () => {
    const upstreamSSE =
      'event: thinking\ndata: {"content":"secret reasoning"}\n\n' +
      'event: token\ndata: "answer"\n\n';
    mockedAxiosPost.mockImplementation(() => {
      const stream = new PassThrough();
      stream.write(upstreamSSE);
      stream.end();
      return Promise.resolve({ data: stream });
    });

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "hello" });

    expect(res.text).not.toContain("event: thinking");
    expect(res.text).toContain("event: token");
  });

  it("forwards event: token and event: done verbatim (non-thinking events pass through)", async () => {
    const upstreamSSE =
      'event: token\ndata: "hi"\n\n' +
      'event: done\ndata: {"chatId":"c1"}\n\n';
    mockedAxiosPost.mockImplementation(() => {
      const stream = new PassThrough();
      stream.write(upstreamSSE);
      stream.end();
      return Promise.resolve({ data: stream });
    });

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "hello" });

    expect(res.text).toContain('event: token\ndata: "hi"');
    expect(res.text).toContain('event: done\ndata: {"chatId":"c1"}');
    expect(res.text).not.toContain("event: thinking");
  });

  it("handles thinking event split across chunks (buffer-based strip)", async () => {
    // The thinking event block is split across two data chunks: the first
    // contains `event: thin` (incomplete), the second completes it with
    // `king\ndata: {"content":"r"}\n\n`. The buffer-based strip holds the
    // incomplete block in `buffer.pending` and filters it once complete.
    mockedAxiosPost.mockImplementation(() => {
      const stream = new PassThrough();
      stream.write('event: thin');
      stream.write('king\ndata: {"content":"r"}\n\n');
      stream.write('event: token\ndata: "ok"\n\n');
      stream.end();
      return Promise.resolve({ data: stream });
    });

    const res = await request(app)
      .post("/api/chat/widget-1/stream")
      .set("X-Session-Token", "valid-token")
      .send({ message: "hello" });

    expect(res.text).not.toContain("event: thinking");
    expect(res.text).not.toContain("event: thin");
    expect(res.text).toContain("event: token");
  });
});