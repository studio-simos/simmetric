// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-03, D-20): WorkspaceAccessDialog extension tests.
 *
 * EXTENDS the pre-existing dialog coverage (16141df2; the WorkspacesPage
 * suite mocks this component — its own interaction flows live here):
 *  - role Select passes {userId, role} to the grant hook (D-20)
 *  - bulk grant invokes useBulkGrantWorkspaceAccess (+ partial-failure
 *    toast lists failed usernames)
 *  - the pre-existing grant/revoke flow still works (reconciliation guard)
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => {
      if (opts && typeof opts === "object" && "failed" in (opts as Record<string, unknown>))
        return `${key}:${(opts as Record<string, unknown>).failed}`;
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
jest.mock("../lib/toast", () => ({
  showSuccess: (...args: unknown[]) => mockShowSuccess(...args),
  showError: (...args: unknown[]) => mockShowError(...args),
}));

jest.mock("../utils/errorUtils", () => ({
  getErrorMessage: (err: unknown, fallback: string) => fallback,
}));

const mockApiGet = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: Parameters<typeof mockApiGet>) => mockApiGet(...args),
}));

const mockGrantMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockRevokeMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockBulkMutateAsync = jest.fn();

jest.mock("../queries/useWorkspaces", () => ({
  useWorkspaceAccess: jest.fn(() => ({
    data: [
      {
        userId: "user-granted-1",
        workspaceId: "ws-1",
        role: "editor",
        grantedAt: "2026-09-15T00:00:00Z",
        grantedBy: null,
        user: { id: "user-granted-1", username: "granted1", email: "g1@t.co", firstName: null, lastName: null },
      },
    ],
    isLoading: false,
  })),
  useGrantWorkspaceAccess: jest.fn(() => ({
    mutateAsync: mockGrantMutateAsync,
    isPending: false,
  })),
  useRevokeWorkspaceAccess: jest.fn(() => ({
    mutateAsync: mockRevokeMutateAsync,
    isPending: false,
  })),
  useBulkGrantWorkspaceAccess: jest.fn(() => ({
    mutateAsync: mockBulkMutateAsync,
    isPending: false,
  })),
}));

jest.mock("@/components/ui/select", () => {
  const native = ({ children, value, onValueChange, "aria-label": ariaLabel }: { children?: React.ReactNode; value?: string; onValueChange?: (v: string) => void; "aria-label"?: string }) => (
    <select value={value} aria-label={ariaLabel} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
      {children}
    </select>
  );
  return {
    Select: native,
    SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children, value }: { children?: React.ReactNode; value?: string }) => <option value={value}>{children}</option>,
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
    SelectValue: () => null,
  };
});

jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange }: { checked?: boolean; onCheckedChange?: () => void }) => (
    <input type="checkbox" role="checkbox" checked={!!checked} onChange={onCheckedChange} />
  ),
}));

import WorkspaceAccessDialog from "../components/WorkspaceAccessDialog";

const USERS = [
  { id: "user-1", username: "alice", email: "a@t.co", firstName: "Alice", lastName: "Smith" },
  { id: "user-2", username: "bob", email: "b@t.co", firstName: null, lastName: null },
];

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { TooltipProvider } = require("@/components/ui/tooltip");
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WorkspaceAccessDialog
          open
          onOpenChange={jest.fn()}
          workspaceId="ws-1"
          workspaceName="Alpha"
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApiGet.mockResolvedValue(USERS);
  mockBulkMutateAsync.mockResolvedValue({ granted: 1, failed: [] });
});

describe("WorkspaceAccessDialog (D-20 extension)", () => {
  it("role Select renders; grant passes {userId, role} to the grant hook", async () => {
    renderDialog();
    // Users load asynchronously (mount-with-open effect) — wait for the
    // option to render, then select bob and set the role.
    await screen.findByRole("option", { name: "bob" });
    fireEvent.change(screen.getByRole("combobox", { name: "workspace.access.selectUser" }), {
      target: { value: "user-2" },
    });
    const roleSelect = screen.getAllByRole("combobox", { name: "workspace.access.role" })[0];
    fireEvent.change(roleSelect, { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: "workspace.access.grantButton" }));

    await waitFor(() => {
      expect(mockGrantMutateAsync).toHaveBeenCalledWith({ userId: "user-2", role: "editor" });
    });
  });

  it("bulk grant invokes useBulkGrantWorkspaceAccess with {userIds, role}", async () => {
    renderDialog();
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    const bulkRoleSelect = screen.getAllByRole("combobox", { name: "workspace.access.role" })[1];
    fireEvent.change(bulkRoleSelect, { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.workspaceAccess.grantBulk" }));
    await waitFor(() => {
      expect(mockBulkMutateAsync).toHaveBeenCalledWith({ userIds: ["user-1"], role: "viewer" });
    });
  });

  it("bulk partial failure toast lists failed usernames", async () => {
    mockBulkMutateAsync.mockResolvedValue({ granted: 0, failed: [{ userId: "user-1", error: "gone" }] });
    renderDialog();
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: "settings.workspaceAccess.grantBulk" }));
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith("settings.workspaceAccess.bulkPartial:alice");
    });
  });

  it("current grants list shows the role badge (D-15 shape consumed)", async () => {
    renderDialog();
    expect(await screen.findAllByText("workspace.access.roleEditor")).not.toHaveLength(0);
  });

  // 189-REVIEW WR-05: a failed /auth/users fetch must not present as an
  // empty grantable list — the dialog renders a load-error row with retry.
  it("user-list load failure surfaces the error row with a retry affordance (WR-05)", async () => {
    mockApiGet.mockRejectedValue(new Error("boom"));
    renderDialog();
    expect(await screen.findByTestId("workspace-access-users-load-error")).toBeInTheDocument();
    // Retry re-invokes loadUsers (recovers against a healthy mock).
    mockApiGet.mockResolvedValue(USERS);
    fireEvent.click(screen.getByRole("button", { name: "workspace.access.retryUsers" }));
    expect(await screen.findByRole("option", { name: "bob" })).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-access-users-load-error")).not.toBeInTheDocument();
  });
});