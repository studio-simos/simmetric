// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ChatPanel component tests — /model slash command behaviors
 */
import "@testing-library/jest-dom";

// Polyfill TextEncoder/TextDecoder for react-router-dom in jsdom
import { TextEncoder, TextDecoder } from "util";
(global as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
(global as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;

// Mock window.matchMedia for jsdom
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
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChatPanel from "../components/ChatPanel";
import { showError } from "../lib/toast";

const renderWithProvider = (ui: React.ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => {
      const map: Record<string, string> = {
        "chat.placeholder": "Type a message...",
        "chat.send": "Send",
        "chat.thinking": "Thinking...",
        "chat.modelCommand.notFound": "Model not found",
        "chat.modelSelector.unavailable": "Failed to update model",
        "chat.readAloud": "Read Aloud",
        "chat.microphone": "Microphone",
      };
      return map[key] || defaultValue || key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Stub the i18n index so the transitive import via RightPanel doesn't run the
// real `i18n.use(initReactI18next).init(...)` side effect (mirrors RightPanel.test).
jest.mock("../i18n", () => ({
  getEnabledLanguages: jest.fn(() => ["en"]),
}));

// Mock ThemeContext — ChatPanel reads resolvedTheme for the hacker send-button glitch.
jest.mock("../contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark", resolvedTheme: "dark", setTheme: jest.fn() }),
}));

// Mock speech recognition
jest.mock("../hooks/useSpeechRecognition", () => ({
  __esModule: true,
  SpeechRecognition: {
    startListening: jest.fn(),
    stopListening: jest.fn(),
    abortListening: jest.fn(),
  },
  useSpeechRecognition: () => ({
    transcript: "",
    listening: false,
    resetTranscript: jest.fn(),
    browserSupportsSpeechRecognition: true,
    isMicrophoneAvailable: true,
  }),
}));

// Mock react-dropzone
jest.mock("react-dropzone", () => ({
  useDropzone: jest.fn(() => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
  })),
}));

// Mock apiUpload so the drop handler resolves without a network call
// (quick 260808-vzm sanitized-badge test).
jest.mock("../utils/api", () => ({
  apiUpload: jest.fn().mockResolvedValue({ id: "doc-1" }),
  apiGet: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    details?: unknown;
    constructor(message: string, status = 0, details?: unknown) {
      super(message);
      this.status = status;
      this.details = details;
    }
  },
}));

// Mock useChat
const mockSendMessage = jest.fn();
const mockAbortStream = jest.fn();
const mockUpdateChatModel = jest.fn().mockResolvedValue(undefined);
const mockLoadChat = jest.fn();
const mockClearChat = jest.fn();
const mockRemoveMessage = jest.fn();
const mockRenameChat = jest.fn();
const mockPersistedModel = { providerId: "p1", model: "gemma4:latest" };

const mockChatState: Record<string, unknown> = {
  messages: [],
  isStreaming: false,
  streamingContent: "",
  statusMessage: "",
  currentChatId: "chat-001",
  chatName: "Test Chat",
  error: null,
  persistedModel: mockPersistedModel,
  sendMessage: mockSendMessage,
  loadChat: mockLoadChat,
  clearChat: mockClearChat,
  abortStream: mockAbortStream,
  removeMessage: mockRemoveMessage,
  renameChat: mockRenameChat,
  updateChatModel: mockUpdateChatModel,
};

jest.mock("../hooks/useChat", () => ({
  useChat: () => mockChatState,
}));

// Mock query hooks
const mockAvailableModels = [
  { id: "m1", name: "gemma4:latest", displayName: "Llama 3", providerId: "p1", providerName: "Ollama", providerType: "ollama", isDefault: true, isLocal: true, capabilities: ["local-only"] },
  { id: "m2", name: "gpt-4o", displayName: "GPT-4o", providerId: "p2", providerName: "OpenAI", providerType: "openai", isDefault: false, isLocal: false, capabilities: ["smartest"] },
  { id: "m3", name: "claude-3-opus", displayName: "Claude 3 Opus", providerId: "p3", providerName: "Anthropic", providerType: "anthropic", isDefault: false, isLocal: false, capabilities: ["smartest"] },
];

