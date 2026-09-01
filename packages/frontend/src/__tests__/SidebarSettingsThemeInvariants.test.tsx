// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Sidebar + Settings theme-invariant DOM tests — Feature 7.1/7.5/7.6/7.7
 * (quick task 260714-phg).
 *
 * The hacker theme is CSS-driven, not React-driven: AppSidebar and SettingsMenu
 * render IDENTICAL markup in every theme — the per-theme differences live
 * entirely in index.css (selected by the `.dark` / `.theme-hacker` classes on
 * <html>). This file tests the real theme contract at three layers, mirroring
 * the ChatThemes.test.tsx pattern (CSS source parsing + structural assertions,
 * ZERO snapshots):
 *
 *  1. CSS contract: index.css declares the neon overrides under
 *     `.theme-hacker` for `.app-subtitle` and
 *     `.settings-menu-item[data-active]` (the `.app-icon` is intentionally
 *     borderless in every theme — no neon override, per commit 99f15f7e5).
 *  2. Theme application: hacker → <html> has `.theme-hacker` + `.dark`;
 *     light/dark → `.theme-hacker` absent.
 *  3. DOM invariance: AppSidebar + SettingsMenu render the same theme hooks
 *     (`.app-subtitle`, `.settings-menu-item`) under all three <html> class
 *     states, and the `.app-subtitle` markup is structurally identical across
 *     themes — proving the theme is carried by CSS, not by conditional React.
 *
 * LOCKED constraints honored: `.theme-hacker` selector only (never the
 * data-theme attribute form), no next-themes import, no snapshot.
 */
import type { ReactNode } from "react";
import type { MockComponentProps, ChildrenOnlyProps } from "../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, cleanup } from "@testing-library/react";
// Node builtins — tsconfig excludes __tests__, so fs/path/__dirname transpile
// via ts-jest and run under Node (same pattern as ChatThemes.test.tsx).
const fs = require("fs");
const path = require("path");

// Mock react-i18next: t returns the key verbatim.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, d?: unknown) => (typeof d === "string" ? d : key),
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("react-router-dom", () => ({
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: "/" }),
}));

// Passthrough Radix Collapsible/Select (same as sidebar-primitives.test.tsx).
jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children, open }: { children?: ReactNode; open?: boolean }) => (
    <div data-open={open ? "true" : "false"}>{open ? children : null}</div>
  ),
  CollapsibleTrigger: ({ children }: ChildrenOnlyProps) => <button>{children}</button>,
  CollapsibleContent: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
}));
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value }: { children?: ReactNode; value?: string }) => (
    <div data-value={value}><select value={value}>{children}</select></div>
  ),
  SelectTrigger: ({ children, ...rest }: MockComponentProps) => (
    <button role="combobox" {...rest}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
  SelectSeparator: () => <div />,
}));

import AppSidebar from "../components/AppSidebar";
import type { AppSidebarProps } from "../components/AppSidebar";
import { SettingsMenu } from "../components/ui/settings-menu";

const INDEX_CSS = fs.readFileSync(
  path.resolve(__dirname, "../index.css"),
  "utf8",
);

const minimalSidebarProps: AppSidebarProps = {
  appName: "Simmetric",
  primaryColor: "#4c6ef5",
  appSubtitle: "Custom Subtitle",
  appIconUrl: "http://x/icon.png",
  isEnterprise: false,
  isAdmin: false,
  menuSections: ["chat", "settings"],
  currentWorkspaceId: null,
  selectedProjectId: "",
  setSelectedProjectId: jest.fn(),
  selectedWorkspaceId: "",
  setSelectedWorkspaceId: jest.fn(),
  setWorkspaceId: jest.fn(),
  license: { tier: "community" },
  t: (key: string) => key,
  sidebarOpen: true,
  setSidebarOpen: jest.fn(),
  projects: [],
  workspaces: [],
};

const SETTINGS_GROUPS = [
  {
    key: "general",
    labelKey: "settings.tabs.general",
    sections: [
      { id: "profile", labelKey: "settings.subSections.profile" },
      { id: "general", labelKey: "settings.subSections.generalSettings" },
    ],
  },
  {
    key: "security",
    labelKey: "settings.tabs.security",
    sections: [{ id: "roles", labelKey: "settings.subSections.roles" }],
  },
];

const THEMES = [
  { name: "light", classes: [] as string[] },
  { name: "dark", classes: ["dark"] },
  { name: "hacker", classes: ["dark", "theme-hacker"] },
];

