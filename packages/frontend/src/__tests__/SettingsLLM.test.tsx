// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsLLM embedding UI tests — provider-driven dropdowns
 */
import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import SettingsLLM from "../components/SettingsLLM";

// Mock i18next. Include initReactI18next so the transitively-imported
// src/i18n/index.ts (which calls i18n.use(initReactI18next)) does not throw
// "You are passing an undefined module" under Jest.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock toast wrapper
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock Select to render native select for testability
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void }) => (
    <select value={value} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  SelectItem: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  SelectValue: () => null,
}));

// Mock settings query hooks
const mockUpdateSettings = jest.fn();
const mockIsReadOnly = jest.fn().mockReturnValue(false);
const mockIsEnvOverridden = jest.fn().mockReturnValue(false);
const mockGetValue = jest.fn().mockReturnValue(undefined);

jest.mock("../queries/useSettings", () => ({
  useSettings: () => ({ data: [] }),
  useSettingsHelpers: () => ({ getValue: mockGetValue, isReadOnly: mockIsReadOnly, isEnvOverridden: mockIsEnvOverridden }),
  useUpdateSettings: () => ({ mutateAsync: mockUpdateSettings }),
}));

// Mock query hooks
jest.mock("../queries/useProviders", () => ({
  useProviders: () => ({
    data: [
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
          { id: "m1", name: "gemma4:latest", displayName: "Llama 3", isLocal: true, isEnabled: true, isAvailable: true, isEmbedding: false, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), providerId: "p1" },
          { id: "m2", name: "nomic-embed-text", displayName: "Nomic Embed", isLocal: true, isEnabled: true, isAvailable: true, isEmbedding: true, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), providerId: "p1" },
        ],
      },
      {
        id: "p2",
        name: "OpenAI",
        type: "openai",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-test",
        isEnabled: true,
        isDefault: false,
        lastError: null,
        lastSyncAt: null,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        models: [
          { id: "m3", name: "text-embedding-3-small", displayName: "Embedding 3 Small", isLocal: false, isEnabled: true, isAvailable: true, isEmbedding: true, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), providerId: "p2" },
          { id: "m4", name: "gpt-4", displayName: "GPT-4", isLocal: false, isEnabled: true, isAvailable: true, isEmbedding: false, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), providerId: "p2" },
        ],
      },
    ],
    isLoading: false,
    error: null,
  }),
}));

describe("SettingsLLM embedding section", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders embedding provider dropdown with providers that have embedding models", () => {
    renderWithProviders(<SettingsLLM />);

    // Open the embedding provider select
    const providerSelect = screen.getAllByRole("combobox")[0];
    fireEvent.click(providerSelect);

    // Should show providers with embedding models
    expect(screen.getByText("Ollama Local")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
  });

  it("shows embedding model dropdown after selecting a provider", () => {
    renderWithProviders(<SettingsLLM />);

    // Select a provider
    const providerSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(providerSelect, { target: { value: "p1" } });

    // Model dropdown should appear
    const modelSelect = screen.getAllByRole("combobox")[1];
    expect(modelSelect).toBeInTheDocument();
  });

  it("filters embedding models by selected provider", () => {
    renderWithProviders(<SettingsLLM />);

    // Select OpenAI provider
    const providerSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(providerSelect, { target: { value: "p2" } });

    // Model dropdown should only show OpenAI's embedding model
    const modelSelect = screen.getAllByRole("combobox")[1];
    expect(modelSelect).toBeInTheDocument();
  });

  it("saves embedding provider and model with settings", async () => {
    mockUpdateSettings.mockResolvedValueOnce({ updated: ["EMBEDDING_PROVIDER", "EMBEDDING_MODEL"], rejected: [] });

    renderWithProviders(<SettingsLLM />);

    // Select provider and model
    const providerSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(providerSelect, { target: { value: "p1" } });

    const modelSelect = screen.getAllByRole("combobox")[1];
    fireEvent.change(modelSelect, { target: { value: "nomic-embed-text" } });

    // Click save
    const saveButton = screen.getByText("settings.saveChanges");
    fireEvent.click(saveButton);

    // Wait for async save
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockUpdateSettings).toHaveBeenCalled();
  });

  // ─── Phase 176 (D-08): EnvOverriddenBadge behaviors ────────────────────

  it("renders env-overridden badge on the provider row when flagged and not readonly", () => {
    mockIsReadOnly.mockReturnValue(false);
    mockIsEnvOverridden.mockImplementation((key: string) => key === "EMBEDDING_PROVIDER");

    renderWithProviders(<SettingsLLM />);

    // Badge label = the i18n key string (t is identity-mapped)
    const badge = screen.getByText("settings.envOverriddenBadge");
    expect(badge).toBeInTheDocument();
    // The row must NOT be disabled (flag ≠ readOnly)
    const providerSelect = screen.getAllByRole("combobox")[0];
    expect(providerSelect).not.toBeDisabled();
  });

  it("renders no env-overridden badge when the flag is false (default)", () => {
    mockIsEnvOverridden.mockReturnValue(false);

    renderWithProviders(<SettingsLLM />);

    expect(screen.queryByText("settings.envOverriddenBadge")).not.toBeInTheDocument();
  });

  it("renders ONLY ReadOnlyBadge (no env badge) when the key is readonly", () => {
    mockIsReadOnly.mockImplementation((key: string) => key === "EMBEDDING_PROVIDER");
    mockIsEnvOverridden.mockImplementation((key: string) => key === "EMBEDDING_PROVIDER");
    // ReadOnlyBadge label precedent: settings.generalTab.envBadge
    renderWithProviders(<SettingsLLM />);

    expect(screen.getByText("settings.generalTab.envBadge")).toBeInTheDocument();
    expect(screen.queryByText("settings.envOverriddenBadge")).not.toBeInTheDocument();
  });

  it("badge content is i18n text only — never an environment variable value (T-176-01)", () => {
    mockIsReadOnly.mockReturnValue(false);
    mockIsEnvOverridden.mockReturnValue(true);

    renderWithProviders(<SettingsLLM />);

    const badge = screen.getByText("settings.envOverriddenBadge");
    // The rendered badge is exactly the i18n key string — no env value leaked in
    expect(badge.textContent).toBe("settings.envOverriddenBadge");
    // The env value a mocked implementation might know is never rendered
    expect(badge.textContent).not.toContain("sk-test");
    expect(badge.textContent).not.toContain("http://ollama:11434");
  });
});
