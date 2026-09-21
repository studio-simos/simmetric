// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-01, D-01/D-03): OnboardingWizard tests — the two D-03
 * empty states + the create flow through useCreatePersonalWorkspace +
 * the 409 duplicate-name copy.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
jest.mock("../lib/toast", () => ({
  showSuccess: (...args: unknown[]) => mockShowSuccess(...args),
  showError: (...args: unknown[]) => mockShowError(...args),
}));

jest.mock("../utils/errorUtils", () => ({
  getErrorMessage: (err: unknown, fallback: string) =>
    (err as { message?: string })?.message ?? fallback,
}));

const mockCreateMutateAsync = jest.fn();
jest.mock("../queries/usePersonalWorkspace", () => ({
  useCreatePersonalWorkspace: jest.fn(() => ({
    mutateAsync: mockCreateMutateAsync,
    isPending: false,
  })),
}));

import OnboardingWizard from "../components/OnboardingWizard";

function renderWizard(props: { hasOnboarded: boolean; workspacesCount: number }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { TooltipProvider } = require("@/components/ui/tooltip");
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <OnboardingWizard {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateMutateAsync.mockResolvedValue({
    workspace: { id: "w1", name: "Mine", projectId: "p1" },
    hasOnboarded: true,
  });
});

describe("OnboardingWizard (D-01/D-03)", () => {
  it("state 1: !hasOnboarded && count 0 → guided wizard with name input + create", () => {
    renderWizard({ hasOnboarded: false, workspacesCount: 0 });
    expect(screen.getByTestId("onboarding-wizard")).toBeInTheDocument();
    expect(screen.getByLabelText("onboarding.workspaceNameLabel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "onboarding.create" })).toBeInTheDocument();
  });

  it("state 2: hasOnboarded && count 0 → ask-admin message, NO create affordance", () => {
    renderWizard({ hasOnboarded: true, workspacesCount: 0 });
    expect(screen.getByTestId("onboarding-ask-admin")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-wizard")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "onboarding.create" })).not.toBeInTheDocument();
  });

  it("create click invokes the mutation hook with the entered (trimmed) name", async () => {
    renderWizard({ hasOnboarded: false, workspacesCount: 0 });
    const input = screen.getByLabelText("onboarding.workspaceNameLabel");
    fireEvent.change(input, { target: { value: "  My workspace  " } });
    fireEvent.click(screen.getByRole("button", { name: "onboarding.create" }));
    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledWith({ workspaceName: "My workspace" });
    });
    expect(mockShowSuccess).toHaveBeenCalledWith("onboarding.createSuccess");
  });

  it("409 duplicate-name error surfaces the onboarding.duplicateName copy", async () => {
    mockCreateMutateAsync.mockRejectedValue(
      new Error("A workspace with this name already exists in this project"),
    );
    renderWizard({ hasOnboarded: false, workspacesCount: 0 });
    fireEvent.change(screen.getByLabelText("onboarding.workspaceNameLabel"), {
      target: { value: "Dup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "onboarding.create" }));
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith("onboarding.duplicateName");
    });
  });

  it("create button disabled on empty or >100-char names (schema bounds mirrored client-side)", () => {
    renderWizard({ hasOnboarded: false, workspacesCount: 0 });
    const button = screen.getByRole("button", { name: "onboarding.create" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("onboarding.workspaceNameLabel"), {
      target: { value: "x".repeat(101) },
    });
    expect(button).toBeDisabled();
  });
});