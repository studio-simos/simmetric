// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsTemplates component tests — Phase 112-01
 *
 * Covers the full CRUD table: column headers, built-in vs custom distinction,
 * empty state, loading state, and action buttons.
 *
 * Mocks: useTemplates hooks, useTranslation, toast, errorUtils.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockUseTemplates = jest.fn();
const mockUseCreateTemplate = jest.fn();
const mockUseUpdateTemplate = jest.fn();
const mockUseDeleteTemplate = jest.fn();

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "settings.templates.description":
          "Manage industry templates applied to workspaces.",
        "settings.templates.createButton": "New Template",
        "settings.templates.columns.icon": "Icon",
        "settings.templates.columns.name": "Name",
        "settings.templates.columns.slug": "Slug",
        "settings.templates.columns.systemPrompt": "System Prompt",
        "settings.templates.columns.skills": "Skills",
        "settings.templates.columns.type": "Type",
        "settings.templates.columns.actions": "Actions",
        "settings.templates.builtIn": "Built-in",
        "settings.templates.custom": "Custom",
        "settings.templates.readOnly": "Read-only",
        "settings.templates.readOnlyHint":
          "Built-in templates cannot be modified",
        "settings.templates.noTemplates": "No templates found",
        "settings.templates.loadError": "Failed to load templates",
        "common.loading": "Loading...",
        "common.edit": "Edit",
        "common.delete": "Delete",
      };
      return map[key] ?? key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
}));

jest.mock("../utils/errorUtils", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : "error",
}));

jest.mock("../queries/useTemplates", () => ({
  useTemplates: (...args: unknown[]) => mockUseTemplates(...args),
  useCreateTemplate: (...args: unknown[]) => mockUseCreateTemplate(...args),
  useUpdateTemplate: (...args: unknown[]) => mockUseUpdateTemplate(...args),
  useDeleteTemplate: (...args: unknown[]) => mockUseDeleteTemplate(...args),
}));

// shadcn Dialog mock — renders children so the form is visible in tests
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// shadcn AlertDialog mock
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-dialog-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { SettingsTemplates } from "../components/SettingsTemplates";

const builtInTemplate = {
  id: "tpl-builtin-1",
  slug: "default-assistant",
  name: "Default Assistant",
  description: "A general-purpose assistant",
  icon: "\uD83E\uDD16",
  systemPrompt: "You are a helpful assistant.",
  skills: ["rag_search", "workspace_memory"],
  parsingConfig: {},
  constraints: {},
  embeddingModel: null,
  isBuiltIn: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const customTemplate = {
  id: "tpl-custom-1",
  slug: "legal-assistant",
  name: "Legal Assistant",
  description: "Assists with legal research",
  icon: "\u2696\uFE0F",
  systemPrompt:
    "You are a legal assistant. You help with legal research and document review.",
  skills: ["rag_search", "wiki_query", "wiki_write"],
  parsingConfig: { ocrRequired: true },
  constraints: { localLLMOnly: true },
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  isBuiltIn: false,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-15T00:00:00Z",
};

describe("SettingsTemplates (Phase 112-01)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseTemplates.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
    mockUseCreateTemplate.mockReturnValue({ mutateAsync: jest.fn() });
    mockUseUpdateTemplate.mockReturnValue({ mutateAsync: jest.fn() });
    mockUseDeleteTemplate.mockReturnValue({ mutateAsync: jest.fn() });
  });

  it("renders the description text", () => {
    mockUseTemplates.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
    render(<SettingsTemplates />);
    expect(
      screen.getByText("Manage industry templates applied to workspaces."),
    ).toBeInTheDocument();
  });

  it("renders 'New Template' button", () => {
    mockUseTemplates.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
    render(<SettingsTemplates />);
    expect(screen.getByText("New Template")).toBeInTheDocument();
  });

  it("renders table with all column headers", () => {
    mockUseTemplates.mockReturnValue({
      data: [builtInTemplate, customTemplate],
      isLoading: false,
      error: null,
    });
    render(<SettingsTemplates />);

    const headers = [
      "Icon",
      "Name",
      "Slug",
      "System Prompt",
      "Skills",
      "Type",
      "Actions",
    ];
    for (const h of headers) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it("renders built-in templates with 'Built-in' badge and read-only action", () => {
    mockUseTemplates.mockReturnValue({
      data: [builtInTemplate],
      isLoading: false,
      error: null,
    });
    render(<SettingsTemplates />);

    expect(screen.getByText("Built-in")).toBeInTheDocument();
    const readOnlyEl = screen.getByText("Read-only");
    expect(readOnlyEl).toBeInTheDocument();
    // Verify the tooltip title attribute (G04)
    expect(readOnlyEl).toHaveAttribute(
      "title",
      "Built-in templates cannot be modified",
    );
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("renders custom templates with Custom badge", () => {
    mockUseTemplates.mockReturnValue({
      data: [customTemplate],
      isLoading: false,
      error: null,
    });
    render(<SettingsTemplates />);

    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("shows empty state when no templates exist", () => {
    mockUseTemplates.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
    render(<SettingsTemplates />);

    expect(screen.getByText("No templates found")).toBeInTheDocument();
  });

  it("shows loading indicator when data is loading", () => {
    mockUseTemplates.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<SettingsTemplates />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error message when query fails", () => {
    mockUseTemplates.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Network error"),
    });
    render(<SettingsTemplates />);

    expect(screen.getByText("Failed to load templates")).toBeInTheDocument();
  });
});
