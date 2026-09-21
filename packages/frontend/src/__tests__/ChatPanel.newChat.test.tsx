// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ChatPanel nav-transition reconciler tests (quick 260910-e0n).
 *
 * Pins the four nav transitions that the R-5 regression broke:
 *   1. new-chat clear   — nav truthy → null with a chat open → clearChat
 *   2. abort-before-clear — same transition with a stream in flight
 *   3. selection load   — nav moves to another chat → loadChat, NO bounce
 *   4. creation adoption — useChat adopts a server chatId → nav setChatId
 *   5. model re-seed    — new-chat transition re-runs the RC-4 chain
 *
 * The ../hooks/useChat and ../contexts/ChatContext mocks are CONTROLLABLE:
 * module-level mutable state objects the tests mutate inside act() before a
 * rerender — this simulates both sides of the panel↔nav sync without the
 * real hooks.
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
import { render, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChatPanel from "../components/ChatPanel";

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
        "chat.palette.fallbackToast": "Selected model is unavailable",
      };
      return map[key] || defaultValue || key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Stub the i18n index so transitive imports don't run the real init.
jest.mock("../i18n", () => ({
  getEnabledLanguages: jest.fn(() => ["en"]),
}));

// Mock ThemeContext
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

// Controllable api mock — apiGet resolves the workspace agent-config shape
// used by the model re-seed chain.
jest.mock("../utils/api", () => ({
  apiUpload: jest.fn().mockResolvedValue({ id: "doc-1" }),
  apiGet: jest.fn(async (url: string) => {
    if (url.includes("/agent-config")) {
      return { providerId: "p1", model: "m-default" };
    }
    return [];
  }),
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

// ── Controllable useChat mock ──
// Tests mutate mockChatState.currentChatId / messages / isStreaming directly
// inside act() before a rerender.
const mockSendMessage = jest.fn();
const mockLoadChat = jest.fn();
const mockClearChat = jest.fn();
const mockAbortStream = jest.fn();
const mockRemoveMessage = jest.fn();
const mockRenameChat = jest.fn();
const mockUpdateChatModel = jest.fn().mockResolvedValue(undefined);
const mockRegenerateLastResponse = jest.fn().mockResolvedValue(undefined);
const mockEditLastMessageAndRegenerate = jest.fn().mockResolvedValue(undefined);

const mockChatState: Record<string, unknown> = {
  messages: [],
  isStreaming: false,
  streamingContent: "",
  statusMessage: null,
  activePlan: null,
  currentChatId: null as string | null,
  chatName: null,
  error: null,
  persistedModel: null as { providerId?: string; model?: string } | null,
  sendMessage: mockSendMessage,
  loadChat: mockLoadChat,
  clearChat: mockClearChat,
  abortStream: mockAbortStream,
  removeMessage: mockRemoveMessage,
  renameChat: mockRenameChat,
  updateChatModel: mockUpdateChatModel,
  regenerateLastResponse: mockRegenerateLastResponse,
  editLastMessageAndRegenerate: mockEditLastMessageAndRegenerate,
};

// The pure model-selection helpers stay REAL (from the owning sub-module) so
// the RC-4 re-seed test exercises the real resolution chain.
jest.mock("../hooks/useChat", () => ({
  ...jest.requireActual("../hooks/useChatModelSelection"),
  useChat: () => mockChatState,
}));

// ── Controllable ChatContext (nav) mock ──
// mockNavSetChatId assigns into mockNavState.currentChatId so the creation
// test can observe adoption; mockNavSetNewChatArchiveId is a plain spy.
const mockNavSetChatId = jest.fn((id: string | null) => {
  mockNavState.currentChatId = id;
});
const mockNavSetNewChatArchiveId = jest.fn();

const mockNavState: Record<string, unknown> = {
  currentWorkspaceId: "ws-1" as string | null,
  currentChatId: null as string | null,
  setWorkspaceId: jest.fn(),
  setChatId: mockNavSetChatId,
  selectionMode: false,
  setSelectionMode: jest.fn(),
  selectedMessageIds: new Set<string>(),
  setSelectedMessageIds: jest.fn(),
  distillDialogOpen: false,
  setDistillDialogOpen: jest.fn(),
  messageCount: 0,
  setMessageCount: jest.fn(),
  newChatArchiveId: null as string | null,
  setNewChatArchiveId: mockNavSetNewChatArchiveId,
};

jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => mockNavState,
}));

