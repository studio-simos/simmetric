// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-03, D-19): SettingsWorkspaceAccess admin panel tests.
 *
 * Pins: panel renders the workspace list; grant action calls the
 * useGrantWorkspaceAccess mutation with {userId, role}; bulk grant calls
 * useBulkGrantWorkspaceAccess with {userIds, role} and the partial-failure
 * toast lists failed usernames (D-17 client contract); revoke calls
 * useRevokeWorkspaceAccess.
 */
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => {
      if (opts && typeof opts === "object" && "failed" in (opts as Record<string, unknown>))
        return `${key}:${(opts as Record<string, unknown>).failed}`;
      if (opts && typeof opts === "object" && "name" in (opts as Record<string, unknown>))
        return `${key}:${(opts as Record<string, unknown>).name}`;
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

// Direct api calls (workspace list + user search) mocked — the panel's
// own loadData path; access CRUD must ride the HOOKS (D-20 golden rule),
// mocked below.
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

jest.mock("../components/WorkspaceAccessDialog", () => ({
  displayName: (u: { username: string; firstName: string | null; lastName: string | null }) =>
    `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.username,
}));

jest.mock("@/components/ui/select", () => {
  const native = ({ children, value, onValueChange, "aria-label": ariaLabel }: { children?: ReactNode; value?: string; onValueChange?: (v: string) => void; "aria-label"?: string }) => (
    <select value={value} aria-label={ariaLabel} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
      {children}
    </select>
  );
  return {
    Select: native,
    SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
    SelectItem: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
    // The trigger renders OUTSIDE the native <select> in the real UI; in the
    // mock it is display-only. The accessible name lives on the mock
    // <select> itself (aria-label passthrough on Select).
    SelectTrigger: ({ children, ...rest }: { children?: ReactNode; "aria-label"?: string }) => (
      <span data-testid="select-trigger" aria-label={(rest as { "aria-label"?: string })["aria-label"]}>
        {children}
      </span>
    ),
    SelectValue: () => null,
  };
});

jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange }: { checked?: boolean; onCheckedChange?: () => void }) => (
    <input type="checkbox" role="checkbox" checked={!!checked} onChange={onCheckedChange} />
  ),
}));

import SettingsWorkspaceAccess from "../components/SettingsWorkspaceAccess";

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { TooltipProvider } = require("@/components/ui/tooltip");
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SettingsWorkspaceAccess />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const WORKSPACES = [
  { id: "ws-1", name: "Alpha", createdAt: "2026-01-01T00:00:00Z", deletedAt: null, projectId: "p1" },
  { id: "ws-2", name: "Beta", createdAt: "2026-01-02T00:00:00Z", deletedAt: null, projectId: "p1" },
];

const USERS = [
  { id: "user-1", username: "alice", email: "a@t.co", firstName: "Alice", lastName: "Smith" },
  { id: "user-2", username: "bob", email: "b@t.co", firstName: null, lastName: null },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/workspaces") return Promise.resolve(WORKSPACES);
    if (path === "/auth/users") return Promise.resolve(USERS);
    return Promise.reject(new Error("unexpected path: " + path));
  });
  mockBulkMutateAsync.mockResolvedValue({ granted: 1, failed: [] });
});

describe("SettingsWorkspaceAccess (D-19)", () => {
  it("renders the workspace list (per-workspace view)", async () => {
    renderPanel();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("expand → grant action calls the grant mutation hook with {userId, role}", async () => {
    renderPanel();
    // Expand the Alpha row (the chevron button carries the grantTitle label).
    fireEvent.click(await screen.findByRole("button", { name: "settings.workspaceAccess.grantTitle:Alpha" }));
    // Pick a user in the single-grant select, then click Grant.
    fireEvent.change(screen.getByRole("combobox", { name: "workspace.access.selectUser" }), {
      target: { value: "user-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.workspaceAccess.grant" }));
    await waitFor(() => {
      expect(mockGrantMutateAsync).toHaveBeenCalledWith({ userId: "user-2", role: "viewer" });
    });
  });

  it("revoke calls the revoke mutation hook", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "settings.workspaceAccess.grantTitle:Alpha" }));
    fireEvent.click(await screen.findByRole("button", { name: "settings.workspaceAccess.revoke" }));
    await waitFor(() => {
      expect(mockRevokeMutateAsync).toHaveBeenCalledWith("user-granted-1");
    });
  });

  it("bulk grant invokes useBulkGrantWorkspaceAccess with the multi-select + role", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "settings.workspaceAccess.grantTitle:Alpha" }));
    // Check alice (first grantable user) in the bulk list, set the bulk role
    // to editor, click Bulk grant.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.change(screen.getByRole("combobox", { name: "settings.workspaceAccess.grantBulk" }), {
      target: { value: "editor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.workspaceAccess.grantBulk" }));
    await waitFor(() => {
      expect(mockBulkMutateAsync).toHaveBeenCalledWith({ userIds: ["user-1"], role: "editor" });
    });
  });

  it("bulk partial failure toast lists failed usernames (D-17 client contract)", async () => {
    mockBulkMutateAsync.mockResolvedValue({ granted: 0, failed: [{ userId: "user-1", error: "gone" }] });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "settings.workspaceAccess.grantTitle:Alpha" }));
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: "settings.workspaceAccess.grantBulk" }));
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith("settings.workspaceAccess.bulkPartial:alice");
    });
  });

  // 189-REVIEW WR-05: a /workspaces or /auth/users failure must NOT present
  // as an empty grantable list — a load-error banner with retry renders.
  it("load failure surfaces the error banner with a retry affordance (WR-05)", async () => {
    mockApiGet.mockImplementation((path: string) =>
      Promise.reject(new Error("boom: " + path)));
    renderPanel();
    expect(await screen.findByTestId("workspace-access-load-error")).toBeInTheDocument();
    // The retry affordance re-invokes loadData.
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(mockApiGet.mock.calls.length).toBeGreaterThanOrEqual(4); // 2 initial + 2 retry
    });
  });

  it("retry after a transient failure recovers to the workspace list (WR-05)", async () => {
    let calls = 0;
    mockApiGet.mockImplementation((path: string) => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error("transient"));
      return path === "/workspaces"
        ? Promise.resolve(WORKSPACES)
        : Promise.resolve(USERS);
    });
    renderPanel();
    expect(await screen.findByTestId("workspace-access-load-error")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-access-load-error")).not.toBeInTheDocument();
  });
});