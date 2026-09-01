// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ModelPalette component tests — CommandDialog, search, selection, footer
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import ModelPalette from "../components/ModelPalette";
import { TooltipProvider } from "@/components/ui/tooltip";

// cmdk requires ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom does not implement scrollIntoView
global.Element.prototype.scrollIntoView = jest.fn();

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, _defaultOrOpts?: unknown, opts?: Record<string, string>) => {
      if (key === "chat.modelSelector.defaultWithModel" && opts) {
        return `Default (${opts.model || "?"} — ${opts.provider || "?"})`;
      }
      const map: Record<string, string> = {
        "chat.palette.searchPlaceholder": "Search model...",
        "chat.modelSelector.noModels": "No models available",
        "chat.palette.footerHints": "↑↓ to navigate, Enter to select, Escape to close",
        "chat.palette.comparisonTipMac": "Cmd+Shift+M to compare models (coming soon)",
        "chat.palette.comparisonTipWin": "Ctrl+Shift+M to compare models (coming soon)",
        "chat.capabilities.localOnly": "Local only",
        "chat.capabilities.fastest": "Fastest",
        "chat.capabilities.smartest": "Smartest",
        "chat.capabilities.reasoning": "Reasoning",
      };
      return map[key] || key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock provider store
const mockAvailableModels = [
  {
    id: "m1",
    name: "gemma4:latest",
    displayName: "Llama 3",
    providerId: "p1",
    providerName: "Ollama Local",
    providerType: "ollama" as const,
    isDefault: true,
    isLocal: true,
    capabilities: ["local-only"],
  },
  {
    id: "m2",
    name: "mistral",
    displayName: null,
    providerId: "p1",
    providerName: "Ollama Local",
    providerType: "ollama" as const,
    isDefault: false,
    isLocal: true,
    capabilities: ["local-only"],
  },
  {
    id: "m3",
    name: "gpt-4",
    displayName: "GPT-4",
    providerId: "p2",
    providerName: "OpenAI",
    providerType: "openai" as const,
    isDefault: false,
    isLocal: false,
    capabilities: [],
  },
  {
    id: "m4",
    name: "claude-3-opus",
    displayName: "Claude 3 Opus",
    providerId: "p3",
    providerName: "Anthropic",
    providerType: "anthropic" as const,
    isDefault: false,
    isLocal: false,
    capabilities: ["smartest"],
  },
];

jest.mock("../queries/useProviders", () => ({
  useAvailableModels: () => ({ data: mockAvailableModels, isLoading: false, error: null }),
}));

describe("ModelPalette", () => {
  const onClose = jest.fn();
  const onSelect = jest.fn();

  const renderWithProvider = (ui: React.ReactElement) =>
    render(<TooltipProvider>{ui}</TooltipProvider>);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders CommandDialog with search input when open", () => {
    renderWithProvider(
      <ModelPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    expect(screen.getByPlaceholderText("Search model...")).toBeInTheDocument();
  });

  it("does not render content when closed", () => {
    renderWithProvider(
      <ModelPalette
        open={false}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    expect(screen.queryByPlaceholderText("Search model...")).not.toBeInTheDocument();
  });

  it("shows provider groups and model names", () => {
    renderWithProvider(
      <ModelPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    expect(screen.getByText("Ollama Local")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();

    expect(screen.getByText("Llama 3")).toBeInTheDocument();
    expect(screen.getByText("mistral")).toBeInTheDocument();
    expect(screen.getByText("GPT-4")).toBeInTheDocument();
    expect(screen.getByText("Claude 3 Opus")).toBeInTheDocument();
  });

  it("calls onSelect and onClose when a model is selected", () => {
    renderWithProvider(
      <ModelPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    const gpt4Item = screen.getByText("GPT-4");
    fireEvent.click(gpt4Item);

    expect(onSelect).toHaveBeenCalledWith({ providerId: "p2", model: "gpt-4" });
    expect(onClose).toHaveBeenCalled();
  });

  it("offers a Default option that clears the override (onSelect null)", () => {
    renderWithProvider(
      <ModelPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    // The Default reset entry resolves to "Default (Llama 3 — Ollama Local)"
    // via the i18n mock for chat.modelSelector.defaultWithModel.
    const defaultItem = screen.getByText("Default (Llama 3 — Ollama Local)");
    fireEvent.click(defaultItem);

    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders footer hints", () => {
    renderWithProvider(
      <ModelPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    expect(
      screen.getByText("↑↓ to navigate, Enter to select, Escape to close")
    ).toBeInTheDocument();
  });

  it("shows Local and Cloud badges", () => {
    renderWithProvider(
      <ModelPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    expect(screen.getAllByText("Local").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Cloud").length).toBeGreaterThanOrEqual(2);
  });

  it("shows default star on the default model", () => {
    renderWithProvider(
      <ModelPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    // One ★ on the default model in the list, plus one on the "Default" reset
    // option at the top (Feature 8 follow-up).
    expect(screen.getAllByText("★").length).toBeGreaterThanOrEqual(1);
  });

  it("shows capability badges for models with capabilities", () => {
    renderWithProvider(
      <ModelPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
      />
    );
    expect(screen.getByText("Smartest")).toBeInTheDocument();
    expect(screen.getAllByText("Local only").length).toBeGreaterThanOrEqual(1);
  });
});
