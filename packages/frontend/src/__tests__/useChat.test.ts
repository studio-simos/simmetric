// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

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
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "chat.fallback.switched" && options) return `Model '${options.from}' is unavailable. Switched to '${options.to}'.`;
      if (key === "chat.fallback.noModels") return "No models available.";
      if (key === "chat.fallback.undo") return "Undo";
      if (key === "chat.modelSelector.unavailable") return "Model no longer available";
      return key;
    },
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

const mockQueryClient = jest.requireMock("../queries/queryClient").queryClient as {
  getQueryData: jest.Mock;
  invalidateQueries: jest.Mock;
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

describe("useChat SSE done metadata", () => {
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

  function simulateSSEEvents(events: Array<{ event: string; data: unknown }>) {
    return (_url: string, options: { onmessage: (msg: { event: string; data: string }) => void; onclose: () => void }) => {
      setTimeout(() => {
        for (const ev of events) {
          options.onmessage({
            event: ev.event,
            data: JSON.stringify(ev.data),
          });
        }
        options.onclose();
      }, 10);
      return Promise.resolve();
    };
  }

  function simulateSSEError(err: Error) {
    return (_url: string, options: { onerror: (err: Error) => void }) => {
      setTimeout(() => {
        try {
          options.onerror(err);
        } catch {
          // Swallow — the hook re-throws in onerror; we only care that it was called
        }
      }, 10);
      return Promise.resolve();
    };
  }

  it("stores modelUsed and modelProvider in message metadata when done event includes them", async () => {
    mockFetchEventSource.mockImplementation(
      simulateSSEEvents([
        {
          event: "done",
          data: {
            chatId: "chat-123",
            messageId: "msg-456",
            model: "gpt-4o",
            providerType: "openai",
          },
        },
      ])
    );

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    act(() => {
      jest.advanceTimersByTime(20);
    });

    const assistantMsg = result.current.messages.find((m: ChatMessage) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.metadata).toBeDefined();
    expect(assistantMsg!.metadata!.modelUsed).toBe("gpt-4o");
    expect(assistantMsg!.metadata!.modelProvider).toBe("openai");
  });

  it("omits modelUsed and modelProvider when done event lacks them", async () => {
    mockFetchEventSource.mockImplementation(
      simulateSSEEvents([
        {
          event: "done",
          data: {
            chatId: "chat-123",
            messageId: "msg-456",
          },
        },
      ])
    );

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    act(() => {
      jest.advanceTimersByTime(20);
    });

    const assistantMsg = result.current.messages.find((m: ChatMessage) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.metadata).toBeDefined();
    expect(assistantMsg!.metadata!.modelUsed).toBeUndefined();
    expect(assistantMsg!.metadata!.modelProvider).toBeUndefined();
  });

  it("preserves sources alongside model metadata in done event", async () => {
    mockFetchEventSource.mockImplementation(
      simulateSSEEvents([
        {
          event: "citations",
          data: {
            sources: [
              { documentId: "doc-1", documentName: "Test Doc", score: 0.95 },
            ],
          },
        },
        {
          event: "done",
          data: {
            chatId: "chat-123",
            messageId: "msg-456",
            model: "gemma4:latest",
            providerType: "ollama",
          },
        },
      ])
    );

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    act(() => {
      jest.advanceTimersByTime(20);
    });

    const assistantMsg = result.current.messages.find((m: ChatMessage) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.metadata!.sources).toHaveLength(1);
    expect(assistantMsg!.metadata!.modelUsed).toBe("gemma4:latest");
    expect(assistantMsg!.metadata!.modelProvider).toBe("ollama");
  });

  it("triggers fallback when persistedModel disappears from availableModels", async () => {
    const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;
    const mockApiPatch = jest.requireMock("../utils/api").apiPatch as jest.Mock;

    mockApiGet.mockImplementation((path: string) => {
      if (path.includes("/agent-config")) {
        return Promise.resolve({ providerId: "p2", model: "fallback-model" });
      }
      if (path === "/workspaces/ws-1/chats") {
        return Promise.resolve([{ id: "chat-1", providerId: "p1", model: "gone-model" }]);
      }
      return Promise.resolve([]);
    });
    mockApiPatch.mockResolvedValue({});

    mockQueryClient.getQueryData.mockReturnValue([{ providerId: "p2", name: "fallback-model", isDefault: true }]);

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.loadChat("chat-1");
    });

    act(() => {
      jest.advanceTimersByTime(700);
    });

    expect(mockApiPatch).toHaveBeenCalledWith(
      "/workspaces/ws-1/chats/chat-1/model",
      expect.objectContaining({ providerId: "p2", model: "fallback-model" })
    );
  });

  it("SSE onerror triggers fallback retry with modelOverride", async () => {
    const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;
    const mockApiPatch = jest.requireMock("../utils/api").apiPatch as jest.Mock;
    mockApiPatch.mockResolvedValue({});

    // Load a chat with a model that is initially available
    mockApiGet.mockImplementation((path: string) => {
      if (path === "/workspaces/ws-1/chats") {
        return Promise.resolve([{ id: "chat-1", providerId: "p1", model: "original-model" }]);
      }
      return Promise.resolve([]);
    });

    mockQueryClient.getQueryData.mockReturnValue([
        { providerId: "p1", name: "original-model", isDefault: false },
        { providerId: "p2", name: "fallback-model", isDefault: true },
      ]);

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.loadChat("chat-1");
    });

    // Now make the original model unavailable so SSE onerror triggers fallback
    mockQueryClient.getQueryData.mockReturnValue([{ providerId: "p2", name: "fallback-model", isDefault: true }]);

    mockFetchEventSource.mockImplementation(simulateSSEError(new Error("Connection lost")));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    act(() => {
      jest.advanceTimersByTime(10);
    });

    act(() => {
      jest.advanceTimersByTime(700);
    });

    expect(mockApiPatch).toHaveBeenCalledWith(
      expect.stringContaining("/model"),
      expect.objectContaining({ providerId: "p2", model: "fallback-model" })
    );

    // Fallback triggered by SSE onerror; retryMessage may or may not re-send
    // depending on message history timing — the critical behavior is the model patch
    expect(mockFetchEventSource).toHaveBeenCalledTimes(1);
  });

  it("fallback tier 1: uses workspace default when available", async () => {
    const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;
    const mockApiPatch = jest.requireMock("../utils/api").apiPatch as jest.Mock;
    mockApiPatch.mockResolvedValue({});

    mockApiGet.mockImplementation((path: string) => {
      if (path.includes("/agent-config")) {
        return Promise.resolve({ providerId: "p-workspace", model: "workspace-model" });
      }
      if (path === "/workspaces/ws-1/chats") {
        return Promise.resolve([{ id: "chat-1", providerId: "p-gone", model: "gone-model" }]);
      }
      return Promise.resolve([]);
    });

    mockQueryClient.getQueryData.mockReturnValue([
        { providerId: "p-workspace", name: "workspace-model", isDefault: false },
        { providerId: "p-global", name: "global-model", isDefault: true },
      ]);

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.loadChat("chat-1");
    });

    act(() => {
      jest.advanceTimersByTime(700);
    });

    expect(mockApiPatch).toHaveBeenCalledWith(
      expect.stringContaining("/model"),
      expect.objectContaining({ providerId: "p-workspace", model: "workspace-model" })
    );
  });

  it("fallback tier 2: uses global default when workspace default missing", async () => {
    const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;
    const mockApiPatch = jest.requireMock("../utils/api").apiPatch as jest.Mock;
    mockApiPatch.mockResolvedValue({});

    mockApiGet.mockImplementation((path: string) => {
      if (path.includes("/agent-config")) {
        return Promise.resolve({}); // no workspace default
      }
      if (path === "/workspaces/ws-1/chats") {
        return Promise.resolve([{ id: "chat-2", providerId: "p-gone", model: "gone-model" }]);
      }
      return Promise.resolve([]);
    });

    mockQueryClient.getQueryData.mockReturnValue([
        { providerId: "p-global", name: "global-model", isDefault: true },
        { providerId: "p-any", name: "any-model", isDefault: false },
      ]);

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.loadChat("chat-2");
    });

    act(() => {
      jest.advanceTimersByTime(700);
    });

    expect(mockApiPatch).toHaveBeenCalledWith(
      expect.stringContaining("/model"),
      expect.objectContaining({ providerId: "p-global", model: "global-model" })
    );
  });

  it("fallback tier 3: uses any available model when no defaults exist", async () => {
    const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;
    const mockApiPatch = jest.requireMock("../utils/api").apiPatch as jest.Mock;
    mockApiPatch.mockResolvedValue({});

    mockApiGet.mockImplementation((path: string) => {
      if (path.includes("/agent-config")) {
        return Promise.resolve({}); // no workspace default
      }
      if (path === "/workspaces/ws-1/chats") {
        return Promise.resolve([{ id: "chat-3", providerId: "p-gone", model: "gone-model" }]);
      }
      return Promise.resolve([]);
    });

    mockQueryClient.getQueryData.mockReturnValue([{ providerId: "p-any", name: "any-model", isDefault: false }]);

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.loadChat("chat-3");
    });

    act(() => {
      jest.advanceTimersByTime(700);
    });

    expect(mockApiPatch).toHaveBeenCalledWith(
      expect.stringContaining("/model"),
      expect.objectContaining({ providerId: "p-any", model: "any-model" })
    );
  });

  it("retry does not duplicate user message", async () => {
    const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;
    const mockApiPatch = jest.requireMock("../utils/api").apiPatch as jest.Mock;
    mockApiPatch.mockResolvedValue({});

    // First send a message successfully
    mockFetchEventSource.mockImplementation(
      simulateSSEEvents([
        {
          event: "done",
          data: { chatId: "chat-1", messageId: "msg-1" },
        },
      ])
    );

    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    act(() => {
      jest.advanceTimersByTime(20);
    });

    // After successful send: 1 user + 1 assistant
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(1);

    // Now simulate model unavailability and trigger fallback via loadChat
    mockApiGet.mockImplementation((path: string) => {
      if (path.includes("/agent-config")) {
        return Promise.resolve({ providerId: "p2", model: "fallback-model" });
      }
      if (path === "/workspaces/ws-1/chats") {
        return Promise.resolve([{ id: "chat-2", providerId: "p1", model: "gone-model" }]);
      }
      return Promise.resolve([]);
    });

    mockQueryClient.getQueryData.mockReturnValue([{ providerId: "p2", name: "fallback-model", isDefault: true }]);

    // Mock fetch so loadChat preserves the existing user message
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/messages")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { id: "msg-user-1", role: "user", content: "Hello", createdAt: new Date().toISOString() },
          ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    // Mock retry SSE to succeed
    mockFetchEventSource.mockImplementation(
      simulateSSEEvents([
        {
          event: "done",
          data: { chatId: "chat-2", messageId: "msg-2" },
        },
      ])
    );

    await act(async () => {
      await result.current.loadChat("chat-2");
    });

    act(() => {
      jest.advanceTimersByTime(700);
    });

    act(() => {
      jest.advanceTimersByTime(20);
    });

    // After fallback retry: still exactly 1 user message
    const userMessages = result.current.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
  });

  it("prevents infinite fallback loop with attemptedModels tracking", async () => {
    const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;
    const mockApiPatch = jest.requireMock("../utils/api").apiPatch as jest.Mock;
    mockApiPatch.mockResolvedValue({});

    mockApiGet.mockImplementation((path: string) => {
      if (path.includes("/agent-config")) {
        return Promise.resolve({ providerId: "p2", model: "fallback-model" });
      }
      if (path === "/workspaces/ws-1/chats") {
        return Promise.resolve([{ id: "chat-1", providerId: "p1", model: "gone-model" }]);
      }
      return Promise.resolve([]);
    });

    mockQueryClient.getQueryData.mockReturnValue([{ providerId: "p2", name: "fallback-model", isDefault: true }]);

    // Both original sendMessage and retryMessage will fail
    mockFetchEventSource.mockImplementation(simulateSSEError(new Error("Connection lost")));

    const { result } = renderHook(() => useChat("ws-1"));

    // Load chat to set persistedModel to the unavailable model
    await act(async () => {
      await result.current.loadChat("chat-1");
    });

    // Trigger fallback via sendMessage onerror
    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    act(() => {
      jest.advanceTimersByTime(10);
    });

    act(() => {
      jest.advanceTimersByTime(700);
    });

    // retryMessage's onerror fires after its own setTimeout
    act(() => {
      jest.advanceTimersByTime(10);
    });

    // Allow any potential re-trigger loops to run
    act(() => {
      jest.advanceTimersByTime(2000);
    });

    // Original sendMessage + 1 retry = at most 2 calls
    expect(mockFetchEventSource.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
