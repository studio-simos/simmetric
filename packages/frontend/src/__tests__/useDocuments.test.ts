// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useDocumentText hook tests — enabled-gating + apiGet URL shape.
 *
 * Uses `React.createElement` (not JSX) so the file stays `.test.ts`
 * per the plan's file list. Mirrors the QueryClientProvider wrapper
 * pattern from test-utils.tsx.
 */

import { createElement, ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockApiGet = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
}));

import { useDocumentText } from "../queries/useDocuments";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useDocumentText", () => {
  it("does not call apiGet when documentId is undefined (enabled gating)", async () => {
    const { result } = renderHook(() => useDocumentText(undefined), {
      wrapper: createWrapper(),
    });
    // Query is disabled — apiGet should never be invoked.
    expect(mockApiGet).not.toHaveBeenCalled();
    // A disabled query reports isLoading false (no pending fetch).
    expect(result.current.isLoading).toBe(false);
  });

  it("calls apiGet with /documents/:id/text and maps the resolved fixture", async () => {
    const fixture = {
      text: "first chunk\n\nsecond chunk",
      length: 25,
      name: "report.md",
      type: "md",
      status: "completed",
    };
    mockApiGet.mockResolvedValueOnce(fixture);

    const { result } = renderHook(() => useDocumentText("doc-123"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiGet).toHaveBeenCalledWith("/documents/doc-123/text");
    expect(result.current.data).toEqual(fixture);
  });
});