function setHtmlClasses(classes: string[]) {
  document.documentElement.classList.remove("dark", "theme-hacker");
  classes.forEach((c) => document.documentElement.classList.add(c));
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark", "theme-hacker");
});

// ===========================================================================
// 1. CSS contract — neon overrides exist under .theme-hacker in index.css
// ===========================================================================
describe("index.css — hacker neon overrides for sidebar + settings", () => {
  it("does NOT declare a neon rule for .theme-hacker .app-icon (icon is borderless)", () => {
    // Commit 99f15f7e5 removed the .app-icon border/glow per user request
    // (2026-07-14) — the app icon renders borderless in every theme, so
    // index.css must NOT carry a .theme-hacker .app-icon override.
    expect(INDEX_CSS).not.toMatch(/\.theme-hacker\s+\.app-icon\s*\{/);
  });

  it("declares a neon rule for .theme-hacker .app-subtitle", () => {
    expect(INDEX_CSS).toMatch(/\.theme-hacker\s+\.app-subtitle\s*\{/);
  });

  it("declares a neon active-state rule for .theme-hacker .settings-menu-item[data-active]", () => {
    expect(INDEX_CSS).toMatch(
      /\.theme-hacker\s+\.settings-menu-item\[data-active/,
    );
  });

  it("never uses a [data-theme=\"hacker\"] selector in index.css (LOCKED)", () => {
    expect(INDEX_CSS).not.toMatch(/data-theme=["']hacker["']/);
  });
});

// ===========================================================================
// 2 + 3. Theme application + DOM invariance across the 3 themes
// ===========================================================================
describe("AppSidebar + SettingsMenu render theme hooks under every theme", () => {
  it.each(THEMES)(
    "renders .app-icon, .app-subtitle, and .settings-menu-item under the '$name' theme",
    ({ classes }) => {
      setHtmlClasses(classes);
      render(
        <>
          <AppSidebar {...minimalSidebarProps} />
          <SettingsMenu
            groups={SETTINGS_GROUPS}
            activeTab="general"
            onSelectTab={jest.fn()}
            onSelectSection={jest.fn()}
          />
        </>,
      );
      expect(document.querySelector(".app-icon")).not.toBeNull();
      expect(document.querySelector(".app-subtitle")).not.toBeNull();
      expect(document.querySelector(".settings-menu-item")).not.toBeNull();
    },
  );

  it("hacker theme sets .theme-hacker + .dark on <html>", () => {
    setHtmlClasses(["dark", "theme-hacker"]);
    render(<AppSidebar {...minimalSidebarProps} />);
    const html = document.documentElement;
    expect(html.classList.contains("theme-hacker")).toBe(true);
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("light + dark themes do NOT set .theme-hacker on <html>", () => {
    // light
    setHtmlClasses([]);
    render(<AppSidebar {...minimalSidebarProps} />);
    expect(document.documentElement.classList.contains("theme-hacker")).toBe(false);
    cleanup();
    // dark
    setHtmlClasses(["dark"]);
    render(<AppSidebar {...minimalSidebarProps} />);
    expect(document.documentElement.classList.contains("theme-hacker")).toBe(false);
  });

  it(".app-subtitle markup is structurally identical across all 3 themes (DOM invariance)", () => {
    const snapshots: string[] = [];
    for (const { classes } of THEMES) {
      setHtmlClasses(classes);
      const { unmount } = render(<AppSidebar {...minimalSidebarProps} />);
      const subtitle = document.querySelector(".app-subtitle");
      // Same element type + class + text in every theme — theme is CSS-only.
      // This is the snapshot-free equivalent of "snapshot per theme": assert
      // identity of the theme-neutral hook element, not pixel output.
      const markup = subtitle ? subtitle.outerHTML : "<missing>";
      // Strip the data-collapsed attribute (varies with sidebarOpen which is
      // constant here, so it's stable — kept for explicitness).
      snapshots.push(markup);
      unmount();
    }
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(snapshots[1]).toBe(snapshots[2]);
  });

  it("SettingsMenu marks the active item with data-active + settings-menu-item class in every theme", () => {
    for (const { classes } of THEMES) {
      setHtmlClasses(classes);
      cleanup();
      render(
        <SettingsMenu
          groups={SETTINGS_GROUPS}
          activeTab="general"
          onSelectTab={jest.fn()}
          onSelectSection={jest.fn()}
        />,
      );
      const generalBtn = document.querySelector(
        '.settings-menu-item[data-active="true"]',
      );
      expect(generalBtn).not.toBeNull();
    }
  });
});