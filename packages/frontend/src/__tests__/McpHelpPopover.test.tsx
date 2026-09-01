// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * McpHelpPopover component tests — Phase 75 MCP-01 (D-01/D-02/D-04/D-07).
 *
 * Automates the UAT item "McpHelpPopover visual rendering + dynamic state"
 * (75-HUMAN-UAT.md test 1). Covers: 4 concept sections + live-status badges +
 * conditional fallback warning + display-only pins fetch + refetch-on-chat-change
 * (WR-03 fix) + deep-link tooltip i18n (WR-01) + i18n parity across 7 locales.
 *
 * The Popover wrapper is mocked as a controlled-by-`open` surface so content
 * rendering is deterministic in jsdom (independent of Radix pointer-event
 * internals). The trigger button stays always-rendered so `disabled` + tooltip
 * assertions are testable. The Tooltip wrapper is stubbed to passthrough.
 */
import { fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import McpHelpPopover from "../components/McpHelpPopover";
import type { McpConnection } from "../queries/useMcpConnections";

// --- Mocks --------------------------------------------------------------

// i18n: return the key (proves no hardcoded English) + interpolate count so
// live-status badges carry the dynamic number.
const t = jest.fn((key: string, opts?: { count?: number }) => {
  if (opts && typeof opts.count === "number") return `${key}:${opts.count}`;
  return key;
});
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockUseChatNav = jest.fn();
jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => mockUseChatNav(),
}));

const mockUseMcpConnections = jest.fn();
jest.mock("../queries/useMcpConnections", () => ({
  useMcpConnections: () => mockUseMcpConnections(),
}));

// api: only apiGet is used (pins fetch). Spy on the others to prove display-only.
const apiGet = jest.fn();
const apiPost = jest.fn();
const apiPut = jest.fn();
const apiDelete = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPut: (...a: unknown[]) => apiPut(...a),
  apiDelete: (...a: unknown[]) => apiDelete(...a),
}));

// Controlled Popover: trigger always rendered + click propagates onOpenChange
// (mirrors Radix wiring); content rendered only when open. Uses context so the
// trigger can call onOpenChange and the content can read open.
jest.mock("@/components/ui/popover", () => {
  const { createContext, useContext } = require("react");
  const Ctx = createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {},
  });
  const Popover = ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (o: boolean) => void;
  }) => (
    <Ctx.Provider value={{ open, setOpen: onOpenChange }}>
      <div data-testid="popover" data-open={open ? "true" : "false"}>
        {children}
      </div>
    </Ctx.Provider>
  );
  const PopoverTrigger = ({ children }: { children: React.ReactNode }) => {
    const { setOpen } = useContext(Ctx);
    return (
      <span data-testid="popover-trigger" onClick={() => setOpen(true)}>
        {children}
      </span>
    );
  };
  const PopoverContent = ({ children }: { children: React.ReactNode }) => {
    const { open } = useContext(Ctx);
    return open ? <div data-testid="popover-content">{children}</div> : null;
  };
  return { Popover, PopoverTrigger, PopoverContent };
});

// Tooltip passthrough (no TooltipProvider in jsdom — avoid Radix noise).
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

// --- Helpers ------------------------------------------------------------

function makeConn(over: Partial<McpConnection> = {}): McpConnection {
  return {
    id: "conn-1",
    name: "Test MCP",
    url: "http://x",
    transportType: "sse",
    projectId: null,
    workspaceId: "ws-1",
    headers: {},
    enabled: true,
    lastSyncAt: null,
    createdAt: "",
    updatedAt: "",
    liveStatus: "connected",
    toolCount: 4,
    ...over,
  };
}

function setup({
  disabled = false,
  chatId = "chat-A",
  workspaceId = "ws-1",
  connections = [makeConn()],
  pins = [{ id: "pin-1", connectionId: "conn-1" }],
}: {
  disabled?: boolean;
  chatId?: string | null;
  workspaceId?: string | null;
  connections?: McpConnection[];
  pins?: Array<{ id: string; connectionId: string }> | null;
} = {}) {
  mockUseChatNav.mockReturnValue({ currentChatId: chatId, currentWorkspaceId: workspaceId });
  mockUseMcpConnections.mockReturnValue({ data: connections });
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiDelete.mockReset();
  if (pins === null) {
    apiGet.mockRejectedValueOnce(new Error("no pins"));
  } else {
    apiGet.mockResolvedValue(pins);
  }
  t.mockClear();
  mockNavigate.mockReset();

  const utils = renderWithProviders(<McpHelpPopover disabled={disabled} />);
  return utils;
}

// Force-open the popover by clicking the trigger button (aria-label = title key).
async function openPopover() {
  const trigger = document.querySelector(
    'button[aria-label="mcpHelp.title"]',
  ) as HTMLButtonElement;
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger);
  // handleOpenChange sets open=true; wait for content to mount.
  await waitFor(() => {
    expect(document.querySelector('[data-testid="popover-content"]')).not.toBeNull();
  });
  return document.querySelector('[data-testid="popover-content"]') as HTMLElement;
}

