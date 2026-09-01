// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for useLicense TanStack Query hooks.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { useLicenseInfo } from "../queries/useLicense";

const mockApiGet = jest.fn();

jest.mock("../queries/api", () => ({
  apiGet: (...args: Parameters<typeof mockApiGet>) => mockApiGet(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useLicenseInfo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches license info and caches with correct key", async () => {
    const mockLicense = {
      tier: "enterprise" as const,
      licensee: "Test Org",
      expiresAt: "2027-01-01T00:00:00Z",
      features: { max_workspaces: 10 },
      valid: true,
    };
    mockApiGet.mockResolvedValueOnce(mockLicense);

    const wrapper = createWrapper();
    const { result } = renderHook(() => useLicenseInfo(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiGet).toHaveBeenCalledWith("/license/info");
    expect(result.current.data).toEqual(mockLicense);
  });

  it("returns error when api fails", async () => {
    mockApiGet.mockRejectedValueOnce(new Error("License check failed"));

    const wrapper = createWrapper();
    const { result } = renderHook(() => useLicenseInfo(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("License check failed");
  });

  it("does not fetch when enabled is false", () => {
    mockApiGet.mockResolvedValueOnce({});

    const wrapper = createWrapper();
    renderHook(() => useLicenseInfo(false), { wrapper });

    expect(mockApiGet).not.toHaveBeenCalled();
  });
});
