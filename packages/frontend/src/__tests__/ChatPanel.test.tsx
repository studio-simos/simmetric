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
    t: (key: string, defaultValue?: string, opts?: Record<string, string>) => {
      const map: Record<string, string> = {
        "chat.placeholder": "Type a message...",
        "chat.send": "Send",
        "chat.thinking": "Thinking...",
        "chat.modelCommand.notFound": "Model not found",
        "chat.modelSelector.unavailable": "Failed to update model",
        "chat.readAloud": "Read Aloud",
        "chat.microphone": "Microphone",
        "chat.skillsPalette.paramError": "Could not read parameters for /{{slug}}. Try /{{slug}} key=value.",
        "chat.cancel": "Cancel",
      };
      let out = map[key] || defaultValue || key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
        }
      }
      return out;
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

// Phase 190 (SKIL-02): the /slug parser reads useSkills (custom ∪ accessible).
const mockSkills: { builtin: unknown[]; custom: unknown[]; accessible: unknown[] } = {
  builtin: [],
  custom: [
    {
      id: "sk-1",
      slug: "translate",
      name: "custom_translate",
      description: "Translate text",
      skillMode: "prompt",
      scope: "personal",
      isEnabled: true,
      workspaceId: null,
      createdBy: "u1",
      config: { defaultParams: {} },
      inputSchema: { properties: { input: { type: "string" } }, required: ["input"] },
    },
    // A disabled row must NOT be invocable (server resolver filters isEnabled).
    {
      id: "sk-2",
      slug: "disabled_skill",
      name: "custom_disabled_skill",
      description: "Disabled skill",
      skillMode: "prompt",
      scope: "personal",
      isEnabled: false,
      workspaceId: null,
      createdBy: "u1",
      config: { defaultParams: {} },
      inputSchema: { properties: { input: { type: "string" } }, required: ["input"] },
    },
    // CR-01: a row scoped to ANOTHER workspace is never offered — the server
    // resolver's workspace arm would reject it (dead command in the palette).
    {
      id: "sk-3",
      slug: "other_ws_skill",
      name: "custom_other_ws_skill",
      description: "Other workspace skill",
      skillMode: "prompt",
      scope: "workspace",
      isEnabled: true,
      workspaceId: "ws-999",
      createdBy: "someone-else",
      config: { defaultParams: {} },
      inputSchema: { properties: { input: { type: "string" } }, required: ["input"] },
    },
  ],
  accessible: [],
};

jest.mock("../queries/useProviders", () => ({
  useAvailableModels: () => ({ data: mockAvailableModels, isLoading: false, error: null }),
}));

