// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useTemplates hook tests — Phase 112-01 (G01, G02).
 *
 * Verifies that query hooks call the correct API endpoints and that
 * query key shapes match expectations.
 *
 * Mocks: apiGet/apiPost/apiPut/apiDelete from queries/api.
 */
import "@testing-library/jest-dom";
import { renderHookWithProviders } from "./test-utils";
import { act, waitFor } from "@testing-library/react";
import { queryKeys } from "../queries/keys";

// Mock the API module so we can assert on endpoint calls
const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiPut = jest.fn();
const mockApiDelete = jest.fn();

jest.mock("../queries/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
  apiPut: (...args: unknown[]) => mockApiPut(...args),
  apiDelete: (...args: unknown[]) => mockApiDelete(...args),
}));

import {
  useTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
} from "../queries/useTemplates";

const mockTemplate = {
  id: "tpl-1",
  slug: "test",
  name: "Test Template",
  description: "A test",
  icon: "\uD83D\uDD12",
  systemPrompt: "You are a test assistant.",
  skills: ["rag_search", "workspace_memory"],
  parsingConfig: {},
  constraints: {},
  embeddingModel: null,
  isBuiltIn: false,
};

describe("useTemplates query hooks (Phase 112-01)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApiGet.mockResolvedValue([mockTemplate]);
    mockApiPost.mockResolvedValue(mockTemplate);
    mockApiPut.mockResolvedValue(mockTemplate);
    mockApiDelete.mockResolvedValue({ message: "Deleted" });
  });

  // ---------------------------------------------------------------------------
  // G02 — query key structure assertions
  // ---------------------------------------------------------------------------
  describe("queryKeys.templates", () => {
    it("queryKeys.templates.all equals ['templates']", () => {
      expect(queryKeys.templates.all).toEqual(["templates"]);
    });

    it("queryKeys.templates.detail('abc') equals ['templates', 'detail', 'abc']", () => {
      expect(queryKeys.templates.detail("abc")).toEqual([
        "templates",
        "detail",
        "abc",
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // G01 — useTemplates (GET)
  // ---------------------------------------------------------------------------
  describe("useTemplates", () => {
    it("calls apiGet('/templates') and returns template list on success", async () => {
      const { result } = renderHookWithProviders(() => useTemplates());

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expect(mockApiGet).toHaveBeenCalledTimes(1);
      expect(mockApiGet).toHaveBeenCalledWith("/templates");
      expect(result.current.data).toEqual([mockTemplate]);
    });

    it("queries fire on mount (apiGet called)", () => {
      renderHookWithProviders(() => useTemplates());
      expect(mockApiGet).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // G01 — useCreateTemplate (POST)
  // ---------------------------------------------------------------------------
  describe("useCreateTemplate", () => {
    it("calls apiPost('/templates', input) on mutation", async () => {
      const { result } = renderHookWithProviders(() => useCreateTemplate());

      const input = {
        slug: "new-template",
        name: "New Template",
        systemPrompt: "You are new.",
      };

      await act(async () => {
        await result.current.mutateAsync(input);
      });

      expect(mockApiPost).toHaveBeenCalledTimes(1);
      expect(mockApiPost).toHaveBeenCalledWith("/templates", input);
    });

    it("returns the created template on success", async () => {
      const { result } = renderHookWithProviders(() => useCreateTemplate());

      const input = {
        slug: "new-template",
        name: "New Template",
        systemPrompt: "You are new.",
      };

      await act(async () => {
        const created = await result.current.mutateAsync(input);
        expect(created).toEqual(mockTemplate);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // G01 — useUpdateTemplate (PUT)
  // ---------------------------------------------------------------------------
  describe("useUpdateTemplate", () => {
    it("calls apiPut('/templates/:id', data) on mutation", async () => {
      const { result } = renderHookWithProviders(() => useUpdateTemplate());

      const id = "tpl-1";
      const data = { name: "Updated Name" };

      await act(async () => {
        await result.current.mutateAsync({ id, data });
      });

      expect(mockApiPut).toHaveBeenCalledTimes(1);
      expect(mockApiPut).toHaveBeenCalledWith(`/templates/${id}`, data);
    });
  });

  // ---------------------------------------------------------------------------
  // G01 — useDeleteTemplate (DELETE)
  // ---------------------------------------------------------------------------
  describe("useDeleteTemplate", () => {
    it("calls apiDelete('/templates/:id') on mutation", async () => {
      const { result } = renderHookWithProviders(() => useDeleteTemplate());

      const id = "tpl-to-delete";

      await act(async () => {
        await result.current.mutateAsync(id);
      });

      expect(mockApiDelete).toHaveBeenCalledTimes(1);
      expect(mockApiDelete).toHaveBeenCalledWith(`/templates/${id}`);
    });

    it("returns success message on delete", async () => {
      const { result } = renderHookWithProviders(() => useDeleteTemplate());

      await act(async () => {
        const response = await result.current.mutateAsync("tpl-1");
        expect(response).toEqual({ message: "Deleted" });
      });
    });
  });
});
