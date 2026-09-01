// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SetupWizard component tests (Phase 152-03, WIZ-01).
 *
 * Analog: LoginPage.test.tsx. Mocks the query hooks from
 * ../queries/useSystem so no live server is required. Uses @swc/jest ESM
 * transform (frontend AGENTS.md §Testing — import/export, not require).
 *
 * Cases (from PLAN Task 3):
 *  1. renders the Card with t("setup.wizard.title") and the controls bar
 *  2. the stepper shows 4 step labels
 *  3. admin step shows username/email/password fields + password show/hide (aria-label)
 *  4. Next is disabled until admin fields are valid (initializeSchema.safeParse)
 *  5. LLM step "Test connection" button triggers the probe mock
 *  6. probe success populates the model dropdown
 *  7. probe failure shows the inline error Alert but Next is still enabled (D-06)
 *  8. confirm step shows a read-only summary
 *  9. "Complete setup" calls useInitialize.mutateAsync
 * 10. on initialize success, localStorage("token") is set (D-08 auto-login)
 */
import type { ReactNode } from "react";
import type { MockComponentProps } from "../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import SetupWizard from "../components/SetupWizard";

// ─── i18n mock ────────────────────────────────────────────────────────
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const map: Record<string, string> = {
        "setup.wizard.title": "Setup Wizard",
        "setup.wizard.subtitle": "Configure your Simmetric Chat installation",
        "setup.wizard.next": "Next",
        "setup.wizard.back": "Back",
        "setup.wizard.complete": "Complete setup",
        "setup.wizard.testConnection": "Test connection",
        "setup.wizard.testing": "Testing…",
        "setup.wizard.probeSuccess": "Connection successful — {{count}} models available",
        "setup.wizard.probeFailure":
          "Could not reach {{target}}. You can proceed and configure this later in Settings.",
        "setup.wizard.modelsEmpty":
          "Test the connection to list available models, or type a model name.",
        "setup.wizard.modelsEmptyAfterProbe":
          "No models found. Check the base URL or type a model name manually.",
        "setup.wizard.initializeError":
          "Setup failed: {{message}}. Check your details and try again.",
        "setup.wizard.success": "Setup complete — welcome to Simmetric Chat",
        "setup.wizard.steps.admin.title": "Admin account",
        "setup.wizard.steps.admin.desc": "Create the administrator account for this installation.",
        "setup.wizard.steps.llm.title": "LLM provider",
        "setup.wizard.steps.llm.desc":
          "Choose where language models run. You can change this later in Settings.",
        "setup.wizard.steps.vector.title": "Vector database",
        "setup.wizard.steps.vector.desc":
          "Pick the vector store for document embeddings. You can change this later in Settings.",
        "setup.wizard.steps.confirm.title": "Confirm",
        "setup.wizard.steps.confirm.desc": "Review your configuration, then complete setup.",
        "setup.wizard.errors.usernameRequired": "Username is required.",
        "setup.wizard.errors.passwordShort": "Password must be at least {{min}} characters.",
        "setup.wizard.errors.emailInvalid": "Enter a valid email address.",
        "setup.wizard.errors.baseUrlRequired": "Base URL is required.",
        "setup.wizard.errors.modelRequired": "Select or enter a model name.",
        "login.language": "Language",
      };
      let value = map[key] || key;
      if (options) {
        for (const [name, replacement] of Object.entries(options)) {
          value = value.replaceAll(`{{${name}}}`, replacement);
        }
      }
      return value;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// ─── query hook mocks ────────────────────────────────────────────────
const mockInitializeMutateAsync = jest.fn();
const mockProbeLlmMutateAsync = jest.fn();
const mockProbeVectorMutateAsync = jest.fn();

jest.mock("../queries/useSystem", () => ({
  useSystemIsInitialized: () => ({
    data: { setupWizardMode: "active", initialized: false },
  }),
  useInitialize: () => ({
    mutateAsync: mockInitializeMutateAsync,
    isPending: false,
  }),
  useProbeLlm: () => ({
    mutateAsync: mockProbeLlmMutateAsync,
    isPending: false,
  }),
  useProbeVector: () => ({
    mutateAsync: mockProbeVectorMutateAsync,
    isPending: false,
  }),
}));

// ─── toast mock ──────────────────────────────────────────────────────
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
}));

// ─── navigation mock (jsdom freezes window.location) ─────────────────
const mockNavigateTo = jest.fn();
jest.mock("../utils/navigation", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
}));

// ─── ThemeToggle mock ────────────────────────────────────────────────
jest.mock("../components/ThemeToggle", () => ({
  __esModule: true,
  default: () => <button data-testid="theme-toggle">Toggle</button>,
}));

