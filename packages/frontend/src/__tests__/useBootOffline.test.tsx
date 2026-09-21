// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useBootOffline, BOOT_OFFLINE_TIMEOUT_MS } from "../hooks/useBootOffline";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useBootOffline", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  function setup() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = jest
      .spyOn(queryClient, "invalidateQueries")
      .mockImplementation(() => Promise.resolve());
    const wrapper = createWrapper(queryClient);
    return { invalidateSpy, wrapper };
  }

  it("does not flag offline while initializing resolves before the timeout", () => {
    const { invalidateSpy, wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ initializing }: { initializing: boolean }) => useBootOffline(initializing),
      { wrapper, initialProps: { initializing: true } },
    );

    act(() => {
      jest.advanceTimersByTime(BOOT_OFFLINE_TIMEOUT_MS - 1);
    });
    expect(result.current.bootOffline).toBe(false);

    rerender({ initializing: false });
    expect(result.current.bootOffline).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("flags offline after the timeout while initializing stays up", () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      ({ initializing }: { initializing: boolean }) => useBootOffline(initializing),
      { wrapper, initialProps: { initializing: true } },
    );

    act(() => {
      jest.advanceTimersByTime(BOOT_OFFLINE_TIMEOUT_MS);
    });
    expect(result.current.bootOffline).toBe(true);
  });

  it("resets the banner when initializing completes, even if it had fired", () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ initializing }: { initializing: boolean }) => useBootOffline(initializing),
      { wrapper, initialProps: { initializing: true } },
    );

    act(() => {
      jest.advanceTimersByTime(BOOT_OFFLINE_TIMEOUT_MS);
    });
    expect(result.current.bootOffline).toBe(true);

    rerender({ initializing: false });
    expect(result.current.bootOffline).toBe(false);
  });

  it("retry invalidates queries, hides the banner, and re-arms a fresh window", async () => {
    const { invalidateSpy, wrapper } = setup();
    const { result } = renderHook(
      ({ initializing }: { initializing: boolean }) => useBootOffline(initializing),
      { wrapper, initialProps: { initializing: true } },
    );

    act(() => {
      jest.advanceTimersByTime(BOOT_OFFLINE_TIMEOUT_MS);
    });
    expect(result.current.bootOffline).toBe(true);

    act(() => {
      result.current.retry();
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(result.current.bootOffline).toBe(false);

    // A retry click while still initializing re-arms a fresh window: the
    // banner stays quiet for the full timeout, then fires again.
    act(() => {
      jest.advanceTimersByTime(BOOT_OFFLINE_TIMEOUT_MS - 1);
    });
    expect(result.current.bootOffline).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.bootOffline).toBe(true);
  });

  it("clears the pending timer on unmount", () => {
    const { wrapper } = setup();
    const { unmount } = renderHook(
      ({ initializing }: { initializing: boolean }) => useBootOffline(initializing),
      { wrapper, initialProps: { initializing: true } },
    );

    unmount();
    // No post-unmount state update: advancing timers must not throw or warn.
    act(() => {
      jest.advanceTimersByTime(BOOT_OFFLINE_TIMEOUT_MS * 2);
    });
  });
});