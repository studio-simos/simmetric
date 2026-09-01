// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TopBar component tests — Feature 3.2 / 3.5 (interaction + responsive).
 *
 * The bar wires together project name (from useProjects), the inline rename
 * trigger (opens ProjectRenameModal), and the user menu dropdown. The model
 * switcher chip was removed (Feature 8 follow-up) — model selection now lives
 * in the ChatInputArea `ChatModelBadge`, with the global Cmd+K palette still
 * available. We mock the heavy dependencies (queries, router, contexts) and
 * stub the child components (ThemeToggle, ProjectRenameModal) so the test
 * stays focused on TopBar's own wiring. Responsive coverage: the header is
 * always visible, the PROGETTO block is always visible, and the "Progetto:"
 * label is hidden below 425px via `hidden min-[425px]:inline`.
 */
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

const mockUseChatNav = jest.fn();
jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => mockUseChatNav(),
}));

const mockUseProjects = jest.fn();
const mockUseRenameProject = jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false }));
jest.mock("../queries/useProjects", () => ({
  useProjects: () => mockUseProjects(),
  useRenameProject: () => mockUseRenameProject(),
}));

const mockUseSessionTokens = jest.fn();
jest.mock("../queries/useChatTokens", () => ({
  useSessionTokens: (...args: unknown[]) => mockUseSessionTokens(...args),
}));

// Stub the cosmetic theme toggle — ThemeToggle is no longer rendered in
// TopBar (Feature 7.4 moved theme switching into UserDropdown). The mock is
// retained so any residual import resolves, but no assertion checks for it.
jest.mock("../components/ThemeToggle", () => ({
  __esModule: true,
  default: () => <button data-testid="theme-toggle">theme</button>,
  themeLabels: { light: "Light", dark: "Dark", hacker: "Hacker", system: "System" },
}));

// Mock ThemeContext — UserDropdown calls useTheme() from @/contexts/ThemeContext.
jest.mock("../contexts/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: jest.fn(),
  }),
}));

// Mock the auth/license hooks UserDropdown calls internally (Feature 7.4).
jest.mock("../queries/useAuth", () => ({
  useMe: () => ({ data: { permissions: ["admin:settings"] } }),
  useMenuSections: () => ({ data: ["analytics", "settings"] }),
}));
jest.mock("../queries/useLicense", () => ({
  useLicenseInfo: () => ({ data: { tier: "enterprise" } }),
}));

// Mock getEnabledLanguages + ALL_LANGUAGES — UserDropdown imports from @/i18n.
jest.mock("../i18n", () => ({
  getEnabledLanguages: () => ["en", "it", "ru"],
  ALL_LANGUAGES: [
    { code: "en", name: "English" },
    { code: "it", name: "Italiano" },
    { code: "ru", name: "Русский" },
  ],
}));

// Mock the Radix DropdownMenu wrapper to render inline. Radix menus open on
// pointer events that jsdom does not fully support; TopBar's responsibility
// is the trigger + item handlers, not Radix's open behavior. This mirrors the
// Select-mock pattern already used in LoginPage.test.tsx. Sub-menus render
// their content inline too (Feature 7.4 UserDropdown uses sub-menus).
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: ChildrenOnlyProps) => <div data-testid="user-menu-root">{children}</div>,
  DropdownMenuTrigger: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  DropdownMenuContent: ({ children }: ChildrenOnlyProps) => <div data-testid="user-menu-content">{children}</div>,
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

// Stub the rename modal — TopBar only owns the open state + the project passdown.
jest.mock("../components/ProjectRenameModal", () => ({
  __esModule: true,
  default: ({
    open,
    project,
  }: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    project: { id: string; name: string } | null;
  }) =>
    open ? (
      <div
        data-testid="rename-modal"
        data-project-id={project?.id}
        data-project-name={project?.name}
      />
    ) : null,
}));

import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../__tests__/mockComponentTypes";
import { render, screen, fireEvent } from "@testing-library/react";
import TopBar from "../components/TopBar";

