// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WorkspacesPage tests — table, filter, empty state, inline delete, read-only tooltip
 */
import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import WorkspacesPage from "../components/WorkspacesPage";

function renderWithProvider(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { TooltipProvider } = require("@/components/ui/tooltip");
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Mutable mock references
const mockUseMe = jest.fn();
const mockUseWorkspaces = jest.fn();
const mockUseUpdateWorkspace = jest.fn();
const mockUseDeleteWorkspace = jest.fn();
const mockUpdateWorkspaceMutateAsync = jest.fn();
const mockDeleteWorkspaceMutateAsync = jest.fn();
const mockBulkDeleteMutateAsync = jest.fn();

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock toast wrapper
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock page meta hook
jest.mock("../hooks/usePageMeta", () => ({
  usePageMeta: jest.fn(),
}));

// Mock auth queries
jest.mock("../queries/useAuth", () => ({
  useMe: (...args: Parameters<typeof mockUseMe>) => mockUseMe(...args),
}));

// Mock workspace queries
jest.mock("../queries/useWorkspaces", () => ({
  useWorkspaces: (...args: Parameters<typeof mockUseWorkspaces>) => mockUseWorkspaces(...args),
  useUpdateWorkspace: () => mockUseUpdateWorkspace(),
  useDeleteWorkspace: () => mockUseDeleteWorkspace(),
  useBulkDeleteWorkspaces: () => ({
    mutateAsync: mockBulkDeleteMutateAsync,
    isPending: false,
  }),
}));

// Mock RecentlyDeleted
jest.mock("../components/RecentlyDeleted", () => ({
  __esModule: true,
  default: () => <div data-testid="recently-deleted">RecentlyDeleted</div>,
}));

// Mock Select to render native select for testability
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void }) => (
    <select
      data-testid="workspace-filter"
      value={value}
      onChange={(e) => onValueChange && onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  SelectItem: ({ children, value }: { children?: ReactNode; value?: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  SelectValue: () => null,
}));

describe("WorkspacesPage", () => {
  const workspaces = [
    {
      id: "ws-1",
      name: "Owned Workspace",
      instructions: "A test workspace",
      createdAt: "2026-05-20T00:00:00Z",
      deletedAt: null,
      projectId: "p1",
      project: { createdBy: "u1", name: "Project 1" },
      _count: { chats: 2, documents: 3 },
      allowMemberUploads: true,
    },
    {
      id: "ws-2",
      name: "Shared Workspace",
      instructions: null,
      createdAt: "2026-05-19T00:00:00Z",
      deletedAt: null,
      projectId: "p2",
      project: { createdBy: "u2", name: "Project 2" },
      _count: { chats: 0, documents: 1 },
      allowMemberUploads: false,
    },
  ];

  const defaultUser = {
    id: "u1",
    username: "admin",
    roles: [{ name: "admin" }],
    permissions: ["workspace:write"],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseMe.mockReturnValue({ data: defaultUser });
    mockUseWorkspaces.mockReturnValue({ data: workspaces, isLoading: false });
    mockUseUpdateWorkspace.mockReturnValue({ mutateAsync: mockUpdateWorkspaceMutateAsync });
    mockUseDeleteWorkspace.mockReturnValue({ mutateAsync: mockDeleteWorkspaceMutateAsync });
    mockBulkDeleteMutateAsync.mockResolvedValue([]);
  });

  it("renders workspace Table with WorkspaceRow children", () => {
    renderWithProvider(<WorkspacesPage />);

    expect(screen.getByText("Owned Workspace")).toBeInTheDocument();
    expect(screen.getByText("Shared Workspace")).toBeInTheDocument();
    expect(screen.getByText("workspace.name")).toBeInTheDocument();
    expect(screen.getByText("workspace.actions")).toBeInTheDocument();
  });

  it("filters workspace list by Select value", () => {
    renderWithProvider(<WorkspacesPage />);

    // The page renders two mocked Selects (project filter + ownership filter);
    // pick the one containing the owned/shared options.
    const select = screen
      .getAllByTestId("workspace-filter")
      .find((el) => within(el).queryByText("workspace.owned") !== null)!;
    expect(select).toBeInTheDocument();

    // Default shows both workspaces
    expect(screen.getByText("Owned Workspace")).toBeInTheDocument();
    expect(screen.getByText("Shared Workspace")).toBeInTheDocument();

    // Change filter to owned
    fireEvent.change(select, { target: { value: "owned" } });
    expect(screen.getByText("Owned Workspace")).toBeInTheDocument();
    expect(screen.queryByText("Shared Workspace")).not.toBeInTheDocument();

    // Change filter to shared
    fireEvent.change(select, { target: { value: "shared" } });
    expect(screen.queryByText("Owned Workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Shared Workspace")).toBeInTheDocument();
  });

  it("renders empty state when no workspaces", () => {
    mockUseWorkspaces.mockReturnValue({ data: [], isLoading: false });

    renderWithProvider(<WorkspacesPage />);

    expect(screen.getByText("workspace.emptyTitle")).toBeInTheDocument();
    expect(screen.getByText("workspace.emptyBody")).toBeInTheDocument();
  });

  it("shows the delete AlertDialog with ghost edit + destructive confirm buttons", () => {
    renderWithProvider(<WorkspacesPage />);

    const deleteButtons = screen.getAllByRole("button", { name: /Delete/i });
    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);

    // Click delete on first workspace row — opens the AlertDialog (UX-01)
    fireEvent.click(deleteButtons[0]);

    // Confirmation text and buttons should appear
    expect(screen.getByText(/workspace.deleteTitle/i)).toBeInTheDocument();
    const cancelButton = screen.getByRole("button", { name: /common.cancel/i });
    const confirmButton = screen.getByRole("button", { name: /common.delete/i });
    expect(cancelButton).toBeInTheDocument();
    expect(confirmButton).toBeInTheDocument();
  });

  it("renders the destructive AlertDialogAction confirm on row delete (WS-01 contract, superseded UX-01)", () => {
    renderWithProvider(<WorkspacesPage />);

    // Enter confirmation state on first workspace row via the AlertDialog
    const deleteButtons = screen.getAllByRole("button", { name: /Delete/i });
    fireEvent.click(deleteButtons[0]);

    // Title and body (with interpolated counts) are present
    expect(screen.getByText("workspace.deleteTitle")).toBeInTheDocument();
    expect(screen.getByText(/workspace.deleteBody/i)).toBeInTheDocument();

    // Cancel + confirm actions both rendered inside the dialog
    const cancelButton = screen.getByRole("button", { name: /common.cancel/i });
    const confirmButton = screen.getByRole("button", { name: /common.delete/i });
    expect(cancelButton).toBeInTheDocument();
    expect(confirmButton).toBeInTheDocument();
  });

  it("renders no delete button for read-only workspace (canEdit gate, UX-01)", () => {
    // Override user to be non-admin without write permission and NOT the owner
    mockUseMe.mockReturnValue({
      data: {
        id: "u99",
        username: "user",
        roles: [{ name: "user" }],
        permissions: ["workspace:read"],
      },
    });

    renderWithProvider(<WorkspacesPage />);

    // D-01/non-editable rule: no delete control at all — the read-only badge
    // communicates the state instead of a disabled control.
    expect(screen.queryByRole("button", { name: /Delete/i })).toBeNull();
  });
});
