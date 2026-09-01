// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ComparisonPane component tests — render, messages, streaming, error, retry
 */
import "@testing-library/jest-dom";

// Mock window.matchMedia for jsdom before component imports
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../../__tests__/test-utils";
import ComparisonPane from "../ComparisonPane";
import type { UseChatReturn, ChatMessage } from "../../hooks/useChat";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "chat.comparison.emptyPane": "Send a message to start the comparison",
        "chat.comparison.retry": "Retry",
        "chat.thinking": "Thinking...",
      };
      return map[key] || key;
    },
  }),
}));

jest.mock("../../utils/markdown", () => ({
  renderMarkdown: (text: string) => `<p>${text}</p>`,
}));

jest.mock("../ModelSelector", () => ({
  __esModule: true,
  default: jest.fn(({ value, onChange }: { value: unknown; onChange?: (value: { providerId: string; model: string }) => void }) => (
    <button data-testid="model-selector" data-value={JSON.stringify(value)} onClick={() => onChange?.({ providerId: "p1", model: "test-model" })}>
      ModelSelector
    </button>
  )),
}));

jest.mock("../CitationPanel", () => ({
  CitationBadge: ({ index, onClick }: { index: number; onClick: () => void }) => (
    <button data-testid={`citation-badge-${index}`} onClick={onClick}>
      {index + 1}
    </button>
  ),
}));

jest.mock("../../queries/useProviders", () => ({
  useAvailableModels: () => ({ data: [], isLoading: false, error: null }),
}));

jest.mock("../../queries/useAuth", () => ({
  useMe: () => ({ data: null }),
  useLogout: () => ({ mutate: jest.fn() }),
}));

function makeMockChat(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  return {
    messages: [],
    isStreaming: false,
    streamingContent: "",
    streamingThinking: "",
    statusMessage: null,
        activePlan: null,
    currentChatId: null,
    chatName: null,
    error: null,
    persistedModel: null,
    sendMessage: jest.fn(),
    loadChat: jest.fn(),
    clearChat: jest.fn(),
    abortStream: jest.fn(),
    removeMessage: jest.fn(),
    renameChat: jest.fn(),
    updateChatModel: jest.fn(),
    setMessages: jest.fn(),
    regenerateLastResponse: jest.fn(),
    editLastMessageAndRegenerate: jest.fn(),
    ...overrides,
  };
}

describe("ComparisonPane", () => {
  it("renders empty state with translation key", () => {
    const chat = makeMockChat();
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    expect(screen.getByText("Send a message to start the comparison")).toBeInTheDocument();
  });

  it("renders user and assistant messages", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "Hello", createdAt: "2024-01-01T00:00:00Z" },
      { id: "m2", role: "assistant", content: "Hi there", createdAt: "2024-01-01T00:00:01Z" },
    ];
    const chat = makeMockChat({ messages });
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there")).toBeInTheDocument();
  });

  it("renders the AI disclaimer below completed assistant messages only (Phase 149 BRAND-02)", () => {
    // One assistant + one user message. The disclaimer element must appear
    // exactly once (under the assistant card) and never under the user card.
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Question?", createdAt: "2024-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", content: "Answer.", createdAt: "2024-01-01T00:00:01Z" },
    ];
    const chat = makeMockChat({ messages });
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    const disclaimers = screen.getAllByTestId("ai-disclaimer");
    expect(disclaimers).toHaveLength(1);
    expect(disclaimers[0]).toHaveClass("text-xs");
    expect(disclaimers[0]).toHaveClass("text-muted-foreground");
  });

  it("renders streaming content when isStreaming", () => {
    const chat = makeMockChat({
      isStreaming: true,
      streamingContent: "typing...",
    });
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    expect(screen.getByText("typing...")).toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders inline error and retry button", () => {
    const chat = makeMockChat({ error: "Failed" });
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("retry button calls sendMessage with modelOverride", () => {
    const sendMessage = jest.fn();
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "test message", createdAt: "2024-01-01T00:00:00Z" },
    ];
    const chat = makeMockChat({ messages, error: "Failed", sendMessage });
    const modelOverride = { providerId: "p1", model: "model-a" };
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={modelOverride} onModelChange={jest.fn()} isStale={false} />);

    fireEvent.click(screen.getByText("Retry"));
    expect(sendMessage).toHaveBeenCalledWith("test message", undefined, undefined, modelOverride);
  });

  it("has ARIA role log and aria-live polite", () => {
    const chat = makeMockChat();
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
  });

  it("renders citation badges for assistant messages with sources", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "Answer",
        createdAt: "2024-01-01T00:00:00Z",
        metadata: {
          sources: [
            { documentId: "d1", documentName: "Doc 1", score: 0.9 },
            { documentId: "d2", documentName: "Doc 2", score: 0.8 },
          ],
        },
      },
    ];
    const chat = makeMockChat({ messages });
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    expect(screen.getByTestId("citation-badge-0")).toBeInTheDocument();
    expect(screen.getByTestId("citation-badge-1")).toBeInTheDocument();
  });

  it("dispatches custom event when citation badge is clicked", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "Answer",
        createdAt: "2024-01-01T00:00:00Z",
        metadata: {
          sources: [{ documentId: "d1", documentName: "Doc 1", score: 0.9 }],
        },
      },
    ];
    const chat = makeMockChat({ messages });
    const listener = jest.fn();
    window.addEventListener("comparison:openCitations", listener as EventListener);
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);

    fireEvent.click(screen.getByTestId("citation-badge-0"));
    expect(listener).toHaveBeenCalledTimes(1);
    const customEvent = listener.mock.calls[0][0] as CustomEvent;
    expect(customEvent.detail.sources).toHaveLength(1);
    expect(customEvent.detail.sources[0].documentId).toBe("d1");

    window.removeEventListener("comparison:openCitations", listener as EventListener);
  });

  it("renders status spinner when statusMessage is present without streaming content", () => {
    const chat = makeMockChat({
      isStreaming: true,
      statusMessage: "Searching documents...",
      streamingContent: "",
    streamingThinking: "",
    });
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    expect(screen.getByText("Searching documents...")).toBeInTheDocument();
  });

  it("does not render empty state when streaming", () => {
    const chat = makeMockChat({ isStreaming: true });
    renderWithProviders(<ComparisonPane chat={chat} modelOverride={null} onModelChange={jest.fn()} isStale={false} />);
    expect(screen.queryByText("Send a message to start the comparison")).not.toBeInTheDocument();
  });
});
