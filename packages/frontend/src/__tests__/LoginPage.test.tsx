// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * LoginPage component tests -- render, Card, Tabs, Select presence
 */
import type { ReactNode } from "react";
import type { MockComponentProps } from "../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import LoginPage from "../components/LoginPage";

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const map: Record<string, string> = {
        "app.subtitle": "AI-powered chat workspace",
        "login.signIn": "Sign In",
        "login.createAccount": "Create Account",
        "login.username": "Username",
        "login.usernamePlaceholder": "Enter username",
        "login.email": "Email",
        "login.emailPlaceholder": "Enter email",
        "login.password": "Password",
        "login.passwordPlaceholderLogin": "Enter password",
        "login.passwordPlaceholderRegister": "Create a strong password",
        "login.signingIn": "Signing in...",
        "login.creatingAccount": "Creating account...",
        "login.successLogin": "Welcome back!",
        "login.successRegister": "Account created successfully",
        "login.authFailed": "Authentication failed",
        "login.contactAdmin": "Contact your administrator for access",
        "login.footer": "Powered by Simmetric Chat",
        "login.language": "Language",
        "login.ssoSignIn": "Login with SSO",
        "login.ssoSignInWith": "Continue with {{provider}}",
        "login.forceChange.title": "Set a new password",
        "login.forceChange.description": "You must set a new password before continuing.",
        "login.forceChange.newPassword": "New password",
        "login.forceChange.confirmPassword": "Confirm password",
        "login.forceChange.newPasswordPlaceholder": "At least 8 characters",
        "login.forceChange.confirmPasswordPlaceholder": "Re-enter your new password",
        "login.forceChange.submit": "Set password",
        "login.forceChange.submitting": "Saving...",
        "login.forceChange.success": "Password updated successfully",
        "login.forceChange.mismatch": "Passwords do not match",
        "login.forceChange.signOut": "Sign out",
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
  // Include initReactI18next so the transitively-imported src/i18n/index.ts
  // (which calls i18n.use(initReactI18next)) does not throw "You are passing an
  // undefined module" under Jest.
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock auth queries
const mockLoginMutateAsync = jest.fn();
const mockSetInitialPasswordMutateAsync = jest.fn();
const mockLogoutMutate = jest.fn();

jest.mock("../queries/useAuth", () => ({
  useLogin: () => ({
    mutateAsync: mockLoginMutateAsync,
    isPending: false,
  }),
  useSetInitialPassword: () => ({
    mutateAsync: mockSetInitialPasswordMutateAsync,
    isPending: false,
  }),
  useLogout: () => ({
    mutate: mockLogoutMutate,
    isPending: false,
  }),
}));

// Mock toast
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
}));

// Mock navigation helper (jsdom 26 freezes window.location — see
// src/utils/navigation.ts).
const mockNavigateTo = jest.fn();
jest.mock("../utils/navigation", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
}));

// Mock ThemeToggle
jest.mock("../components/ThemeToggle", () => ({
  __esModule: true,
  default: () => <button data-testid="theme-toggle">Toggle</button>,
}));

// Mock shadcn/ui components that use @/ path aliases not resolved by Jest
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
  Card: ({ children, ...props }: MockComponentProps) => <div data-testid="card" {...props}>{children}</div>,
  CardHeader: ({ children, ...props }: MockComponentProps) => <div data-testid="card-header" {...props}>{children}</div>,
  CardTitle: ({ children, ...props }: MockComponentProps) => <div data-testid="card-title" {...props}>{children}</div>,
  CardDescription: ({ children, ...props }: MockComponentProps) => <div data-testid="card-description" {...props}>{children}</div>,
  CardContent: ({ children, ...props }: MockComponentProps) => <div data-testid="card-content" {...props}>{children}</div>,
}));

jest.mock("@/components/ui/select", () => {
  const React = require("react");
  return {
    Select: ({ children, value, onValueChange, ...props }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void; [key: string]: unknown }) => (
      <div data-testid="select" data-value={value} {...props}>
        {React.Children.map(children, (child: React.ReactNode) =>
          React.isValidElement(child)
            ? React.cloneElement(child, { selectValue: value, onValueChange })
            : child
        )}
      </div>
    ),
    SelectTrigger: ({ children, selectValue: _selectValue, onValueChange: _onValueChange, ...props }: { children?: ReactNode; selectValue?: unknown; onValueChange?: (value: string) => void; [key: string]: unknown }) => (
      <button data-testid="select-trigger" {...props}>{children}</button>
    ),
    SelectValue: () => <span data-testid="select-value" />,
    SelectContent: ({ children, selectValue: _selectValue, onValueChange: _onValueChange, ...props }: { children?: ReactNode; selectValue?: unknown; onValueChange?: (value: string) => void; [key: string]: unknown }) => <div data-testid="select-content" {...props}>{children}</div>,
    SelectItem: ({ children, value, onValueChange, selectValue: _selectValue, ...props }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void; selectValue?: unknown; [key: string]: unknown }) => (
      <div
        data-testid="select-item"
        data-value={value}
        role="option"
        onClick={() => onValueChange && onValueChange(value)}
        {...props}
      >
        {children}
      </div>
    ),
  };
});

