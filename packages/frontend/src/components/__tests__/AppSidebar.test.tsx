// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppSidebar branding unit tests — Feature 7.6/7.7 Slice D (quick task 260714-phg).
 *
 * Covers the white-label branding render paths introduced in Slice D:
 *  - appIconUrl truthy → <img class="app-icon"> with src + alt
 *  - appIconUrl falsy + collapsed → fallback <span> with appName initial + aria-label
 *  - appSubtitle truthy → <p class="app-subtitle"> shows the custom subtitle
 *  - appSubtitle falsy → <p class="app-subtitle"> falls back to t("app.subtitle")
 *
 * The sidebar primitives (SidebarSection/Item/Dropdown) are exercised in
 * sidebar-primitives.test.tsx — we do NOT re-test them here. Radix
 * Collapsible/Select are mocked as passthroughs (same pattern) so AppSidebar's
 * own branding wiring is the only thing under test. SynthesisBadge is stubbed
 * (it carries a TanStack Query hook we don't need for branding assertions).
 *
 * Repo convention: NO snapshots — only structural + text assertions.
 */
import type { ReactNode } from "react";
import type { MockComponentProps, ChildrenOnlyProps } from "../../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, cleanup } from "@testing-library/react";

// Mock react-i18next: t returns the key verbatim so t("app.subtitle") →
// "app.subtitle" is assertable as the fallback subtitle text.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("react-router-dom", () => ({
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: "/" }),
}));

// Mock Collapsible as a passthrough (same as sidebar-primitives.test.tsx) so
// SidebarSection renders its children without Radix jsdom plumbing.
jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children, open }: { children?: ReactNode; open?: boolean }) => (
    <div data-testid="collapsible" data-open={open ? "true" : "false"}>
      {open ? children : null}
    </div>
  ),
  CollapsibleTrigger: ({ children }: ChildrenOnlyProps) => (
    <button data-testid="collapsible-trigger">{children}</button>
  ),
  CollapsibleContent: ({ children }: ChildrenOnlyProps) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
}));

// Mock Select as a passthrough (same as sidebar-primitives.test.tsx).
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value }: { children?: ReactNode; value?: string }) => (
    <div data-testid="select" data-value={value}>
      <select value={value}>{children}</select>
    </div>
  ),
  SelectTrigger: ({ children, ...rest }: MockComponentProps) => (
    <button data-testid="select-trigger" role="combobox" {...rest}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span data-testid="select-value">{placeholder}</span>
  ),
  SelectContent: ({ children }: ChildrenOnlyProps) => <div data-testid="select-content">{children}</div>,
  SelectItem: ({ children, value }: { children?: ReactNode; value?: string }) => (
    <option value={value} data-testid="select-item">
      {children}
    </option>
  ),
  SelectSeparator: () => <div data-testid="select-separator" />,
}));

import AppSidebar from "../AppSidebar";
import type { AppSidebarProps } from "../AppSidebar";

function minimalProps(overrides: Partial<AppSidebarProps> = {}): AppSidebarProps {
  return {
    appName: "Simmetric",
    primaryColor: "#4c6ef5",
    appSubtitle: undefined,
    appIconUrl: undefined,
    isEnterprise: false,
    isAdmin: false,
    menuSections: ["chat", "settings"],
    currentWorkspaceId: null,
    selectedProjectId: "",
    setSelectedProjectId: jest.fn(),
    selectedWorkspaceId: "",
    setSelectedWorkspaceId: jest.fn(),
    setWorkspaceId: jest.fn(),
    t: (key: string) => key,
    sidebarOpen: true,
    setSidebarOpen: jest.fn(),
    projects: [],
    workspaces: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("AppSidebar branding render", () => {
  it("renders <img class='app-icon'> with src + alt when appIconUrl is truthy (open mode)", () => {
    render(<AppSidebar {...minimalProps({ appIconUrl: "http://x/icon.png" })} />);
    const img = document.querySelector("img.app-icon") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("http://x/icon.png");
    expect(img.getAttribute("alt")).toBe("Simmetric");
  });

  it("renders the SVG Monogram fallback when appIconUrl is falsy and collapsed (Phase 149 D-02)", () => {
    render(
      <AppSidebar
        {...minimalProps({ appIconUrl: undefined, sidebarOpen: false, isMobile: false })}
      />,
    );
    // Phase 149 BRAND-01: collapsed rail fallback is now the inline SVG
    // Monogram (the same "S" mark as the favicon), not a text initial. The
    // Monogram renders an <svg role='img' aria-label='Simmetric Chat'> with a
    // rounded-square background + "S" letter in primaryColor.
    const monogram = screen.getByLabelText("Simmetric Chat");
    expect(monogram.tagName).toBe("svg");
    expect(monogram).toHaveClass("rounded-md");
  });

  it("renders the custom subtitle inside <p class='app-subtitle'> when appSubtitle is provided", () => {
    render(<AppSidebar {...minimalProps({ appSubtitle: "Custom Subtitle" })} />);
    const subtitle = document.querySelector("p.app-subtitle");
    expect(subtitle).not.toBeNull();
    expect(subtitle!.textContent).toBe("Custom Subtitle");
  });

  it("falls back to t('app.subtitle') inside <p class='app-subtitle'> when appSubtitle is empty/undefined", () => {
    render(<AppSidebar {...minimalProps({ appSubtitle: undefined })} />);
    const subtitle = document.querySelector("p.app-subtitle");
    expect(subtitle).not.toBeNull();
    // t mock returns the key verbatim → "app.subtitle"
    expect(subtitle!.textContent).toBe("app.subtitle");
  });
});