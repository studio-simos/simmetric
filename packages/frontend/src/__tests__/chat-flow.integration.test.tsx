// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 4.10.2 — Chat flow integration test.
 *
 * Exercises the REAL `useChat` hook against a mocked SSE transport. The mock
 * captures fetchEventSource's callbacks (onopen/onmessage/onclose/onerror) and
 * exposes `emit`/`closeStream`/`throwError` helpers so the test can drive the
 * full event protocol (token → citations → done, and the error path) and
 * assert the React state transitions:
 *   - optimistic user message + isStreaming on send
 *   - token accumulation into streamingContent
 *   - status events surface in statusMessage
 *   - done finalizes an assistant message (content, modelUsed, modelProvider,
 *     sources) and clears streaming state + sets currentChatId
 *   - error event sets error and halts streaming
 *   - abortStream cancels and clears streaming state
 *
 * This is an integration test of the SSE→state pipeline, not a ChatPanel
 * render test (ChatPanel's /model command and layouts are covered in
 * ChatPanel.test.tsx and the chat/__tests__ suite).
 */
import { act, renderHook } from "@testing-library/react";
import { useChat, type SourceCitation, resolveEffectiveModel, isModelAvailable } from "../hooks/useChat";

// --- Mock SSE transport ---------------------------------------------------
jest.mock("@microsoft/fetch-event-source", () => {
  const holder: { handlers: Record<string, (arg: unknown) => void> | null } = { handlers: null };
  const fetchEventSource = jest.fn(async (_url: string, opts: Record<string, (arg: unknown) => void>) => {
    // Simulate a successful SSE handshake.
    await opts.onopen?.({ ok: true, status: 200, json: async () => ({}) });
    // Capture callbacks so the test can drive the stream externally.
    holder.handlers = opts;
  });
  return {
    __esModule: true,
    fetchEventSource,
    emit: (event: string, data: string) => holder.handlers?.onmessage({ event, data }),
    closeStream: () => holder.handlers?.onclose?.(),
    throwError: (err: unknown) => holder.handlers?.onerror?.(err),
    reset: () => { holder.handlers = null; },
  };
});

// --- Mock peripheral modules used by useChat ------------------------------
jest.mock("../utils/api", () => ({
  apiGet: jest.fn().mockResolvedValue({}),
  apiPut: jest.fn().mockResolvedValue({}),
  apiPatch: jest.fn().mockResolvedValue({}),
  apiDelete: jest.fn().mockResolvedValue({}),
  apiPost: jest.fn().mockResolvedValue({}),
  apiUpload: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    details?: unknown;
    constructor(message: string, status: number, details?: unknown) {
      super(message);
      this.status = status;
      this.details = details;
    }
  },
  handleResponse: jest.fn(),
}));

jest.mock("../utils/archiveQueue", () => ({ addWikiEdit: jest.fn() }));
jest.mock("../utils/modelDefaults", () => ({ getGlobalDefaultModel: jest.fn(() => null) }));
jest.mock("../queries/queryClient", () => ({
  queryClient: {
    getQueryData: jest.fn(() => []),
    setQueryData: jest.fn(),
    invalidateQueries: jest.fn(),
  },
}));
jest.mock("../queries/keys", () => ({
  queryKeys: { providers: { available: "providers.available" } },
}));
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Returns defaultValue when provided (string OR object — the fallback
    // "switched" key passes an interpolation object), else the key itself.
    t: (key: string, defaultValue?: unknown) => (defaultValue ?? key) as string,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));
// Toast helpers — mocked so the 3-tier fallback tests can assert which toast
// fired (switched+Undo vs noModels) without rendering sonner in jsdom.
jest.mock("../lib/toast", () => ({
  toastWithAction: jest.fn(),
  showError: jest.fn(),
  showSuccess: jest.fn(),
  showInfo: jest.fn(),
}));

