// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useLinkArchive mutation — unit tests (ARCH-LINK-01 frontend).
 *
 * Covers: apiPatch URL+body (link + null unlink), invalidateQueries on
 * success, success toast, error toast. Mirrors the useRenameChat test
 * pattern. The hook is imported from `../queries/useChats`.
 */

// Mock react-i18next before any imports that consume it.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock the API layer so the mutation never hits the network.
jest.mock("../queries/api", () => ({
  apiPatch: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    details?: unknown;
    constructor(message: string, status: number, details?: unknown) {
      super(message);
      this.status = status;
      this.details = details;
    }
  },
}));

// Mock the toast helpers so we can assert they were called with the i18n key.
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiPatch } from "../queries/api";
import { showSuccess, showError } from "../lib/toast";
import { useLinkArchive } from "../queries/useChats";
import type { ReactNode } from "react";

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const mockedApiPatch = apiPatch as jest.MockedFunction<typeof apiPatch>;
const mockedShowSuccess = showSuccess as jest.MockedFunction<typeof showSuccess>;
const mockedShowError = showError as jest.MockedFunction<typeof showError>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useLinkArchive", () => {
  it("calls apiPatch with the correct URL and body when linking", async () => {
    mockedApiPatch.mockResolvedValueOnce({} as never);
    const { result } = renderHook(() => useLinkArchive(), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId: "ws-1",
        chatId: "chat-1",
        archiveId: "arch-1",
      });
    });

    expect(mockedApiPatch).toHaveBeenCalledWith(
      "/workspaces/ws-1/chats/chat-1/archive",
      { archiveId: "arch-1" },
    );
  });

  it("calls apiPatch with null archiveId when unlinking", async () => {
    mockedApiPatch.mockResolvedValueOnce({} as never);
    const { result } = renderHook(() => useLinkArchive(), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId: "ws-1",
        chatId: "chat-1",
        archiveId: null,
      });
    });

    expect(mockedApiPatch).toHaveBeenCalledWith(
      "/workspaces/ws-1/chats/chat-1/archive",
      { archiveId: null },
    );
  });

  it("invalidates the chats list query on success", async () => {
    mockedApiPatch.mockResolvedValueOnce({} as never);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLinkArchive(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId: "ws-1",
        chatId: "chat-1",
        archiveId: "arch-1",
      });
    });

    expect(invalidateSpy).toHaveBeenCalled();
    // The invalidate call must target the chats list cache key for the workspace.
    const lastCall = invalidateSpy.mock.calls[invalidateSpy.mock.calls.length - 1]?.[0];
    expect(JSON.stringify(lastCall)).toContain("chats");
    expect(JSON.stringify(lastCall)).toContain("ws-1");
  });

  it("shows the linked success toast on link", async () => {
    mockedApiPatch.mockResolvedValueOnce({} as never);
    const { result } = renderHook(() => useLinkArchive(), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId: "ws-1",
        chatId: "chat-1",
        archiveId: "arch-1",
      });
    });

    expect(mockedShowSuccess).toHaveBeenCalledWith("chat.archive.linked");
  });

  it("shows the error toast when the mutation fails", async () => {
    mockedApiPatch.mockRejectedValueOnce(new Error("boom") as never);
    const { result } = renderHook(() => useLinkArchive(), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      try {
        await result.current.mutateAsync({
          workspaceId: "ws-1",
          chatId: "chat-1",
          archiveId: "arch-1",
        });
      } catch {
        /* expected */
      }
    });

    await waitFor(() => {
      expect(mockedShowError).toHaveBeenCalledWith("chat.archive.error");
    });
  });
});