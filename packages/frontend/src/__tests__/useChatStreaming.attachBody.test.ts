// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 191 (D-02) — useChatStreaming.sendMessage trailing attachedArchiveIds
 * transport body-shape tests.
 *
 * Proves the wire contract at the fetchEventSource boundary:
 *  - 7th arg ["u1","u2"] → body contains attachedArchiveIds: ["u1","u2"]
 *  - NO 7th arg (or empty array) → body has NO attachedArchiveIds key
 *    (byte-identical wire to pre-191)
 *  - positional order preserved: content, attachedDocId, attachedDocName,
 *    modelOverride, archiveId, skillCall, attachedArchiveIds — Phase 190
 *    callers never shift.
 */
jest.mock("@microsoft/fetch-event-source", () => ({
  fetchEventSource: jest.fn(),
}));

jest.mock("../utils/api", () => ({
  apiGet: jest.fn().mockResolvedValue([]),
  apiPut: jest.fn().mockResolvedValue({}),
  apiPatch: jest.fn().mockResolvedValue({}),
  apiDelete: jest.fn().mockResolvedValue({}),
}));

jest.mock("../queries/queryClient", () => ({
  queryClient: {
    getQueryData: jest.fn(() => []),
    invalidateQueries: jest.fn(),
  },
}));

jest.mock("../queries/keys", () => ({
  queryKeys: { providers: { available: ["providers", "available"] } },
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockFetchEventSource = jest.requireMock("@microsoft/fetch-event-source").fetchEventSource as jest.Mock;

import { renderHook, act } from "@testing-library/react";
import { useChat } from "../hooks/useChat";

const localStorageMock = {
  getItem: jest.fn().mockReturnValue("test-token"),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

function makeNoopStream() {
  return (_url: string, options: { onclose: () => void }) => {
    setTimeout(() => options.onclose(), 0);
    return Promise.resolve();
  };
}

function capturedBody(): Record<string, unknown> {
  const call = mockFetchEventSource.mock.calls.at(-1)!;
  const options = call[1] as { body: string };
  return JSON.parse(options.body) as Record<string, unknown>;
}

function makeArgs() {
  return {
    setMessages: jest.fn(),
    setIsStreaming: jest.fn(),
    setStreamingContent: jest.fn(),
    setStreamingThinking: jest.fn(),
    streamingThinkingRef: { current: "" },
    streamingContentRef: { current: "" },
    setStatusMessage: jest.fn(),
    setActivePlan: jest.fn(),
    setError: jest.fn(),
    setCurrentChatId: jest.fn(),
    currentSourcesRef: { current: [] },
    currentPlanRef: { current: null },
    abortRef: { current: null },
    workspaceId: "ws-1",
    chatId: "chat-1",
    persistedModel: null,
    persistedModelRef: { current: null },
    handleFallbackRef: { current: jest.fn() },
    isFallbackInProgressRef: { current: false },
    setPersistedModel: jest.fn(),
  } as unknown as Parameters<typeof useChat>[0];
}

describe("useChatStreaming sendMessage — attachedArchiveIds body shape (Phase 191 D-02)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchEventSource.mockReset();
    mockFetchEventSource.mockImplementation(makeNoopStream());
  });

  it("7th arg ['u1','u2'] → body contains attachedArchiveIds ['u1','u2']", async () => {
    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage("hi", undefined, undefined, undefined, null, undefined, ["u1", "u2"]);
    });
    const body = capturedBody();
    expect(body.attachedArchiveIds).toEqual(["u1", "u2"]);
    expect(body.message).toBe("hi");
  });

  it("WITHOUT the 7th arg → body has NO attachedArchiveIds key (byte-identical wire — D-02)", async () => {
    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage("hi");
    });
    const body = capturedBody();
    expect(body).not.toHaveProperty("attachedArchiveIds");
  });

  it("empty array 7th arg → body has NO attachedArchiveIds key (byte-identical wire — D-02)", async () => {
    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage("hi", undefined, undefined, undefined, null, undefined, []);
    });
    const body = capturedBody();
    expect(body).not.toHaveProperty("attachedArchiveIds");
  });

  it("positional order preserved — skillCall (6th) and attachedArchiveIds (7th) both ride the body (Phase 190 callers never shift)", async () => {
    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage(
        "hi",
        undefined,
        undefined,
        undefined,
        null,
        { slug: "translate", params: { input: "Ciao" } },
        ["u1"],
      );
    });
    const body = capturedBody();
    expect(body.skillCall).toEqual({ slug: "translate", params: { input: "Ciao" } });
    expect(body.attachedArchiveIds).toEqual(["u1"]);
  });

  it("skillCall alone (Phase 190 shape) → body carries skillCall and NO attachedArchiveIds (backward compat)", async () => {
    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage("hi", undefined, undefined, undefined, null, {
        slug: "translate",
        params: { input: "Ciao" },
      });
    });
    const body = capturedBody();
    expect(body.skillCall).toEqual({ slug: "translate", params: { input: "Ciao" } });
    expect(body).not.toHaveProperty("attachedArchiveIds");
  });
});

// ── 191-03 (WR-01 review fix): retryMessage carries the composer's CURRENT
// selection so regenerate / edit-regenerate / model-fallback turns stay
// archive-grounded AND the server mirror keeps tracking the selection
// (the mirror now only writes when the field is present). The regenerate
// path needs an open chat (chatId + last user message), so the tests seed
// both via loadChat against a stubbed messages fetch. ──
describe("useChatStreaming retryMessage — attachedArchiveIds carry-through (191-03 WR-01)", () => {
  const USER_MSG = { id: "u1", role: "user", content: "hello", metadata: {}, createdAt: new Date().toISOString() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchEventSource.mockReset();
    mockFetchEventSource.mockImplementation(makeNoopStream());
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([USER_MSG]),
    } as Response);
  });

  it("parent-threaded selection → retryMessage body contains attachedArchiveIds (isRegeneration body)", async () => {
    const { result } = renderHook(() => useChat("ws-1", { attachedArchives: ["u1", "u2"] }));
    await act(async () => {
      await result.current.loadChat("chat-1");
    });
    await act(async () => {
      await result.current.regenerateLastResponse();
    });
    const body = capturedBody();
    expect(body.attachedArchiveIds).toEqual(["u1", "u2"]);
    expect(body.isRegeneration).toBe(true);
  });

  it("NO selection threaded → retryMessage body has NO attachedArchiveIds key (byte-identical)", async () => {
    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.loadChat("chat-1");
    });
    await act(async () => {
      await result.current.regenerateLastResponse();
    });
    const body = capturedBody();
    expect(body).not.toHaveProperty("attachedArchiveIds");
  });

  it("EMPTY selection threaded → retryMessage body has NO attachedArchiveIds key (non-empty spread only)", async () => {
    const { result } = renderHook(() => useChat("ws-1", { attachedArchives: [] }));
    await act(async () => {
      await result.current.loadChat("chat-1");
    });
    await act(async () => {
      await result.current.regenerateLastResponse();
    });
    const body = capturedBody();
    expect(body).not.toHaveProperty("attachedArchiveIds");
  });
});