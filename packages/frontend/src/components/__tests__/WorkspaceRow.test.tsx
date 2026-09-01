// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WorkspaceRow component tests — Wave 0 stubs + 260809-dhn save behavior
 */
import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import WorkspaceRow from "../WorkspaceRow";

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock toast wrapper
jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

import { showError } from "../../lib/toast";

// Mock auth queries — mutable via useMeMock so permission gating is testable
const useMeMock = jest.fn();
jest.mock("../../queries/useAuth", () => ({
  useMe: () => useMeMock(),
}));

// Mock providers (embedding model list)
jest.mock("../../queries/useProviders", () => ({
  useProviders: () => ({ data: [] }),
}));

// Mock apiGet (covers /agent/skills and /templates fetches fired by the expand effect)
jest.mock("../../utils/api", () => ({
  apiGet: jest.fn(),
}));

// Mock AlertDialog to render inline (ArchiveCard.test.tsx precedent).
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: ChildrenOnlyProps) => (
    <div data-testid="alert-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: ChildrenOnlyProps) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: ChildrenOnlyProps) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
  AlertDialogCancel: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: (e: unknown) => void;
  }) => (
    <button type="button" data-testid="alert-cancel" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogAction: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: (e: unknown) => void;
  }) => (
    <button type="button" data-testid="alert-action" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

// Mock Select to render native select for testability
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void }) => (
    <select
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

// Mock IconPicker (avoids radix Popover in jsdom) — WorkspaceRow imports it as a named export
jest.mock("../IconPicker", () => ({
  __esModule: true,
  IconPicker: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <input aria-label="icon" value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

import { apiGet } from "../../utils/api";
import { showSuccess } from "../../lib/toast";

function renderWithProvider(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const workspace = {
  id: "ws-1",
  name: "Old Name",
  instructions: null,
  createdAt: "2026-05-20T00:00:00Z",
  deletedAt: null,
  projectId: "p1",
  project: { createdBy: "u1", name: "Project 1" },
  _count: { chats: 0, documents: 0 },
  allowMemberUploads: false,
  agentConfig: null,
};

describe("WorkspaceRow delete AlertDialog (UX-01)", () => {
  const onUpdate = jest.fn();
  const onDelete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["workspace:write"] } });
    (apiGet as jest.Mock).mockResolvedValue([]);
    onUpdate.mockResolvedValue(undefined);
    onDelete.mockResolvedValue(undefined);
  });

  it("opens the delete dialog on delete click", () => {
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} />
    );
    expect(screen.queryByTestId("alert-content")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "workspace.deleteWorkspace" }));
    expect(screen.getByTestId("alert-content")).toBeInTheDocument();
    expect(screen.getByText("workspace.deleteTitle")).toBeInTheDocument();
  });

  it("cancel closes the dialog and never calls onDelete", () => {
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} />
    );
    fireEvent.click(screen.getByRole("button", { name: "workspace.deleteWorkspace" }));
    fireEvent.click(screen.getByTestId("alert-cancel"));
    expect(screen.queryByTestId("alert-content")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("confirm calls onDelete once with the workspace id", async () => {
    jest.useFakeTimers();
    try {
      renderWithProvider(
        <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} />
      );
      fireEvent.click(screen.getByRole("button", { name: "workspace.deleteWorkspace" }));
      fireEvent.click(screen.getByTestId("alert-action"));
      // 300ms fade delay before the mutation fires
      await jest.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith("ws-1");
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows the localized delete toast after a confirmed delete", async () => {
    jest.useFakeTimers();
    try {
      renderWithProvider(
        <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} />
      );
      fireEvent.click(screen.getByRole("button", { name: "workspace.deleteWorkspace" }));
      fireEvent.click(screen.getByTestId("alert-action"));
      await jest.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();
      expect(onDelete).toHaveBeenCalled();
      expect(showSuccess).toHaveBeenCalledWith("workspace.deletedToast");
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the fade behavior on confirmed delete", async () => {
    jest.useFakeTimers();
    try {
      renderWithProvider(
        <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} />
      );
      const row = screen.getByRole("row").closest("tr") as HTMLElement;
      expect(row.className).not.toContain("opacity-0");
      fireEvent.click(screen.getByRole("button", { name: "workspace.deleteWorkspace" }));
      fireEvent.click(screen.getByTestId("alert-action"));
      // Fade class applies immediately on confirm, before the 300ms wait
      await waitFor(() => expect(row.className).toContain("opacity-0"));
      await jest.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      expect(onDelete).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("restores the row (no fade) when the delete mutation fails (CR-01)", async () => {
    jest.useFakeTimers();
    try {
      const failingDelete = jest.fn().mockRejectedValue(new Error("500"));
      renderWithProvider(
        <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={failingDelete} />
      );
      const row = screen.getByRole("row").closest("tr") as HTMLElement;
      fireEvent.click(screen.getByRole("button", { name: "workspace.deleteWorkspace" }));
      fireEvent.click(screen.getByTestId("alert-action"));
      await waitFor(() => expect(row.className).toContain("opacity-0"));
      await jest.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();
      // Error path resets fadingOut — the row must NOT stay visually deleted
      expect(failingDelete).toHaveBeenCalled();
      expect(showError).toHaveBeenCalled();
      await waitFor(() => expect(row.className).not.toContain("opacity-0"));
    } finally {
      jest.useRealTimers();
    }
  });

  it("non-editable rows render no delete control (canEdit gate)", () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: [] } });
    renderWithProvider(
      <WorkspaceRow
        workspace={{ ...workspace, project: { createdBy: "someone-else", name: "P" } }}
        onUpdate={onUpdate}
        onDelete={onDelete}
        currentUserId="u1"
      />
    );
    expect(screen.queryByRole("button", { name: "workspace.deleteWorkspace" })).toBeNull();
    // read-only badge is rendered instead
    expect(screen.getByText("workspace.readOnly")).toBeInTheDocument();
  });
});

describe("WorkspaceRow save behavior (260809-dhn)", () => {
  const onUpdate = jest.fn();
  const onDelete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (apiGet as jest.Mock).mockResolvedValue([]);
    onUpdate.mockResolvedValue(undefined);
    onDelete.mockResolvedValue(undefined);
  });

  it("keeps the edit form open after save and shows the freshly-saved values", async () => {
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} />
    );

    fireEvent.click(screen.getByRole("button", { name: "workspace.edit" }));
    await waitFor(() => expect(screen.getByLabelText("workspace.name")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("workspace.name"), {
      target: { value: "New Name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "workspace.saveChanges" }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("ws-1", expect.objectContaining({ name: "New Name" }))
    );

    // The form stays open and reflects the saved values
    const nameInput = screen.getByLabelText("workspace.name");
    expect(nameInput).toBeInTheDocument();
    expect(nameInput).toHaveValue("New Name");
  });

  it("disables Save once the refetched workspace prop lands (draft re-sync)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (ws: typeof workspace) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TooltipProvider>
            <WorkspaceRow workspace={ws} isAdmin onUpdate={onUpdate} onDelete={onDelete} />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(ui(workspace));

    fireEvent.click(screen.getByRole("button", { name: "workspace.edit" }));
    await waitFor(() => expect(screen.getByLabelText("workspace.name")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("workspace.name"), {
      target: { value: "New Name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "workspace.saveChanges" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());

    // Once the refetched workspace prop lands, the draft re-syncs and Save disables
    rerender(ui({ ...workspace, name: "New Name" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "workspace.saveChanges" })).toBeDisabled()
    );
  });
});