jest.mock("../queries/useProviders", () => ({
  useAvailableModels: () => ({ data: mockAvailableModels, isLoading: false, error: null }),
}));

jest.mock("../hooks/useModelAvailability", () => ({
  useModelAvailability: () => ({ isStale: false, isPolling: false, lastChecked: null }),
}));

// Mock toast wrapper
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock model availability
jest.mock("../hooks/useModelAvailability", () => ({
  useModelAvailability: () => ({ isStale: false }),
}));

// Mock chat store
jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => ({
    currentWorkspaceId: "ws-001",
    currentChatId: null,
    setWorkspaceId: jest.fn(),
    setChatId: jest.fn(),
    // quick 260723-nnr follow-up — lifted chat panel action state. (Tokens
    // removed in follow-up 3 — lives in RightPanel Token Stats tendina now.)
    selectionMode: false,
    setSelectionMode: jest.fn(),
    selectedMessageIds: new Set<string>(),
    setSelectedMessageIds: jest.fn(),
    distillDialogOpen: false,
    setDistillDialogOpen: jest.fn(),
    messageCount: 0,
    setMessageCount: jest.fn(),
  }),
}));

// Mock markdown renderer
jest.mock("../utils/markdown", () => ({
  renderMarkdown: (text: string) => text,
}));

// Mock child components that may trigger side effects or API calls
jest.mock("../components/ChatSidebar", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("../components/CitationPanel", () => ({
  __esModule: true,
  default: () => null,
  CitationBadge: () => null,
}));

jest.mock("../components/ModelSelector", () => {
  const actual = jest.requireActual("../components/ModelSelector");
  return {
    __esModule: true,
    // Mock the default component (heavy dropdown not needed here), but keep
    // the real `capabilityKeyMap` + `ProviderIcon` so ChatModelBadge can render
    // capability chips without crashing — these are pure data/leaf exports.
    default: () => null,
    capabilityKeyMap: actual.capabilityKeyMap,
    ProviderIcon: actual.ProviderIcon,
  };
});

jest.mock("../components/ModelComparisonView", () => ({
  __esModule: true,
  default: () => null,
}));

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = jest.fn();

describe("ChatPanel /model command", () => {
  const dispatchEventSpy = jest.spyOn(window, "dispatchEvent");

  beforeEach(() => {
    jest.clearAllMocks();
    dispatchEventSpy.mockClear();
    // useMessageHistory persists to localStorage — isolate history between tests.
    localStorage.clear();
  });

  afterAll(() => {
    dispatchEventSpy.mockRestore();
  });

  it("switches model immediately on exact match /model gemma4:latest", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "/model gemma4:latest" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(dispatchEventSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "open-palette" }));
  });

  it("dispatches open-palette with no args /model", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "/model" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(dispatchEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-palette" })
    );
  });

  it("dispatches open-palette with filter on partial match /model gpt", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "/model gpt" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).not.toHaveBeenCalled();
    const calls = dispatchEventSpy.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "open-palette"
    );
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { detail: { filter: string } }).detail).toEqual({ filter: "gpt" });
  });

  it("shows error toast on no-match /model nonexistent", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "/model nonexistent" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith("Model not found");
  });

  it("clears input after /model command is handled", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "/model gemma4:latest" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(textarea).toHaveValue("");
  });

  it("sends normal message when input does not start with /model", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "Hello world" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // 260815-k5s contract: sendMessage takes 5 args — (content, attachedDocId,
    // attachedDocName, modelOverride, archiveId). This assert previously
    // pinned the pre-k5s 4-arg shape; expect.anything() at the 4th slot
    // matched the modelOverride object while the REAL 5th (archiveId
    // undefined) fell outside the expected arg list. Assert the full shape.
    expect(mockSendMessage).toHaveBeenCalledWith(
      "Hello world",
      undefined,
      undefined,
      expect.anything(),
      undefined,
    );
  });

  it("renders Simmetric Native message layouts (user bubble + AI document)", () => {
    mockChatState.messages = [
      { id: "msg-1", role: "user", content: "Hello", metadata: {} },
      { id: "msg-2", role: "assistant", content: "Hi there", metadata: { modelUsed: "gemma4:latest" } },
    ];
    const { container } = renderWithProvider(<ChatPanel />);

    // 4.2.1: user bubble (right-aligned) + 4.2.2: AI document (full-width left).
    expect(container.querySelectorAll(".chat-msg-user").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll(".chat-msg-ai").length).toBeGreaterThanOrEqual(1);

    // message content rendered
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there")).toBeInTheDocument();
    // 4.1.1: model name surfaced via ChatModelBadge in the AI document header.
    // The inline input composer badge was relocated to the RightPanel console
    // (quick 260723-nnr), so only the AI document occurrence remains here.
    const badges = screen.getAllByText("gemma4:latest");
    expect(badges.length).toBeGreaterThanOrEqual(1);

    // Reset state for other tests
    mockChatState.messages = [];
  });
});

