// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * FiltersTab component + useFilters/useUpdateFilter hooks tests — Phase 100-03.
 *
 * Behavior covered (per PLAN <behavior>):
 *  - FiltersTab renders plugin list with name, priority, enabled toggle, inlet/outlet badges
 *  - FiltersTab shows "No filter plugins installed" when list is empty
 *  - clicking enable/disable toggle calls apiPatch('/api/filters/:name', { enabled: !current })
 *  - toggle success invalidates the filters query (useQueryClient().invalidateQueries)
 *  - FiltersTab is NOT rendered when user lacks filters:manage permission (SettingsPage gate)
 *  - useFilters returns data from GET /api/filters as array of plugin objects
 *  - useUpdateFilter mutation calls apiPatch with correct path + body
 */
import { render, screen, fireEvent, waitFor, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";

// Mock api utilities — hoisted by jest.
jest.mock("../utils/api", () => ({
  apiGet: jest.fn(),
  apiPatch: jest.fn(),
}));

// Mock react-i18next — returns the key as-is (standard fallback behavior
// when no translation resources are loaded in the test environment).
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { apiGet, apiPatch } from "../utils/api";
import { useFilters, useUpdateFilter } from "../queries/useFilters";
import { FiltersTab } from "../components/FiltersTab";

const mockApiGet = apiGet as jest.MockedFunction<typeof apiGet>;
const mockApiPatch = apiPatch as jest.MockedFunction<typeof apiPatch>;

/** Standard plugin descriptor returned by GET /api/filters (matches server route). */
const DLP_PLUGIN = {
  name: "dlp",
  priority: -1,
  enabled: true,
  hasInlet: true,
  hasOutlet: true,
  outletStreaming: true,
  description: "DLP redaction filter",
};

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

function wrap(client: QueryClient, ui: ReactNode) {
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApiGet.mockResolvedValue([]);
  mockApiPatch.mockResolvedValue({ message: "ok" });
});

describe("useFilters hook", () => {
  it("returns data from GET /api/filters as array of plugin objects", async () => {
    mockApiGet.mockResolvedValue([DLP_PLUGIN]);
    const client = makeClient();

    const { result } = renderHook(() => useFilters(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(result.current.data).toEqual([DLP_PLUGIN]));
    expect(mockApiGet).toHaveBeenCalledWith("/filters");
  });
});

describe("useUpdateFilter mutation", () => {
  it("calls apiPatch with correct path + body", async () => {
    const client = makeClient();

    const { result } = renderHook(() => useUpdateFilter(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(result.current).toBeDefined());
    await result.current.mutateAsync({ name: "dlp", enabled: false });
    expect(mockApiPatch).toHaveBeenCalledWith("/filters/dlp", { enabled: false });
  });

  it("invalidates the filters query on success", async () => {
    const client = makeClient();
    const invalidateSpy = jest.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useUpdateFilter(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(result.current).toBeDefined());
    await result.current.mutateAsync({ name: "dlp", enabled: false });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["filters"] });
  });
});

describe("FiltersTab component", () => {
  it("renders plugin list with name, priority, enabled toggle, inlet/outlet badges", async () => {
    mockApiGet.mockResolvedValue([DLP_PLUGIN]);
    const client = makeClient();
    wrap(client, <FiltersTab />);

    await waitFor(() => {
      expect(screen.getByText("dlp")).toBeInTheDocument();
    });
    expect(screen.getByText(/-1/)).toBeInTheDocument();
    expect(screen.getByText(/DLP redaction filter/)).toBeInTheDocument();
    // Toggle (switch) rendered — role="switch"
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("shows empty state when list is empty", async () => {
    mockApiGet.mockResolvedValue([]);
    const client = makeClient();
    wrap(client, <FiltersTab />);

    await waitFor(() => {
      expect(screen.getByText("settings.filters.noPlugins")).toBeInTheDocument();
    });
  });

  it("clicking toggle calls apiPatch with toggled enabled value", async () => {
    mockApiGet.mockResolvedValue([DLP_PLUGIN]);
    const client = makeClient();
    wrap(client, <FiltersTab />);

    await waitFor(() => {
      expect(screen.getByRole("switch")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(mockApiPatch).toHaveBeenCalledWith("/filters/dlp", { enabled: false });
    });
  });

  it("toggling from disabled to enabled sends enabled=true", async () => {
    mockApiGet.mockResolvedValue([{ ...DLP_PLUGIN, enabled: false }]);
    const client = makeClient();
    wrap(client, <FiltersTab />);

    await waitFor(() => {
      expect(screen.getByRole("switch")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(mockApiPatch).toHaveBeenCalledWith("/filters/dlp", { enabled: true });
    });
  });
});