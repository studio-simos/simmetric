// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * UserMenuDialog tests — R-5.1 rail reorder + mobile drawer.
 *
 * Covers the two invariants of the R-5.1 revision:
 *  1. Desktop: the left rail lists language, theme AND settings — settings
 *     below language/theme (the R-5.1 reorder), and selecting it navigates
 *     to /settings and closes the dialog.
 *  2. Mobile (<768px): the rail surfaces as a left Sheet drawer with an
 *     open/close toggle (top-bar PanelLeftOpen → drawer → header X),
 *     mirroring SettingsPage's mobile master/detail drawer.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock("../i18n", () => ({
  getEnabledLanguages: () => ["en", "it"],
  ALL_LANGUAGES: [
    { code: "en", name: "English" },
    { code: "it", name: "Italiano" },
  ],
}));

jest.mock("../queries/useAuth", () => ({
  useMe: () => ({ data: { permissions: ["admin:settings"] } }),
}));

jest.mock("../queries/useLicense", () => ({
  useLicenseInfo: () => ({ data: { tier: "community" } }),
}));

jest.mock("../contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "light", setTheme: jest.fn() }),
}));

// ThemeToggle exports themeLabels (plain map); stub the module so the map
// stays available without pulling the real ThemeContext-driven component.
jest.mock("../components/ThemeToggle", () => ({
  themeLabels: { light: "Pearl", dark: "Dark", hacker: "Hacker", system: "System" },
}));

let mockIsMobile = false;
jest.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

jest.mock("@/components/ui/dialog", () => {
  const PassthroughDialog = ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null;
  const PassthroughContent = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return { Dialog: PassthroughDialog, DialogContent: PassthroughContent };
});

jest.mock("@/components/ui/sheet", () => {
  const PassthroughSheet = ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="sheet">{children}</div> : null;
  const PassthroughContent = ({ children, side }: { children?: React.ReactNode; side?: string }) => (
    <div data-side={side}>{children}</div>
  );
  const PassthroughTitle = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return { Sheet: PassthroughSheet, SheetContent: PassthroughContent, SheetTitle: PassthroughTitle };
});

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, fireEvent, within } from "@testing-library/react";
import UserMenuDialog from "../components/ui/UserMenuDialog";
import type { UserMenuDialogProps } from "../components/ui/UserMenuDialog";

// ── Helpers ──────────────────────────────────────────────────────

const baseProps: UserMenuDialogProps = {
  open: true,
  onOpenChange: jest.fn(),
  user: { username: "admin", firstName: "Ada", lastName: "Lovelace" },
  onLogout: jest.fn(),
};

function railItems(): string[] {
  const menu = screen.getByRole("menu", { name: "topbar.userMenu" });
  // The left rail is the first column of the menu — its menuitem buttons
  // are language, theme and (since R-5.1) settings.
  const rail = menu.firstElementChild as HTMLElement;
  return Array.from(rail.querySelectorAll<HTMLElement>("[role='menuitem']")).map(
    (el) => el.textContent ?? "",
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe("UserMenuDialog (desktop)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile = false;
  });

  it("lists the rail destinations in order: language, theme, settings", () => {
    render(<UserMenuDialog {...baseProps} />);

    // R-5.1 invariant: settings sits BELOW the language and theme entries.
    expect(railItems()).toEqual([
      "user-dropdown.language",
      "user-dropdown.theme",
      "menu.settings",
    ]);
  });

  it("navigates to /settings and closes the dialog when the settings entry is pressed", () => {
    render(<UserMenuDialog {...baseProps} />);

    fireEvent.click(screen.getByRole("menuitem", { name: "menu.settings" }));

    expect(mockNavigate).toHaveBeenCalledWith("/settings");
    expect(baseProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens the language panel from the rail and marks the active language", () => {
    render(<UserMenuDialog {...baseProps} />);

    fireEvent.click(screen.getByRole("menuitem", { name: "user-dropdown.language" }));

    expect(screen.getByRole("menuitem", { name: /English/ })).toHaveClass("bg-accent");
    expect(screen.getByRole("menuitem", { name: /Italiano/ })).toBeInTheDocument();
  });
});

describe("UserMenuDialog (mobile)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile = true;
  });

  it("starts with the rail drawer closed and a top-bar open toggle", () => {
    render(<UserMenuDialog {...baseProps} />);

    // The drawer is a left Sheet, initially closed.
    expect(screen.queryByTestId("sheet")).not.toBeInTheDocument();
    // The pane top bar carries the drawer trigger (same pattern as
    // SettingsPage's mobile drawer toggle).
    expect(
      screen.getByRole("button", { name: "user-dropdown.openMenu" }),
    ).toBeInTheDocument();
  });

  it("opens the drawer from the top-bar toggle and closes it from the header X", () => {
    render(<UserMenuDialog {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "user-dropdown.openMenu" }));
    const drawer = screen.getByTestId("sheet");
    expect(drawer.querySelector("[data-side='left']")).toBeInTheDocument();

    // The rail inside the drawer keeps the R-5.1 order.
    const rail = Array.from(
      drawer.querySelectorAll<HTMLElement>("[role='menuitem']"),
    ).map((el) => el.textContent ?? "");
    expect(rail).toEqual([
      "user-dropdown.language",
      "user-dropdown.theme",
      "menu.settings",
    ]);

    // Header X closes the drawer.
    fireEvent.click(within(drawer as HTMLElement).getByRole("button", { name: "user-dropdown.closeMenu" }));
    expect(screen.queryByTestId("sheet")).not.toBeInTheDocument();
  });

  it("selects a rail destination from the drawer: panel opens and the drawer closes", () => {
    render(<UserMenuDialog {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "user-dropdown.openMenu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "user-dropdown.theme" }));

    // The theme panel content is now visible in the main pane…
    expect(screen.getByRole("menuitem", { name: /Pearl/ })).toBeInTheDocument();
    // …and the drawer closed to reveal it (SettingsPage drawer behavior).
    expect(screen.queryByTestId("sheet")).not.toBeInTheDocument();
  });

  it("navigates to /settings from the drawer's settings entry", () => {
    render(<UserMenuDialog {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "user-dropdown.openMenu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "menu.settings" }));

    expect(mockNavigate).toHaveBeenCalledWith("/settings");
    expect(baseProps.onOpenChange).toHaveBeenCalledWith(false);
  });
});