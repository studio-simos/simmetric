// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsDlpPatterns tests (quick 260829-ony).
 *
 * Covers: render of the pattern list (built-in badge + custom row), enabled
 * toggle fires the update mutation, dialog open/validation (invalid regex
 * blocks save), and local test preview rendering. Mock shape mirrors
 * SettingsMaintenance.test.tsx (query hooks mocked at module level, i18next
 * returns raw keys).
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsDlpPatterns } from "../components/SettingsDlpPatterns";

function renderWithProvider(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const BUILT_IN = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "email",
  displayName: "Email",
  pattern: "[a-z]+@[a-z]+\\.[a-z]+",
  patternFlags: "gu",
  replacement: "[REDACTED]",
  isEnabled: true,
  isBuiltIn: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const CUSTOM = {
  ...BUILT_IN,
  id: "22222222-2222-4222-8222-222222222222",
  name: "fiscal_code",
  displayName: "Italian Fiscal Code",
  pattern: "[A-Z]{6}\\d{2}[A-Z]\\d{2}[A-Z]\\d{5}",
  isBuiltIn: false,
};

const mockPatterns = { data: [BUILT_IN, CUSTOM], isLoading: false, error: null };
const mockCreate = { mutateAsync: jest.fn().mockResolvedValue({ pattern: CUSTOM }) };
const mockUpdate = { mutateAsync: jest.fn().mockResolvedValue({ pattern: BUILT_IN }) };
const mockDelete = { mutateAsync: jest.fn().mockResolvedValue({ message: "ok" }) };

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // minimal interpolation so error text is checkable
      if (opts && "error" in opts) return `${key}:${opts["error"]}`;
      if (opts && "count" in opts) return `${key}:${opts["count"]}`;
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("../queries/useDlpPatterns", () => ({
  useDlpPatterns: () => mockPatterns,
  useCreateDlpPattern: () => mockCreate,
  useUpdateDlpPattern: () => mockUpdate,
  useDeleteDlpPattern: () => mockDelete,
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

describe("SettingsDlpPatterns", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders title, add button, built-in badge and custom row", () => {
    renderWithProvider(<SettingsDlpPatterns />);

    expect(screen.getByText("dlpPatterns.title")).toBeInTheDocument();
    expect(screen.getByText(/dlpPatterns.dangerZone/)).toBeInTheDocument();
    const row = screen.getByTestId("dlp-pattern-row-email");
    expect(row).toBeInTheDocument();
    expect(screen.getByText("dlpPatterns.builtIn")).toBeInTheDocument();
    expect(screen.getByTestId("dlp-pattern-row-fiscal_code")).toBeInTheDocument();
    // Custom row exposes delete; built-in exposes edit only
    expect(screen.getByLabelText("dlpPatterns.delete Italian Fiscal Code")).toBeInTheDocument();
  });

  it("toggle switch fires update mutation with isEnabled flip", async () => {
    renderWithProvider(<SettingsDlpPatterns />);

    fireEvent.click(screen.getByLabelText("dlpPatterns.toggle Email"));
    await waitFor(() => expect(mockUpdate.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mutateAsync).toHaveBeenCalledWith({
      id: BUILT_IN.id,
      data: { isEnabled: false },
    });
  });

  it("add dialog: valid pattern enables save, invalid regex blocks save", async () => {
    renderWithProvider(<SettingsDlpPatterns />);

    fireEvent.click(screen.getByTestId("dlp-add-pattern"));
    const nameInput = screen.getByTestId("dlp-pattern-name") as HTMLInputElement;
    const displayInput = screen.getByTestId("dlp-pattern-display") as HTMLInputElement;
    const regexInput = screen.getByTestId("dlp-pattern-regex") as HTMLInputElement;
    const saveBtn = screen.getByTestId("dlp-pattern-save") as HTMLButtonElement;

    // Empty form → save disabled
    expect(saveBtn).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: "italian_fiscal_code" } });
    fireEvent.change(displayInput, { target: { value: "Italian Fiscal Code" } });
    fireEvent.change(regexInput, { target: { value: "[A-Z]{6}\\d{2}" } });
    expect(saveBtn).toBeEnabled();

    // Invalid regex shows the inline error and disables save
    fireEvent.change(regexInput, { target: { value: "([unclosed" } });
    expect(screen.getByTestId("dlp-pattern-regex-error")).toHaveTextContent(
      "dlpPatterns.dialog.invalidRegex",
    );
    expect(saveBtn).toBeDisabled();
  });

  it("dialog save posts the create payload and shows the test preview", async () => {
    renderWithProvider(<SettingsDlpPatterns />);

    fireEvent.click(screen.getByTestId("dlp-add-pattern"));
    fireEvent.change(screen.getByTestId("dlp-pattern-name"), { target: { value: "fiscal_code" } });
    fireEvent.change(screen.getByTestId("dlp-pattern-display"), {
      target: { value: "Italian Fiscal Code" },
    });
    fireEvent.change(screen.getByTestId("dlp-pattern-regex"), {
      target: { value: "RSSMRA85T01A56225" },
    });
    const sample = screen.getByTestId("dlp-pattern-sample");
    fireEvent.change(sample, { target: { value: "code RSSMRA85T01A56225 here" } });

    // Live preview (client-side, no persistence)
    expect(screen.getByTestId("dlp-pattern-preview")).toHaveTextContent("RSSMRA85T01A56225");
    expect(screen.getByTestId("dlp-pattern-preview")).toHaveTextContent("[REDACTED]");

    fireEvent.click(screen.getByTestId("dlp-pattern-save"));
    await waitFor(() => expect(mockCreate.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreate.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "fiscal_code",
        displayName: "Italian Fiscal Code",
        pattern: "RSSMRA85T01A56225",
      }),
    );
  });
});
