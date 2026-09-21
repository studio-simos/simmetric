// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.

/**
 * Phase 193 LDAP query-hook contract tests (193-04 Task 1).
 *
 * Pins the three new hooks on their wire contracts (the endpoints Plan 05
 * / Plan 03 implement — MOCKED here per the plan's coupling_justified note):
 *
 * - useLdapLogin — POST /auth/ldap/login carrying { username, password };
 *   onSuccess stores the token under the SAME `token` localStorage key and
 *   seeds/invalidates exactly what useLogin does (storage-parity contract).
 * - useTestLdapConnection — POST /sso/ldap/test → structured diagnostics
 *   { reachable, bindOk, userFound, groupsFound, groupCount? }.
 * - useLdapMap / usePutLdapMap — GET/PUT /sso/ldap/map; the PUT invalidates
 *   the sso.config + sso.ldapMap keys (no new key family).
 */

import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockApiGet = jest.fn();
const mockApiPut = jest.fn();
const mockApiFetch = jest.fn();

jest.mock("../queries/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPut: (...args: unknown[]) => mockApiPut(...args),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  useLdapLogin,
  useTestLdapConnection,
  useLdapMap,
  usePutLdapMap,
} from "../queries/useSso";
import { queryKeys } from "../queries/keys";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useLdapLogin (Phase 193, D-18)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it("POSTs { username, password } to /auth/ldap/login", async () => {
    mockApiFetch.mockResolvedValueOnce({
      user: { id: "u1", username: "ldapuser" },
      token: "ldap-tok",
    });

    const { result } = renderHook(() => useLdapLogin(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ username: "ldapuser", password: "secret" });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith("/auth/ldap/login", {
      method: "POST",
      body: JSON.stringify({ username: "ldapuser", password: "secret" }),
    });
  });

  it("stores the token with the same localStorage key/semantics as useLogin and seeds the me cache", async () => {
    const user = { id: "u1", username: "ldapuser" };
    mockApiFetch.mockResolvedValueOnce({ user, token: "ldap-tok" });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useLdapLogin(), { wrapper });
    await result.current.mutateAsync({ username: "ldapuser", password: "secret" });

    // Storage parity with useLogin (useAuth.ts:81) — SAME key, seeded me cache.
    expect(localStorage.getItem("token")).toBe("ldap-tok");
    expect(queryClient.getQueryData(queryKeys.auth.me)).toEqual(user);
    // Same invalidation family as useLogin (quick 260807-no8 contract).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.auth.menuSections });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.all });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.projects.all });

    invalidateSpy.mockRestore();
  });
});

describe("useTestLdapConnection (Phase 193, D-16)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("POSTs to /sso/ldap/test and returns the structured diagnostics shape", async () => {
    const diagnostics = {
      reachable: true,
      bindOk: true,
      userFound: true,
      groupsFound: true,
      groupCount: 3,
    };
    mockApiFetch.mockResolvedValueOnce(diagnostics);

    const { result } = renderHook(() => useTestLdapConnection(), {
      wrapper: createWrapper(),
    });

    const data = await result.current.mutateAsync();

    expect(mockApiFetch).toHaveBeenCalledWith("/sso/ldap/test", { method: "POST" });
    expect(data).toEqual(diagnostics);
    // Stage NAMES only — the shape carries booleans + a count, never raw
    // LDAP server error strings (T-193-12).
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(["reachable", "bindOk", "userFound", "groupsFound"]),
    );
  });
});

describe("useLdapMap / usePutLdapMap (Phase 193, D-19)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("GETs /sso/ldap/map and exposes the mappings list", async () => {
    const mappings = [{ ldapGroupDn: "cn=admins,ou=groups,dc=x", roleId: "r1" }];
    mockApiGet.mockResolvedValueOnce({ mappings });

    const { result } = renderHook(() => useLdapMap(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiGet).toHaveBeenCalledWith("/sso/ldap/map");
    expect(result.current.data).toEqual({ mappings });
  });

  it("PUTs the full staged list to /sso/ldap/map and invalidates sso.config + sso.ldapMap", async () => {
    const mappings = [{ ldapGroupDn: "cn=admins,ou=groups,dc=x", roleId: "r1" }];
    mockApiPut.mockResolvedValueOnce({ mappings });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => usePutLdapMap(), { wrapper });
    await result.current.mutateAsync({ mappings });

    expect(mockApiPut).toHaveBeenCalledWith("/sso/ldap/map", { mappings });
    // Reuses the sso family — no new key family (VALIDATION planner note).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.sso.config });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.sso.ldapMap });

    invalidateSpy.mockRestore();
  });
});