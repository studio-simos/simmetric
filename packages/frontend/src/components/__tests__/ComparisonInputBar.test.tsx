// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import ComparisonInputBar from "../ComparisonInputBar";
import type { UseChatReturn } from "../../hooks/useChat";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "chat.placeholder": "Type a message...",
        "chat.send": "Send",
        "chat.stopGenerating": "Stop",
        "chat.microphone": "Microphone",
        "chat.comparison.waiting": "Waiting for responses...",
        "chat.comparison.sendToOne": "Send to this pane only",
      };
      if (key === "chat.comparison.keepResponse" && options?.model) {
        return `Keep ${options.model}`;
      }
      return map[key] || key;
    },
  }),
}));

jest.mock("react-dropzone", () => ({
  useDropzone: () => ({
    getRootProps: () => ({ onClick: jest.fn() }),
    getInputProps: () => ({ onChange: jest.fn() }),
    isDragActive: false,
  }),
}));

jest.mock("../../hooks/useSpeechRecognition", () => ({
  __esModule: true,
  SpeechRecognition: {
    startListening: jest.fn(),
    stopListening: jest.fn(),
  },
  useSpeechRecognition: () => ({
    transcript: "",
    listening: false,
    resetTranscript: jest.fn(),
  }),
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
    sendMessage: jest.fn().mockResolvedValue(undefined),
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

describe("ComparisonInputBar", () => {
  const defaultProps = {
    paneA: makeMockChat(),
    paneB: makeMockChat(),
    activePane: "A" as const,
    sendToOne: false,
    onToggleSendToOne: jest.fn(),
    modelOverrideA: null,
    modelOverrideB: null,
    workspaceId: "ws-1",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("disabled send button while either pane is streaming", () => {
    const paneA = makeMockChat({ isStreaming: true });
    render(<ComparisonInputBar {...defaultProps} paneA={paneA} />);
    const sendButton = screen.getByText("Waiting for responses...");
    expect(sendButton).toBeDisabled();
  });

  it("sends to both panes by default", () => {
    const paneA = makeMockChat();
    const paneB = makeMockChat();
    render(<ComparisonInputBar {...defaultProps} paneA={paneA} paneB={paneB} />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "Hello both" } });
    const sendButton = screen.getByText("Send");
    fireEvent.click(sendButton);

    expect(paneA.sendMessage).toHaveBeenCalledWith(
      "Hello both",
      undefined,
      undefined,
      undefined
    );
  });

  it("sends to one pane when sendToOne is active", () => {
    const paneA = makeMockChat();
    const paneB = makeMockChat();
    render(
      <ComparisonInputBar
        {...defaultProps}
        paneA={paneA}
        paneB={paneB}
        sendToOne={true}
        activePane="B"
      />
    );

    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "Hello B" } });
    const sendButton = screen.getByText("Send");
    fireEvent.click(sendButton);

    expect(paneA.sendMessage).not.toHaveBeenCalled();
    expect(paneB.sendMessage).toHaveBeenCalledWith(
      "Hello B",
      undefined,
      undefined,
      undefined
    );
  });

  it("calls abortStream on both panes when stop clicked", () => {
    const paneA = makeMockChat({ isStreaming: true });
    const paneB = makeMockChat({ isStreaming: true });
    render(<ComparisonInputBar {...defaultProps} paneA={paneA} paneB={paneB} />);

    const stopButton = screen.getByText("Stop");
    fireEvent.click(stopButton);

    expect(paneA.abortStream).toHaveBeenCalledTimes(1);
    expect(paneB.abortStream).toHaveBeenCalledTimes(1);
  });

  it("toggles sendToOne when toggle button clicked", () => {
    const onToggle = jest.fn();
    render(<ComparisonInputBar {...defaultProps} onToggleSendToOne={onToggle} />);

    const toggleButton = screen.getByLabelText("Send to this pane only");
    fireEvent.click(toggleButton);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
