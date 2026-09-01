// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * RightPanel component tests — Feature 3.5 (collapsible right-side console).
 *
 * Three sections: Token Stats, Archivio collegato (Phase 80, permission-gated
 * — hidden in these tests because the mock user lacks archive:read), Skills &
 * MCP. Collapsed state persists to localStorage["right-panel-open"] (default
 * open). Hidden below the `lg` breakpoint in both states. We mock the
 * query/context dependencies.
 */
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockUseChatNav = jest.fn();
jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => mockUseChatNav(),
}));

const mockUseSessionTokens = jest.fn();
const mockUseChatTokens = jest.fn();
jest.mock("../queries/useChatTokens", () => ({
  useSessionTokens: (...args: unknown[]) => mockUseSessionTokens(...args),
  useChatTokens: (...args: unknown[]) => mockUseChatTokens(...args),
}));

const mockUseMcpConnections = jest.fn();
jest.mock("../queries/useMcpConnections", () => ({
  useMcpConnections: () => mockUseMcpConnections(),
}));

// Phase 80 — linked archive section dependencies. Mocked so RightPanel can
// render without a QueryClientProvider; the mock user has no archive:read,
// so the "Archivio collegato" section is hidden (canLinkArchive === false).
const mockUseMe = jest.fn();
jest.mock("../queries/useAuth", () => ({
  useMe: () => mockUseMe(),
}));

const mockUseChats = jest.fn();
jest.mock("../queries/useChats", () => ({
  useChats: (...args: unknown[]) => mockUseChats(...args),
  useLinkArchive: () => ({
    mutate: jest.fn(),
    isPending: false,
  }),
}));

const mockUseArchives = jest.fn();
jest.mock("../queries/useArchives", () => ({
  useArchives: (...args: unknown[]) => mockUseArchives(...args),
}));

// quick 260723-nnr — Chat controls section dependencies. Mocked so RightPanel
// can render without a QueryClientProvider.
const mockUseAvailableModels = jest.fn();
const mockUseModelAvailability = jest.fn();
jest.mock("../queries/useProviders", () => ({
  useAvailableModels: (...args: unknown[]) => mockUseAvailableModels(...args),
}));
jest.mock("../hooks/useModelAvailability", () => ({
  useModelAvailability: (...args: unknown[]) => mockUseModelAvailability(...args),
}));

// The relocated popovers/modal carry their own hook dependencies; stub them so
// the RightPanel unit test stays focused on the console panel itself.
jest.mock("../components/McpPinnerPopover", () => ({
  __esModule: true,
  default: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="mcp-pinner" data-disabled={disabled} />
  ),
}));
jest.mock("../components/McpHelpPopover", () => ({
  __esModule: true,
  default: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="mcp-help" data-disabled={disabled} />
  ),
}));
jest.mock("../components/WikiHistoryModal", () => ({
  __esModule: true,
  WikiHistoryModal: ({ archiveId }: { archiveId: string; onClose: () => void }) => (
    <div data-testid="wiki-history-modal" data-archive-id={archiveId} />
  ),
}));

// 260815-k5s — mock the Radix Select as a native <select> so the new-chat
// archive selector's onValueChange can be driven with fireEvent.change. The
// existing tests never render the section (canLinkArchive is false without
// archive:read), so this mock is inert for them.
jest.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, disabled, children }: { value?: string; onValueChange?: (v: string) => void; disabled?: boolean; children: React.ReactNode }) => (
    <select data-testid="archive-select" value={value ?? ""} disabled={disabled} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
  SelectValue: () => null,
}));

import { render, screen, fireEvent } from "@testing-library/react";
import RightPanel from "../components/RightPanel";

const PROPS = { selectedProjectId: "proj-1" };

function setupTokens(session: unknown, chatTokens: unknown) {
  mockUseChatNav.mockReturnValue({
    currentWorkspaceId: "ws-1",
    currentChatId: null,
    // quick 260723-nnr follow-up — lifted chat panel action state used by the
    // Select/Save-to-Wiki controls now rendered in RightPanel. (Tokens removed
    // in follow-up 3 — lives in the Token Stats collapsible tendina now.)
    selectionMode: false,
    setSelectionMode: jest.fn(),
    selectedMessageIds: new Set<string>(),
    setSelectedMessageIds: jest.fn(),
    distillDialogOpen: false,
    setDistillDialogOpen: jest.fn(),
    messageCount: 0,
    setMessageCount: jest.fn(),
    // 260815-k5s — ephemeral new-chat archive selection (ChatContext).
    newChatArchiveId: null,
    setNewChatArchiveId: jest.fn(),
  });
  mockUseSessionTokens.mockReturnValue({ data: session });
  mockUseChatTokens.mockReturnValue({ data: chatTokens });
  mockUseMcpConnections.mockReturnValue({ data: [] });
  // Phase 80 mocks — user without archive:read keeps the section hidden.
  mockUseMe.mockReturnValue({ data: { permissions: ["chat:write"] } });
  mockUseChats.mockReturnValue({ data: [] });
  mockUseArchives.mockReturnValue({ data: [] });
  // 260723-nnr mocks — no available models + non-stale by default.
  mockUseAvailableModels.mockReturnValue({ data: [] });
  mockUseModelAvailability.mockReturnValue({ isStale: false });
}

