// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useChat characterization — pins the UseChatReturn shape that the 9
 * frontend importers depend on. Captured green on base BEFORE the
 * useChat.ts extraction (Phase 88 MOD-02, D-02 base-capture discipline).
 *
 * A red test after extraction is a regression, not a missing test.
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

import { renderHook } from "@testing-library/react";
import { useChat } from "../hooks/useChat";

const localStorageMock = {
  getItem: jest.fn().mockReturnValue("test-token"),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

describe("useChat characterization (UseChatReturn shape pinned)", () => {
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

  it("returns a UseChatReturn with every public field present", () => {
    const { result } = renderHook(() => useChat("ws-1"));

    const r = result.current;

    // State fields
    expect(Array.isArray(r.messages)).toBe(true);
    expect(typeof r.isStreaming).toBe("boolean");
    expect(typeof r.streamingContent).toBe("string");
    // D-03 (Phase 94, Plan 94-03): additive mirror of streamingContent.
    expect(typeof r.streamingThinking).toBe("string");
    expect(r.statusMessage).toBeNull();
    expect(r.activePlan).toBeNull();
    expect(r.currentChatId).toBeNull();
    expect(r.chatName).toBeNull();
    expect(r.error).toBeNull();
    expect(r.persistedModel).toBeNull();

    // Action methods
    expect(typeof r.sendMessage).toBe("function");
    expect(typeof r.loadChat).toBe("function");
    expect(typeof r.clearChat).toBe("function");
    expect(typeof r.abortStream).toBe("function");
    expect(typeof r.removeMessage).toBe("function");
    expect(typeof r.renameChat).toBe("function");
    expect(typeof r.updateChatModel).toBe("function");
    expect(typeof r.setMessages).toBe("function");
    expect(typeof r.regenerateLastResponse).toBe("function");
    expect(typeof r.editLastMessageAndRegenerate).toBe("function");
  });

  it("returns a stable UseChatReturn shape across re-renders", () => {
    const { result, rerender } = renderHook(() => useChat("ws-1"));

    const keysBefore = Object.keys(result.current).sort();
    rerender();
    const keysAfter = Object.keys(result.current).sort();

    expect(keysAfter).toEqual(keysBefore);
    // Pin the exact field set the 9 importers depend on.
    expect(keysAfter).toEqual(
      [
        "abortStream",
        "activePlan",
        "chatName",
        "clearChat",
        "currentChatId",
        "editLastMessageAndRegenerate",
        "error",
        "isStreaming",
        "loadChat",
        "messages",
        "persistedModel",
        "regenerateLastResponse",
        "removeMessage",
        "renameChat",
        "sendMessage",
        "setMessages",
        "statusMessage",
        "streamingContent",
        "streamingThinking",
        "updateChatModel",
      ]
    );
  });
});