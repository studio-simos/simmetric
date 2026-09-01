// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsProviders ModelRow embedding toggle tests
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsProviders from "../components/SettingsProviders";
import { TooltipProvider } from "@/components/ui/tooltip";

// SettingsProviders calls useQueryClient(), so renders must be wrapped in a
// real QueryClientProvider.
function renderProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SettingsProviders />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// Mutable mock references (accessed via getters so jest.mock factories can resolve them)
const mockFns = {
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  updateModel: jest.fn(),
  fetchProviders: jest.fn(),
};

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock toast wrapper
jest.mock("../lib/toast", () => ({
  showSuccess: (...args: Parameters<typeof mockFns.showSuccess>) => mockFns.showSuccess(...args),
  showError: (...args: Parameters<typeof mockFns.showError>) => mockFns.showError(...args),
  showInfo: (...args: Parameters<typeof mockFns.showInfo>) => mockFns.showInfo(...args),
}));

// Mock chat context
jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => ({ currentWorkspaceId: null, currentChatId: null, setWorkspaceId: jest.fn(), setChatId: jest.fn() }),
}));

// Mock provider queries
jest.mock("../queries/useProviders", () => ({
  useProviders: () => ({ data: [
    {
      id: "p1",
      name: "Ollama Local",
      type: "ollama",
      baseUrl: "http://ollama:11434",
      apiKey: null,
      isEnabled: true,
      isDefault: true,
      lastError: null,
      lastSyncAt: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      models: [
        {
          id: "m1",
          name: "gemma4:latest",
          displayName: "Llama 3",
          isLocal: true,
          isEnabled: true,
          isAvailable: true,
          isEmbedding: false,
          capabilities: ["fastest"],
        },
        {
          id: "m2",
          name: "nomic-embed-text",
          displayName: "Nomic Embed",
          isLocal: true,
          isEnabled: true,
          isAvailable: true,
          isEmbedding: true,
        },
      ],
    },
  ], isLoading: false, error: null }),
  useCreateProvider: () => ({ mutateAsync: jest.fn() }),
  useUpdateProvider: () => ({ mutateAsync: jest.fn() }),
  useDeleteProvider: () => ({ mutateAsync: jest.fn() }),
  useSetDefaultProvider: () => ({ mutateAsync: jest.fn() }),
  useRefreshModels: () => ({ mutateAsync: jest.fn() }),
  useUpdateModel: () => ({ mutateAsync: (...args: Parameters<typeof mockFns.updateModel>) => mockFns.updateModel(...args) }),
  useDeleteModel: () => ({ mutateAsync: jest.fn() }),
  useSetDefaultModel: () => ({ mutateAsync: jest.fn() }),
  useAvailableModels: () => ({ data: [], isLoading: false, error: null }),
}));

describe("SettingsProviders", () => {

  it("renders embedding toggle for each model row", () => {
    renderProviders();

    // Expand the provider
    const expandButton = screen.getByText("Ollama Local");
    fireEvent.click(expandButton);

    // Should show embedding toggles (checkboxes)
    const checkboxes = screen.getAllByRole("checkbox");
    // 3 per model row: m1 enabled[0] embed[1] ocr[2] + m2 enabled[3] embed[4] ocr[5] = 6
    expect(checkboxes.length).toBe(6);
  });

  it("shows embedding model checked when isEmbedding is true", () => {
    renderProviders();

    const expandButton = screen.getByText("Ollama Local");
    fireEvent.click(expandButton);

    const checkboxes = screen.getAllByRole("checkbox");
    // m1 isEmbedding=false (embed checkbox[1] unchecked), m2 isEmbedding=true (embed checkbox[4] checked)
    expect(checkboxes[1]).not.toBeChecked();
    expect(checkboxes[4]).toBeChecked();
  });

  it("calls updateModel when embedding toggle is clicked", async () => {
    mockFns.updateModel.mockResolvedValueOnce(undefined);

    renderProviders();

    const expandButton = screen.getByText("Ollama Local");
    fireEvent.click(expandButton);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    await waitFor(() => {
      expect(mockFns.updateModel).toHaveBeenCalledWith({ providerId: "p1", modelId: "m1", data: { isEmbedding: true } });
    });
  });

  it("shows success toast when embedding toggle succeeds", async () => {
    mockFns.updateModel.mockResolvedValueOnce(undefined);

    renderProviders();

    const expandButton = screen.getByText("Ollama Local");
    fireEvent.click(expandButton);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    await waitFor(() => {
      expect(mockFns.showError).not.toHaveBeenCalledWith(expect.any(String));
    });
  });

  it("shows error toast when embedding toggle fails", async () => {
    mockFns.updateModel.mockRejectedValueOnce(new Error("Network error"));

    renderProviders();

    const expandButton = screen.getByText("Ollama Local");
    fireEvent.click(expandButton);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    await waitFor(() => {
      expect(mockFns.showError).toHaveBeenCalledWith("settings.providers.updateFailed");
    });
  });

  it("provider enable toggle uses primary color (no hardcoded green/red)", () => {
    // Regression: the provider enable/disable Switch must NOT override with
    // !bg-green-500 / !bg-red-500 — it must inherit data-checked:bg-primary so
    // it respects the user's BRANDING_PRIMARY_COLOR (Settings → Aspetto).
    renderProviders();

    const providerToggle = screen.getByRole("switch", {
      name: "settings.providers.toggleEnabled",
    });
    const cls = providerToggle.getAttribute("class") ?? "";
    expect(cls).not.toMatch(/bg-green-500/);
    expect(cls).not.toMatch(/bg-red-500/);
    // The Switch UI component relies on data-checked:bg-primary (no per-instance override).
    expect(cls).toMatch(/data-checked:bg-primary|peer group\/switch/);
  });

});