jest.mock("@/components/ui/tabs", () => {
  const React = require("react");
  const { useState } = React;

  const TabsContext = React.createContext<{ value: string; onValueChange: (v: string) => void }>({
    value: "",
    onValueChange: () => {},
  });

  return {
    Tabs: ({ children, defaultValue, value: controlledValue, onValueChange, ...props }: { children?: ReactNode; defaultValue?: string; value?: string; onValueChange?: (value: string) => void; [key: string]: unknown }) => {
      const [internalValue, setInternalValue] = useState(defaultValue || "");
      const activeValue = controlledValue !== undefined ? controlledValue : internalValue;
      const handleChange = (v: string) => {
        if (onValueChange) onValueChange(v);
        if (controlledValue === undefined) setInternalValue(v);
      };
      return (
        <TabsContext.Provider value={{ value: activeValue, onValueChange: handleChange }}>
          <div data-testid="tabs" data-value={activeValue} data-default={defaultValue} {...props}>
            {children}
          </div>
        </TabsContext.Provider>
      );
    },
    TabsList: ({ children, ...props }: MockComponentProps) => <div data-testid="tabs-list" role="tablist" {...props}>{children}</div>,
    TabsTrigger: ({ children, value, ...props }: { children?: ReactNode; value?: string; [key: string]: unknown }) => {
      const ctx = React.useContext(TabsContext);
      return (
        <button
          data-testid="tabs-trigger"
          data-value={value}
          role="tab"
          aria-selected={ctx.value === value}
          onClick={() => ctx.onValueChange(value)}
          {...props}
        >
          {children}
        </button>
      );
    },
    TabsContent: ({ children, value, ...props }: { children?: ReactNode; value?: string; [key: string]: unknown }) => {
      const ctx = React.useContext(TabsContext);
      if (ctx.value !== value) return null;
      return (
        <div data-testid="tabs-content" data-value={value} role="tabpanel" {...props}>
          {children}
        </div>
      );
    },
  };
});

jest.mock("@/components/ui/app", () => ({
  AppInput: ({ label, ...props }: { label?: string; children?: ReactNode; [key: string]: unknown }) => (
    <div>
      {label && <label>{label}</label>}
      <input aria-label={label} {...props} />
    </div>
  ),
}));

jest.mock("lucide-react", () => ({
  Eye: () => <svg data-testid="eye-icon" />,
  EyeOff: () => <svg data-testid="eyeoff-icon" />,
}));

// useSsoStatus is mocked at module level; the SSO tests below override the
// returned status per-test via mockSsoStatus.
const mockSsoStatus = jest.fn();
jest.mock("../queries/useSso", () => ({
  useSsoConfig: () => ({ data: undefined }),
  useSsoStatus: () => ({ data: mockSsoStatus() }),
}));

