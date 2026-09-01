// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ProjectRenameModal component tests — Feature 1 / 3.5 (interaction: rename).
 *
 * Verifies the rename flow: prefill from the active project, client-side
 * validation (1–200 chars mirrors the shared Zod schema), commit via
 * `useRenameProject` (PUT /api/projects/:id), success/error toasts, close on
 * success, Enter-to-save, and the disabled state of the Save button.
 */
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Return the key as-is so we can assert on stable text; for the counter
    // we render the raw value, so no interpolation needed here.
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockMutateAsync = jest.fn();
const mockUseRenameProject = jest.fn(() => ({
  mutateAsync: mockMutateAsync,
  isPending: false,
}));

jest.mock("../queries/useProjects", () => ({
  useRenameProject: () => mockUseRenameProject(),
}));

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
jest.mock("../lib/toast", () => ({
  showSuccess: (...args: unknown[]) => mockShowSuccess(...args),
  showError: (...args: unknown[]) => mockShowError(...args),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ProjectRenameModal from "../components/ProjectRenameModal";

const PROPS = {
  open: true,
  onOpenChange: jest.fn(),
  project: { id: "proj-1", name: "Original Name" },
};

describe("ProjectRenameModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("prefills the input with the current project name when open", () => {
    render(<ProjectRenameModal {...PROPS} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Original Name");
    // Character counter mirrors the 1–200 Zod constraint.
    expect(screen.getByText("13/200")).toBeInTheDocument();
  });

  it("keeps the Save button disabled for an empty (whitespace-only) name", () => {
    render(<ProjectRenameModal {...PROPS} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    // Counter renders trimmed.length, so whitespace-only → 0/200.
    expect(screen.getByText("0/200")).toBeInTheDocument();
    expect(screen.getByText("projectRename.save")).toBeDisabled();
  });

  it("keeps the Save button disabled when the name exceeds 200 chars", () => {
    render(<ProjectRenameModal {...PROPS} />);
    const input = screen.getByRole("textbox");
    // Programmatic value assignment bypasses the DOM maxLength clamp, so the
    // counter shows the raw (over-limit) length — and Save stays disabled.
    const tooLong = "x".repeat(201);
    fireEvent.change(input, { target: { value: tooLong } });
    expect(screen.getByText("201/200")).toBeInTheDocument();
    expect(screen.getByText("projectRename.save")).toBeDisabled();
  });

  it("commits the rename via mutateAsync, toasts success, and closes", async () => {
    mockMutateAsync.mockResolvedValueOnce({ id: "proj-1", name: "New Name" });
    render(<ProjectRenameModal {...PROPS} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.click(screen.getByText("projectRename.save"));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ projectId: "proj-1", name: "New Name" });
    });
    expect(mockShowSuccess).toHaveBeenCalledWith("projectRename.success");
    expect(PROPS.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("trims the name before submitting", async () => {
    mockMutateAsync.mockResolvedValueOnce({ id: "proj-1", name: "Trimmed" });
    render(<ProjectRenameModal {...PROPS} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  Trimmed  " } });
    fireEvent.click(screen.getByText("projectRename.save"));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ projectId: "proj-1", name: "Trimmed" });
    });
  });

  it("shows an error toast and stays open when the mutation rejects", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error("Server boom"));
    render(<ProjectRenameModal {...PROPS} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Still Valid" } });
    fireEvent.click(screen.getByText("projectRename.save"));

    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith("Server boom");
    });
    expect(mockShowSuccess).not.toHaveBeenCalled();
    expect(PROPS.onOpenChange).not.toHaveBeenCalled();
  });

  it("falls back to the generic error message on non-Error rejections", async () => {
    mockMutateAsync.mockRejectedValueOnce("string reject");
    render(<ProjectRenameModal {...PROPS} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Valid" } });
    fireEvent.click(screen.getByText("projectRename.save"));

    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith("projectRename.error");
    });
  });

  it("submits on Enter when the name is valid", async () => {
    mockMutateAsync.mockResolvedValueOnce({ id: "proj-1", name: "Enter Save" });
    render(<ProjectRenameModal {...PROPS} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Enter Save" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ projectId: "proj-1", name: "Enter Save" });
    });
  });

  it("does not submit on Enter when the name is empty", () => {
    render(<ProjectRenameModal {...PROPS} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("closes via the Cancel button without mutating", () => {
    render(<ProjectRenameModal {...PROPS} />);
    fireEvent.click(screen.getByText("projectRename.cancel"));
    expect(PROPS.onOpenChange).toHaveBeenCalledWith(false);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});