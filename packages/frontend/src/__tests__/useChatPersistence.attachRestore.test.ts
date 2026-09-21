// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 191 (KNOW-02 D-05) — useChatPersistence.loadChat restore-seam tests.
 *
 * Proves the per-chat archive-selection restore contract:
 *  - a chats-list row carrying attachedArchiveIds: ["x"] → setRestoredArchiveIds(["x"])
 *  - a row WITHOUT the field (or undefined) → setRestoredArchiveIds([])
 *  - loadChat without the optional callback → no throw (byte-identical legacy path)
 */
jest.mock("../utils/api", () => ({
  apiGet: jest.fn(),
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

const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;

import { renderHook, act } from "@testing-library/react";
import { useChat } from "../hooks/useChat";

const localStorageMock = {
  getItem: jest.fn().mockReturnValue("test-token"),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

const CHAT_ID = "chat-restore-1";
const WS_ID = "ws-1";

function stubChatApis(chatsList: Array<Record<string, unknown>>) {
  mockApiGet.mockImplementation((path: string) => {
    if (path.includes("/agent-config")) {
      return Promise.resolve({ providerId: null, model: null });
    }
    return Promise.resolve(chatsList);
  });
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve([]),
  } as Response);
}

function makePersistenceOverrides(setRestoredArchiveIds?: (ids: string[]) => void) {
  return {
    setRestoredArchiveIds,
    // The other persistence-owned setters the parent threads; loadChat only
    // touches messages/currentChatId/error/streamingContent/statusMessage/
    // activePlan/setPersistedModel + refs.
  };
}

describe("useChatPersistence loadChat — attachedArchiveIds restore seam (Phase 191 D-05)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("row carrying attachedArchiveIds ['x'] → setRestoredArchiveIds invoked with ['x']", async () => {
    stubChatApis([
      { id: CHAT_ID, providerId: null, model: "qwen2.5:3b", attachedArchiveIds: ["x"] },
    ]);
    const setRestoredArchiveIds = jest.fn();
    const { result } = renderHook(() =>
      useChat(WS_ID, makePersistenceOverrides(setRestoredArchiveIds) as never),
    );
    await act(async () => {
      await result.current.loadChat(CHAT_ID);
    });
    expect(setRestoredArchiveIds).toHaveBeenCalledWith(["x"]);
  });

  it("row WITHOUT the field → setRestoredArchiveIds invoked with []", async () => {
    stubChatApis([
      { id: CHAT_ID, providerId: null, model: "qwen2.5:3b" },
    ]);
    const setRestoredArchiveIds = jest.fn();
    const { result } = renderHook(() =>
      useChat(WS_ID, makePersistenceOverrides(setRestoredArchiveIds) as never),
    );
    await act(async () => {
      await result.current.loadChat(CHAT_ID);
    });
    expect(setRestoredArchiveIds).toHaveBeenCalledWith([]);
  });

  it("row with null attachedArchiveIds → setRestoredArchiveIds invoked with []", async () => {
    stubChatApis([
      { id: CHAT_ID, providerId: null, model: "qwen2.5:3b", attachedArchiveIds: null },
    ]);
    const setRestoredArchiveIds = jest.fn();
    const { result } = renderHook(() =>
      useChat(WS_ID, makePersistenceOverrides(setRestoredArchiveIds) as never),
    );
    await act(async () => {
      await result.current.loadChat(CHAT_ID);
    });
    expect(setRestoredArchiveIds).toHaveBeenCalledWith([]);
  });

  it("chat not found in the list → setRestoredArchiveIds invoked with [] (no throw)", async () => {
    stubChatApis([]);
    const setRestoredArchiveIds = jest.fn();
    const { result } = renderHook(() =>
      useChat(WS_ID, makePersistenceOverrides(setRestoredArchiveIds) as never),
    );
    await act(async () => {
      await result.current.loadChat(CHAT_ID);
    });
    expect(setRestoredArchiveIds).toHaveBeenCalledWith([]);
  });

  it("loadChat without the optional callback → no throw (byte-identical legacy path)", async () => {
    stubChatApis([
      { id: CHAT_ID, providerId: null, model: "qwen2.5:3b", attachedArchiveIds: ["x"] },
    ]);
    const { result } = renderHook(() => useChat(WS_ID));
    await act(async () => {
      await result.current.loadChat(CHAT_ID);
    });
    // Reaching here without throwing proves the optional seam.
    expect(mockApiGet).toHaveBeenCalled();
  });
});