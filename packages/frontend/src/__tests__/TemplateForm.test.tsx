// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TemplateForm component tests — Phase 112-01 (G03).
 *
 * Verifies form field rendering, slug disabled state during edit,
 * form validation (submit disabled when required fields empty),
 * onSubmit/onCancel callbacks, and error display.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { TemplateForm } from "../components/TemplateForm";

// Mock i18n so the form renders with predictable text
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "settings.templates.form.nameLabel": "Name",
        "settings.templates.form.namePlaceholder": "e.g., Legal Assistant",
        "settings.templates.form.slugLabel": "Slug",
        "settings.templates.form.slugPlaceholder": "e.g., legal",
        "settings.templates.form.slugHint":
          "Unique identifier, lowercase — cannot be changed after creation",
        "settings.templates.form.iconLabel": "Icon",
        "settings.templates.form.iconPlaceholder": "e.g., \u2696\uFE0F",
        "settings.templates.form.embeddingModelLabel":
          "Embedding Model (optional)",
        "settings.templates.form.embeddingModelPlaceholder":
          "e.g., Xenova/all-MiniLM-L6-v2",
        "settings.templates.form.descriptionLabel": "Description",
        "settings.templates.form.descriptionPlaceholder":
          "Short description of this template",
        "settings.templates.form.systemPromptLabel": "System Prompt",
        "settings.templates.form.systemPromptPlaceholder":
          "Instructions injected into the agent system prompt...",
        "settings.templates.form.skillsLabel": "Skills",
        "settings.templates.form.skillsPlaceholder":
          "rag_search, workspace_memory",
        "settings.templates.form.skillsHint":
          "Comma-separated list of agent skills enabled for this template",
        "settings.templates.form.persistToDiskLabel": "Persist to disk",
        "settings.templates.form.persistToDiskHint":
          "Also save as a JSON file so the template is re-seeded on restart",
        "settings.templates.createButton": "New Template",
        "common.cancel": "Cancel",
        "common.save": "Save",
        "common.saving": "Saving...",
      };
      return map[key] ?? key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock shadcn DialogFooter so it renders children without wrapping them
jest.mock("@/components/ui/dialog", () => ({
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  __esModule: true,
}));

const baseProps = {
  submitting: false,
  error: null as string | null,
  onSubmit: jest.fn(),
  onCancel: jest.fn(),
};

describe("TemplateForm (Phase 112-01)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Create mode
  // -------------------------------------------------------------------------
  it("renders all form fields in create mode", () => {
    render(<TemplateForm {...baseProps} />);

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Slug")).toBeInTheDocument();
    expect(screen.getByLabelText("Icon")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Embedding Model (optional)"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("System Prompt")).toBeInTheDocument();
    expect(screen.getByLabelText("Skills")).toBeInTheDocument();
    // Persist to disk checkbox only in create mode
    expect(screen.getByLabelText("Persist to disk")).toBeInTheDocument();
  });

  it("slug field is enabled in create mode", () => {
    render(<TemplateForm {...baseProps} />);
    const slugInput = screen.getByLabelText("Slug");
    expect(slugInput).not.toBeDisabled();
  });

  it("shows slug hint text in create mode", () => {
    render(<TemplateForm {...baseProps} />);
    expect(
      screen.getByText(
        "Unique identifier, lowercase — cannot be changed after creation",
      ),
    ).toBeInTheDocument();
  });

  it("shows 'New Template' button text in create mode", () => {
    render(<TemplateForm {...baseProps} />);
    expect(screen.getByText("New Template")).toBeInTheDocument();
  });

  it("disables submit button when name is empty", () => {
    render(<TemplateForm {...baseProps} />);
    const submitBtn = screen.getByText("New Template");
    expect(submitBtn).toBeDisabled();
  });

  it("disables submit button when systemPrompt is empty", () => {
    render(<TemplateForm {...baseProps} />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Test Name" },
    });
    // System prompt is still empty
    const submitBtn = screen.getByText("New Template");
    expect(submitBtn).toBeDisabled();
  });

  it("enables submit button when name, slug, and systemPrompt are filled", () => {
    render(<TemplateForm {...baseProps} />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Test Template" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "test" },
    });
    fireEvent.change(screen.getByLabelText("System Prompt"), {
      target: { value: "You are a test assistant." },
    });
    const submitBtn = screen.getByText("New Template");
    expect(submitBtn).not.toBeDisabled();
  });

  it("calls onSubmit with form values when saved", () => {
    const onSubmit = jest.fn();
    render(<TemplateForm {...baseProps} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Test Template" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "test" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A test template" },
    });
    fireEvent.change(screen.getByLabelText("Icon"), {
      target: { value: "\uD83D\uDD12" },
    });
    fireEvent.change(screen.getByLabelText("System Prompt"), {
      target: { value: "You are a test assistant." },
    });
    fireEvent.change(screen.getByLabelText("Skills"), {
      target: { value: "rag_search, workspace_memory" },
    });

    fireEvent.click(screen.getByText("New Template"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Test Template",
        slug: "test",
        description: "A test template",
        icon: "\uD83D\uDD12",
        systemPrompt: "You are a test assistant.",
        skills: ["rag_search", "workspace_memory"],
      }),
    );
  });

  it("calls onCancel when cancel button is clicked", () => {
    const onCancel = jest.fn();
    render(<TemplateForm {...baseProps} onCancel={onCancel} />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows 'Saving...' when submitting is true", () => {
    render(<TemplateForm {...baseProps} submitting={true} />);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("displays error alert when error prop is set", () => {
    render(<TemplateForm {...baseProps} error="Something went wrong" />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Edit mode
  // -------------------------------------------------------------------------
  const editTemplate = {
    id: "tpl-edit-1",
    slug: "legal-assistant",
    name: "Legal Assistant",
    description: "Helps with legal research",
    icon: "\u2696\uFE0F",
    systemPrompt: "You are a legal assistant.",
    skills: ["rag_search", "wiki_query"],
    parsingConfig: { ocrRequired: true },
    constraints: { localLLMOnly: true },
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    isBuiltIn: false,
  };

  it("renders with pre-populated values in edit mode", () => {
    render(<TemplateForm {...baseProps} initial={editTemplate} />);

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.value).toBe("Legal Assistant");

    const slugInput = screen.getByLabelText("Slug") as HTMLInputElement;
    expect(slugInput.value).toBe("legal-assistant");
  });

  it("slug field is disabled in edit mode", () => {
    render(<TemplateForm {...baseProps} initial={editTemplate} />);

    const slugInput = screen.getByLabelText("Slug");
    expect(slugInput).toBeDisabled();
  });

  it("shows 'Save' button text in edit mode", () => {
    render(<TemplateForm {...baseProps} initial={editTemplate} />);
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("does not show persist-to-disk checkbox in edit mode", () => {
    render(<TemplateForm {...baseProps} initial={editTemplate} />);
    expect(
      screen.queryByLabelText("Persist to disk"),
    ).not.toBeInTheDocument();
  });

  it("calls onSubmit with updated values in edit mode", () => {
    const onSubmit = jest.fn();
    render(
      <TemplateForm
        {...baseProps}
        initial={editTemplate}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Updated Assistant" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Updated Assistant",
        slug: "legal-assistant", // preserved from initial
        systemPrompt: "You are a legal assistant.", // preserved
      }),
    );
  });

  it("submit is disabled when name cleared in edit mode", () => {
    render(
      <TemplateForm {...baseProps} initial={editTemplate} />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "" },
    });
    expect(screen.getByText("Save")).toBeDisabled();
  });
});
