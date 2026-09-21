// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WorkspaceRow DLP toggle tests — Phase 192 (D-05, UI-SPEC interaction rule 1).
 *
 * Contract under test:
 *  - The DLP Switch renders in the expanded editor with the optimistic flip
 *    (onCheckedChange → onUpdate with { dlpDocumentScanEnabled }).
 *  - Gate-blocked arm: gate not passed AND toggle off → Switch disabled +
 *    gateBlocked helper visible (workspace.dlp.gateBlocked).
 *  - An already-ON toggle is NEVER disabled, even when the gate has not
 *    passed — turning OFF is never blocked (UI-SPEC rule 1).
 *  - Save error → optimistic revert + showError(workspace.dlp.saveError).
 *  - Undefined gate (prop absent) is treated as NOT passed (fail-closed).
 */
import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import WorkspaceRow from "../WorkspaceRow";

// Mock i18next (identity t — keys asserted literally, repo component-test style)
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

// Mock AlertDialog to render inline (WorkspaceRow.test.tsx precedent)
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

// Mock IconPicker (avoids radix Popover in jsdom)
jest.mock("../IconPicker", () => ({
  __esModule: true,
  IconPicker: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <input aria-label="icon" value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

// Mock WorkspaceAccessDialog (renders its own queries)
jest.mock("../WorkspaceAccessDialog", () => ({
  __esModule: true,
  default: () => <div data-testid="workspace-access-dialog-stub" />,
}));

import { apiGet } from "../../utils/api";

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
  dlpDocumentScanEnabled: false,
  agentConfig: null,
};

/** Expand the row editor so the DLP toggle row is in the DOM. */
async function expandEditor() {
  fireEvent.click(screen.getByRole("button", { name: "workspace.edit" }));
  await waitFor(() => expect(screen.getByTestId("dlp-scan-toggle-row")).toBeInTheDocument());
}

/** The DLP Switch carries the workspace.dlp.scanToggle aria-label. */
function dlpSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "workspace.dlp.scanToggle" });
}

describe("WorkspaceRow DLP toggle (Phase 192, D-05)", () => {
  const onUpdate = jest.fn();
  const onDelete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["workspace:write"] } });
    (apiGet as jest.Mock).mockResolvedValue([]);
    onUpdate.mockResolvedValue(undefined);
    onDelete.mockResolvedValue(undefined);
  });

  it("renders the DLP toggle row in the expanded editor with helper copy", async () => {
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} dlpGatePassed />
    );
    await expandEditor();

    expect(screen.getByText("workspace.dlp.scanToggle")).toBeInTheDocument();
    expect(screen.getByText("workspace.dlp.scanDescription")).toBeInTheDocument();
    expect(screen.getByText("workspace.dlp.disabled")).toBeInTheDocument();
  });

  it("gate not passed + toggle off → Switch disabled + gateBlocked helper visible", async () => {
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} dlpGatePassed={false} />
    );
    await expandEditor();

    expect(dlpSwitch()).toBeDisabled();
    expect(screen.getByTestId("dlp-gate-blocked")).toBeInTheDocument();
    expect(screen.getByText("workspace.dlp.gateBlocked")).toBeInTheDocument();
  });

  it("undefined gate (prop absent) is treated as not-passed fail-closed", async () => {
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} />
    );
    await expandEditor();

    expect(dlpSwitch()).toBeDisabled();
    expect(screen.getByTestId("dlp-gate-blocked")).toBeInTheDocument();
  });

  it("toggle ON + gate not passed → Switch enabled (turning OFF is never blocked)", async () => {
    renderWithProvider(
      <WorkspaceRow
        workspace={{ ...workspace, dlpDocumentScanEnabled: true }}
        isAdmin
        onUpdate={onUpdate}
        onDelete={onDelete}
        dlpGatePassed={false}
      />
    );
    await expandEditor();

    expect(dlpSwitch()).toBeEnabled();
    // The gate-blocked helper only targets the enablement direction — an
    // already-on toggle shows the plain status line instead.
    expect(screen.queryByTestId("dlp-gate-blocked")).not.toBeInTheDocument();
  });

  it("gate passed + toggle off → Switch enabled (no gateBlocked helper)", async () => {
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} dlpGatePassed />
    );
    await expandEditor();

    expect(dlpSwitch()).toBeEnabled();
    expect(screen.queryByTestId("dlp-gate-blocked")).not.toBeInTheDocument();
  });

  it("onCheckedChange calls onUpdate with dlpDocumentScanEnabled (optimistic flip)", async () => {
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} dlpGatePassed />
    );
    await expandEditor();

    fireEvent.click(dlpSwitch());
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("ws-1", { dlpDocumentScanEnabled: true })
    );
    // Optimistic: the status line flips to enabled immediately
    expect(screen.getByText("workspace.dlp.enabled")).toBeInTheDocument();
  });

  it("save error reverts the optimistic flip and fires the saveError toast", async () => {
    onUpdate.mockRejectedValueOnce(new Error("500"));
    renderWithProvider(
      <WorkspaceRow workspace={workspace} isAdmin onUpdate={onUpdate} onDelete={onDelete} dlpGatePassed />
    );
    await expandEditor();

    fireEvent.click(dlpSwitch());
    await waitFor(() => expect(showError).toHaveBeenCalledWith("workspace.dlp.saveError"));
    // Reverted to the server truth (off)
    await waitFor(() => expect(screen.getByText("workspace.dlp.disabled")).toBeInTheDocument());
  });

  it("re-syncs the toggle when the refetched workspace prop lands", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (ws: typeof workspace) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TooltipProvider>
            <WorkspaceRow workspace={ws} isAdmin onUpdate={onUpdate} onDelete={onDelete} dlpGatePassed />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(ui(workspace));
    await expandEditor();

    fireEvent.click(dlpSwitch());
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());

    // The refetched prop lands with the saved value — the optimistic state
    // re-syncs from server truth.
    rerender(ui({ ...workspace, dlpDocumentScanEnabled: true }));
    await waitFor(() => expect(screen.getByText("workspace.dlp.enabled")).toBeInTheDocument());
  });

  it("non-admin rows never render the DLP toggle row", () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: [] } });
    renderWithProvider(
      <WorkspaceRow
        workspace={{ ...workspace, project: { createdBy: "someone-else", name: "P" } }}
        onUpdate={onUpdate}
        onDelete={onDelete}
        currentUserId="u1"
        dlpGatePassed
      />
    );
    // Non-editable row: no edit affordance (canEdit gate) → the expanded
    // editor — and with it the admin-only DLP toggle row — never renders.
    expect(screen.queryByRole("button", { name: "workspace.edit" })).toBeNull();
    expect(screen.getByText("workspace.readOnly")).toBeInTheDocument();
    expect(screen.queryByTestId("dlp-scan-toggle-row")).not.toBeInTheDocument();
  });
});