describe("ChatPanel attached-doc sanitization (quick 260808-vzm)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it("shows the sanitized name in the attached-doc badge after dropping 'My Report.txt'", async () => {
    const { useDropzone } = jest.requireMock("react-dropzone") as {
      useDropzone: jest.Mock;
    };
    const { apiUpload } = jest.requireMock("../utils/api") as {
      apiUpload: jest.Mock;
    };
    apiUpload.mockResolvedValue({ id: "doc-1" });

    renderWithProvider(<ChatPanel />);

    // Grab the onDrop handler the component registered with useDropzone.
    const dropzoneCall = (useDropzone as unknown as jest.Mock).mock.calls.find(
      (c) => c[0] && typeof c[0].onDrop === "function",
    );
    expect(dropzoneCall).toBeDefined();
    const { onDrop } = dropzoneCall[0] as { onDrop: (files: File[]) => Promise<void> };

    const file = new File(["hello"], "My Report.txt", { type: "text/plain" });
    await act(async () => {
      await onDrop([file]);
    });

    expect(apiUpload).toHaveBeenCalledWith(
      "/documents/upload",
      expect.any(FormData),
    );
    // The badge renders the sanitized name (spaces -> dashes).
    expect(screen.getByText("My-Report.txt")).toBeInTheDocument();
    // The raw client filename must NOT appear anywhere.
    expect(screen.queryByText("My Report.txt")).not.toBeInTheDocument();
  });
});

describe("ChatPanel message history (↑/↓)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  const textareaOf = () => screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;

  it("recalls the last sent message on ArrowUp and restores the draft on ArrowDown", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();

    // Send two messages to populate the global history.
    fireEvent.change(textarea, { target: { value: "first message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    fireEvent.change(textarea, { target: { value: "second message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(textarea).toHaveValue("");

    // ArrowUp on the first line (empty input) recalls the newest message.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea).toHaveValue("second message");

    // ArrowUp again recalls the older message.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea).toHaveValue("first message");

    // ArrowUp at the oldest entry is a no-op (value unchanged).
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea).toHaveValue("first message");

    // ArrowDown moves forward.
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveValue("second message");

    // ArrowDown past newest restores the live draft (empty, since we never typed one).
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveValue("");
  });

  it("preserves an unsent draft and restores it after history navigation", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();

    // Populate history with one message.
    fireEvent.change(textarea, { target: { value: "sent one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(textarea).toHaveValue("");

    // Start typing a new draft, then recall history and come back.
    fireEvent.change(textarea, { target: { value: "draft in progress" } });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea).toHaveValue("sent one");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveValue("draft in progress");
  });

  it("does not recall history when the cursor is not on the first line (multiline)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();

    fireEvent.change(textarea, { target: { value: "history item" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Multiline input: cursor on the second line. ArrowUp must NOT recall —
    // it should move the cursor up instead (default behavior, value unchanged).
    fireEvent.change(textarea, { target: { value: "line one\nline two" } });
    // Place caret at the start of "line two" (index 9, past the first newline).
    textarea.setSelectionRange?.(9, 9);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea).toHaveValue("line one\nline two");
  });
});
