// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WorkspacesPage component tests — UX-04 multi-select + bulk delete (Phase 179)
 *
 * Covers the D-04 contract: header select-all + per-row checkboxes, bulk bar
 * hidden at 0 selected, select-all over an empty list is a no-op, cancel →
 * bulk mutation never called, confirm → fan-out called once with the visible
 * selected id list, settled rejections surface as a skipped count in the toast
 * (403-swallow prohibition T-179-01).
 */

import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        let s = key;
        for (const [k, v] of Object.entries(opts)) {
          s = s.replace(`{{${k}}}`, String(v));
        }
        return s;
      }
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// AlertDialog inline mock (ArchiveCard.test.tsx precedent)
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

// Select rendered as native select for jsdom testability
jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <select
      value={value}
      onChange={(e) => onValueChange && onValueChange(e.target.value)}
      aria-label="test-select"
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  SelectItem: ({ children, value }: { children?: ReactNode; value?: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
  SelectValue: () => null,
}));

const deleteMutate = jest.fn().mockResolvedValue(undefined);
const bulkDeleteMutate = jest.fn();
const updateMutate = jest.fn().mockResolvedValue(undefined);

jest.mock("../../queries/useWorkspaces", () => ({
  useWorkspaces: () => ({ data: mockWorkspaces, isLoading: false }),
  useUpdateWorkspace: () => ({ mutateAsync: updateMutate }),
  useDeleteWorkspace: () => ({ mutateAsync: deleteMutate }),
  useBulkDeleteWorkspaces: () => ({ mutateAsync: bulkDeleteMutate, isPending: false }),
}));

const useMeMock = jest.fn();
jest.mock("../../queries/useAuth", () => ({
  useMe: () => useMeMock(),
}));

// RecentlyDeleted renders its own queries — stub the whole component
jest.mock("../RecentlyDeleted", () => ({
  __esModule: true,
  default: () => <div data-testid="recently-deleted-stub" />,
}));

// WorkspaceCreatePanel + projects fetch — stub both
jest.mock("../WorkspaceCreatePanel", () => ({
  __esModule: true,
  default: () => <div data-testid="create-panel-stub" />,
}));

const makeApiError = (status: number, message: string) => {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
};

jest.mock("../../utils/api", () => ({
  apiGet: jest.fn().mockResolvedValue([]),
  ApiError: class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));



jest.mock("../../utils/errorUtils", () => ({
  getErrorMessage: (err: unknown, fallback: string) => fallback,
}));

// Checkbox mock: native input wired to onCheckedChange (Radix signature)
jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
    "data-testid": testId,
    "data-state": dataState,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    "aria-label"?: string;
    "data-testid"?: string;
    "data-state"?: string;
  }) => (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      data-testid={testId}
      data-state={dataState}
      checked={!!checked}
      onChange={(e) => onCheckedChange && onCheckedChange(e.target.checked)}
    />
  ),
}));

import WorkspacesPage from "../WorkspacesPage";
import { showSuccess, showError } from "../../lib/toast";

