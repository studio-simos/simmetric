// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Sidebar primitive tests — Feature 7.2 Slice B (quick task 260714-n3q).
 *
 * Covers SidebarSection / SidebarItem / SidebarLink / SidebarDropdown behavior:
 * - SidebarSection: label + chevron toggle, localStorage persistence, rail mode
 *   (collapsed) hides label and forces items visible.
 * - SidebarItem: icon + label + active state; rail mode shows icon only with title tooltip.
 * - SidebarLink: direct-link variant, same active logic, no icon required.
 * - SidebarDropdown: Select wrapper with label + items + placeholder + addOption.
 *
 * Repo convention: structural assertions (no snapshots). Radix Select/Collapsible
 * are mocked as passthrough divs (same pattern as RightPanel.test.tsx) so we test
 * the primitive's own wiring (state, localStorage, active styling, rail mode)
 * rather than Radix internals.
 */

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock Collapsible as a passthrough that renders children based on `open` and
// wires CollapsibleTrigger's click to the Collapsible's onOpenChange via a
// factory-local shared state object. Lets us assert SidebarSection's own
// state/localStorage wiring without Radix jsdom complexity or duplicate triggers.
jest.mock("@/components/ui/collapsible", () => {
  const state: { onOpenChange: ((o: boolean) => void) | null; open: boolean } = {
    onOpenChange: null,
    open: false,
  };
  return {
    Collapsible: ({ children, open, onOpenChange }: { children?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
      state.onOpenChange = onOpenChange ?? null;
      state.open = open ?? false;
      return (
        <div data-testid="collapsible" data-open={open ? "true" : "false"}>
          {open ? children : null}
        </div>
      );
    },
    CollapsibleTrigger: ({ children, ...rest }: MockComponentProps) => (
      <button
        data-testid="collapsible-trigger"
        onClick={() => state.onOpenChange && state.onOpenChange(!state.open)}
        {...rest}
      >
        {children}
      </button>
    ),
    CollapsibleContent: ({ children }: ChildrenOnlyProps) => (
      <div data-testid="collapsible-content">{children}</div>
    ),
  };
});

// Mock Select as a passthrough that renders the trigger value + all items
// (so the addOption + items assertions work without Radix portal plumbing).
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void }) => (
    <div data-testid="select" data-value={value}>
      <select
        value={value}
        onChange={(e) => onValueChange && onValueChange(e.target.value)}
      >
        {children}
      </select>
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

import type { ReactNode } from "react";
import type { MockComponentProps, ChildrenOnlyProps } from "../../../__tests__/mockComponentTypes";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  SidebarSection,
  SidebarItem,
  SidebarLink,
  SidebarDropdown,
} from "../index";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SidebarSection", () => {
  it("renders the group label and children when open", () => {
    render(
      <SidebarSection label="Overview">
        <span data-testid="child">Dashboard</span>
      </SidebarSection>,
    );
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("persists open/close state to localStorage under storageKey", () => {
    render(
      <SidebarSection label="Chat Tools" storageKey="test-group">
        <span data-testid="child">Chat</span>
      </SidebarSection>,
    );
    // Toggle via the trigger
    const trigger = screen.getByTestId("collapsible-trigger");
    fireEvent.click(trigger);
    // Persisted key should exist (state was written)
    const raw = localStorage.getItem("test-group");
    expect(raw).not.toBeNull();
  });

  it("rail mode (collapsed) hides the label and shows children directly", () => {
    render(
      <SidebarSection label="Knowledge" collapsed>
        <span data-testid="child">KB</span>
      </SidebarSection>,
    );
    // Label hidden in rail mode
    expect(screen.queryByText("Knowledge")).not.toBeInTheDocument();
    // Children still rendered (rail shows items as icon-only)
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});

describe("SidebarItem", () => {
  it("renders icon + label and calls onClick on click", () => {
    const onClick = jest.fn();
    render(
      <SidebarItem
        path="/dashboard"
        label="Dashboard"
        icon={<span data-testid="icon">icon</span>}
        onClick={onClick}
      />,
    );
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dashboard/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies active styling when isActive", () => {
    render(
      <SidebarItem
        path="/chat"
        label="Chat"
        isActive
        primaryColor="#00ff9c"
        onClick={jest.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /chat/i });
    // Active state injects inline color via primaryColor
    expect(btn.style.color).toBe("rgb(0, 255, 156)");
  });

  it("rail mode (collapsed) shows icon only with title tooltip, label hidden", () => {
    render(
      <SidebarItem
        path="/documents"
        label="Documents"
        icon={<span data-testid="icon">docs</span>}
        collapsed
        onClick={jest.fn()}
      />,
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.queryByText("Documents")).not.toBeInTheDocument();
    // title attribute provides tooltip in rail mode
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("title")).toBe("Documents");
  });
});

describe("SidebarLink", () => {
  it("renders a direct link and calls onClick", () => {
    const onClick = jest.fn();
    render(<SidebarLink path="/settings" label="Settings" onClick={onClick} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies active styling when isActive", () => {
    render(
      <SidebarLink
        path="/sso"
        label="SSO"
        isActive
        primaryColor="#4c6ef5"
        onClick={jest.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /sso/i });
    expect(btn.style.color).toBe("rgb(76, 110, 245)");
  });
});

describe("SidebarDropdown", () => {
  it("renders the label and placeholder when no value", () => {
    render(
      <SidebarDropdown
        label="Project"
        value=""
        onValueChange={jest.fn()}
        items={[]}
        placeholder="Select project..."
      />,
    );
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("renders items and an add option when provided", () => {
    render(
      <SidebarDropdown
        label="Workspace"
        value=""
        onValueChange={jest.fn()}
        items={[{ id: "p1", name: "Project One" }]}
        placeholder="Select workspace..."
        addOption={{ value: "__add__", label: "+ Add workspace" }}
      />,
    );
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    // Items render inside the mocked Select
    expect(screen.getByText("Project One")).toBeInTheDocument();
    expect(screen.getByText("+ Add workspace")).toBeInTheDocument();
  });
});