jest.mock("../queries/useSkills", () => ({
  useSkills: () => ({ data: mockSkills, isLoading: false, error: null }),
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
// ── Phase 191 archive-draft lifecycle (191-04 WR-02 + IN-02 review fixes) ──
// The mount-time write effect removes the CURRENT key when the selection is
// empty (write-before-read ordering), so a same-key draft only reaches the
// read effect through a KEY TRANSITION. The lifecycle tests below drive the
// transition via a mutable mockChatState.currentChatId: render with chat-A,
// then re-render with a different chat id — the read effect for the NEW key
// runs against the saved draft (IN-02 clamp) and the cleanup arm fires (WR-02).
const chatNavContext = {
  currentWorkspaceId: "ws-001",
  currentChatId: "chat-001" as string | null,
  setWorkspaceId: jest.fn(),
  setChatId: jest.fn(),
  selectionMode: false,
  setSelectionMode: jest.fn(),
  selectedMessageIds: new Set<string>(),
  setSelectedMessageIds: jest.fn(),
  distillDialogOpen: false,
  setDistillDialogOpen: jest.fn(),
  messageCount: 0,
  setMessageCount: jest.fn(),
  // quick 260910-e0n — shape-complete: the panel reconciler destructures
  // setNewChatArchiveId (new-chat transition resets the ephemeral pick).
  newChatArchiveId: null,
  setNewChatArchiveId: jest.fn(),
};

jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => chatNavContext,
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

    // 260815-k5s + Phase 191 contract: sendMessage takes 7 positional args —
    // (content, attachedDocId, attachedDocName, modelOverride, archiveId,
    // skillCall, attachedArchiveIds). The two trailing slots (skillCall,
    // attachedArchiveIds) are additive-optional and stay undefined here
    // (no slash-skill, no attached archive chips).
    expect(mockSendMessage).toHaveBeenCalledWith(
      "Hello world",
      undefined,
      undefined,
      expect.anything(),
      undefined,
      undefined,
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

// ── Phase 190 (SKIL-02): /slug parser arms — appended-only suite (Pitfall 9:
// every /model assertion above stays untouched and green). ──
describe("ChatPanel /slug skill parser (Phase 190)", () => {
  const textareaOf = () => screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it("sends message + skillCall for a matched skill with positional args (D-09)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "/translate Ciao mondo" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "/translate Ciao mondo",
      undefined,
      undefined,
      expect.anything(),
      undefined,
      { slug: "translate", params: { input: "Ciao mondo" } },
      // Phase 191 (D-02): the 7th attachedArchiveIds slot is undefined —
      // no archive chips attached in this scenario.
      undefined,
    );
    expect(textarea).toHaveValue("");
  });

  it("shows the paramError notice and does NOT send when required params are missing (D-09)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "/translate" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(
      screen.getByText("Could not read parameters for /translate. Try /translate key=value.")
    ).toBeInTheDocument();
  });

  it("sends an unmatched /word as a normal message with NO skillCall (D-08 never-error)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "/nonexistent word" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "/nonexistent word",
      undefined,
      undefined,
      expect.anything(),
      undefined,
      // Phase 190/191 trailing slots: skillCall (absent for a plain send)
      // and attachedArchiveIds (no chips) — both undefined.
      undefined,
      undefined,
    );
    // The plain-send shape carries the full 7-arg arity (Phase 190 skillCall
    // + Phase 191 attachedArchiveIds trailing slots, both undefined here).
    expect(mockSendMessage.mock.calls[0].length).toBe(7);
    expect(mockSendMessage.mock.calls[0][5]).toBeUndefined(); // skillCall
    expect(mockSendMessage.mock.calls[0][6]).toBeUndefined(); // attachedArchiveIds
  });

  it("treats a builtin-style slug as a normal message (match set excludes builtins)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "/rag_search find stuff" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0].length).toBe(7);
    expect(mockSendMessage.mock.calls[0][5]).toBeUndefined(); // skillCall
    expect(mockSendMessage.mock.calls[0][6]).toBeUndefined(); // attachedArchiveIds
  });

  it("never routes a disabled custom skill (match set filters isEnabled)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "/disabled_skill hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0].length).toBe(7);
    expect(mockSendMessage.mock.calls[0][5]).toBeUndefined(); // skillCall
    expect(mockSendMessage.mock.calls[0][6]).toBeUndefined(); // attachedArchiveIds
  });

  it("CR-01: a row scoped to ANOTHER workspace is never offered (falls through as a normal message)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    // ws-999 ≠ the panel's currentWorkspaceId (ws-001) — the workspace filter
    // excludes it, so the /slug falls through to a normal message.
    fireEvent.change(textarea, { target: { value: "/other_ws_skill hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0].length).toBe(7);
    expect(mockSendMessage.mock.calls[0][4]).toBeUndefined(); // archiveId
    expect(mockSendMessage.mock.calls[0][5]).toBeUndefined(); // skillCall
    expect(mockSendMessage.mock.calls[0][6]).toBeUndefined(); // attachedArchiveIds
  });

  it("routes /model first — the /model branch owns inputs starting with /model (Pitfall 9)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "/model gemma4:latest" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// ── Phase 190 (SKIL-02/D-10): SkillsPalette mount contract in ChatPanel —
// separate surface (Pitfall 9), insert-not-send selection. ──
describe("ChatPanel skills palette mount (Phase 190)", () => {
  const textareaOf = () => screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it("typing '/' opens the palette and selecting a row inserts '/slug ' WITHOUT sending", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();

    // The palette is open while the input starts with "/" (cached data only).
    fireEvent.change(textarea, { target: { value: "/trans" } });
    expect(screen.getByTestId("skills-palette-item-translate")).toBeInTheDocument();

    // Selecting inserts "/translate " into the input — sendMessage NOT called.
    fireEvent.click(screen.getByTestId("skills-palette-item-translate"));
    expect(textarea).toHaveValue("/translate ");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("the palette does not open for the /model family (separate surfaces — Pitfall 9)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "/model gpt" } });
    expect(screen.queryByTestId("skills-palette-item-translate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skills-palette-empty")).not.toBeInTheDocument();
  });

  it("a space after the slug closes the palette (space-disambiguation)", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "/translate" } });
    expect(screen.getByTestId("skills-palette-item-translate")).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "/translate " } });
    expect(screen.queryByTestId("skills-palette-item-translate")).not.toBeInTheDocument();
  });

  it("normal (non-slash) input keeps the palette closed", () => {
    renderWithProvider(<ChatPanel />);
    const textarea = textareaOf();
    fireEvent.change(textarea, { target: { value: "hello world" } });
    expect(screen.queryByTestId("skills-palette-item-translate")).not.toBeInTheDocument();
  });
});

// ── Phase 191 archive-draft lifecycle (191-04 WR-02 review fix) ──
// An abandoned `attachedArchives:<ws>:new` draft must be cleared once a real
// chat id is active (the dead endsWith(":new") gate is replaced), so it
// cannot resurrect its chips — and silently attach them — in the next new
// chat. The IN-02 tamper clamp is pinned indirectly: any draft that DOES
// reach the read effect is clamped to 5 before it can reach sendMessage.
describe("ChatPanel attached-archives draft lifecycle (191-04)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockChatState.currentChatId = "chat-001";
  });

  afterEach(() => {
    mockChatState.currentChatId = "chat-001";
  });

  it("WR-02: a stale ':new' draft is cleared when a real chat id is active (cannot resurrect in the next new chat)", () => {
    // Abandoned new-chat draft (user attached X, never sent, clicked a chat).
    localStorage.setItem("attachedArchives:ws-001:new", JSON.stringify(["abandoned-id"]));
    renderWithProvider(<ChatPanel />);

    // currentChatId = "chat-001" (real id) → the read effect's cleanup arm
    // removes the abandoned new-chat draft.
    expect(localStorage.getItem("attachedArchives:ws-001:new")).toBeNull();
    // An unrelated chat's draft is untouched by the same arm.
    localStorage.setItem("attachedArchives:ws-001:chat-999", JSON.stringify(["other-id"]));
    act(() => {
      mockChatState.currentChatId = "chat-B";
    });
    expect(localStorage.getItem("attachedArchives:ws-001:chat-999")).not.toBeNull();
  });
});
