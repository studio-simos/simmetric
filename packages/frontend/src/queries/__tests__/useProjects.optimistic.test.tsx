// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useCreateProject optimistic-mutation integration tests — Feature 7.3 Slice B
 * (quick task 260714-phg).
 *
 * Verifies the optimistic cache contract introduced in Slice B:
 *  1. onMutate: cancelQueries, snapshot cache, insert a temp project (id starts
 *     with "temp-") so the sidebar selector updates immediately.
 *  2. onError: rollback to the pre-mutation snapshot (temp removed) when the
 *     API rejects.
 *  3. onSuccess: invalidateQueries is called so the real server record replaces
 *     the temp on refetch.
 *
 * We mock ../api (apiPost + ApiError) and drive a real QueryClient via
 * renderHook so the cache mutations are observable through queryClient.
 * Repo convention: NO snapshots.
 */
import "@testing-library/jest-dom";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Mock the api module so useCreateProject's mutationFn is controllable. We
// export a class-style ApiError so `new ApiError(...)` works with instanceof.
const mockApiPost = jest.fn();
jest.mock("../api", () => ({
  apiPost: (...args: unknown[]) => mockApiPost(...args),
  apiGet: jest.fn(),
  apiPut: jest.fn(),
  apiPatch: jest.fn(),
  apiDelete: jest.fn(),
  apiUpload: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

import { useCreateProject } from "../useProjects";
import { queryKeys } from "../keys";
import type { Project } from "@simmetric-chat/shared";

const projectA: Project = {
  id: "p-a",
  name: "Project A",
  description: null,
  createdBy: "u-1",
  deletedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const projectB: Project = {
  id: "p-b",
  name: "Project B",
  description: null,
  createdBy: "u-1",
  deletedAt: null,
  createdAt: new Date("2026-01-02"),
  updatedAt: new Date("2026-01-02"),
};

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client },
      children,
    );
  };
}

afterEach(() => {
  mockApiPost.mockReset();
});

describe("useCreateProject optimistic mutation", () => {
  it("optimistically inserts a temp-* project into the cache on mutate", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // Pre-seed cache with [projectA]
    client.setQueryData<Project[]>(queryKeys.projects.all, [projectA]);
    // Delay the API resolve so we can observe the temp before it's replaced.
    mockApiPost.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(projectB), 50)),
    );

    const { result } = renderHook(() => useCreateProject(), {
      wrapper: makeWrapper(client),
    });

    act(() => {
      result.current.mutate({ name: "New" });
    });

    // While the API is in flight, the cache should contain A + temp-* project.
    await waitFor(() => {
      const cache = client.getQueryData<Project[]>(queryKeys.projects.all) ?? [];
      expect(cache).toHaveLength(2);
      expect(cache[0]).toEqual(projectA);
      expect(cache[1]?.id.startsWith("temp-")).toBe(true);
      expect(cache[1]?.name).toBe("New");
    });

    // Wait for the mutation to settle so act() warnings stay quiet.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back to the snapshot when the API rejects (500)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData<Project[]>(queryKeys.projects.all, [projectA]);
    mockApiPost.mockRejectedValue(new Error("fail"));

    const { result } = renderHook(() => useCreateProject(), {
      wrapper: makeWrapper(client),
    });

    act(() => {
      result.current.mutate({ name: "New" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const cache = client.getQueryData<Project[]>(queryKeys.projects.all) ?? [];
    // Temp project must be gone — cache rolled back to [projectA].
    expect(cache).toHaveLength(1);
    expect(cache[0]).toEqual(projectA);
    expect(cache.find((p) => p.id.startsWith("temp-"))).toBeUndefined();
  });

  it("invalidates the projects query on success so the real record refetches", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData<Project[]>(queryKeys.projects.all, [projectA]);
    mockApiPost.mockResolvedValue(projectB);

    const invalidateSpy = jest.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useCreateProject(), {
      wrapper: makeWrapper(client),
    });

    act(() => {
      result.current.mutate({ name: "Project B" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.projects.all }),
    );
    invalidateSpy.mockRestore();
  });
});