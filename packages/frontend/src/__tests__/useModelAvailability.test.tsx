// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useModelAvailability } from "../hooks/useModelAvailability";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useModelAvailability", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("does not poll when active is false", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries").mockImplementation(() => Promise.resolve());
    const wrapper = createWrapper(queryClient);
    renderHook(() => useModelAvailability(false), { wrapper });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("fetches immediately and starts polling when active is true", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries").mockImplementation(() => Promise.resolve());
    const wrapper = createWrapper(queryClient);
    renderHook(() => useModelAvailability(true), { wrapper });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(30000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("pauses polling when document becomes hidden", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries").mockImplementation(() => Promise.resolve());
    const wrapper = createWrapper(queryClient);
    renderHook(() => useModelAvailability(true), { wrapper });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      jest.advanceTimersByTime(30000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("resumes polling with immediate fetch when document becomes visible", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries").mockImplementation(() => Promise.resolve());
    const wrapper = createWrapper(queryClient);
    renderHook(() => useModelAvailability(true), { wrapper });

    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("returns isStale true when lastChecked is null", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    jest.spyOn(queryClient, "invalidateQueries").mockImplementation(() => Promise.resolve());
    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useModelAvailability(true), { wrapper });
    expect(result.current.isStale).toBe(true);
  });

  it("returns isPolling true when active and interval is running", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    jest.spyOn(queryClient, "invalidateQueries").mockImplementation(() => Promise.resolve());
    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useModelAvailability(true), { wrapper });
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    expect(result.current.isPolling).toBe(true);
  });

  it("cleans up interval on unmount", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries").mockImplementation(() => Promise.resolve());
    const wrapper = createWrapper(queryClient);
    const { unmount } = renderHook(() => useModelAvailability(true), { wrapper });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(30000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });
});