const sse = jest.requireMock("@microsoft/fetch-event-source") as {
  emit: (event: string, data: string) => void;
  closeStream: () => void;
  throwError: (err: unknown) => void;
  reset: () => void;
};

beforeEach(() => {
  sse.reset();
});

describe("useChat — SSE chat flow integration", () => {
  it("streams tokens and finalizes an assistant message on done", async () => {
    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => {
      await result.current.sendMessage("What is RAG?");
    });

    // Optimistic user message + streaming on.
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.role).toBe("user");
    expect(result.current.messages[0]?.content).toBe("What is RAG?");

    // Token accumulation.
    act(() => {
      sse.emit("token", JSON.stringify("Retrieval"));
      sse.emit("token", JSON.stringify("-Augmented"));
      sse.emit("token", JSON.stringify(" Generation"));
    });
    expect(result.current.streamingContent).toBe("Retrieval-Augmented Generation");

    // Citations then done finalize the assistant message.
    const sources: SourceCitation[] = [
      { documentId: "d1", documentName: "doc1", score: 0.9, chunkText: "ctx" },
    ];
    await act(async () => {
      sse.emit("citations", JSON.stringify({ sources }));
      sse.emit("done", JSON.stringify({
        messageId: "m-asst-1",
        chatId: "chat-xyz",
        model: "gemma4:latest",
        providerType: "ollama",
      }));
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamingContent).toBe("");
    expect(result.current.currentChatId).toBe("chat-xyz");

    const msgs = result.current.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.content).toBe("Retrieval-Augmented Generation");
    expect(msgs[1]?.metadata?.modelUsed).toBe("gemma4:latest");
    expect(msgs[1]?.metadata?.modelProvider).toBe("ollama");
    expect(msgs[1]?.metadata?.sources).toEqual(sources);
  });

  it("reflects status events and clears them on done", async () => {
    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => { await result.current.sendMessage("hi"); });

    act(() => { sse.emit("status", JSON.stringify({ message: "Searching documents" })); });
    expect(result.current.statusMessage).toBe("Searching documents");

    await act(async () => {
      sse.emit("done", JSON.stringify({ messageId: "a1", chatId: "c1" }));
    });
    expect(result.current.statusMessage).toBeNull();
  });

  it("sets an error and halts streaming on an error event", async () => {
    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => { await result.current.sendMessage("hi"); });
    act(() => { sse.emit("token", JSON.stringify("partial")); });
    expect(result.current.streamingContent).toBe("partial");

    await act(async () => {
      sse.emit("error", JSON.stringify({ error: "Upstream model crashed" }));
    });

    expect(result.current.error).toBe("Upstream model crashed");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamingContent).toBe("");
  });

  it("translates cloud-offline error markers via i18n", async () => {
    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => { await result.current.sendMessage("hi"); });

    await act(async () => {
      sse.emit("error", JSON.stringify({ error: "[CLOUD_MODEL_OFFLINE] something" }));
    });

    // The mock t() returns its defaultValue for the cloud-offline key.
    expect(result.current.error).toContain("ollama.com");
  });

  it("abortStream cancels and clears streaming state", async () => {
    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => { await result.current.sendMessage("hi"); });
    act(() => { sse.emit("token", JSON.stringify("streaming...")); });
    expect(result.current.isStreaming).toBe(true);

    act(() => { result.current.abortStream(); });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamingContent).toBe("");
    expect(result.current.statusMessage).toBeNull();
  });

  it("does not duplicate the user message when done arrives", async () => {
    const { result } = renderHook(() => useChat("ws-1"));

    await act(async () => { await result.current.sendMessage("once"); });
    await act(async () => {
      sse.emit("token", JSON.stringify("reply"));
      sse.emit("done", JSON.stringify({ messageId: "a", chatId: "c" }));
    });

    const userMsgs = result.current.messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(result.current.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

// ===========================================================================
//  4.10.2 — 3-tier model fallback (sub-bullet: "modello non disponibile →
//  fallback → messaggio warning"). resolveFallbackModel tries, in order:
//  workspace default → global default (isDefault) → any available. The
//  polling watcher (useChat.ts:407) fires handleFallback when the persisted
//  model is no longer in availableModels. These tests drive that path by
//  setting persistedModel to a missing model via updateChatModel (which
//  requires currentChatId, so we send + done first) and asserting the model
//  switches to the right tier with the right toast.
//
//  NOTE on MSW: this suite mocks @microsoft/fetch-event-source directly
//  (capturing its callbacks) rather than using MSW — MSW's SSE support is
//  limited and a transport mock is more deterministic for driving the event
//  protocol. See TODO 4.10.2 note.
// ===========================================================================
const toast = jest.requireMock("../lib/toast") as {
  toastWithAction: jest.Mock;
  showError: jest.Mock;
};
const queryClientMock = jest.requireMock("../queries/queryClient") as {
  queryClient: { getQueryData: jest.Mock };
};

describe("useChat — 3-tier model fallback", () => {
  beforeEach(() => {
    sse.reset();
    toast.toastWithAction.mockClear();
    toast.showError.mockClear();
    queryClientMock.queryClient.getQueryData.mockReturnValue([]);
  });

  // Helper: get to a state with currentChatId set (send + done), then switch
  // to a model that is NOT in the available list, which triggers the watcher.
  // Real timers (not fake) — handleFallback awaits a 500ms timer and then
  // runs retryMessage; fake timers leaked that async chain across tests.
  async function driveFallback(available: Array<{ providerId: string; name: string; isDefault: boolean }>) {
    const { result } = renderHook(() => useChat("ws-1"));
    queryClientMock.queryClient.getQueryData.mockReturnValue(available);

    await act(async () => { await result.current.sendMessage("hi"); });
    await act(async () => {
      sse.emit("done", JSON.stringify({ messageId: "a1", chatId: "c1" }));
    });
    expect(result.current.currentChatId).toBe("c1");

    // Switch to a model absent from `available` → persistedModel.providerId
    // changes null→"ollama" → the watcher effect re-runs → handleFallback.
    await act(async () => { await result.current.updateChatModel("ollama", "gemma4:latest"); });
    // Let handleFallback's 500ms wait + the retryMessage it triggers settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 650)); });
    return result;
  }

  it("tier 2: falls back to the global-default model and shows the switched+Undo toast", async () => {
    const result = await driveFallback([
      { providerId: "openai", name: "gpt-4o", isDefault: true },
    ]);

    expect(result.current.persistedModel).toEqual({ providerId: "openai", model: "gpt-4o" });
    expect(toast.toastWithAction).toHaveBeenCalledTimes(1);
    // The i18n mock returns the interpolation object as the "switched" message.
    expect(toast.toastWithAction.mock.calls[0]?.[0]).toMatchObject({ to: "gpt-4o" });
    // Undo action is the 3rd positional arg.
    expect(typeof toast.toastWithAction.mock.calls[0]?.[2]).toBe("function");
    expect(toast.showError).not.toHaveBeenCalled();
  });

  it("tier 3: falls back to any available model when no global default exists", async () => {
    const result = await driveFallback([
      { providerId: "anthropic", name: "claude-haiku", isDefault: false },
    ]);

    expect(result.current.persistedModel).toEqual({ providerId: "anthropic", model: "claude-haiku" });
    expect(toast.toastWithAction).toHaveBeenCalledTimes(1);
    expect(toast.toastWithAction.mock.calls[0]?.[0]).toMatchObject({ to: "claude-haiku" });
  });

  it("no available models: shows the noModels error and leaves the requested model in place without looping", async () => {
    // No workspace default (apiGet → {}), no global default, no models at all
    // → resolveFallbackModel returns null → showError(noModels), no toast,
    // persistedModel stays at the optimistically-set requested model.
    const result = await driveFallback([]);

    expect(toast.showError).toHaveBeenCalledTimes(1);
    expect(toast.toastWithAction).not.toHaveBeenCalled();
    expect(result.current.persistedModel).toEqual({ providerId: "ollama", model: "gemma4:latest" });
  });
});

// ===========================================================================
//  260723-lrx — Model selection persistence + auto-fallback.
//  resolveEffectiveModel validates candidates against the live availableModels
//  list before they're sent, so a stale workspace/global default pointing at an
//  unavailable model is skipped (RC-1). loadChat persists the resolved model
//  onto the Chat record when the chat had none or its stored model is gone
//  (RC-3). The SSE `error` event now triggers handleFallback, not just
//  `onerror` connection drops (RC-2).
// ===========================================================================
describe("resolveEffectiveModel — validated candidate resolution", () => {
  const available = [
    { providerId: "openai", name: "gpt-4o", isDefault: true },
    { providerId: "anthropic", name: "claude-haiku", isDefault: false },
  ];

  it("isModelAvailable: true only when providerId+model match an available entry", () => {
    expect(isModelAvailable(available, { providerId: "openai", model: "gpt-4o" })).toBe(true);
    expect(isModelAvailable(available, { providerId: "openai", model: "gpt-3.5" })).toBe(false);
    expect(isModelAvailable(available, { providerId: "missing", model: "x" })).toBe(false);
    expect(isModelAvailable(available, null)).toBe(false);
    expect(isModelAvailable(available, { providerId: "openai" })).toBe(false);
  });

  it("returns the first candidate that is actually available (RC-1: skips stale defaults)", () => {
    // The per-chat stored model is gone, the workspace default is gone, but
    // the global default survives → it wins.
    const stored = { providerId: "deleted", model: "gone" };
    const wsDefault = { providerId: "also-deleted", model: "gone-too" };
    const globalDefault = { providerId: "anthropic", model: "claude-haiku" };
    expect(resolveEffectiveModel(available, [stored, wsDefault, globalDefault], wsDefault)).toEqual({
      providerId: "anthropic",
      model: "claude-haiku",
    });
  });

  it("falls back to the three-tier chain when no candidate is available", () => {
    // No candidate matches → resolveFallbackModel → workspace (null) → global
    // isDefault (gpt-4o) → returns the isDefault model.
    expect(resolveEffectiveModel(available, [
      { providerId: "x", model: "y" },
    ], null)).toEqual({ providerId: "openai", model: "gpt-4o" });
  });

  it("tier 3: returns the first available model when none is default", () => {
    const list = [
      { providerId: "anthropic", name: "claude-haiku", isDefault: false },
      { providerId: "openai", name: "gpt-4o", isDefault: false },
    ];
    expect(resolveEffectiveModel(list, [{ providerId: "gone", model: "x" }], null)).toEqual({
      providerId: "anthropic",
      model: "claude-haiku",
    });
  });

  it("returns null when no model is available at all", () => {
    expect(resolveEffectiveModel([], [{ providerId: "x", model: "y" }], null)).toBeNull();
  });
});

describe("useChat — loadChat persists the resolved model (RC-3)", () => {
  const apiGetMock = jest.requireMock("../utils/api").apiGet as jest.Mock;
  const apiPatchMock = jest.requireMock("../utils/api").apiPatch as jest.Mock;

  beforeEach(() => {
    sse.reset();
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPatchMock.mockResolvedValue({});
    queryClientMock.queryClient.getQueryData.mockReturnValue([
      { providerId: "openai", name: "gpt-4o", isDefault: true },
    ]);
    // loadChat fetches messages via global fetch (not apiGet).
    (global as Record<string, unknown>).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("persists a valid model when the chat has no providerId stored", async () => {
    // chats list: the chat exists but has no per-chat model.
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/chats")) return [{ id: "c1", providerId: null, model: "" }];
      if (url.endsWith("/agent-config")) return { providerId: "ws-prov", model: "ws-model" };
      return {};
    });
    // availableModels does NOT contain ws-model → workspace default skipped,
    // falls back to the isDefault model (gpt-4o).
    queryClientMock.queryClient.getQueryData.mockReturnValue([
      { providerId: "openai", name: "gpt-4o", isDefault: true },
    ]);

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => { await result.current.loadChat("c1"); });

    expect(result.current.persistedModel).toEqual({ providerId: "openai", model: "gpt-4o" });
    // RC-3: the resolved model is persisted onto the chat record. (The mocked
    // apiPatch does not prepend /api — the real util does — so we assert the
    // raw path passed by useChat.)
    expect(apiPatchMock).toHaveBeenCalledWith(
      "/workspaces/ws-1/chats/c1/model",
      { providerId: "openai", model: "gpt-4o" },
    );
  });

  it("does NOT patch when the chat already has a valid stored model", async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/chats")) return [{ id: "c1", providerId: "openai", model: "gpt-4o" }];
      if (url.endsWith("/agent-config")) return { providerId: "ws-prov", model: "ws-model" };
      return {};
    });

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => { await result.current.loadChat("c1"); });

    expect(result.current.persistedModel).toEqual({ providerId: "openai", model: "gpt-4o" });
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("persists a fallback model when the stored model is no longer available", async () => {
    // Chat stored a model that has since been removed from availableModels.
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/chats")) return [{ id: "c1", providerId: "deleted", model: "gone" }];
      if (url.endsWith("/agent-config")) return {};
      return {};
    });

    const { result } = renderHook(() => useChat("ws-1"));
    await act(async () => { await result.current.loadChat("c1"); });

    expect(result.current.persistedModel).toEqual({ providerId: "openai", model: "gpt-4o" });
    expect(apiPatchMock).toHaveBeenCalledWith(
      "/workspaces/ws-1/chats/c1/model",
      { providerId: "openai", model: "gpt-4o" },
    );
  });
});