// Mock useChatPanelState with a flat bag so the reseed's setModelOverride
// assertion is direct (the real hook is pure useState; mocking avoids the
// persistedModel mirroring effect racing the assertion).
const mockSetModelOverride = jest.fn();
jest.mock("../hooks/useChatPanelState", () => ({
  __esModule: true,
  useChatPanelState: () => ({
    input: "",
    setInput: jest.fn(),
    ttsPlaying: null,
    setTtsPlaying: jest.fn(),
    citationPanelSources: null,
    setCitationPanelSources: jest.fn(),
    attachedDoc: null,
    setAttachedDoc: jest.fn(),
    uploading: false,
    setUploading: jest.fn(),
    modelOverride: null,
    setModelOverride: mockSetModelOverride,
    isComparing: false,
    setIsComparing: jest.fn(),
    wikiTooltip: null,
    setWikiTooltip: jest.fn(),
    wikiModalSlug: null,
    setWikiModalSlug: jest.fn(),
    wikiCreateSlug: null,
    setWikiCreateSlug: jest.fn(),
    editingMessageId: null,
    setEditingMessageId: jest.fn(),
    editInput: "",
    setEditInput: jest.fn(),
    deletingMessageId: null,
    setDeletingMessageId: jest.fn(),
    statusAnnouncement: null,
    setStatusAnnouncement: jest.fn(),
    showDlpTexts: false,
    setShowDlpTexts: jest.fn(),
  }),
}));

// Mock query hooks
const mockAvailableModels = [
  { id: "m1", name: "m-pref", displayName: "Pref", providerId: "p1", providerName: "P1", providerType: "ollama", isDefault: false, isLocal: true, capabilities: [] },
  { id: "m2", name: "m-default", displayName: "Default", providerId: "p1", providerName: "P1", providerType: "ollama", isDefault: true, isLocal: true, capabilities: [] },
];

jest.mock("../queries/useProviders", () => ({
  useAvailableModels: () => ({ data: mockAvailableModels, isLoading: false, error: null }),
}));

jest.mock("../queries/useChats", () => ({
  useChats: () => ({ data: [] }),
}));

jest.mock("../queries/useSettings", () => ({
  useSettingsHelpers: () => ({ getValue: () => null }),
}));

jest.mock("../queries/useAuth", () => ({
  useMe: () => ({ data: null }),
}));

// Mock toast wrapper
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
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
    default: () => null,
    capabilityKeyMap: actual.capabilityKeyMap,
    ProviderIcon: actual.ProviderIcon,
  };
});