// --- Tests --------------------------------------------------------------

describe("McpHelpPopover", () => {
  afterEach(() => jest.clearAllMocks());

  it("renders title + 4 concept sections + live-status + troubleshooting + deep-link when open", async () => {
    setup();
    const content = await openPopover();

    // Header title
    expect(within(content).getByText("mcpHelp.title")).toBeInTheDocument();

    // 4 concept labels + bodies
    const labels = [
      "mcpHelp.concept.entry",
      "mcpHelp.concept.pinning",
      "mcpHelp.concept.skillResolution",
      "mcpHelp.concept.toolUse",
    ];
    const bodies = [
      "mcpHelp.concept.entryBody",
      "mcpHelp.concept.pinningBody",
      "mcpHelp.concept.skillResolutionBody",
      "mcpHelp.concept.toolUseBody",
    ];
    for (const k of [...labels, ...bodies]) {
      expect(within(content).getByText(k)).toBeInTheDocument();
    }

    // Troubleshooting
    expect(within(content).getByText("mcpHelp.troubleshooting.title")).toBeInTheDocument();
    expect(within(content).getByText("mcpHelp.troubleshooting.toolMissing")).toBeInTheDocument();
    expect(
      within(content).getByText("mcpHelp.troubleshooting.seeMarketplaceDoc"),
    ).toBeInTheDocument();

    // Footer deep-link
    expect(within(content).getByText("mcpHelp.deepLinkLabel")).toBeInTheDocument();
    expect(within(content).getByText("mcpHelp.deepLink")).toBeInTheDocument();
  });

  it("disables trigger when the disabled prop is set (parent derives it from !currentChatId) and surfaces disabledTooltip", () => {
    setup({ disabled: true, chatId: null });
    const trigger = document.querySelector(
      'button[aria-label="mcpHelp.title"]',
    ) as HTMLButtonElement;
    expect(trigger).toBeDisabled();

    // Tooltip content reflects disabled copy (tooltip always rendered by mock).
    const tooltip = document.querySelector('[data-testid="tooltip-content"]');
    expect(tooltip?.textContent).toBe("mcpHelp.disabledTooltip");
  });

  it("shows live-status counters (pinned, tools available) when workspaceConns > 0", async () => {
    setup({
      connections: [
        makeConn({ id: "conn-1", toolCount: 3 }),
        makeConn({ id: "conn-2", toolCount: 5 }),
      ],
      pins: [
        { id: "p1", connectionId: "conn-1" },
        { id: "p2", connectionId: "conn-2" },
      ],
    });
    const content = await openPopover();

    // 2 pinned, 8 tools (3+5), both active (enabled + connected + workspace match).
    expect(within(content).getByText("mcpHelp.liveStatus.pinned:2")).toBeInTheDocument();
    expect(within(content).getByText("mcpHelp.liveStatus.toolsAvailable:8")).toBeInTheDocument();
  });

  it("shows empty live state when workspaceConns is empty", async () => {
    // Connection in a different workspace → workspaceConns filter yields 0.
    setup({ connections: [makeConn({ workspaceId: "ws-other" })], pins: [] });
    const content = await openPopover();
    expect(within(content).getByText("mcpHelp.liveStatus.empty")).toBeInTheDocument();
    // Counters absent.
    expect(within(content).queryByText(/mcpHelp\.liveStatus\.pinned/)).not.toBeInTheDocument();
  });

  it("renders fallback warning only when all pinned connections are disabled or out-of-scope", async () => {
    // Case 1: pinned but disabled → allPinnedDisabled true → warning shown.
    const { rerender } = setup({
      connections: [makeConn({ id: "conn-1", enabled: false })],
      pins: [{ id: "p1", connectionId: "conn-1" }],
    });
    let content = await openPopover();
    expect(within(content).getByText("mcpHelp.fallbackWarning")).toBeInTheDocument();

    // Case 2: pinned + enabled + connected → no warning.
    apiGet.mockResolvedValue([{ id: "p1", connectionId: "conn-1" }]);
    mockUseMcpConnections.mockReturnValue({
      data: [makeConn({ id: "conn-1", enabled: true, liveStatus: "connected" })],
    });
    rerender(<McpHelpPopover disabled={false} />);
    await waitFor(() => {
      const c = document.querySelector('[data-testid="popover-content"]');
      expect(c).not.toBeNull();
    });
    content = document.querySelector('[data-testid="popover-content"]') as HTMLElement;
    expect(within(content).queryByText("mcpHelp.fallbackWarning")).not.toBeInTheDocument();

    // Case 3: nothing pinned (pinnedCount=0) → no warning.
    apiGet.mockResolvedValue([]);
    rerender(<McpHelpPopover disabled={false} />);
    await waitFor(() => {
      const c = document.querySelector('[data-testid="popover-content"]');
      expect(c).not.toBeNull();
    });
    content = document.querySelector('[data-testid="popover-content"]') as HTMLElement;
    expect(within(content).queryByText("mcpHelp.fallbackWarning")).not.toBeInTheDocument();
  });

  it("fetches /chats/:id/pins on open (display-only, no mutation calls)", async () => {
    setup({ chatId: "chat-A" });
    await openPopover();

    expect(apiGet).toHaveBeenCalledWith("/chats/chat-A/pins");
    // Display-only: no mutation endpoints invoked.
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPut).not.toHaveBeenCalled();
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it("refetches pins when the active chat changes while open (WR-03 fix)", async () => {
    const { rerender } = setup({ chatId: "chat-A" });
    await openPopover();

    // Initial open fetches chat-A pins.
    expect(apiGet).toHaveBeenCalledWith("/chats/chat-A/pins");

    // Simulate switching to a different chat while the popover stays open.
    apiGet.mockResolvedValue([{ id: "p1", connectionId: "conn-1" }]);
    mockUseChatNav.mockReturnValue({ currentChatId: "chat-B", currentWorkspaceId: "ws-1" });
    rerender(<McpHelpPopover disabled={false} />);

    // The useEffect on [open, fetchPins] refetches with the new chat id.
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith("/chats/chat-B/pins");
    });
  });

  it("navigates to /mcp-marketplace from both the troubleshooting link and the footer deep-link", async () => {
    setup();
    const content = await openPopover();

    // Troubleshooting "see marketplace" button.
    fireEvent.click(within(content).getByText("mcpHelp.troubleshooting.seeMarketplaceDoc"));
    expect(mockNavigate).toHaveBeenCalledWith("/mcp-marketplace");

    // Footer deep-link button.
    fireEvent.click(within(content).getByText("mcpHelp.deepLink"));
    expect(mockNavigate).toHaveBeenLastCalledWith("/mcp-marketplace");
  });

  it("uses the i18n deepLinkTooltip (WR-01: not a hardcoded English string)", async () => {
    setup();
    await openPopover();
    // The footer Button title attribute must come from t() (WR-01/WR-02 fix).
    expect(t).toHaveBeenCalledWith("mcpHelp.deepLinkTooltip");
  });

  it("resolves workspace connections by currentWorkspaceId (no cross-workspace leak in tool count)", async () => {
    setup({
      workspaceId: "ws-1",
      connections: [
        makeConn({ id: "conn-1", workspaceId: "ws-1", toolCount: 2 }),
        makeConn({ id: "conn-2", workspaceId: "ws-other", toolCount: 99 }),
      ],
      pins: [
        { id: "p1", connectionId: "conn-1" },
        { id: "p2", connectionId: "conn-2" },
      ],
    });
    const content = await openPopover();
    // pinnedCount = total pins for the chat (2, both connectionIds are pinned);
    // toolCount is workspace-filtered → conn-2 (ws-other) is excluded, tools = 2.
    expect(within(content).getByText("mcpHelp.liveStatus.pinned:2")).toBeInTheDocument();
    expect(within(content).getByText("mcpHelp.liveStatus.toolsAvailable:2")).toBeInTheDocument();
  });
});

