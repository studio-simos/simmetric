// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 192 plan 03 Task 2 — done-handler additive content preference
 * (D-09 terminal-state contract / Pitfall 9 ref precedence).
 *
 * Pins BOTH `case "done":` blocks in useChatStreaming.ts via the two send
 * paths that reach them:
 *   - retryMessage  → done block 1 (retry variant, :228)
 *   - sendMessage   → done block 2 (main variant, :527 — temp-user dedup +
 *     alreadyHasUser race guard untouched)
 *
 * Contract (UI-SPEC interaction rule 6):
 *   (a) done with content: "Mario Rossi" → terminal message content is the
 *       re-composed text while the streamed ref held "[PERSON_1]"
 *   (b) done WITHOUT content → message content === ref value byte-identical
 *       (old servers / non-DLP chats unchanged)
 *
 * Setup mirrors useChatStreaming.attachBody.test.ts (mock
 * fetch-event-source, minimum args via useChat).
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
  queryKeys: {
    providers: { available: ["providers", "available"] },
    chats: { list: (ws: string) => ["chats", "list", ws] },
  },
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
import { useChat, ChatMessage } from "../hooks/useChat";

const localStorageMock = {
  getItem: jest.fn().mockReturnValue("test-token"),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

/**
 * SSE pump: stream the masked placeholder tokens, then fire the done event
 * with an OPTIONAL content field (additive — present only for permitted
 * DLP users).
 */
function simulateStream(donePayload: Record<string, unknown>, tokens: string[] = ["Il firmatario è [PERSON_1]."]) {
  return (
    _url: string,
    options: {
      onmessage: (msg: { event: string; data: string }) => void;
      onclose: () => void;
    }
  ) => {
    setTimeout(() => {
      for (const tk of tokens) {
        options.onmessage({ event: "token", data: JSON.stringify(tk) });
      }
      options.onmessage({ event: "done", data: JSON.stringify(donePayload) });
      options.onclose();
    }, 10);
    return Promise.resolve();
  };
}

function assistantMessageOf(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find((m) => m.role === "assistant");
}

const USER_MSG = { id: "u1", role: "user", content: "hello", metadata: {}, createdAt: new Date().toISOString() };

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchEventSource.mockReset();
  jest.useFakeTimers();
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve([USER_MSG]),
  } as Response);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("done content preference — main sendMessage path (done block 2)", () => {
  it("done with content: 'Mario Rossi' → terminal message content is the re-composed text (D-09)", async () => {
    mockFetchEventSource.mockImplementation(
      simulateStream({ chatId: "chat-1", messageId: "m-1", content: "Mario Rossi" }),
    );

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage("chi è il firmatario?");
    });
    act(() => {
      jest.advanceTimersByTime(20);
    });

    const msg = assistantMessageOf(result.current.messages);
    expect(msg).toBeDefined();
    expect(msg!.content).toBe("Mario Rossi");
  });

  it("done WITHOUT content → message content === streamed ref value (byte-identical fallback — Pitfall 9)", async () => {
    mockFetchEventSource.mockImplementation(
      simulateStream({ chatId: "chat-1", messageId: "m-2" }, ["Il firmatario è [PERSON_1]"]),
    );

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage("chi è il firmatario?");
    });
    act(() => {
      jest.advanceTimersByTime(20);
    });

    const msg = assistantMessageOf(result.current.messages);
    expect(msg).toBeDefined();
    expect(msg!.content).toBe("Il firmatario è [PERSON_1]");
  });

  it("done with content: undefined → byte-identical fallback (the 'omitted' wire shape)", async () => {
    mockFetchEventSource.mockImplementation(
      simulateStream({ chatId: "chat-1", messageId: "m-3", content: undefined }, ["[PERSON_1] spa"]),
    );

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage("q");
    });
    act(() => {
      jest.advanceTimersByTime(20);
    });

    const msg = assistantMessageOf(result.current.messages);
    expect(msg!.content).toBe("[PERSON_1] spa");
  });

  it("temp-user dedup + alreadyHasUser race guard is preserved when content is present", async () => {
    mockFetchEventSource.mockImplementation(
      simulateStream({ chatId: "chat-1", messageId: "m-4", content: "Mario Rossi" }),
    );

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.sendMessage("q");
    });
    act(() => {
      jest.advanceTimersByTime(20);
    });

    const msgs = result.current.messages;
    // No temp-user message survives the done block (dedup ran); exactly one
    // user message + one assistant message.
    expect(msgs.filter((m) => m.id.startsWith("temp-user-"))).toHaveLength(0);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

describe("done content preference — retryMessage path (done block 1)", () => {
  /** retryMessage is exposed via regenerateLastResponse (the retryMessageRef
   * cross-hook seam — useChat facade carries regenerate, not retry). */
  it("done with content → terminal message content is the re-composed text (retry variant)", async () => {
    mockFetchEventSource.mockImplementation(
      simulateStream({ chatId: "chat-1", messageId: "m-r1", content: "Mario Rossi" }),
    );

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.loadChat("chat-1");
    });
    await act(async () => {
      await result.current.regenerateLastResponse();
    });
    act(() => {
      jest.advanceTimersByTime(20);
    });

    const msg = assistantMessageOf(result.current.messages);
    expect(msg).toBeDefined();
    expect(msg!.content).toBe("Mario Rossi");
  });

  it("done WITHOUT content → byte-identical ref fallback (retry variant)", async () => {
    mockFetchEventSource.mockImplementation(
      simulateStream({ chatId: "chat-1", messageId: "m-r2" }, ["testo [PERSON_1] mascherato"]),
    );

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => {
      await result.current.loadChat("chat-1");
    });
    await act(async () => {
      await result.current.regenerateLastResponse();
    });
    act(() => {
      jest.advanceTimersByTime(20);
    });

    const msg = assistantMessageOf(result.current.messages);
    expect(msg).toBeDefined();
    expect(msg!.content).toBe("testo [PERSON_1] mascherato");
  });
});

describe("source assertions — widget path + streaming accumulation untouched", () => {
  const fs = require("fs");
  const path = require("path");

  it("streaming accumulation is untouched — tokens still accumulate into the ref (placeholders stream as literal text, UI-SPEC surface 5 silent-by-design)", async () => {
    // The useChat.dlp.test.tsx progressive canary pins accumulation; here we
    // pin that the done-handler change did not touch the token arm: the
    // source contains exactly the two coalescing lines and no change to the
    // token handlers.
    const hookTs = fs.readFileSync(path.resolve(__dirname, "../hooks/useChatStreaming.ts"), "utf8");
    const coalesces = hookTs.match(/data\.content \?\? args\.streamingContentRef\.current/g) ?? [];
    expect(coalesces).toHaveLength(2); // BOTH done blocks
    expect(hookTs).not.toMatch(/streamingContentRef\.current \?\? data\.content/); // precedence pinned
  });

  it("widget path needs zero frontend changes — packages/widget is not imported by the hook", () => {
    const hookTs = fs.readFileSync(path.resolve(__dirname, "../hooks/useChatStreaming.ts"), "utf8");
    expect(hookTs).not.toContain("packages/widget");
    expect(hookTs).not.toMatch(/from ["'].*widget/);
  });
});