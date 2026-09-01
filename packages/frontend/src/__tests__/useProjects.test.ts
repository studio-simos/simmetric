// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useProjects() enabled-param guard tests (quick 260807-no8).
 *
 * Verifies the fix at packages/frontend/src/queries/useProjects.ts —
 * `useProjects(enabled = true)` — which gates the GET /api/projects
 * query on auth. Before the fix App.tsx called useProjects() and
 * useWorkspaces() unconditionally at the top of the component, so on
 * the login screen (no token) both fired unauthenticated → the server
 * returned 401 → TanStack Query cached the error state, and after
 * login the errored queries were never refetched, leaving the sidebar
 * workspace selector empty.
 *
 * Uses `React.createElement` (not JSX) so the file stays `.test.ts`.
 * Mirrors the QueryClientProvider wrapper pattern from useAuth.test.ts.
 */

import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockApiGet = jest.fn();

// useProjects imports from ./api (the queries re-export); useWorkspaces
// imports apiGet directly from ../utils/api — mock both so the queryFn
// is intercepted for both hooks.
jest.mock("../queries/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: jest.fn(),
  apiPut: jest.fn(),
  apiUpload: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

jest.mock("../utils/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: jest.fn(),
  apiPut: jest.fn(),
  apiDelete: jest.fn(),
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { useProjects } from "../queries/useProjects";
import { useWorkspaces } from "../queries/useWorkspaces";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useProjects enabled guard (quick 260807-no8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not fire GET /projects when disabled (login-screen 401 path eliminated)", () => {
    const { result } = renderHook(() => useProjects(false), {
      wrapper: createWrapper(),
    });

    // A disabled query must never invoke apiGet — no unauthenticated
    // request can hit the server or the rate limiter.
    expect(mockApiGet).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isLoading).toBe(false);
  });

  it("fires GET /projects and returns the project list when enabled", async () => {
    mockApiGet.mockResolvedValueOnce([
      { id: "p1", name: "Project A" },
      { id: "p2", name: "Project B" },
    ]);

    const { result } = renderHook(() => useProjects(true), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiGet).toHaveBeenCalledWith("/projects");
    expect(result.current.data).toEqual([
      { id: "p1", name: "Project A" },
      { id: "p2", name: "Project B" },
    ]);
  });

  it("defaults to enabled so existing call sites keep fetching", async () => {
    mockApiGet.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useProjects(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiGet).toHaveBeenCalledWith("/projects");
  });
});

describe("useWorkspaces enabled guard (quick 260807-no8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not fire GET /workspaces when disabled", () => {
    const { result } = renderHook(() => useWorkspaces(false), {
      wrapper: createWrapper(),
    });

    expect(mockApiGet).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("fires GET /workspaces when enabled", async () => {
    mockApiGet.mockResolvedValueOnce([{ id: "w1", name: "Workspace A" }]);

    const { result } = renderHook(() => useWorkspaces(true), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiGet).toHaveBeenCalledWith("/workspaces");
  });
});