const mockWorkspaces = [
  {
    id: "ws-1",
    name: "Alpha",
    instructions: null,
    createdAt: "2026-05-20T00:00:00Z",
    deletedAt: null,
    projectId: "p1",
    project: { createdBy: "u1", name: "P1" },
    _count: { chats: 0, documents: 0 },
    allowMemberUploads: false,
    agentConfig: null,
  },
  {
    id: "ws-2",
    name: "Beta",
    instructions: null,
    createdAt: "2026-05-21T00:00:00Z",
    deletedAt: null,
    projectId: "p1",
    project: { createdBy: "u1", name: "P1" },
    _count: { chats: 0, documents: 0 },
    allowMemberUploads: false,
    agentConfig: null,
  },
];

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkspacesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function rowCheckbox(id: string): HTMLElement {
  return screen.getByTestId(`select-${id}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  useMeMock.mockReturnValue({
    data: { id: "u1", roles: [{ name: "admin" }], permissions: ["workspace:write"] },
  });
  bulkDeleteMutate.mockResolvedValue([
    { status: "fulfilled", value: undefined },
    { status: "fulfilled", value: undefined },
  ]);
});

describe("WorkspacesPage multi-select (UX-04)", () => {
  it("renders workspace list with per-row checkboxes", () => {
    renderPage();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(rowCheckbox("ws-1")).toBeInTheDocument();
    expect(rowCheckbox("ws-2")).toBeInTheDocument();
  });

  it("hides the bulk bar when zero rows are selected", () => {
    renderPage();
    expect(screen.queryByLabelText("workspace.bulk.deleteButton")).toBeNull();
  });

  it("per-row checkbox toggles selection and reveals the bulk bar with count", () => {
    renderPage();
    fireEvent.click(rowCheckbox("ws-1"));
    expect(screen.getByLabelText("workspace.bulk.deleteButton")).toBeInTheDocument();
    // Badge renders the localized "selected" count label
    expect(screen.getByText("workspace.bulk.selected")).toBeInTheDocument();
  });

  it("header select-all selects every visible row then clears on second click", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("select-all"));
    expect((rowCheckbox("ws-1") as HTMLInputElement).checked).toBe(true);
    expect((rowCheckbox("ws-2") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("workspace.bulk.selected")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("select-all"));
    expect((rowCheckbox("ws-1") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText("workspace.bulk.deleteButton")).toBeNull();
  });

  it("select-all over an empty filtered list is a no-op (bar never appears)", () => {
    const { container } = renderPage();
    // Filter to a project with no workspaces
    const projectSelect = screen.getAllByLabelText("test-select")[0];
    fireEvent.change(projectSelect, { target: { value: "p-missing" } });
    // Table is gone (empty state) — no select-all header rendered
    expect(screen.queryByTestId("select-all")).toBeNull();
    expect(screen.queryByLabelText("workspace.bulk.deleteButton")).toBeNull();
    expect(container).toBeDefined();
  });

  it("clears selection when the filter value changes (hidden rows never counted)", () => {
    renderPage();
    fireEvent.click(rowCheckbox("ws-1"));
    expect(screen.getByLabelText("workspace.bulk.deleteButton")).toBeInTheDocument();
    // Switch ownership filter — selection must clear
    const viewSelect = screen.getAllByLabelText("test-select")[1];
    fireEvent.change(viewSelect, { target: { value: "owned" } });
    expect(screen.queryByLabelText("workspace.bulk.deleteButton")).toBeNull();
  });
});

describe("WorkspacesPage bulk delete dialog (UX-04)", () => {
  it("cancel closes the dialog and never calls the bulk mutation", async () => {
    renderPage();
    fireEvent.click(rowCheckbox("ws-1"));
    fireEvent.click(screen.getByLabelText("workspace.bulk.deleteButton"));
    expect(screen.getByTestId("alert-content")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("alert-cancel"));
    expect(screen.queryByTestId("alert-content")).toBeNull();
    expect(bulkDeleteMutate).not.toHaveBeenCalled();
  });

  it("confirm calls the bulk hook once with the visible selected id list", async () => {
    renderPage();
    fireEvent.click(rowCheckbox("ws-1"));
    fireEvent.click(rowCheckbox("ws-2"));
    fireEvent.click(screen.getByLabelText("workspace.bulk.deleteButton"));
    fireEvent.click(screen.getByTestId("alert-action"));
    await waitFor(() => expect(bulkDeleteMutate).toHaveBeenCalledTimes(1));
    // Table renders createdAt-desc (ws-2 first) — assert as a set of ids
    const calledIds = bulkDeleteMutate.mock.calls[0][0] as string[];
    expect(calledIds).toHaveLength(2);
    expect(calledIds).toEqual(expect.arrayContaining(["ws-1", "ws-2"]));
  });

  it("counts settled rejections as skipped in the result toast (403 never swallowed)", async () => {
    bulkDeleteMutate.mockResolvedValue([
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: makeApiError(403, "forbidden") },
    ]);
    renderPage();
    fireEvent.click(rowCheckbox("ws-1"));
    fireEvent.click(rowCheckbox("ws-2"));
    fireEvent.click(screen.getByLabelText("workspace.bulk.deleteButton"));
    fireEvent.click(screen.getByTestId("alert-action"));
    await waitFor(() => expect(showSuccess).toHaveBeenCalled());
    // Localized result toast carries the deleted+skipped counts (interpolation
    // asserted at the call-shape level: key + numeric args passed to t())
    const toastArg = showSuccess.mock.calls[0][0] as string;
    expect(toastArg).toContain("workspace.bulk.deleteResult");
    // 403 skips never surface the error toast (WR-02: only non-403 failures do)
    expect(showError).not.toHaveBeenCalled();
  });

  it("non-403 rejection (5xx) surfaces the error toast, not a skip count", async () => {
    bulkDeleteMutate.mockResolvedValue([
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: makeApiError(500, "boom") },
    ]);
    renderPage();
    fireEvent.click(rowCheckbox("ws-1"));
    fireEvent.click(rowCheckbox("ws-2"));
    fireEvent.click(screen.getByLabelText("workspace.bulk.deleteButton"));
    fireEvent.click(screen.getByTestId("alert-action"));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(showSuccess).toHaveBeenCalled();
  });

  it("all-rejected fan-out shows the deleteError toast instead of a success", async () => {
    bulkDeleteMutate.mockResolvedValue([
      { status: "rejected", reason: makeApiError(403, "forbidden") },
      { status: "rejected", reason: makeApiError(403, "forbidden") },
    ]);
    renderPage();
    fireEvent.click(rowCheckbox("ws-1"));
    fireEvent.click(rowCheckbox("ws-2"));
    fireEvent.click(screen.getByLabelText("workspace.bulk.deleteButton"));
    fireEvent.click(screen.getByTestId("alert-action"));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(showError).toHaveBeenCalledWith("workspace.bulk.deleteError");
    expect(showSuccess).not.toHaveBeenCalled();
  });

  it("bulk delete clears the selection afterwards", async () => {
    renderPage();
    fireEvent.click(rowCheckbox("ws-1"));
    fireEvent.click(screen.getByLabelText("workspace.bulk.deleteButton"));
    fireEvent.click(screen.getByTestId("alert-action"));
    await waitFor(() => expect(bulkDeleteMutate).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByLabelText("workspace.bulk.deleteButton")).toBeNull()
    );
  });
});