describe("useChat — SSE error event triggers fallback (RC-2)", () => {
  beforeEach(() => {
    sse.reset();
    toast.toastWithAction.mockClear();
    toast.showError.mockClear();
  });

  it("auto-recovers when the selected model errors mid-stream", async () => {
    const available = [
      { providerId: "openai", name: "gpt-4o", isDefault: true },
      { providerId: "anthropic", name: "claude-haiku", isDefault: false },
    ];
    queryClientMock.queryClient.getQueryData.mockReturnValue(available);

    const { result } = renderHook(() => useChat("ws-1"));

    // Establish a chat + select an available (non-default) model so
    // persistedModelRef is set when the error event arrives.
    await act(async () => { await result.current.sendMessage("hi"); });
    await act(async () => {
      sse.emit("done", JSON.stringify({ messageId: "a1", chatId: "c1" }));
    });
    await act(async () => { await result.current.updateChatModel("anthropic", "claude-haiku"); });
    expect(result.current.persistedModel).toEqual({ providerId: "anthropic", model: "claude-haiku" });

    // Send another message, then surface an SSE `error` event (the selected
    // model crashed at the provider). Pre-fix this only set error state; now
    // it must also trigger handleFallback.
    await act(async () => { await result.current.sendMessage("again"); });
    await act(async () => {
      sse.emit("error", JSON.stringify({ error: "model crashed" }));
    });
    // handleFallback awaits updateChatModel (200ms debounce) + a 500ms wait
    // before re-sending; let it settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 750)); });

    // The error was surfaced then cleared by the auto-recovery retry
    // (retryMessage resets error). The key RC-2 assertion: the model
    // auto-switched to a working one without a manual dropdown pick.
    expect(result.current.persistedModel).toEqual({ providerId: "openai", model: "gpt-4o" });
    expect(toast.toastWithAction).toHaveBeenCalledTimes(1);
    expect(toast.toastWithAction.mock.calls[0]?.[0]).toMatchObject({ to: "gpt-4o" });
  });
});