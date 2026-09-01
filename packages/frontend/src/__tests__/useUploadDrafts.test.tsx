// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for useUploadDrafts TanStack Query hooks (Phase 71-04 Task 3).
 *
 * Covers D-09 conditional refetchInterval predicate (terminal vs in-flight),
 * the enabled gate (no fetch until workspaceId), and the three mutations
 * (stage / assign / retryKb) including the D-08 retry-only-KB body shape.
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiPatch = jest.fn();
const mockApiDelete = jest.fn();
const mockFetch = jest.fn();

jest.mock("../queries/api", () => ({
  apiGet: (...args: Parameters<typeof mockApiGet>) => mockApiGet(...args),
  apiPost: (...args: Parameters<typeof mockApiPost>) => mockApiPost(...args),
  apiPatch: (...args: Parameters<typeof mockApiPatch>) => mockApiPatch(...args),
  apiDelete: (...args: Parameters<typeof mockApiDelete>) => mockApiDelete(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// useStageUpload uses raw fetch (multipart) — mock it on globalThis
beforeAll(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;
});

afterEach(() => {
  localStorage.removeItem("token");
});

import {
  useUploadDrafts,
  useStageUpload,
  useAssignDraft,
  useRetryKb,
  useRetryRag,
  useRetryBoth,
  useDeleteDraft,
  useRenameDraft,
  hasInFlightDraft,
  type UploadDraft,
} from "../queries/useUploadDrafts";
import { queryKeys } from "../queries/keys";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const TERMINAL_DRAFT: UploadDraft = {
  id: "d1",
  parseStatus: "done",
  originalName: "done.pdf",
  fileSize: 1024,
  mimeType: "application/pdf",
  expiresAt: "2027-01-01T00:00:00Z",
  ragStatus: "completed",
  kbStatus: "COMPLETED",
};

const IN_FLIGHT_DRAFT: UploadDraft = {
  id: "d2",
  parseStatus: "assigned",
  originalName: "assigned.pdf",
  fileSize: 1024,
  mimeType: "application/pdf",
  expiresAt: "2027-01-01T00:00:00Z",
  ragStatus: "processing",
  kbStatus: null,
};

describe("hasInFlightDraft (D-09 predicate)", () => {
  it("returns false for undefined data", () => {
    expect(hasInFlightDraft(undefined)).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(hasInFlightDraft([])).toBe(false);
  });

  it("returns false when all drafts are terminal (rag=completed, kb=COMPLETED, parseStatus=done)", () => {
    expect(hasInFlightDraft([TERMINAL_DRAFT])).toBe(false);
  });

  it("returns true when any draft has parseStatus=assigned (D-09)", () => {
    expect(hasInFlightDraft([IN_FLIGHT_DRAFT])).toBe(true);
  });

  it("returns true when any draft has non-terminal ragStatus", () => {
    expect(
      hasInFlightDraft([
        { ...TERMINAL_DRAFT, parseStatus: "done", ragStatus: "processing" },
      ])
    ).toBe(true);
  });

  it("returns true when any draft has non-terminal kbStatus", () => {
    expect(
      hasInFlightDraft([
        { ...TERMINAL_DRAFT, parseStatus: "done", ragStatus: "completed", kbStatus: "PROCESSING" },
      ])
    ).toBe(true);
  });

  it("returns false when ragStatus is failed (terminal) and kbStatus is FAILED (terminal)", () => {
    expect(
      hasInFlightDraft([
        { ...TERMINAL_DRAFT, parseStatus: "done", ragStatus: "failed", kbStatus: "FAILED" },
      ])
    ).toBe(false);
  });
});

describe("useUploadDrafts (query)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not fetch when workspaceId is undefined (enabled gate)", () => {
    const wrapper = createWrapper();
    renderHook(() => useUploadDrafts(undefined), { wrapper });
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it("fetches /uploads/pending?workspaceId=<id> when workspaceId is provided", async () => {
    mockApiGet.mockResolvedValueOnce([]);
    const wrapper = createWrapper();
    const { result } = renderHook(() => useUploadDrafts("ws-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiGet).toHaveBeenCalledWith("/uploads/pending?workspaceId=ws-1");
  });
});

describe("useStageUpload (mutation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls fetch POST /api/uploads with Authorization header + FormData body (no custom Content-Type)", async () => {
    localStorage.setItem("token", "test-token");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "d3", parseStatus: "uploaded" }),
    });
    const wrapper = createWrapper();
    const { result } = renderHook(() => useStageUpload(), { wrapper });

    const formData = new FormData();
    formData.append("file", new Blob(["x"]), "test.pdf");
    formData.append("workspaceId", "ws-1");

    await act(async () => {
      await result.current.mutateAsync({ formData, workspaceId: "ws-1" });
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/uploads");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    // Browser sets Content-Type for FormData — hook must NOT set it explicitly
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(init.body).toBe(formData);
  });
});

describe("useAssignDraft (mutation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls apiPost /uploads/:id/assign with the assignDraftSchema body", async () => {
    mockApiPost.mockResolvedValueOnce({ ok: true });
    const wrapper = createWrapper();
    const { result } = renderHook(() => useAssignDraft("ws-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "d1",
        body: { rag: true, kb: true, archiveId: "a-1" },
      });
    });

    expect(mockApiPost).toHaveBeenCalledWith("/uploads/d1/assign", {
      rag: true,
      kb: true,
      archiveId: "a-1",
    });
  });
});