const BASE_PROPS = {
  currentSection: "Chat",
  selectedProjectId: "proj-1",
  user: { username: "jdoe", firstName: "Jane", lastName: "Doe" },
  onLogout: jest.fn(),
};

function setup(overrides: Partial<typeof BASE_PROPS> = {}) {
  mockUseChatNav.mockReturnValue({ currentWorkspaceId: "ws-1" });
  mockUseProjects.mockReturnValue({
    data: [{ id: "proj-1", name: "Project Alpha" }],
  });
  mockUseSessionTokens.mockReturnValue({ data: undefined, isLoading: false });

  return render(<TopBar {...BASE_PROPS} {...overrides} />);
}

describe("TopBar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the active project name resolved from useProjects", () => {
    setup();
    expect(screen.getByText("Project Alpha")).toBeInTheDocument();
  });

  it("shows an ellipsis when the selected project id has no matching project", () => {
    setup({ selectedProjectId: "missing-id" });
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("shows the no-project label when no project is selected", () => {
    setup({ selectedProjectId: "" });
    expect(screen.getByText("topbar.noProject")).toBeInTheDocument();
  });

  it("is always visible (flex, not hidden md:flex) — unified mobile/desktop bar", () => {
    setup();
    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(header?.className).toContain("flex");
    expect(header?.className).not.toContain("hidden");
  });

  it("shows the PROGETTO block at all breakpoints (always visible, not hidden)", () => {
    setup();
    // The project name + rename button render at every breakpoint — the block
    // is no longer gated behind `hidden md:flex`.
    expect(screen.getByText("Project Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("topbar.renameProject")).toBeInTheDocument();
  });

  it("hides the PROGETTO label below 425px via `hidden min-[425px]:inline`", () => {
    setup();
    const label = screen.getByText("sidebar.project:");
    expect(label.className).toContain("hidden");
    expect(label.className).toContain("min-[425px]:inline");
  });

  it("opens the rename modal with the active project when the rename button is clicked", () => {
    setup();
    expect(screen.queryByTestId("rename-modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("topbar.renameProject"));

    const modal = screen.getByTestId("rename-modal");
    expect(modal).toHaveAttribute("data-project-id", "proj-1");
    expect(modal).toHaveAttribute("data-project-name", "Project Alpha");
  });

  it("disables the rename button when there is no active project", () => {
    setup({ selectedProjectId: "missing" });
    expect(screen.getByLabelText("topbar.renameProject")).toBeDisabled();
  });

  it("renders the avatar initials when no avatar URL is provided", () => {
    setup();
    // initials("Jane", "Doe") → "JD"
    expect(screen.getByText("JD")).toBeInTheDocument();
  });

  it("renders the current section label", () => {
    setup({ currentSection: "Documents" });
    expect(screen.getByText("Documents")).toBeInTheDocument();
  });

  it("mounts the TokenCounterWidget and UserDropdown children", () => {
    setup();
    // ThemeToggle is no longer in TopBar (Feature 7.4 moved theme into UserDropdown).
    // UserDropdown renders the trigger with the same aria-label.
    expect(screen.getByLabelText("topbar.userMenu")).toBeInTheDocument();
    // The widget renders its aria-label regardless of data.
    expect(screen.getByLabelText("Session token usage")).toBeInTheDocument();
  });

  describe("user menu", () => {
    it("navigates to /settings when Settings is clicked", () => {
      setup();
      // The mocked dropdown renders items inline; the trigger keeps its aria-label.
      expect(screen.getByLabelText("topbar.userMenu")).toBeInTheDocument();
      fireEvent.click(screen.getByText("menu.settings"));
      expect(mockNavigate).toHaveBeenCalledWith("/settings");
    });

    it("calls onLogout when Sign Out is clicked", () => {
      const onLogout = jest.fn();
      setup({ onLogout });
      fireEvent.click(screen.getByText("user-dropdown.signOut"));
      expect(onLogout).toHaveBeenCalledTimes(1);
    });
  });
});