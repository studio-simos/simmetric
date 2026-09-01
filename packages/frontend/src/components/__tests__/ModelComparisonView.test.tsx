// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { useChat } from "../../hooks/useChat";
import ModelComparisonView from "../ModelComparisonView";

const mockAbortStreamA = jest.fn();
const mockAbortStreamB = jest.fn();

// Mock useChat — return different objects for pane A and pane B
jest.mock("../../hooks/useChat", () => ({
  useChat: jest.fn(),
}));

// Mock ComparisonPane to render a simple testable container
jest.mock("../ComparisonPane", () => ({
  __esModule: true,
  default: function ComparisonPaneMock() {
    return <div data-testid="comparison-pane-container">Pane</div>;
  },
}));

// Mock ProviderIcon to avoid SVG issues
jest.mock("../ModelSelector", () => ({
  ProviderIcon: function ProviderIconMock({ type }: { type: string }) {
    return <span data-testid="provider-icon">{type}</span>;
  },
}));

// Mock i18next useTranslation
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "chat.comparison.title": "Model Comparison",
        "chat.comparison.close": "Close comparison",
        "chat.comparison.soon": "Shared input (Plan 03)",
        "chat.modelSelector.default": "Default",
        "chat.comparison.tabLabel": "Model:",
      };
      return map[key] || key;
    },
  }),
}));

describe("ModelComparisonView", () => {
  const defaultProps = {
    workspaceId: "test-workspace-id",
    onClose: jest.fn(),
    mainChat: {
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
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    let callCount = 0;
    (useChat as jest.Mock).mockImplementation(() => {
      callCount += 1;
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
        abortStream: callCount === 1 ? mockAbortStreamA : mockAbortStreamB,
        removeMessage: jest.fn(),
        renameChat: jest.fn(),
        updateChatModel: jest.fn(),
        setMessages: jest.fn(),
        regenerateLastResponse: jest.fn(),
        editLastMessageAndRegenerate: jest.fn(),
      };
    });
  });

  it("renders comparison header with title", () => {
    render(<ModelComparisonView {...defaultProps} />);
    expect(screen.getByText("Model Comparison")).toBeInTheDocument();
  });

  it("renders two pane containers on desktop", () => {
    // Mock desktop viewport width
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });
    window.dispatchEvent(new Event("resize"));

    render(<ModelComparisonView {...defaultProps} />);
    const panes = screen.getAllByTestId("comparison-pane-container");
    expect(panes).toHaveLength(2);
  });

  it("renders mobile tab switcher on narrow viewports", () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });
    window.dispatchEvent(new Event("resize"));

    render(<ModelComparisonView {...defaultProps} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("calls onClose when close button clicked", () => {
    render(<ModelComparisonView {...defaultProps} />);
    const closeButton = screen.getByLabelText("Close comparison");
    fireEvent.click(closeButton);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("calls abortStream on both panes when unmounted", () => {
    const { unmount } = render(<ModelComparisonView {...defaultProps} />);
    unmount();
    expect(mockAbortStreamA).toHaveBeenCalledTimes(1);
    expect(mockAbortStreamB).toHaveBeenCalledTimes(1);
  });
});