// useFeature is mocked at module level; the SSO tests below override the
// return value per-test via mockFeatureEnabled.
const mockFeatureEnabled = jest.fn();
jest.mock("../hooks/useFeature", () => ({
  useFeature: () => mockFeatureEnabled(),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSsoStatus.mockReturnValue(undefined);
    mockFeatureEnabled.mockReturnValue(false);
  });

  it("renders Card with title and subtitle", () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByTestId("card")).toBeInTheDocument();
    expect(screen.getByTestId("card-header")).toBeInTheDocument();
    expect(screen.getByTestId("card-title")).toHaveTextContent("Simmetric Chat");
    expect(screen.getByTestId("card-description")).toHaveTextContent("AI-powered chat workspace");
  });

  it("does NOT render a Create Account tab (self-registration removed)", () => {
    renderWithProviders(<LoginPage />);
    expect(screen.queryByRole("tab", { name: "Create Account" })).not.toBeInTheDocument();
    expect(screen.queryByText("Create Account")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("shows only the Sign In form fields", () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter password")).toBeInTheDocument();
    expect(screen.getByText("Contact your administrator for access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeInTheDocument();
    // No register-only fields
    expect(screen.queryByPlaceholderText("Enter email")).not.toBeInTheDocument();
  });

  it("renders language Select with options", () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByTestId("select")).toBeInTheDocument();
    expect(screen.getByTestId("select-trigger")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Italiano" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Русский" })).toBeInTheDocument();
  });

  it("renders theme toggle", () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  it("renders footer text", () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByText("Powered by Simmetric Chat")).toBeInTheDocument();
  });

  it("submits login form with username and password", async () => {
    mockLoginMutateAsync.mockResolvedValueOnce({ user: { id: "1", username: "admin" }, token: "tok" });

    renderWithProviders(<LoginPage />);
    const usernameInput = screen.getByLabelText("Username");
    const passwordInput = screen.getByPlaceholderText("Enter password");
    const submitButton = screen.getByRole("button", { name: "Sign In" });

    fireEvent.change(usernameInput, { target: { value: "admin" } });
    fireEvent.change(passwordInput, { target: { value: "password123" } });
    fireEvent.click(submitButton);

    expect(mockLoginMutateAsync).toHaveBeenCalledWith({ username: "admin", password: "password123" });
  });

  // ─── SSO button (quick 260808-p5y) ─────────────────────────────

  it("renders the SSO button for an enabled saml status and navigates to the saml login route", () => {
    mockFeatureEnabled.mockReturnValue(true);
    mockSsoStatus.mockReturnValue({ enabled: true, provider: "saml", oidcProvider: null });

    renderWithProviders(<LoginPage />);
    const ssoButton = screen.getByRole("button", { name: "Login with SSO" });
    expect(ssoButton).toBeInTheDocument();
    fireEvent.click(ssoButton);
    expect(mockNavigateTo).toHaveBeenCalledWith("/api/auth/saml/login");
  });

  it("navigates to the google oidc login route with the provider label", () => {
    mockFeatureEnabled.mockReturnValue(true);
    mockSsoStatus.mockReturnValue({ enabled: true, provider: "oidc", oidcProvider: "google" });

    renderWithProviders(<LoginPage />);
    const ssoButton = screen.getByRole("button", { name: "Continue with Google" });
    expect(ssoButton).toBeInTheDocument();
    fireEvent.click(ssoButton);
    expect(mockNavigateTo).toHaveBeenCalledWith("/api/auth/oidc/google/login");
  });

  it("navigates to the custom oidc login route with the generic label", () => {
    mockFeatureEnabled.mockReturnValue(true);
    mockSsoStatus.mockReturnValue({ enabled: true, provider: "oidc", oidcProvider: "oidc" });

    renderWithProviders(<LoginPage />);
    const ssoButton = screen.getByRole("button", { name: "Login with SSO" });
    expect(ssoButton).toBeInTheDocument();
    fireEvent.click(ssoButton);
    expect(mockNavigateTo).toHaveBeenCalledWith("/api/auth/oidc/oidc/login");
  });

  it("does NOT render the SSO button when the public status reports disabled", () => {
    mockFeatureEnabled.mockReturnValue(true);
    mockSsoStatus.mockReturnValue({ enabled: false, provider: null, oidcProvider: null });

    renderWithProviders(<LoginPage />);
    expect(screen.queryByRole("button", { name: "Login with SSO" })).not.toBeInTheDocument();
    expect(screen.queryByText("or sign in with SSO")).not.toBeInTheDocument();
  });

  it("does NOT render the SSO button when the license feature is disabled", () => {
    mockFeatureEnabled.mockReturnValue(false);
    mockSsoStatus.mockReturnValue({ enabled: true, provider: "saml", oidcProvider: null });

    renderWithProviders(<LoginPage />);
    expect(screen.queryByRole("button", { name: "Login with SSO" })).not.toBeInTheDocument();
  });
});

// ─── ForcePasswordChange ──────────────────────────────────────────

import ForcePasswordChange from "../components/ForcePasswordChange";

describe("ForcePasswordChange", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders new and confirm password fields", () => {
    renderWithProviders(<ForcePasswordChange />);
    expect(screen.getByPlaceholderText("At least 8 characters")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Re-enter your new password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set password" })).toBeInTheDocument();
  });

  it("shows a mismatch error and does not call the mutation when passwords differ", () => {
    renderWithProviders(<ForcePasswordChange />);
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "longenough1" },
    });
    fireEvent.change(screen.getByPlaceholderText("Re-enter your new password"), {
      target: { value: "different123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match");
    expect(mockSetInitialPasswordMutateAsync).not.toHaveBeenCalled();
  });
});
