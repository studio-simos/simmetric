// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for useRenameSynthesisRun TanStack Query mutation (SYN-03 frontend).
 *
 * Verifies:
 * - mutate() calls apiPatch with "/synthesis/:runId/rename" and { name }
 * - onSuccess invalidates synthesis.pendingRuns() + synthesis.detail(runId)
 * - SynthesisRunData includes a non-optional name: string field
 */

import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockApiPatch = jest.fn();
const mockInvalidate = jest.fn();

jest.mock("../queries/api", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiDelete: jest.fn(),
  apiPatch: (...args: unknown[]) => mockApiPatch(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

jest.mock("../queries/keys", () => ({
  queryKeys: {
    synthesis: {
      pendingRuns: () => ["synthesis", "pendingRuns", "global"],
      detail: (id: string) => ["synthesis", "detail", id],
    },
  },
}));

import { useRenameSynthesisRun, type SynthesisRunData } from "../queries/useSynthesis";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Spy on invalidateQueries to assert the invalidation contract.
  jest.spyOn(queryClient, "invalidateQueries").mockImplementation((...args: unknown[]) => {
    mockInvalidate(...args);
    return Promise.resolve();
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useRenameSynthesisRun", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls apiPatch with /synthesis/:runId/rename and { name }", async () => {
    mockApiPatch.mockResolvedValueOnce(undefined);
    const wrapper = createWrapper();
    const { result } = renderHook(() => useRenameSynthesisRun(), { wrapper });

    await result.current.mutateAsync({ runId: "r1", name: "New" });

    expect(mockApiPatch).toHaveBeenCalledWith("/synthesis/r1/rename", { name: "New" });
  });

  it("invalidates pendingRuns + detail on success", async () => {
    mockApiPatch.mockResolvedValueOnce(undefined);
    const wrapper = createWrapper();
    const { result } = renderHook(() => useRenameSynthesisRun(), { wrapper });

    await result.current.mutateAsync({ runId: "r1", name: "New" });

    await waitFor(() => {
      // Two invalidate calls: pendingRuns() and detail(runId)
      expect(mockInvalidate).toHaveBeenCalledTimes(2);
    });

    const firstCall = mockInvalidate.mock.calls[0][0] as { queryKey: unknown[] };
    const secondCall = mockInvalidate.mock.calls[1][0] as { queryKey: unknown[] };
    expect(firstCall.queryKey).toEqual(["synthesis", "pendingRuns", "global"]);
    expect(secondCall.queryKey).toEqual(["synthesis", "detail", "r1"]);
  });

  it("SynthesisRunData includes name: string (non-optional)", () => {
    // Compile-time assertion: this assignment must type-check.
    const run: SynthesisRunData = {
      id: "r1",
      archiveId: "a1",
      name: "Sintesi · Archive · 21/07/2026 18:35",
      status: "COMPLETED",
      pagesRead: 0,
      pagesWritten: 0,
      tokensUsed: 0,
      llmCallsUsed: 0,
      contradictionsFound: 0,
      previewJson: null,
      error: null,
      createdBy: "u1",
      createdAt: "2026-07-21T00:00:00Z",
      updatedAt: "2026-07-21T00:00:00Z",
    };
    expect(run.name).toBe("Sintesi · Archive · 21/07/2026 18:35");
    // name is not optional — accessing it never yields undefined.
    expect(typeof run.name).toBe("string");
  });
});