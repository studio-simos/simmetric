// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useMe() token guard tests (DBG-03 / D-07 — login-rate-limit fix).
 *
 * Verifies the fix at packages/frontend/src/queries/useAuth.ts:49 —
 * `enabled: enabled && !!localStorage.getItem("token")` — which restores
 * the pre-migration `if (!token) return` guard and stops the
 * unauthenticated /auth/me request loop that exhausted the global
 * apiRateLimiter (200/min) on the login screen.
 *
 * Uses `React.createElement` (not JSX) so the file stays `.test.ts`.
 * Mirrors the QueryClientProvider wrapper pattern from useDocuments.test.ts.
 */

import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();

jest.mock("../queries/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
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

import { useMe, useLogin } from "../queries/useAuth";
import { queryKeys } from "../queries/keys";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useMe token guard", () => {
  let getItemSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    getItemSpy = jest.spyOn(Storage.prototype, "getItem");
  });

  afterEach(() => {
    getItemSpy.mockRestore();
  });

  it("does not fire the /auth/me request when no token is stored", () => {
    getItemSpy.mockReturnValue(null);

    const { result } = renderHook(() => useMe(), { wrapper: createWrapper() });

    // The query is disabled — apiGet must never be invoked, so no
    // unauthenticated request can hit the rate limiter.
    expect(mockApiGet).not.toHaveBeenCalled();
    // A disabled query is not loading and never starts fetching.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("does not fire even when explicitly enabled without a token", () => {
    getItemSpy.mockReturnValue(null);

    const { result } = renderHook(() => useMe(true), { wrapper: createWrapper() });

    // enabled=true alone is not enough — the token guard still wins.
    expect(mockApiGet).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("fires the /auth/me request when a token is stored", async () => {
    getItemSpy.mockImplementation((key: string) => (key === "token" ? "test-token" : null));
    mockApiGet.mockResolvedValueOnce({ id: "u1", username: "admin" });

    const { result } = renderHook(() => useMe(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiGet).toHaveBeenCalledWith("/auth/me");
    expect(result.current.data).toEqual({ id: "u1", username: "admin" });
  });
});

/**
 * useLogin invalidation tests (quick 260807-no8).
 *
 * Verifies that useLogin.onSuccess invalidates menuSections, workspaces
 * and projects so sidebar data (workspace selector) is refetched with the
 * fresh token after login — fixing the empty workspace selector that
 * followed the 401-error caches from the login screen.
 */
describe("useLogin post-login invalidation (quick 260807-no8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("invalidates menuSections, workspaces and projects on success", async () => {
    mockApiPost.mockResolvedValueOnce({ user: { id: "u1", username: "admin" }, token: "tok" });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useLogin(), { wrapper });
    await result.current.mutateAsync({ username: "admin", password: "secret" });

    // The fresh token must be stored and the user seeded into the me cache
    expect(localStorage.getItem("token")).toBe("tok");
    expect(queryClient.getQueryData(queryKeys.auth.me)).toEqual({ id: "u1", username: "admin" });
    // Sidebar data (workspaces + projects) must be invalidated alongside
    // menuSections so the selectors refetch with the fresh token.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.auth.menuSections });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.all });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.projects.all });

    invalidateSpy.mockRestore();
  });
});
