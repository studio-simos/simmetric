// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * D-01 DLP progressive flush canary — Phase 88 MOD-02.
 *
 * Asserts the frontend SSE consumption is PROGRESSIVE: each `token` event
 * triggers an incremental `streamingContent` update, NOT a single buffered
 * emit at stream close. The server-side `progressiveDLPFlush` lives in
 * `packages/server/src/routes/chat.ts` — this canary is a CONTRACT test on
 * the frontend's progressive accumulation, NOT a code-move test. It guards
 * the progressive-flush contract through the useChat.ts split.
 *
 * Captured green on base BEFORE extraction (D-02). A red test after
 * extraction means the split broke the progressive SSE consumption contract.
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
import { useChat } from "../hooks/useChat";

const localStorageMock = {
  getItem: jest.fn().mockReturnValue("test-token"),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

/**
 * Dispatch one token event per timer tick so the test can assert the
 * intermediate `streamingContent` state between events (progressive).
 */
function simulateProgressiveTokens(tokens: string[]) {
  return (
    _url: string,
    options: {
      onmessage: (msg: { event: string; data: string }) => void;
      onclose: () => void;
    }
  ) => {
    tokens.forEach((tk, idx) => {
      setTimeout(() => {
        options.onmessage({ event: "token", data: JSON.stringify(tk) });
      }, (idx + 1) * 10);
    });
    setTimeout(() => {
      options.onmessage({
        event: "done",
        data: JSON.stringify({ chatId: "chat-prog", messageId: "msg-prog" }),
      });
      options.onclose();
    }, (tokens.length + 1) * 10);
    return Promise.resolve();
  };
}

describe("useChat D-01 DLP progressive flush canary", () => {
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

  it("streamingContent accumulates progressively across token events", async () => {
    mockFetchEventSource.mockImplementation(simulateProgressiveTokens(["A", "B", "C"]));

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hi");
    });

    // Before any token events fire, streamingContent is empty (sendMessage resets it).
    expect(result.current.streamingContent).toBe("");

    // First token -> "A"
    act(() => {
      jest.advanceTimersByTime(10);
    });
    expect(result.current.streamingContent).toBe("A");

    // Second token -> "AB"
    act(() => {
      jest.advanceTimersByTime(10);
    });
    expect(result.current.streamingContent).toBe("AB");

    // Third token -> "ABC"
    act(() => {
      jest.advanceTimersByTime(10);
    });
    expect(result.current.streamingContent).toBe("ABC");
  });

  it("progressive accumulation holds for token events delivered as raw (non-JSON) data", async () => {
    // The onmessage handler falls back to treating raw event.data as a token
    // when JSON.parse throws. Verify progressive accumulation in that path too.
    mockFetchEventSource.mockImplementation(
      (_url: string, options: { onmessage: (msg: { event: string; data: string }) => void; onclose: () => void }) => {
        ["X", "Y"].forEach((tk, idx) => {
          setTimeout(() => {
            // Non-JSON raw payload — triggers the catch branch
            options.onmessage({ event: "token", data: tk });
          }, (idx + 1) * 10);
        });
        setTimeout(() => {
          options.onmessage({
            event: "done",
            data: JSON.stringify({ chatId: "chat-raw", messageId: "msg-raw" }),
          });
          options.onclose();
        }, 30);
        return Promise.resolve();
      }
    );

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hi");
    });

    act(() => {
      jest.advanceTimersByTime(10);
    });
    expect(result.current.streamingContent).toBe("X");

    act(() => {
      jest.advanceTimersByTime(10);
    });
    expect(result.current.streamingContent).toBe("XY");
  });

  describe("DLP matches in SSE done event (Phase 115)", () => {
    function simulateDlpDone() {
      return (
        _url: string,
        options: {
          onmessage: (msg: { event: string; data: string }) => void;
          onclose: () => void;
        }
      ) => {
        setTimeout(() => {
          options.onmessage({
            event: "done",
            data: JSON.stringify({
              chatId: "chat-dlp",
              messageId: "msg-dlp",
              dlp_matches: [
                { type: "email", text: "user@example.com" },
                { type: "credit_card", text: "4111111111111111" },
              ],
            }),
          });
          options.onclose();
        }, 10);
        return Promise.resolve();
      };
    }

    it("includes dlp_matches in the done event payload", async () => {
      mockFetchEventSource.mockImplementation(simulateDlpDone());

      const { result } = renderHook(() => useChat("ws-1"));

      await act(async () => {
        await result.current.sendMessage("Hi");
      });

      act(() => {
        jest.advanceTimersByTime(10);
      });

      // After the stream completes, the messages should include the assistant message
      // with dlpMatches in metadata
      const messages = result.current.messages;
      const assistantMsg = messages.find((m) => m.id === "msg-dlp");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.metadata?.dlpMatches).toBeDefined();
      expect(assistantMsg!.metadata?.dlpMatches).toHaveLength(2);
      expect(assistantMsg!.metadata?.dlpMatches![0]).toEqual({
        type: "email",
        text: "user@example.com",
      });
      expect(assistantMsg!.metadata?.dlpMatches![1]).toEqual({
        type: "credit_card",
        text: "4111111111111111",
      });
    });

    it("does not include dlpMatches when no dlp_matches in done event", async () => {
      mockFetchEventSource.mockImplementation(
        (
          _url: string,
          options: {
            onmessage: (msg: { event: string; data: string }) => void;
            onclose: () => void;
          }
        ) => {
          setTimeout(() => {
            options.onmessage({
              event: "done",
              data: JSON.stringify({ chatId: "chat-nodlp", messageId: "msg-nodlp" }),
            });
            options.onclose();
          }, 10);
          return Promise.resolve();
        }
      );

      const { result } = renderHook(() => useChat("ws-1"));

      await act(async () => {
        await result.current.sendMessage("Hi");
      });

      act(() => {
        jest.advanceTimersByTime(10);
      });

      const messages = result.current.messages;
      const assistantMsg = messages.find((m) => m.id === "msg-nodlp");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.metadata?.dlpMatches).toBeUndefined();
    });
  });
});