jest.mock("../components/ModelComparisonView", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("../components/RightPanel", () => ({
  __esModule: true,
  default: () => null,
}));

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = jest.fn();

/** Reset both controllable state objects to the given start values. */
const resetState = (opts: {
  navChatId: string | null;
  chatChatId: string | null;
  isStreaming?: boolean;
  messages?: Array<Record<string, unknown>>;
}) => {
  mockNavState.currentChatId = opts.navChatId;
  mockNavState.newChatArchiveId = null;
  mockChatState.currentChatId = opts.chatChatId;
  mockChatState.isStreaming = opts.isStreaming ?? false;
  mockChatState.messages = opts.messages ?? [];
  mockChatState.persistedModel = null;
};

describe("ChatPanel nav-transition reconciler (quick 260910-e0n)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it("Test 1: new-chat transition clears the open chat", () => {
    resetState({ navChatId: "chat-001", chatChatId: "chat-001", messages: [{ id: "msg-1", role: "user", content: "Hello", metadata: {} }] });
    const { rerender } = renderWithProvider(<ChatPanel />);

    // User clicks sidebar "New chat" → App.tsx setChatId(null) → nav flips
    // to null while useChat still holds chat-001.
    act(() => {
      mockNavState.currentChatId = null;
    });
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <TooltipProvider>
            <ChatPanel />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(mockClearChat).toHaveBeenCalledTimes(1);
    expect(mockNavSetNewChatArchiveId).toHaveBeenCalledWith(null);
    expect(mockLoadChat).not.toHaveBeenCalled();
  });

  it("Test 2: new-chat transition aborts an in-flight stream before clearing", () => {
    resetState({ navChatId: "chat-001", chatChatId: "chat-001", isStreaming: true, messages: [{ id: "msg-1", role: "user", content: "Hello", metadata: {} }] });
    const { rerender } = renderWithProvider(<ChatPanel />);

    act(() => {
      mockNavState.currentChatId = null;
    });
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <TooltipProvider>
            <ChatPanel />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(mockAbortStream).toHaveBeenCalledTimes(1);
    expect(mockClearChat).toHaveBeenCalledTimes(1);
    // abortStream must run BEFORE clearChat so the in-flight stream's done
    // event cannot re-adopt the old chat after the clear.
    expect(mockAbortStream.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearChat.mock.invocationCallOrder[0]
    );
  });

  it("Test 3: selecting another chat loads it instead of bouncing back", () => {
    resetState({ navChatId: "chat-001", chatChatId: "chat-001", messages: [{ id: "msg-1", role: "user", content: "Hello", metadata: {} }] });
    const { rerender } = renderWithProvider(<ChatPanel />);

    // User clicks chat-B in the sidebar → nav moves to chat-002.
    act(() => {
      mockNavState.currentChatId = "chat-002";
    });
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <TooltipProvider>
            <ChatPanel />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // The regression pin: the old sync-back effect would have written the
    // stale "chat-001" back into nav — it must not.
    expect(mockLoadChat).toHaveBeenCalledWith("chat-002");
    const wroteStaleId = mockNavSetChatId.mock.calls.some(
      (call) => call[0] === "chat-001"
    );
    expect(wroteStaleId).toBe(false);
  });

  it("Test 4: brand-new chat creation adopts the server chatId into nav", () => {
    resetState({ navChatId: null, chatChatId: null, messages: [] });
    const { rerender } = renderWithProvider(<ChatPanel />);

    // sendMessage's SSE done event sets useChat's currentChatId (server
    // chatId) while nav still has no chat.
    act(() => {
      mockChatState.currentChatId = "chat-new-1";
    });
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <TooltipProvider>
            <ChatPanel />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Creation adoption preserved (what the deleted sync-back existed for).
    expect(mockNavSetChatId).toHaveBeenCalledWith("chat-new-1");
    expect(mockClearChat).not.toHaveBeenCalled();
    expect(mockLoadChat).not.toHaveBeenCalled();
  });

  it("Test 5: new-chat transition re-seeds the model from the per-workspace preference chain", async () => {
    resetState({ navChatId: "chat-001", chatChatId: "chat-001", messages: [] });
    // Seed a valid per-workspace preference (RC-4 chain winner).
    localStorage.setItem("modelPref:ws-1", JSON.stringify({ providerId: "p1", model: "m-pref" }));
    const { rerender } = renderWithProvider(<ChatPanel />);

    act(() => {
      mockNavState.currentChatId = null;
    });
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <TooltipProvider>
            <ChatPanel />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Flush the async reseed (localStorage read + apiGet + setModelOverride).
    await act(async () => {
      await Promise.resolve();
    });

    // The resolved selection is written back to the workspace preference
    // (RC-4 persist) and applied as the panel's model override.
    expect(mockSetModelOverride).toHaveBeenCalledWith({ providerId: "p1", model: "m-pref" });
    expect(JSON.parse(localStorage.getItem("modelPref:ws-1") ?? "null")).toEqual({
      providerId: "p1",
      model: "m-pref",
    });
  });
});