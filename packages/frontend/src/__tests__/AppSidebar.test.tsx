// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppSidebar — uploads menu section visibility tests (Phase 71-03 Task 1),
 * updated for the UI revision R-4: the uploads item left the permanent
 * sidebar and now lives in the AppNavOverlay (same RBAC gate — "uploads" in
 * menuSections, user role has document:write, SC-1 visibility). The
 * sidebar-side test now asserts the minimal rail renders WITHOUT the nav
 * item regardless of menuSections; the overlay-side test asserts the
 * uploads item renders when the section is present.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn(), t: (key: string) => key },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const pushMock = jest.fn();
jest.mock("react-router-dom", () => ({
  useNavigate: () => pushMock,
  useLocation: () => ({ pathname: "/" }),
  MemoryRouter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The desktop nav dialog hosts the real cmdk body — jsdom has no matchMedia,
// so the mobile branch is forced (bottom Sheet renders the same nav content).
let mockIsMobile = false;
jest.mock("../hooks/use-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

// Mock the Command primitives (same passthrough pattern as AppNavOverlay.test):
// the real cmdk needs jsdom affordances (selection APIs) this file doesn't test.
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

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import AppSidebar from "../components/AppSidebar";
import AppNavOverlay from "../components/AppNavOverlay";
import type { AppNavOverlayProps } from "../components/AppNavOverlay";

// ── Helpers ──────────────────────────────────────────────────────

function renderSidebar(menuSections: string[], overrides = {}) {
  return render(
    <AppSidebar
      appName="Simmetric Chat"
      primaryColor="#4c6ef5"
      user={null}
      onMenuOpenChange={jest.fn()}
      menuOpen={false}
      onOpenUserMenu={jest.fn()}
      t={(key: string) => key}
      sidebarOpen
      setSidebarOpen={jest.fn()}
      {...overrides}
    />
  );
}

function renderOverlay(overrides: Partial<AppNavOverlayProps> = {}) {
  // Mobile branch (Sheet) — plain Radix Dialog, no cmdk internals needed.
  mockIsMobile = true;
  const props: AppNavOverlayProps = {
    open: true,
    onClose: jest.fn(),
    isEnterprise: false,
    isAdmin: false,
    menuSections: ["uploads"],
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
  return render(<AppNavOverlay {...props} />);
}

afterEach(() => {
  mockIsMobile = false;
});

// ── Tests ────────────────────────────────────────────────────────

describe("AppSidebar uploads menu section (UI revision R-5)", () => {
  it("the minimal rail renders WITHOUT the uploads nav item (moved to overlay)", () => {
    renderSidebar(["dashboard", "chat", "documents", "knowledgeBase", "workspaces", "widget", "uploads"]);
    expect(screen.queryByText("sidebar.uploads")).not.toBeInTheDocument();
  });

  it("the overlay renders the uploads item when 'uploads' is in menuSections", () => {
    renderOverlay({ menuSections: ["chat", "uploads"] });
    expect(screen.getByText("sidebar.uploads")).toBeInTheDocument();
  });

  it("the overlay does NOT render the uploads item when 'uploads' is absent", () => {
    renderOverlay({ menuSections: ["chat", "widget"] });
    expect(screen.queryByText("sidebar.uploads")).not.toBeInTheDocument();
  });
});

describe("AppSidebar inline menu toggle (UI revision R-7)", () => {
  it("clicking the footer Menu button calls onMenuOpenChange(true)", () => {
    const onMenuOpenChange = jest.fn();
    renderSidebar(["chat"], { onMenuOpenChange, menuOpen: false });
    fireEvent.click(screen.getByRole("button", { name: "nav.openMenu" }));
    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
    expect(onMenuOpenChange).toHaveBeenCalledTimes(1);
  });

  it("with the menu open, clicking the button calls onMenuOpenChange(false)", () => {
    const onMenuOpenChange = jest.fn();
    renderSidebar(["chat"], { onMenuOpenChange, menuOpen: true });
    fireEvent.click(screen.getByRole("button", { name: "nav.closeMenu" }));
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  it("the nav region is completely unmounted when menuOpen is false", () => {
    renderSidebar(["chat"], {
      menuOpen: false,
      nav: <div data-testid="inline-nav">nav</div>,
    });
    expect(screen.queryByTestId("inline-nav")).not.toBeInTheDocument();
  });

  it("the nav region renders between the body and the footer when menuOpen is true", () => {
    renderSidebar(["chat"], {
      menuOpen: true,
      nav: <div data-testid="inline-nav">nav</div>,
    });
    expect(screen.getByTestId("inline-nav")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "nav.closeMenu" })).toBeInTheDocument();
  });

  it("opening the menu from the collapsed rail expands the sidebar (one click, no dead end)", () => {
    const setSidebarOpen = jest.fn();
    renderSidebar(["chat"], {
      menuOpen: true,
      sidebarOpen: false,
      isMobile: false,
      setSidebarOpen,
    });
    expect(setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it("closing the menu never force-collapses the sidebar", () => {
    const setSidebarOpen = jest.fn();
    renderSidebar(["chat"], {
      menuOpen: false,
      sidebarOpen: true,
      isMobile: false,
      setSidebarOpen,
    });
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});