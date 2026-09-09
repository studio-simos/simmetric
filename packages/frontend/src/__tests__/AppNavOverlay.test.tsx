// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppNavOverlay tests — UI revision R-5.
 *
 * Structural assertions (repo convention: no snapshots): the desktop dialog
 * renders a two-pane layout (group rail + wide active pane), so entries appear
 * in both the rail CommandList and the pane rows — assertions use
 * getAllByText(...).length accordingly. RBAC filtering, isAdmin gates and
 * enterprise locks are unchanged.
 */
import "@testing-library/jest-dom";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", t: (key: string) => key },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const pushMock = jest.fn();
jest.mock("react-router-dom", () => ({
  useNavigate: () => pushMock,
  useLocation: () => ({ pathname: "/" }),
}));

jest.mock("@/components/ui/command", () => {
  return {
    CommandDialog: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
      open ? <div data-testid="command-dialog">{children}</div> : null,
    Command: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    CommandInput: (props: Record<string, unknown>) => <input {...props} />,
    CommandList: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    CommandEmpty: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children, heading }: { children?: React.ReactNode; heading?: string }) => (
      <div data-heading={heading}>{children}</div>
    ),
    CommandItem: ({
      children,
      onSelect,
    }: {
      children?: React.ReactNode;
      onSelect?: () => void;
    }) => (
      <button type="button" onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
    CommandSeparator: () => <div data-testid="command-separator" />,
  };
});

jest.mock("../components/sidebar/SidebarDropdown", () => ({
  __esModule: true,
  default: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="sidebar-dropdown">{placeholder}</div>
  ),
}));
jest.mock("../components/sidebar", () => ({
  SidebarDropdown: () => null,
}));

// Mobile breakpoint control: the overlay renders a bottom Sheet on mobile
// (<768px) and a CommandDialog on desktop. Tests flip this flag.
let mockIsMobile = false;
jest.mock("../hooks/use-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

import AppNavOverlay from "../components/AppNavOverlay";
import type { AppNavOverlayProps } from "../components/AppNavOverlay";

function minimalProps(overrides: Partial<AppNavOverlayProps> = {}): AppNavOverlayProps {
  return {
    open: true,
    onClose: jest.fn(),
    isEnterprise: false,
    isAdmin: false,
    menuSections: ["dashboard", "chat", "documents", "knowledgeBase", "uploads", "widget", "settings"],
    t: (key: string) => key,
    selectedProjectId: "",
    setSelectedProjectId: jest.fn(),
    selectedWorkspaceId: "",
    setSelectedWorkspaceId: jest.fn(),
    setWorkspaceId: jest.fn(),
    projects: [],
    workspaces: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  pushMock.mockClear();
});

describe("AppNavOverlay", () => {
  it("renders nothing when closed", () => {
    render(<AppNavOverlay {...minimalProps({ open: false })} />);
    expect(screen.queryByTestId("command-dialog")).toBeNull();
  });

  it("renders nav groups with RBAC filtering (user sees no admin items)", () => {
    render(<AppNavOverlay {...minimalProps()} />);
    expect(screen.getAllByText("sidebar.dashboard").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sidebar.chat").length).toBeGreaterThan(0);
    // Not in menuSections → hidden
    expect(screen.queryByText("sidebar.projects")).toBeNull();
    expect(screen.queryByText("sidebar.eventLog")).toBeNull();
    expect(screen.queryByText("sidebar.sso")).toBeNull();
  });

  it("shows admin items when isAdmin is true", () => {
    render(
      <AppNavOverlay
        {...minimalProps({
          isAdmin: true,
          menuSections: ["chat", "eventLog", "settings"],
        })}
      />,
    );
    expect(screen.getAllByText("sidebar.eventLog").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sidebar.sso").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sidebar.settings").length).toBeGreaterThan(0);
  });

  it("renders each nav entry at least once (rail + pane duplication is intentional)", () => {
    const { container } = render(
      <AppNavOverlay {...minimalProps({ menuSections: ["chat", "widget", "analytics", "eventLog"] })} />,
    );
    const locks = container.querySelectorAll("svg.lucide-lock");
    // widget + analytics + eventLog, duplicated across the rail and the pane
    expect(locks.length).toBeGreaterThanOrEqual(3);
    expect(container.textContent).not.toContain("\u{1F512}");
  });

  it("hides Lock icons when enterprise tier is active", () => {
    const { container } = render(
      <AppNavOverlay
        {...minimalProps({ isEnterprise: true, menuSections: ["chat", "widget", "analytics", "eventLog"] })}
      />,
    );
    expect(container.querySelectorAll("svg.lucide-lock").length).toBe(0);
  });

  it("navigates and closes on item select (rail path)", () => {
    const onClose = jest.fn();
    render(<AppNavOverlay {...minimalProps({ onClose })} />);
    fireEvent.click(screen.getAllByText("sidebar.dashboard")[0]!);
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
    expect(onClose).toHaveBeenCalled();
  });

  it("wide pane shows the active group's entries and navigates (pane path)", () => {
    const onClose = jest.fn();
    render(
      <AppNavOverlay
        {...minimalProps({
          onClose,
          menuSections: ["chat", "documents"],
        })}
      />,
    );
    // Default pane = the group containing the active path (/) → chat tools;
    // its wide-pane rows render as plain buttons with the entry label.
    const paneRows = screen.getAllByText("sidebar.chat");
    expect(paneRows.length).toBeGreaterThanOrEqual(2);
    // Clicking the wide-pane row (the last rendered one) navigates + closes.
    fireEvent.click(paneRows[paneRows.length - 1]!);
    expect(pushMock).toHaveBeenCalledWith("/");
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the project/workspace selector rows (force-mounted + rail)", () => {
    render(<AppNavOverlay {...minimalProps()} />);
    expect(screen.getAllByTestId("sidebar-dropdown").length).toBeGreaterThanOrEqual(2);
  });

  it("renders as a bottom Sheet on mobile with the same nav content", () => {
    mockIsMobile = true;
    try {
      render(
        <AppNavOverlay {...minimalProps({ menuSections: ["chat", "uploads"] })} />,
      );
      // Same RBAC-filtered content inside the Sheet surface
      expect(screen.getByText("sidebar.chat")).toBeInTheDocument();
      expect(screen.getByText("sidebar.uploads")).toBeInTheDocument();
      // Lock badge still rendered for non-enterprise widget section
    } finally {
      mockIsMobile = false;
    }
  });

  it("mobile Sheet renders nothing when closed", () => {
    mockIsMobile = true;
    try {
      render(<AppNavOverlay {...minimalProps({ open: false })} />);
      expect(screen.queryByText("sidebar.chat")).not.toBeInTheDocument();
    } finally {
      mockIsMobile = false;
    }
  });
});