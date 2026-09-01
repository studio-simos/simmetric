// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * D-02 streaming buffer replay + D-08.4 SSE consumption CONTRACT canary.
 *
 * The server's `packages/server/src/routes/chat.ts` accumulates streamed
 * tokens into `fullResponse` and applies a DLP tail-holdback (`finalResponse`)
 * emitted at stream close. This contract test asserts the FRONTEND's
 * accumulation matches the concatenation of all token payloads — i.e. the
 * frontend consumes the SSE stream identically, so the server-side
 * `fullResponse`/`finalResponse` distinction is preserved by the split.
 *
 * NOTE: `progressiveDLPFlush` / `finalResponse` / `fullResponse` are
 * server-side concepts in `packages/server/src/routes/chat.ts` — they are
 * NOT inside `useChat.ts`. This canary does not grep for them in the
 * frontend hook; it asserts the SSE consumption contract via the
 * accumulated `streamingContent` and the persisted assistant message
 * content.
 *
 * Captured green on base BEFORE extraction (D-02).
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
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockFetchEventSource = jest.requireMock("@microsoft/fetch-event-source").fetchEventSource as jest.Mock;

import { renderHook, act } from "@testing-library/react";
import { useChat, ChatMessage } from "../hooks/useChat";

const localStorageMock = {
  getItem: jest.fn().mockReturnValue("test-token"),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

function simulateSSEEvents(events: Array<{ event: string; data: unknown }>) {
  return (
    _url: string,
    options: {
      onmessage: (msg: { event: string; data: string }) => void;
      onclose: () => void;
    }
  ) => {
    setTimeout(() => {
      for (const ev of events) {
        options.onmessage({ event: ev.event, data: JSON.stringify(ev.data) });
      }
      options.onclose();
    }, 10);
    return Promise.resolve();
  };
}

describe("useChat SSE consumption contract canary (D-02 / D-08.4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchEventSource.mockReset();
    jest.useFakeTimers();
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("accumulated streamingContent equals the concatenation of all token payloads (D-02 buffer replay)", async () => {
    mockFetchEventSource.mockImplementation(
      simulateSSEEvents([
        { event: "token", data: "Hello" },
        { event: "token", data: ", " },
        { event: "token", data: "world" },
        { event: "token", data: "!" },
        { event: "done", data: { chatId: "c-contract", messageId: "m-contract" } },
      ])
    );

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hi");
    });

    // Capture streamingContent BEFORE the done event fires (done resets it).
    // The done event is in the same setTimeout batch, so we capture the
    // accumulated value from the persisted assistant message instead.
    act(() => {
      jest.advanceTimersByTime(20);
    });

    const assistantMsg = result.current.messages.find((m: ChatMessage) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    // The contract: the assistant message content equals the concatenation
    // of every token payload — exactly what the server's fullResponse
    // accumulator relies on the frontend reproducing.
    expect(assistantMsg!.content).toBe("Hello, world!");
  });

  it("streamingContent resets to empty after done event (D-08.4 truncation contract)", async () => {
    mockFetchEventSource.mockImplementation(
      simulateSSEEvents([
        { event: "token", data: "A" },
        { event: "token", data: "B" },
        { event: "done", data: { chatId: "c-reset", messageId: "m-reset" } },
      ])
    );

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hi");
    });

    act(() => {
      jest.advanceTimersByTime(20);
    });

    // After done, streamingContent is reset to "" — the assistant message
    // holds the final accumulated content. This is the contract: streaming
    // buffer replay is finalized into the message and the live buffer is
    // cleared, so the next turn starts fresh.
    expect(result.current.streamingContent).toBe("");
    expect(result.current.isStreaming).toBe(false);

    const assistantMsg = result.current.messages.find((m: ChatMessage) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("AB");
  });

  it("status and citations events do not corrupt the token accumulation contract", async () => {
    mockFetchEventSource.mockImplementation(
      simulateSSEEvents([
        { event: "token", data: "P" },
        { event: "status", data: { message: "thinking" } },
        { event: "token", data: "Q" },
        { event: "citations", data: { sources: [{ documentId: "d1", documentName: "Doc", score: 0.5 }] } },
        { event: "token", data: "R" },
        { event: "done", data: { chatId: "c-mixed", messageId: "m-mixed" } },
      ])
    );

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hi");
    });

    act(() => {
      jest.advanceTimersByTime(20);
    });

    const assistantMsg = result.current.messages.find((m: ChatMessage) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("PQR");
    expect(assistantMsg!.metadata!.sources).toHaveLength(1);
  });
});