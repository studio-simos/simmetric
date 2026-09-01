// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * McpPinnerPopover tests — per-chat MCP pinning.
 *
 * jsdom environment. The popover's Radix trigger renders via createPortal,
 * so assertions target the portal content (screen queries are portal-aware).
 * The popover is opened with a fireEvent.click on the trigger button.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("react-router-dom", () => ({
  useNavigate: () => jest.fn(),
}));

const mockUseChatNav = jest.fn();
jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => mockUseChatNav(),
}));

const mockUseMcpConnections = jest.fn();
jest.mock("../queries/useMcpConnections", () => ({
  useMcpConnections: () => mockUseMcpConnections(),
}));

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiDelete = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
  apiDelete: (...args: unknown[]) => mockApiDelete(...args),
}));

const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();
jest.mock("../lib/toast", () => ({
  showError: (...args: unknown[]) => mockShowError(...args),
  showSuccess: (...args: unknown[]) => mockShowSuccess(...args),
}));

import McpPinnerPopover from "../components/McpPinnerPopover";

const WS_ID = "ws-1";
const CONN_WS = {
  id: "c-ws",
  name: "Scoped-WS",
  url: "u1",
  transportType: "sse",
  projectId: null,
  workspaceId: WS_ID,
  headers: {},
  enabled: true,
  lastSyncAt: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  liveStatus: "connected",
  toolCount: 3,
};
const CONN_GLOBAL = {
  id: "c-global",
  name: "Global-Conn",
  url: "u2",
  transportType: "sse",
  projectId: null,
  workspaceId: null,
  headers: {},
  enabled: true,
  lastSyncAt: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  liveStatus: "disconnected",
  toolCount: 0,
};
const CONN_PROJECT = {
  id: "c-proj",
  name: "Project-Conn",
  url: "u3",
  transportType: "sse",
  projectId: "proj-1",
  workspaceId: null,
  headers: {},
  enabled: true,
  lastSyncAt: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  liveStatus: "connected",
  toolCount: 1,
};
const CONN_OTHER_WS = {
  id: "c-other",
  name: "Other-WS",
  url: "u4",
  transportType: "sse",
  projectId: null,
  workspaceId: "ws-2",
  headers: {},
  enabled: true,
  lastSyncAt: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  liveStatus: "connected",
  toolCount: 1,
};

function setup(chatId: string | null, connections: unknown[], disabled: boolean = !chatId) {
  mockUseChatNav.mockReturnValue({ currentChatId: chatId, currentWorkspaceId: WS_ID });
  mockUseMcpConnections.mockReturnValue({ data: connections });
  mockApiGet.mockResolvedValue([]);
  return render(<TooltipProvider><McpPinnerPopover disabled={disabled} /></TooltipProvider>);

}

async function openPopover() {
  const trigger = screen.getByRole("button", { name: "mcpPinner.title" });
  fireEvent.click(trigger);
}

describe("McpPinnerPopover — connection scoping", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it("is disabled only without a workspace (RightPanel passes !currentWorkspaceId)", () => {
    setup(null, [], true);
    expect(screen.getByRole("button", { name: "mcpPinner.title" })).toBeDisabled();
  });

  it("is enabled without a chat but with a workspace (staging allowed)", () => {
    setup(null, [], false);
    expect(screen.getByRole("button", { name: "mcpPinner.title" })).toBeEnabled();
  });

  it("is enabled when a chat is active", () => {
    setup("chat-1", []);
    expect(screen.getByRole("button", { name: "mcpPinner.title" })).toBeEnabled();
  });

  it("lists workspace-scoped AND global connections, excludes project-scoped and other-workspace", async () => {
    setup("chat-1", [CONN_WS, CONN_GLOBAL, CONN_PROJECT, CONN_OTHER_WS]);
    await openPopover();

    expect(await screen.findByText("Scoped-WS")).toBeInTheDocument();
    expect(screen.getByText("Global-Conn")).toBeInTheDocument();
    // Project-scoped connections are not pinnable from a workspace chat (D-14).
    expect(screen.queryByText("Project-Conn")).not.toBeInTheDocument();
    expect(screen.queryByText("Other-WS")).not.toBeInTheDocument();
  });

  it("shows the global badge on global connections", async () => {
    setup("chat-1", [CONN_GLOBAL]);
    await openPopover();

    expect(await screen.findByText("Global-Conn")).toBeInTheDocument();
    expect(screen.getByText("mcpPinner.globalBadge")).toBeInTheDocument();
  });

  it("pins a connection when the switch is toggled (POST /chats/:id/pins)", async () => {
    setup("chat-1", [CONN_WS]);
    mockApiPost.mockResolvedValue({ id: "pin-1" });
    await openPopover();

    const sw = await screen.findByRole("switch", { name: "mcpPinner.pinToggle" });
    fireEvent.click(sw);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith("/chats/chat-1/pins", { connectionId: "c-ws" });
    });
  });
});

describe("McpPinnerPopover — staging on new chats (no chat id)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it("stages a pin without a chat (no POST), shows it in the counter", async () => {
    setup(null, [CONN_WS], false);
    await openPopover();

    const sw = await screen.findByRole("switch", { name: "mcpPinner.pinToggle" });
    fireEvent.click(sw);

    expect(mockApiPost).not.toHaveBeenCalled();
    // Counter badge shows the staged pin.
    await waitFor(() => {
      expect(screen.getByText("1")).toBeInTheDocument();
    });
  });

  it("un-stages a pinned connection on second toggle", async () => {
    setup(null, [CONN_WS], false);
    await openPopover();

    const sw = await screen.findByRole("switch", { name: "mcpPinner.pinToggle" });
    fireEvent.click(sw);
    fireEvent.click(sw);

    expect(mockApiPost).not.toHaveBeenCalled();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("flushes staged pins when a chat becomes active", async () => {
    const { rerender } = setup(null, [CONN_WS], false);
    await openPopover();

    const sw = await screen.findByRole("switch", { name: "mcpPinner.pinToggle" });
    fireEvent.click(sw);
    expect(mockApiPost).not.toHaveBeenCalled();

    // Simulate the chat being created (first message) — ChatContext syncs the id.
    mockUseChatNav.mockReturnValue({ currentChatId: "chat-9", currentWorkspaceId: WS_ID });
    mockApiPost.mockResolvedValue({ id: "pin-9" });
    rerender(<TooltipProvider><McpPinnerPopover disabled={false} /></TooltipProvider>);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith("/chats/chat-9/pins", { connectionId: "c-ws" });
    });
  });
});
