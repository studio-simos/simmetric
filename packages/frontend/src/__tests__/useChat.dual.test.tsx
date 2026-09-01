// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Dual useChat instantiation tests — verifies two hook instances
 * inside the same component maintain independent abort/state.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { useChat } from "../hooks/useChat";

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

const localStorageMock = {
  getItem: jest.fn().mockReturnValue("test-token"),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

/**
 * Wrapper component that instantiates useChat twice.
 * Each pane gets its own hook state.
 */
function DualUseChatWrapper() {
  const paneA = useChat("test-workspace-id");
  const paneB = useChat("test-workspace-id");

  return (
    <div>
      <div data-testid="pane-a-streaming">{paneA.isStreaming ? "true" : "false"}</div>
      <div data-testid="pane-b-streaming">{paneB.isStreaming ? "true" : "false"}</div>
      <button data-testid="send-a" onClick={() => paneA.sendMessage("Hello A")}>Send A</button>
      <button data-testid="send-b" onClick={() => paneB.sendMessage("Hello B")}>Send B</button>
      <button data-testid="abort-a" onClick={paneA.abortStream}>Abort A</button>
      <button data-testid="abort-b" onClick={paneB.abortStream}>Abort B</button>
    </div>
  );
}

describe("Dual useChat instances", () => {
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

  function simulateSSEStream() {
    return (_url: string, options: { onmessage: (msg: { event: string; data: string }) => void }) => {
      setTimeout(() => {
        options.onmessage({
          event: "token",
          data: JSON.stringify("token"),
        });
      }, 10);
      return Promise.resolve();
    };
  }

  it("instantiating useChat twice creates independent state objects", async () => {
    mockFetchEventSource.mockImplementation(simulateSSEStream());
    render(<DualUseChatWrapper />);

    // Both initially not streaming
    expect(screen.getByTestId("pane-a-streaming").textContent).toBe("false");
    expect(screen.getByTestId("pane-b-streaming").textContent).toBe("false");

    // Trigger send on pane A
    await waitFor(() => screen.getByTestId("send-a").click());

    await waitFor(() => {
      expect(screen.getByTestId("pane-a-streaming").textContent).toBe("true");
    });

    // Pane B should still be false
    expect(screen.getByTestId("pane-b-streaming").textContent).toBe("false");
  });

  it("two independent useChat instances do not share abort state", async () => {
    mockFetchEventSource.mockImplementation(simulateSSEStream());
    render(<DualUseChatWrapper />);

    // Start stream on pane A
    await waitFor(() => screen.getByTestId("send-a").click());

    await waitFor(() => {
      expect(screen.getByTestId("pane-a-streaming").textContent).toBe("true");
    });

    expect(screen.getByTestId("pane-b-streaming").textContent).toBe("false");

    // Abort pane A
    screen.getByTestId("abort-a").click();

    await waitFor(() => {
      expect(screen.getByTestId("pane-a-streaming").textContent).toBe("false");
    });

    // Pane B should remain unaffected
    expect(screen.getByTestId("pane-b-streaming").textContent).toBe("false");
  });
});