describe("useRetryKb (mutation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls apiPost /uploads/:id/retry with body {rag:false, kb:true, archiveId} (D-01 redirect to /retry)", async () => {
    mockApiPost.mockResolvedValueOnce({ ok: true });
    const wrapper = createWrapper();
    const { result } = renderHook(() => useRetryKb("ws-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: "d1", archiveId: "a-1" });
    });

    expect(mockApiPost).toHaveBeenCalledWith("/uploads/d1/retry", {
      rag: false,
      kb: true,
      archiveId: "a-1",
    });
  });
});

describe("useRetryRag (mutation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls apiPost /uploads/:id/retry with body {rag:true, kb:false} and invalidates list", async () => {
    mockApiPost.mockResolvedValueOnce({ ok: true });
    const { wrapper, queryClient } = createWrapperWithClient();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRetryRag("ws-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: "d1" });
    });

    expect(mockApiPost).toHaveBeenCalledWith("/uploads/d1/retry", {
      rag: true,
      kb: false,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.uploadDrafts.list("ws-1"),
    });
  });
});

describe("useRetryBoth (mutation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls apiPost /uploads/:id/retry with body {rag:true, kb:true, archiveId} and invalidates list", async () => {
    mockApiPost.mockResolvedValueOnce({ ok: true });
    const { wrapper, queryClient } = createWrapperWithClient();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRetryBoth("ws-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: "d1", archiveId: "a-1" });
    });

    expect(mockApiPost).toHaveBeenCalledWith("/uploads/d1/retry", {
      rag: true,
      kb: true,
      archiveId: "a-1",
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.uploadDrafts.list("ws-1"),
    });
  });
});

/**
 * Wrapper variant that exposes the QueryClient so tests can spy on
 * invalidateQueries (Phase 76-02 — useDeleteDraft/useRenameDraft invalidation).
 */
function createWrapperWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
  return { wrapper, queryClient };
}

describe("useDeleteDraft (mutation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls apiDelete /uploads/:id and invalidates uploadDrafts.list(workspaceId) on success", async () => {
    mockApiDelete.mockResolvedValueOnce({ message: "Draft deleted" });
    const { wrapper, queryClient } = createWrapperWithClient();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useDeleteDraft("ws-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: "d1" });
    });

    expect(mockApiDelete).toHaveBeenCalledWith("/uploads/d1");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.uploadDrafts.list("ws-1"),
    });
  });
});

describe("useRenameDraft (mutation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls apiPatch /uploads/:id with body { originalName } and invalidates uploadDrafts.list(workspaceId) on success", async () => {
    mockApiPatch.mockResolvedValueOnce({ id: "d1", originalName: "New Name" });
    const { wrapper, queryClient } = createWrapperWithClient();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRenameDraft("ws-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: "d1", originalName: "New Name" });
    });

    expect(mockApiPatch).toHaveBeenCalledWith("/uploads/d1", { originalName: "New Name" });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.uploadDrafts.list("ws-1"),
    });
  });
});