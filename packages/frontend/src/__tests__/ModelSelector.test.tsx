// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ModelSelector component tests — render, grouping, search, default, onChange
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import ModelSelector from "../components/ModelSelector";
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
    // i18next t(key, defaultValue, { interpolate params })
    t: (key: string, _defaultOrOpts?: unknown, opts?: Record<string, string>) => {
      if (key === "chat.modelSelector.defaultWithModel" && opts) {
        return `Default (${opts.model || "?"} — ${opts.provider || "?"})`;
      }
      if (key === "chat.modelSelector.defaultWithModel") {
        return "Default";
      }
      const map: Record<string, string> = {
        "chat.modelSelector.default": "Default",
        "chat.modelSelector.noModels": "No models available",
        "chat.modelSelector.searchPlaceholder": "Search model...",
        "chat.modelSelector.unavailable": "Model no longer available",
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

// Mock provider queries
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

describe("ModelSelector", () => {
  const onChange = jest.fn();

  const renderWithProvider = (ui: React.ReactElement) =>
    render(<TooltipProvider>{ui}</TooltipProvider>);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders with default label when no value is selected", () => {
    renderWithProvider(<ModelSelector value={null} onChange={onChange} />);
    // Closed trigger shows the short label; the full default-model label
    // is the first item inside the opened dropdown.
    expect(screen.getByText("Default")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Default (Llama 3 — Ollama Local)")).toBeInTheDocument();
  });

  it("renders selected model name when value is provided", () => {
    renderWithProvider(
      <ModelSelector
        value={{ providerId: "p1", model: "gemma4:latest" }}
        onChange={onChange}
      />
    );
    expect(screen.getByText("Llama 3")).toBeInTheDocument();
  });

  it("opens dropdown on click and shows grouped models", () => {
    renderWithProvider(<ModelSelector value={null} onChange={onChange} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);

    // CommandInput placeholder appears when open
    expect(screen.getByPlaceholderText("Search model...")).toBeInTheDocument();

    // Provider groups
    expect(screen.getByText("Ollama Local")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();

    // Model names
    expect(screen.getByText("Llama 3")).toBeInTheDocument();
    expect(screen.getByText("mistral")).toBeInTheDocument();
    expect(screen.getByText("GPT-4")).toBeInTheDocument();
    expect(screen.getByText("Claude 3 Opus")).toBeInTheDocument();
  });

  it("filters models by search input", () => {
    renderWithProvider(<ModelSelector value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    const searchInput = screen.getByPlaceholderText("Search model...");
    fireEvent.change(searchInput, { target: { value: "llama" } });

    expect(screen.getByText("Llama 3")).toBeInTheDocument();
    expect(screen.queryByText("GPT-4")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude 3 Opus")).not.toBeInTheDocument();
  });

  it("calls onChange with selected model", () => {
    renderWithProvider(<ModelSelector value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    const gpt4Option = screen.getByText("GPT-4");
    fireEvent.click(gpt4Option);

    expect(onChange).toHaveBeenCalledWith({ providerId: "p2", model: "gpt-4" });
  });

  it("calls onChange with null when Default is selected", () => {
    renderWithProvider(<ModelSelector value={{ providerId: "p1", model: "gemma4:latest" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    const defaultButton = screen.getAllByText("Default (Llama 3 — Ollama Local)")[0];
    fireEvent.click(defaultButton);

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("closes dropdown after selection", () => {
    renderWithProvider(<ModelSelector value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByPlaceholderText("Search model...")).toBeInTheDocument();

    const gpt4Option = screen.getByText("GPT-4");
    fireEvent.click(gpt4Option);

    expect(screen.queryByPlaceholderText("Search model...")).not.toBeInTheDocument();
  });

  it("shows Local badge for Ollama models and Cloud for others", () => {
    renderWithProvider(<ModelSelector value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    // Two Ollama models → two Local badges, two cloud providers → two Cloud badges
    expect(screen.getAllByText("Local")).toHaveLength(2);
    expect(screen.getAllByText("Cloud")).toHaveLength(2);
  });

  it("shows default star on the default model", () => {
    renderWithProvider(<ModelSelector value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("★")).toBeInTheDocument();
  });

  it("renders translated capability badges for models with capabilities", () => {
    renderWithProvider(<ModelSelector value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    // Trigger + 2 dropdown items = 3 "Local only" badges
    expect(screen.getAllByText("Local only")).toHaveLength(3);
    expect(screen.getByText("Smartest")).toBeInTheDocument();
  });

  it("shows unavailable model warning when provided", () => {
    renderWithProvider(
      <ModelSelector
        value={null}
        onChange={onChange}
        unavailableModel={{ providerId: "p-deleted", model: "deleted-model" }}
      />
    );
    expect(screen.getByText("⚠")).toBeInTheDocument();
  });
});
