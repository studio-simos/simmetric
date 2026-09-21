// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useDlpEvalResult hook-path pin — Phase 192 plan 10 (Gap 1 closure, tracer).
 *
 * The enablement gate's ONLY data link: useDlpEvalResult must call apiGet
 * with EXACTLY "/system/dlp/eval/result" — the path the server serves at
 * system.ts router.get("/dlp/eval/result") under app.use("/api/system")
 * (apiGet prepends /api, so the wire path is /api/system/dlp/eval/result).
 * The previously-encoded hyphenated path variant was a 404:
 * the gate truth never reached WorkspacesPage's dlpGatePassed or the panel.
 *
 * Task 2's supertest battery (dlpEvalRoutes.test.ts) proves the SERVER side
 * of this same path — together the two pins close the loop end-to-end.
 *
 * The no-run arm payload { passed: false, noRun: true } must flow through as
 * query DATA (not an error arm) — the panel renders its documented empty
 * state from it and the toggle treats it as gate-not-passed, fail-closed.
 */
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock surface per the repo hook-test convention (DocumentsPage.dlpChips
// test: jest.mock on src/utils/api with (...args) => mockApiGet(...args)).
const mockApiGet = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...(args as [])),
  apiPost: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    details?: unknown;
    constructor(status: number, message: string, details?: unknown) {
      super(message);
      this.status = status;
      this.details = details;
    }
  },
}));

import { useDlpEvalResult } from "../queries/useDlpDocs";

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

describe("useDlpEvalResult hook path (192-10 Gap 1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls apiGet with EXACTLY /system/dlp/eval/result (the server-served path)", async () => {
    mockApiGet.mockResolvedValueOnce({ passed: false, noRun: true });

    const { result } = renderHook(() => useDlpEvalResult(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiGet).toHaveBeenCalledTimes(1);
    expect(mockApiGet).toHaveBeenCalledWith("/system/dlp/eval/result");
  });

  it("the no-run arm flows through as query data (not an error arm)", async () => {
    const noRunArm = { passed: false, noRun: true } as const;
    mockApiGet.mockResolvedValueOnce(noRunArm);

    const { result } = renderHook(() => useDlpEvalResult(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data).toEqual(noRunArm));
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
  });
});