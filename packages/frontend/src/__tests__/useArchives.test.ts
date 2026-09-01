// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useExportArchive blob URL race-protection tests (DBG-01 / D-10).
 *
 * Verifies the fix at packages/frontend/src/queries/useArchives.ts:219 —
 * `setTimeout(() => window.URL.revokeObjectURL(url), 1000)` — which defers
 * revocation of the blob URL until the browser has had time to start the
 * download. The original code revoked the URL synchronously after a.click(),
 * racing the browser's download initiation and producing empty downloads.
 *
 * Uses `React.createElement` (not JSX) so the file stays `.test.ts`.
 */

import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("../queries/api", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiPut: jest.fn(),
  apiDelete: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

jest.mock("../lib/toast", () => ({
  showError: jest.fn(),
  showSuccess: jest.fn(),
}));

import { useExportArchive } from "../queries/useArchives";
import { showError } from "../lib/toast";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useExportArchive blob URL timing", () => {
  const createObjectURLMock = jest.fn();
  const revokeObjectURLMock = jest.fn();
  const fetchMock = jest.fn();
  let setTimeoutSpy: jest.SpyInstance;
  let clickSpy: jest.SpyInstance;
  let appendChildSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    // jsdom does not implement URL.createObjectURL — install controllable mocks.
    createObjectURLMock.mockReturnValue("blob:mock-archive-url");
    window.URL.createObjectURL = createObjectURLMock as unknown as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = revokeObjectURLMock as unknown as typeof URL.revokeObjectURL;

    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["archive-bytes"], { type: "application/zip" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // Spy AFTER mocks are in place so the scheduled callback is captured.
    setTimeoutSpy = jest.spyOn(global, "setTimeout");
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    appendChildSpy = jest.spyOn(document.body, "appendChild");

    localStorage.setItem("token", "test-token");
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clickSpy.mockRestore();
    appendChildSpy.mockRestore();
    localStorage.removeItem("token");
  });

  it("schedules URL.revokeObjectURL via setTimeout with a 1000ms delay, not synchronously", async () => {
    const { result } = renderHook(() => useExportArchive(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ archiveId: "a1", format: "zip" });

    // The export endpoint was hit with the format param + auth header.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/archives/a1/export?format=zip",
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
    );

    // Blob URL created and download triggered immediately...
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // ...but revocation is deferred: scheduled with the 1000ms race-protection
    // delay, and NOT called synchronously after a.click().
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(revokeObjectURLMock).not.toHaveBeenCalled();

    // The scheduled callback revokes exactly the URL that was created.
    const raceProtectionCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 1000);
    expect(raceProtectionCall).toBeDefined();
    (raceProtectionCall![0] as () => void)();
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-archive-url");
  });

  it("fires revocation only after the 1000ms delay elapses (fake timers)", async () => {
    jest.useFakeTimers();
    try {
      const { result } = renderHook(() => useExportArchive(), { wrapper: createWrapper() });

      await result.current.mutateAsync({ archiveId: "a1", format: "zip" });

      // Before the delay: the URL is still valid for the in-flight download.
      expect(revokeObjectURLMock).not.toHaveBeenCalled();

      jest.advanceTimersByTime(999);
      expect(revokeObjectURLMock).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
      expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-archive-url");
    } finally {
      jest.useRealTimers();
    }
  });

  it("names the download file from archiveId + format", async () => {
    const { result } = renderHook(() => useExportArchive(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ archiveId: "a1", format: "pdf" });

    // RTL's renderHook also appends its mount container to document.body,
    // so locate the anchor specifically rather than indexing calls[0].
    const anchorCall = appendChildSpy.mock.calls.find(
      (call) => call[0] instanceof HTMLAnchorElement,
    );
    expect(anchorCall).toBeDefined();
    const anchor = anchorCall![0] as HTMLAnchorElement;
    expect(anchor.download).toBe("archive-a1.pdf");
    expect(anchor.href).toBe("blob:mock-archive-url");
  });

  it("surfaces server errors via the mutation onError showError path", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Archive not found" }),
    });
    const { result } = renderHook(() => useExportArchive(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({ archiveId: "missing", format: "zip" }),
    ).rejects.toThrow("Archive not found");

    expect(showError).toHaveBeenCalledWith("Archive not found");
    // No download machinery engaged on failure.
    expect(createObjectURLMock).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