// ─── shadcn primitive mocks (mirror LoginPage.test.tsx) ─────────────
jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: MockComponentProps) => <button {...props}>{children}</button>,
}));

jest.mock("@/components/ui/input", () => ({
  Input: (props: MockComponentProps) => <input {...props} />,
}));

jest.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: MockComponentProps) => <label {...props}>{children}</label>,
}));

jest.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="card" {...props}>{children}</div>
  ),
  CardHeader: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="card-header" {...props}>{children}</div>
  ),
  CardTitle: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="card-title" {...props}>{children}</div>
  ),
  CardDescription: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="card-description" {...props}>{children}</div>
  ),
  CardContent: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="card-content" {...props}>{children}</div>
  ),
}));

jest.mock("@/components/ui/alert", () => ({
  Alert: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="alert" role="alert" {...props}>{children}</div>
  ),
  AlertDescription: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="alert-description" {...props}>{children}</div>
  ),
}));

jest.mock("@/components/ui/separator", () => ({
  Separator: (props: MockComponentProps) => <div data-testid="separator" {...props} />,
}));

jest.mock("@/components/ui/select", () => {
  const React = require("react");
  return {
    Select: ({
      children,
      value,
      onValueChange,
      ...props
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
      [key: string]: unknown;
    }) => (
      <div data-testid="select" data-value={value || ""} {...props}>
        {React.Children.map(children, (child: React.ReactNode) =>
          React.isValidElement(child)
            ? React.cloneElement(child, { selectValue: value, onValueChange })
            : child,
        )}
      </div>
    ),
    SelectTrigger: ({ children, ...props }: MockComponentProps) => (
      <button data-testid="select-trigger" {...props}>{children}</button>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => (
      <span data-testid="select-value" data-placeholder={placeholder || ""} />
    ),
    SelectContent: ({ children, ...props }: MockComponentProps) => (
      <div data-testid="select-content" {...props}>{children}</div>
    ),
    SelectItem: ({
      children,
      value,
      onValueChange,
      ...props
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
      [key: string]: unknown;
    }) => (
      <div
        data-testid="select-item"
        data-value={value}
        role="option"
        onClick={() => onValueChange && onValueChange(value as string)}
        {...props}
      >
        {children}
      </div>
    ),
  };
});

jest.mock("@/components/ui/app", () => ({
  AppInput: ({
    label,
    error,
    ...props
  }: { label?: string; error?: string; children?: ReactNode; [key: string]: unknown }) => (
    <div>
      {label && <label>{label}</label>}
      <input aria-label={label} {...(props as Record<string, unknown>)} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  ),
}));

jest.mock("lucide-react", () => ({
  Check: () => <svg data-testid="check-icon" />,
  Eye: () => <svg data-testid="eye-icon" />,
  EyeOff: () => <svg data-testid="eyeoff-icon" />,
  Loader2: () => <svg data-testid="loader2-icon" />,
}));

describe("SetupWizard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockInitializeMutateAsync.mockReset();
    mockProbeLlmMutateAsync.mockReset();
    mockProbeVectorMutateAsync.mockReset();
  });

  // 1. renders the Card with t("setup.wizard.title") and the controls bar
  it("renders the Card with the wizard title and the controls bar", () => {
    renderWithProviders(<SetupWizard />);
    expect(screen.getByTestId("card")).toBeInTheDocument();
    expect(screen.getByTestId("card-title")).toHaveTextContent("Setup Wizard");
    expect(screen.getByTestId("card-description")).toHaveTextContent(
      "Configure your Simmetric Chat installation",
    );
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("select")).toBeInTheDocument(); // language selector
  });

  // 2. the stepper shows 4 step labels
  //     The stepper renders the 4 step labels; on step 0 the "Admin
  //     account" heading ALSO renders, so use getAllByText for that one
  //     and getByText for the other three (only rendered by the stepper
  //     at this point).
  it("renders a stepper with 4 step labels", () => {
    renderWithProviders(<SetupWizard />);
    expect(screen.getAllByText("Admin account").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("LLM provider")).toBeInTheDocument();
    expect(screen.getByText("Vector database")).toBeInTheDocument();
    expect(screen.getByText("Confirm")).toBeInTheDocument();
  });

  // 3. admin step shows username/email/password fields + password show/hide (aria-label)
  it("shows username, email, and password fields with a password show/hide toggle", () => {
    renderWithProviders(<SetupWizard />);
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    // Email field — input[type=email] labelled by the t() string
    const emailInput = document.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement | null;
    expect(emailInput).not.toBeNull();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByTestId("eyeoff-icon")).toBeInTheDocument(); // starts hidden
    expect(
      screen.getByRole("button", {
        name: /show password/i,
      }),
    ).toBeInTheDocument();
  });

  // 4. Next is disabled until admin fields are valid (initializeSchema.safeParse)
  it("disables Next until username/email/password are valid", () => {
    renderWithProviders(<SetupWizard />);
    const nextButton = screen.getByRole("button", { name: "Next" });
    expect(nextButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });

    expect(nextButton).not.toBeDisabled();
  });

  // 5. LLM step "Test connection" button triggers the probe mock
  it("triggers useProbeLlm when the LLM step Test connection button is clicked", async () => {
    renderWithProviders(<SetupWizard />);
    // Advance to LLM step: fill admin fields and click Next
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // LLM step is now visible — find the Test connection button
    const testConn = await screen.findByRole("button", { name: "Test connection" });
    mockProbeLlmMutateAsync.mockResolvedValueOnce({
      ok: true,
      models: ["qwen2.5-coder:latest", "llama3.2:latest"],
    });
    fireEvent.click(testConn);

    await waitFor(() => expect(mockProbeLlmMutateAsync).toHaveBeenCalledTimes(1));
    // The provider + baseUrl are passed through
    expect(mockProbeLlmMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama" }),
    );
  });

  // 6. probe success populates the model dropdown
  it("populates the model dropdown after a successful LLM probe", async () => {
    renderWithProviders(<SetupWizard />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const testConn = await screen.findByRole("button", { name: "Test connection" });
    mockProbeLlmMutateAsync.mockResolvedValueOnce({
      ok: true,
      models: ["qwen2.5-coder:latest", "llama3.2:latest"],
    });
    fireEvent.click(testConn);

    // The success message with count=2 should appear
    await waitFor(() =>
      expect(
        screen.getByText(
          "Connection successful — 2 models available",
        ),
      ).toBeInTheDocument(),
    );
    // A model dropdown option (SelectItem) should render with a model
    // name. The language selector also uses SelectItem, so scope by the
    // model name (which only the model dropdown contains).
    await waitFor(() =>
      expect(screen.getByText("qwen2.5-coder:latest")).toBeInTheDocument(),
    );
  });

  // 7. probe failure shows the inline error Alert but Next is still enabled (D-06)
  it("shows an inline error Alert on probe failure but keeps Next enabled (D-06)", async () => {
    renderWithProviders(<SetupWizard />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const testConn = await screen.findByRole("button", { name: "Test connection" });
    mockProbeLlmMutateAsync.mockResolvedValueOnce({
      ok: false,
      error: "ECONNREFUSED",
    });
    fireEvent.click(testConn);

    await waitFor(() => expect(screen.getByTestId("alert")).toBeInTheDocument());
    // The inline error text should mention the failure
    expect(screen.getByTestId("alert")).toHaveTextContent(/Could not reach/);
    // Next button still enabled (non-blocking per D-06)
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });

  // 8. confirm step shows a read-only summary
  it("shows a read-only summary on the confirm step", async () => {
    renderWithProviders(<SetupWizard />);
    // admin
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // llm → next (no probe needed; model optional via manual fallback)
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // vector → next
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // confirm step visible — "Confirm" appears in both the stepper label
    // and the step 3 heading; assert the heading (more specific).
    expect(screen.getByRole("heading", { name: "Confirm" })).toBeInTheDocument();
    // read-only summary should list the admin username + email
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });

  // 9. "Complete setup" calls useInitialize.mutateAsync
  it("calls useInitialize.mutateAsync when Complete setup is clicked", async () => {
    mockInitializeMutateAsync.mockResolvedValueOnce({
      user: { id: "1", username: "admin", email: "a@b.com", mustChangePassword: false },
      token: "jwt-token-123",
    });
    renderWithProviders(<SetupWizard />);
    // Walk through the 4 steps
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // llm
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // vector

    const completeButton = await screen.findByRole("button", { name: "Complete setup" });
    fireEvent.click(completeButton);

    await waitFor(() => expect(mockInitializeMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockInitializeMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "admin",
        email: "admin@example.com",
        password: "password123",
      }),
    );
  });

  // 10. on initialize success, localStorage("token") is set (D-08 auto-login)
  it("stores the returned JWT in localStorage on initialize success (D-08)", async () => {
    mockInitializeMutateAsync.mockResolvedValueOnce({
      user: { id: "1", username: "admin", email: "a@b.com", mustChangePassword: false },
      token: "jwt-token-123",
    });
    renderWithProviders(<SetupWizard />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const completeButton = await screen.findByRole("button", { name: "Complete setup" });
    await act(async () => {
      fireEvent.click(completeButton);
    });

    await waitFor(() => {
      expect(localStorage.getItem("token")).toBe("jwt-token-123");
    });
  });
});