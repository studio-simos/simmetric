// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppSidebarNav tests — UI revision R-6 (persistent sidebar navigation).
 *
 * Structural assertions (repo convention: no snapshots). Mirrors the
 * AppNavOverlay.test RBAC matrix: menuSections filtering, isAdmin gates,
 * enterprise lock badges, navigation on click. Also covers the persist-key
 * contract (`sidebar-nav:<groupId>`), the touch-target class below `lg`,
 * and the rail-mode icon-only rendering with title tooltips + corner locks.
 */

import "@testing-library/jest-dom";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const pushMock = jest.fn();
// Mutable pathname (mockIsMobile pattern): tests flip this to exercise the
// active-route styling without redefining window.location (jsdom forbids it).
let mockPathname = "/";
jest.mock("react-router-dom", () => ({
  useNavigate: () => pushMock,
  useLocation: () => ({ pathname: mockPathname }),
}));

// Passthrough Collapsible (same pattern as sidebar-primitives.test.tsx):
// a factory-local shared state wires the trigger's click to the
// Collapsible's onOpenChange so toggling works in jsdom.
jest.mock("@/components/ui/collapsible", () => {
  const state: { onOpenChange: ((o: boolean) => void) | null; open: boolean } = {
    onOpenChange: null,
    open: false,
  };
  return {
    Collapsible: ({
      children,
      open,
      onOpenChange,
    }: {
      children?: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => {
      state.onOpenChange = onOpenChange ?? null;
      state.open = open ?? false;
      return (
        <div data-testid="collapsible" data-open={open ? "true" : "false"}>
          {open ? children : null}
        </div>
      );
    },
    CollapsibleTrigger: ({ children, ...rest }: Record<string, unknown>) => (
      <button
        data-testid="collapsible-trigger"
        onClick={() => state.onOpenChange && state.onOpenChange(!state.open)}
        {...rest}
      >
        {children as React.ReactNode}
      </button>
    ),
    CollapsibleContent: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="collapsible-content">{children}</div>
    ),
  };
});

import AppSidebarNav from "../components/sidebar/AppSidebarNav";
import type { AppSidebarNavProps } from "../components/sidebar/AppSidebarNav";

function minimalProps(overrides: Partial<AppSidebarNavProps> = {}): AppSidebarNavProps {
  return {
    menuSections: [
      "dashboard",
      "chat",
      "documents",
      "knowledgeBase",
      "uploads",
      "workspaces",
      "widget",
      "settings",
    ],
    isAdmin: false,
    isEnterprise: false,
    primaryColor: "#4c6ef5",
    t: (key: string) => key,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  pushMock.mockClear();
  localStorage.clear();
  mockPathname = "/";
});

describe("AppSidebarNav", () => {
  it("renders the RBAC-filtered nav groups (user sees no admin items)", () => {
    render(<AppSidebarNav {...minimalProps()} />);
    expect(screen.getAllByText("sidebar.dashboard").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sidebar.chat").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sidebar.documents").length).toBeGreaterThan(0);
    // Not in menuSections → hidden
    expect(screen.queryByText("sidebar.projects")).not.toBeInTheDocument();
    expect(screen.queryByText("sidebar.eventLog")).not.toBeInTheDocument();
    expect(screen.queryByText("sidebar.sso")).not.toBeInTheDocument();
    // Group labels come from the same navModel keys
    expect(screen.getByText("sidebar.group.overview")).toBeInTheDocument();
    expect(screen.getByText("sidebar.group.knowledge")).toBeInTheDocument();
  });

  it("renders admin-only SSO when isAdmin is true", () => {
    render(
      <AppSidebarNav
        {...minimalProps({ isAdmin: true, menuSections: ["chat", "settings"] })}
      />,
    );
    expect(screen.getByText("sidebar.sso")).toBeInTheDocument();
  });

  it("renders lock badges for license-gated entries in community tier", () => {
    const { container } = render(
      <AppSidebarNav
        {...minimalProps({ menuSections: ["chat", "widget", "analytics", "eventLog"] })}
      />,
    );
    // widget + analytics + eventLog
    const locks = container.querySelectorAll("svg.lucide-lock");
    expect(locks.length).toBe(3);
  });

  it("renders no lock badges when enterprise tier is active", () => {
    const { container } = render(
      <AppSidebarNav
        {...minimalProps({
          isEnterprise: true,
          menuSections: ["chat", "widget", "analytics", "eventLog"],
        })}
      />,
    );
    expect(container.querySelectorAll("svg.lucide-lock").length).toBe(0);
  });

  it("navigates to the entry path on click (locked entries navigate too)", () => {
    render(<AppSidebarNav {...minimalProps({ menuSections: ["chat", "widget"] })} />);
    fireEvent.click(screen.getByRole("button", { name: "sidebar.widget" }));
    expect(pushMock).toHaveBeenCalledWith("/widgets");
  });

  it("persists group open state under sidebar-nav:<groupId>", () => {
    render(<AppSidebarNav {...minimalProps()} />);
    const trigger = screen.getAllByTestId("collapsible-trigger")[0]!;
    fireEvent.click(trigger);
    expect(localStorage.getItem("sidebar-nav:overview")).not.toBeNull();
  });

  it("applies the touch-target class on expanded nav rows", () => {
    render(<AppSidebarNav {...minimalProps()} />);
    const chatBtn = screen.getByRole("button", { name: "sidebar.chat" });
    expect(chatBtn.className).toContain("max-lg:min-h-[44px]");
  });

  it("marks the active route (inline primaryColor styling via SidebarItem)", () => {
    mockPathname = "/dashboard";
    try {
      render(<AppSidebarNav {...minimalProps({ menuSections: ["dashboard", "chat"] })} />);
      const dashboardBtn = screen.getByRole("button", { name: "sidebar.dashboard" });
      // Inline active style: primaryColor + "15" bg + colored text. jsdom
      // normalizes colors (#4c6ef515 → rgba(76,110,245,0.082)), so assert
      // the normalized rgba + the exact hex-derived rgb text color.
      expect(dashboardBtn.getAttribute("style")).toContain("background-color: rgba(76, 110, 245, 0.082)");
      expect(dashboardBtn.getAttribute("style")).toContain("color: rgb(76, 110, 245)");
      // Inactive item stays unstyled
      const chatBtn = screen.getByRole("button", { name: "sidebar.chat" });
      expect(chatBtn.style.backgroundColor).toBe("");
    } finally {
      mockPathname = "/";
    }
  });

  describe("rail mode (collapsed)", () => {
    it("renders icon-only items with title tooltips (labels hidden)", () => {
      render(
        <AppSidebarNav {...minimalProps({ menuSections: ["dashboard", "chat"] })} collapsed />,
      );
      const dashboardBtn = screen.getByRole("button", { name: "sidebar.dashboard" });
      expect(dashboardBtn.getAttribute("title")).toBe("sidebar.dashboard");
      expect(screen.queryByText("sidebar.group.overview")).not.toBeInTheDocument();
      expect(screen.queryByText("sidebar.dashboard")).not.toBeInTheDocument();
    });

    it("renders group icons instead of labels in rail mode", () => {
      const { container } = render(
        <AppSidebarNav {...minimalProps({ menuSections: ["dashboard", "chat"] })} collapsed />,
      );
      // Rail mode renders the group's first-entry icon inside the section
      // (the icon-only items render their own entry icons).
      expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
    });

    it("renders tiny corner locks for locked entries in rail mode", () => {
      const { container } = render(
        <AppSidebarNav
          {...minimalProps({ menuSections: ["chat", "widget", "analytics", "eventLog"] })}
          collapsed
        />,
      );
      const cornerLocks = container.querySelectorAll(".absolute svg.lucide-lock");
      expect(cornerLocks.length).toBe(3);
    });

    it("navigates from the rail (icon-only) buttons", () => {
      render(
        <AppSidebarNav {...minimalProps({ menuSections: ["chat", "widget"] })} collapsed />,
      );
      fireEvent.click(screen.getByRole("button", { name: "sidebar.widget" }));
      expect(pushMock).toHaveBeenCalledWith("/widgets");
    });
  });
});