// --- i18n parity across 8 locales (UAT: strings render in active locale) ---

describe("McpHelpPopover i18n parity (8 locales)", () => {
  const LOCALES = ["en", "it", "ru", "de", "es", "fr", "zh", "pt"] as const;
  const REQUIRED_KEYS = [
    "title",
    "disabledTooltip",
    "fallbackWarning",
    "deepLinkLabel",
    "deepLink",
    "deepLinkTooltip",
    "concept.entry",
    "concept.entryBody",
    "concept.pinning",
    "concept.pinningBody",
    "concept.skillResolution",
    "concept.skillResolutionBody",
    "concept.toolUse",
    "concept.toolUseBody",
    "liveStatus.pinned",
    "liveStatus.toolsAvailable",
    "liveStatus.empty",
    "troubleshooting.title",
    "troubleshooting.toolMissing",
    "troubleshooting.seeMarketplaceDoc",
  ];

  function getPath(obj: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((acc, k) => {
      if (acc && typeof acc === "object" && k in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[k];
      }
      return undefined;
    }, obj);
  }

  for (const locale of LOCALES) {
    it(`locale '${locale}' defines all mcpHelp keys`, () => {
      const dict = require(`../i18n/${locale}/translation.json`);
      const mcpHelp = dict.mcpHelp;
      expect(mcpHelp).toBeDefined();
      for (const key of REQUIRED_KEYS) {
        const val = getPath(mcpHelp, key);
        expect(val).toBeDefined();
        expect(typeof val).toBe("string");
        expect((val as string).length).toBeGreaterThan(0);
      }
    });
  }
});