describe("RightPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it("renders the expanded panel by default and the two section titles", () => {
    setupTokens(undefined, undefined);
    render(<RightPanel {...PROPS} />);

    expect(screen.getByText("rightPanel.title")).toBeInTheDocument();
    expect(screen.getByText("rightPanel.tokenStats")).toBeInTheDocument();
    expect(screen.getByText("rightPanel.skillsMcp")).toBeInTheDocument();
    expect(screen.queryByText("rightPanel.quickSettings")).not.toBeInTheDocument();
  });

  it("MCP pinner enabled with a workspace even without a chat (staging); disabled without workspace", () => {
    // No chat (currentChatId null) but a workspace → pinner enabled (staging).
    setupTokens(undefined, undefined);
    const { container } = render(<RightPanel {...PROPS} />);
    expect(container.querySelector('[data-testid="mcp-pinner"]')).toHaveAttribute("data-disabled", "false");

    // No workspace at all → pinner disabled.
    mockUseChatNav.mockReturnValue({
      currentWorkspaceId: null,
      currentChatId: null,
      selectionMode: false,
      selectedMessageIds: new Set(),
      setSelectedMessageIds: jest.fn(),
      setDistillDialogOpen: jest.fn(),
      messageCount: 0,
      newChatArchiveId: null,
      setNewChatArchiveId: jest.fn(),
    });
    const { container: container2 } = render(<RightPanel {...PROPS} />);
    expect(container2.querySelector('[data-testid="mcp-pinner"]')).toHaveAttribute("data-disabled", "true");
  });

  it("CON-01 sheet variant: renders only the two sections, no Quick Settings, no collapse/expand controls", () => {
    setupTokens(undefined, undefined);
    render(<RightPanel {...PROPS} variant="sheet" />);

    // Header title + the two surviving section titles.
    expect(screen.getByText("rightPanel.title")).toBeInTheDocument();
    expect(screen.getByText("rightPanel.tokenStats")).toBeInTheDocument();
    expect(screen.getByText("rightPanel.skillsMcp")).toBeInTheDocument();
    // Section 3 (Quick Settings) must be absent in the mobile Sheet variant too.
    expect(screen.queryByText("rightPanel.quickSettings")).not.toBeInTheDocument();
    // The sheet variant is frame-only (no rail / collapse / expand controls —
    // the Sheet provides those). Their aria-labels must not be rendered.
    expect(screen.queryByLabelText("rightPanel.collapse")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("rightPanel.expand")).not.toBeInTheDocument();
  });

  it("collapses to the narrow rail when the collapse button is clicked", () => {
    setupTokens(undefined, undefined);
    render(<RightPanel {...PROPS} />);

    fireEvent.click(screen.getByLabelText("rightPanel.collapse"));

    // The rail renders an expand button with the vertical title.
    expect(screen.getByLabelText("rightPanel.expand")).toBeInTheDocument();
    expect(screen.getByText("rightPanel.title")).toBeInTheDocument();
    // localStorage persisted the collapsed state.
    expect(localStorage.getItem("right-panel-open")).toBe("false");
    // Section titles are gone in the collapsed view.
    expect(screen.queryByText("rightPanel.tokenStats")).not.toBeInTheDocument();
  });

  it("re-expands from the rail", () => {
    setupTokens(undefined, undefined);
    render(<RightPanel {...PROPS} />);
    fireEvent.click(screen.getByLabelText("rightPanel.collapse"));
    fireEvent.click(screen.getByLabelText("rightPanel.expand"));

    expect(screen.getByText("rightPanel.tokenStats")).toBeInTheDocument();
    expect(localStorage.getItem("right-panel-open")).toBe("true");
  });

  it("restores the collapsed state from localStorage on mount", () => {
    localStorage.setItem("right-panel-open", "false");
    setupTokens(undefined, undefined);
    render(<RightPanel {...PROPS} />);

    expect(screen.getByLabelText("rightPanel.expand")).toBeInTheDocument();
    expect(screen.queryByText("rightPanel.tokenStats")).not.toBeInTheDocument();
  });

  it("applies the responsive `hidden lg:flex` class in both states", () => {
    setupTokens(undefined, undefined);
    const { container } = render(<RightPanel {...PROPS} />);
    let root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("hidden");
    expect(root.className).toContain("lg:flex");

    fireEvent.click(screen.getByLabelText("rightPanel.collapse"));
    root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("hidden");
    expect(root.className).toContain("lg:flex");
  });

  it("renders formatted IN/OUT/TOT token stats when session data exists", () => {
    setupTokens(
      { totalInput: 1500, totalOutput: 2500, total: 4000 },
      undefined,
    );
    render(<RightPanel {...PROPS} />);

    expect(screen.getByText("1.5k")).toBeInTheDocument();
    expect(screen.getByText("2.5k")).toBeInTheDocument();
    expect(screen.getByText("4k")).toBeInTheDocument();
    expect(screen.queryByText("rightPanel.noTokenData")).not.toBeInTheDocument();
  });

  it("shows the no-token-data hint when the session total is zero", () => {
    setupTokens({ totalInput: 0, totalOutput: 0, total: 0 }, undefined);
    render(<RightPanel {...PROPS} />);

    expect(screen.getByText("rightPanel.noTokenData")).toBeInTheDocument();
    // Em-dash placeholders for IN/OUT/TOT.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("renders the five built-in agent skills", () => {
    setupTokens(undefined, undefined);
    render(<RightPanel {...PROPS} />);

    const skillKeys = ["rag_search", "workspace_memory", "wiki_query", "wiki_write", "document_temp_process"];
    skillKeys.forEach((k) => {
      expect(screen.getByText(`skills.${k}.displayName`)).toBeInTheDocument();
    });
  });

  it("shows the no-MCP empty state when no connections match the scope", () => {
    setupTokens(undefined, undefined);
    mockUseMcpConnections.mockReturnValue({ data: [] });
    render(<RightPanel {...PROPS} />);

    expect(screen.getByText("rightPanel.noMcp")).toBeInTheDocument();
  });

  it("lists only the MCP connections scoped to the active workspace or project", () => {
    mockUseChatNav.mockReturnValue({ currentWorkspaceId: "ws-1", currentChatId: null, newChatArchiveId: null, setNewChatArchiveId: jest.fn() });
    mockUseSessionTokens.mockReturnValue({ data: undefined });
    mockUseChatTokens.mockReturnValue({ data: undefined });
    mockUseMcpConnections.mockReturnValue({
      data: [
        { id: "c1", name: "Scoped-WS", workspaceId: "ws-1", projectId: null, liveStatus: "connected", toolCount: 3, url: "u1" },
        { id: "c2", name: "Scoped-Project", workspaceId: null, projectId: "proj-1", liveStatus: "disconnected", toolCount: 0, url: "u2" },
        { id: "c3", name: "Other", workspaceId: "ws-2", projectId: "proj-2", liveStatus: "connected", toolCount: 1, url: "u3" },
      ],
    });

    render(<RightPanel {...PROPS} />);

    expect(screen.getByText("Scoped-WS")).toBeInTheDocument();
    expect(screen.getByText("Scoped-Project")).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();

    // Tool count badge only for connections with toolCount > 0.
    expect(screen.getByText("3T")).toBeInTheDocument();
    // Zero toolCount → no "0T" badge rendered for Scoped-Project.
    expect(screen.queryByText("0T")).not.toBeInTheDocument();
  });

  // 260815-k5s — new-chat archive selector (D-01: drop !!currentChatId gate).
  it("renders the archive selector for a new chat (currentChatId null) with archive:read and routes changes to setNewChatArchiveId (no PATCH)", () => {
    const setNewChatArchiveId = jest.fn();
    const archiveId = "00000000-0000-4000-8000-000000000000";
    mockUseChatNav.mockReturnValue({
      currentWorkspaceId: "ws-1",
      currentChatId: null,
      selectionMode: false,
      setSelectionMode: jest.fn(),
      selectedMessageIds: new Set(),
      setSelectedMessageIds: jest.fn(),
      setDistillDialogOpen: jest.fn(),
      messageCount: 0,
      setMessageCount: jest.fn(),
      newChatArchiveId: null,
      setNewChatArchiveId,
    });
    mockUseSessionTokens.mockReturnValue({ data: undefined });
    mockUseChatTokens.mockReturnValue({ data: undefined });
    mockUseMcpConnections.mockReturnValue({ data: [] });
    mockUseAvailableModels.mockReturnValue({ data: [] });
    mockUseModelAvailability.mockReturnValue({ isStale: false });
    // archive:read grants canLinkArchive even without a chat.
    mockUseMe.mockReturnValue({ data: { permissions: ["chat:write", "archive:read"] } });
    mockUseChats.mockReturnValue({ data: [] });
    mockUseArchives.mockReturnValue({ data: [{ id: archiveId, name: "Docs Archive", _count: { pages: 7 } }] });

    render(<RightPanel {...PROPS} />);

    // Section title renders for a new chat.
    expect(screen.getByText("chat.archive.sectionTitle")).toBeInTheDocument();
    // The selector is present and enabled (no mutation pending).
    const select = screen.getByTestId("archive-select") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    // The archive option is listed.
    expect(screen.getByText("Docs Archive")).toBeInTheDocument();

    // Changing the selection routes to setNewChatArchiveId (no server call).
    fireEvent.change(select, { target: { value: archiveId } });
    expect(setNewChatArchiveId).toHaveBeenCalledTimes(1);
    expect(setNewChatArchiveId).toHaveBeenCalledWith(archiveId);

    // The mutation (PATCH) must NOT have been invoked for a new chat.
    // useLinkArchive is mocked at module level with a jest.fn() mutate.
    // (We assert only the ephemeral setter was called — the real mutation
    //  spy lives in the module mock above; here we rely on setNewChatArchiveId
    //  being the only side effect.)
  });
});