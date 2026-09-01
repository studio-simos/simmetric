// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * UserDropdown unit tests — Feature 7.4 Slice A (quick task 260714-phg).
 *
 * The UserDropdown is a self-contained TopBar menu that renders: avatar/
 * initials trigger, username + role badge, Language sub-menu, Theme sub-menu,
 * Links (Settings only — Analytics/Admin links removed; both reachable via the
 * sidebar), footer (license tier in primary color + app version), and Sign
 * Out. The Admin link was removed in Feature 8.4 (it duplicated Settings —
 * both navigated to /settings); admin stays reachable via the sidebar /sso
 * link. The role badge still reflects isAdmin.
 *
 * We mock the Radix DropdownMenu wrapper as an inline passthrough (same pattern
 * as TopBar.test.tsx) so the items are always visible and clickable without
 * jsdom pointer-event gymnastics. The auth/license/theme/i18n hooks are stubbed
 * per-case so we can exercise the conditional rendering paths.
 *
 * Repo convention: NO snapshots — only structural + text assertions.
 */
import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../../../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// Mock react-i18next: t returns the key verbatim so label keys are assertable.
// A shared i18n object (with a jest.fn changeLanguage) lets us assert the
// language-switch click path invoked i18n.changeLanguage with the right code.
const mockChangeLanguage = jest.fn();
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, d?: unknown) => (typeof d === "string" ? d : key),
    i18n: { language: "en", changeLanguage: mockChangeLanguage },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

// Mock ThemeContext — UserDropdown calls useTheme() from @/contexts/ThemeContext.
const mockSetTheme = jest.fn();
jest.mock("@/contexts/ThemeContext", () => ({
  useTheme: () => ({
    theme: "light",
    resolvedTheme: "light",
    setTheme: mockSetTheme,
  }),
}));

// Mock getEnabledLanguages + ALL_LANGUAGES — UserDropdown imports from @/i18n.
jest.mock("@/i18n", () => ({
  getEnabledLanguages: () => ["en", "it", "ru"],
  ALL_LANGUAGES: [
    { code: "en", name: "English" },
    { code: "it", name: "Italiano" },
    { code: "ru", name: "Русский" },
  ],
}));

// Mock themeLabels — UserDropdown imports from ../ThemeToggle.
jest.mock("@/components/ThemeToggle", () => ({
  themeLabels: { light: "Light", dark: "Dark", hacker: "Hacker", system: "System" },
}));

// Mock the auth hooks UserDropdown calls internally.
const mockUseMe = jest.fn();
const mockUseMenuSections = jest.fn();
jest.mock("@/queries/useAuth", () => ({
  useMe: () => mockUseMe(),
  useMenuSections: () => mockUseMenuSections(),
}));

// Mock the license hook.
const mockUseLicenseInfo = jest.fn();
jest.mock("@/queries/useLicense", () => ({
  useLicenseInfo: () => mockUseLicenseInfo(),
}));

// Mock the Radix DropdownMenu wrapper to render inline (same pattern as
// TopBar.test.tsx). Sub-menus render their content inline too so we can click
// the Language/Theme items directly without Radix open/close plumbing.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: ChildrenOnlyProps) => <div data-testid="dropdown-root">{children}</div>,
  DropdownMenuTrigger: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  DropdownMenuContent: ({ children }: ChildrenOnlyProps) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({ children, onClick, className }: { children?: ReactNode; onClick?: (e: unknown) => void; className?: string }) => (
    <button type="button" onClick={onClick} className={className}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: ChildrenOnlyProps) => <div data-testid="dropdown-sub">{children}</div>,
  DropdownMenuSubTrigger: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
}));

import UserDropdown from "../UserDropdown";

const baseUser = {
  username: "alice",
  firstName: "Alice",
  lastName: "Wonder",
  avatar: null,
};

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  mockUseMe.mockReset();
  mockUseMenuSections.mockReset();
  mockUseLicenseInfo.mockReset();
});

function setupHooks(overrides?: {
  permissions?: string[];
  menuSections?: string[];
  licenseTier?: string | null;
}) {
  mockUseMe.mockReturnValue({
    data: overrides?.permissions
      ? { permissions: overrides.permissions }
      : { permissions: [] },
  });
  mockUseMenuSections.mockReturnValue({
    data: overrides?.menuSections ?? [],
  });
  mockUseLicenseInfo.mockReturnValue({
    data: overrides?.licenseTier ? { tier: overrides.licenseTier } : undefined,
  });
}

describe("UserDropdown", () => {
  it("renders fallback '?' initial and '—' username when user is null", () => {
    setupHooks();
    render(<UserDropdown user={null} onLogout={jest.fn()} />);
    // Trigger fallback initial
    expect(screen.getByText("?")).toBeInTheDocument();
    // Header username fallback
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders the username header and role badge 'user' for a non-admin user", () => {
    setupHooks({ permissions: [] });
    render(<UserDropdown user={baseUser} onLogout={jest.fn()} />);
    expect(screen.getByText("alice")).toBeInTheDocument();
    // role badge user (t key returned verbatim)
    expect(screen.getByText("user-dropdown.role.user")).toBeInTheDocument();
  });

  it("renders admin role badge but NO admin link when permissions include admin:settings (8.4)", () => {
    setupHooks({ permissions: ["admin:settings"] });
    render(<UserDropdown user={baseUser} onLogout={jest.fn()} />);
    // Role badge still reflects admin status
    expect(screen.getByText("user-dropdown.role.admin")).toBeInTheDocument();
    // Admin link removed (8.4): must NOT be rendered
    expect(screen.queryByText("menu.admin")).not.toBeInTheDocument();
  });

  it("does NOT render the analytics link even when menuSections includes 'analytics'", () => {
    // Analytics link removed from the dropdown per request — analytics stays
    // reachable only via the sidebar.
    setupHooks({ menuSections: ["analytics", "settings"] });
    render(<UserDropdown user={baseUser} onLogout={jest.fn()} />);
    expect(screen.queryByText("menu.analytics")).not.toBeInTheDocument();
  });

  it("renders the license tier in the footer when license is present", () => {
    setupHooks({ licenseTier: "enterprise" });
    render(<UserDropdown user={baseUser} onLogout={jest.fn()} />);
    // Footer: t("user-dropdown.license"): ENTERPRISE
    expect(screen.getByText(/user-dropdown\.license/)).toBeInTheDocument();
    expect(screen.getByText(/ENTERPRISE/)).toBeInTheDocument();
  });

  it("calls i18n.changeLanguage with the first enabled language code on click", () => {
    setupHooks();
    render(<UserDropdown user={baseUser} onLogout={jest.fn()} />);
    // First enabled language is "en" → label "English" (mock ALL_LANGUAGES)
    fireEvent.click(screen.getByText("English"));
    expect(mockChangeLanguage).toHaveBeenCalledWith("en");
  });

  it("calls setTheme('hacker') when the Hacker theme item is clicked", () => {
    setupHooks();
    render(<UserDropdown user={baseUser} onLogout={jest.fn()} />);
    fireEvent.click(screen.getByText("Hacker"));
    expect(mockSetTheme).toHaveBeenCalledWith("hacker");
  });

  it("calls onLogout when the Sign Out item is clicked", () => {
    const onLogout = jest.fn();
    setupHooks();
    render(<UserDropdown user={baseUser} onLogout={onLogout} />);
    fireEvent.click(screen.getByText("user-dropdown.signOut"));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("renders the Settings link always (unconditional)", () => {
    setupHooks({ menuSections: [] });
    render(<UserDropdown user={baseUser} onLogout={jest.fn()} />);
    expect(screen.getByText("menu.settings")).toBeInTheDocument();
  });
});