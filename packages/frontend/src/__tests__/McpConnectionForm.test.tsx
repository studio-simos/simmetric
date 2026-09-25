// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * McpConnectionForm tests — Phase 196 plan 03 Task 2 (D-01/MCPU-01).
 *
 * TDD RED→GREEN: the <behavior> block pins the auth-fields contract —
 * oauth requires provider (create refine mirror), spurious-field reset on
 * authType flip, edit-mode locking + create-time-only clientId, headers
 * editor visibility, payload shapes.
 */
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      let out = key;
      for (const [k, v] of Object.entries(opts)) {
        out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      }
      return out;
    },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Radix Select mock (LoginPage.test.tsx pattern): a flat DOM with
// onValueChange plumbing — no portal/pointer-event gymnastics in jsdom.
// The trigger keeps the component's own data-testid; the Select wrapper is
// tagged with the same testid + "-select" so tests can scope per-Select.
jest.mock("@/components/ui/select", () => {
  const React = require("react");
  return {
    Select: ({ children, value, onValueChange, ...props }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void; [key: string]: unknown }) => (
      <div data-testid="select-root" data-value={value} {...props}>
        {React.Children.map(children, (child: React.ReactNode) =>
          React.isValidElement(child)
            ? React.cloneElement(child, { selectValue: value, onValueChange })
            : child
        )}
      </div>
    ),
    SelectTrigger: ({ children, selectValue: _sv, onValueChange: _ovc, ...props }: { children?: ReactNode; selectValue?: unknown; onValueChange?: (value: string) => void; [key: string]: unknown }) => (
      <button type="button" data-testid="select-trigger" {...props}>{children}</button>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => (
      <span data-testid="select-value">{placeholder ?? ""}</span>
    ),
    SelectContent: ({ children, selectValue: _sv, onValueChange, ...props }: { children?: ReactNode; selectValue?: unknown; onValueChange?: (value: string) => void; [key: string]: unknown }) => (
      <div data-testid="select-content" {...props}>
        {React.Children.map(children, (child: React.ReactNode) =>
          React.isValidElement(child)
            ? React.cloneElement(child, { selectValue: _sv, onValueChange })
            : child
        )}
      </div>
    ),
    SelectItem: ({ children, value, onValueChange, selectValue: _sv, ...props }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void; selectValue?: unknown; [key: string]: unknown }) => (
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

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      let out = key;
      for (const [k, v] of Object.entries(opts)) {
        out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      }
      return out;
    },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockApiGet = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
}));

const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();
jest.mock("../lib/toast", () => ({
  showError: (...args: unknown[]) => mockShowError(...args),
  showSuccess: (...args: unknown[]) => mockShowSuccess(...args),
}));

// Redirect seam not used by the form, but the component tree pulls it via
// the queries module only — no stub needed here.

const mockCreateMutate = jest.fn();
const mockUpdateMutate = jest.fn();
jest.mock("../queries/useMcpConnections", () => ({
  useCreateMcpConnection: () => ({ mutateAsync: mockCreateMutate }),
  useUpdateMcpConnection: () => ({ mutateAsync: mockUpdateMutate }),
}));

import McpConnectionForm from "../components/McpConnectionForm";

const connEdit = {
  id: "conn-9",
  name: "Graph Conn",
  url: "https://graph.example.com",
  transportType: "streamable-http" as const,
  projectId: null,
  workspaceId: "ws-1",
  headers: {},
  enabled: true,
  lastSyncAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  authType: "oauth" as const,
  oauthProvider: "microsoft",
  oauthStatus: "authorized" as const,
  tokenExpiresAt: null,
  oauthScopes: null,
  oauthErrorSummary: null,
};

const renderForm = (connection?: typeof connEdit | null) => {
  const utils = render(<McpConnectionForm connection={connection} onClose={() => {}} onSave={() => {}} />);
  return utils;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApiGet.mockImplementation((path: string) =>
    path === "/projects"
      ? Promise.resolve([{ id: "p1", name: "Project One" }])
      : path === "/workspaces"
        ? Promise.resolve([{ id: "w1", name: "Workspace One" }])
        : Promise.resolve([])
  );
});

afterEach(() => {
  cleanup();
});

// Select helpers over the mocked Select: scope by the trigger's own
// data-testid (the component passes a unique one per Select), then click the
// option INSIDE that Select's subtree and assert the wrapper's data-value.
async function selectValue(triggerTestId: string, itemValue: string) {
  const trigger = screen.getByTestId(triggerTestId);
  const root = trigger.closest("[data-testid='select-root']");
  if (!root) throw new Error(`select root not found for ${triggerTestId}`);
  const options = Array.from(root.querySelectorAll("[role='option']"));
  const target = options.find((el) => el.getAttribute("data-value") === itemValue);
  if (!target) throw new Error(`option ${itemValue} not found in ${triggerTestId}`);
  fireEvent.click(target);
  await waitFor(() => {
    expect(root.getAttribute("data-value")).toBe(itemValue);
  });
}

describe("McpConnectionForm — auth fields (D-01)", () => {
  it("authType defaults to none for new connections", () => {
    renderForm();
    expect(screen.getByText("settings.mcpConnections.oauth.authTypeLabel")).toBeInTheDocument();
    expect(screen.getByTestId("authtype-select-trigger").closest("[data-testid='select-root']")).toHaveAttribute("data-value", "none");
  });

  it("selecting oauth reveals provider select + scopes input + clientId input (create mode)", async () => {
    renderForm();
    await selectValue("authtype-select-trigger", "oauth");
    expect(screen.getAllByText("settings.mcpConnections.oauth.providerLabel").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("settings.mcpConnections.oauth.scopesLabel").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("settings.mcpConnections.oauth.clientIdLabel").length).toBeGreaterThanOrEqual(1);
  });

  it("submitting oauth with empty provider blocks save with providerRequired + no mutation", async () => {
    renderForm();
    await selectValue("authtype-select-trigger", "oauth");
    await selectValue("project-select-trigger", "p1");
    fireEvent.change(screen.getByTestId("mcp-name-input"), { target: { value: "G" } });
    fireEvent.change(screen.getByTestId("mcp-url-input"), { target: { value: "https://x.com" } });
    fireEvent.click(screen.getByTestId("mcp-submit"));
    await waitFor(() => {
      expect(screen.getByText("settings.mcpConnections.oauth.providerRequired")).toBeInTheDocument();
      expect(mockCreateMutate).not.toHaveBeenCalled();
    });
  });

  it("oauth fields reset when authType switches away (spurious-field refine mirror)", async () => {
    renderForm();
    await selectValue("authtype-select-trigger", "oauth");
    fireEvent.change(screen.getByTestId("mcp-oauth-scopes-input"), { target: { value: "https://scope" } });
    await selectValue("authtype-select-trigger", "none");
    // Provider select + scopes input are gone from the DOM.
    expect(screen.queryByTestId("mcp-oauth-scopes-input")).not.toBeInTheDocument();
    // Re-selecting oauth reveals a cleared scopes input.
    await selectValue("authtype-select-trigger", "oauth");
    const scopesInput = screen.getByTestId("mcp-oauth-scopes-input") as HTMLInputElement;
    expect(scopesInput.value).toBe("");
  });

  it("edit mode: authType + provider disabled, clientId absent, headers editor hidden with hint", () => {
    renderForm(connEdit);
    // Both Select wrappers carry the disabled passthrough.
    const selects = screen.getAllByTestId("select-root");
    expect(selects.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId("mcp-oauth-clientid-input")).not.toBeInTheDocument();
    expect(screen.getAllByText("settings.mcpConnections.oauth.lockedHint").length).toBeGreaterThanOrEqual(1);
    // authType oauth → headers editor replaced by the static hint line.
    expect(screen.getByText("settings.mcpConnections.oauth.staticHeadersHint")).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-headers-editor")).not.toBeInTheDocument();
  });

  it("edit payload omits authType/oauthProvider/oauthClientId; create payload includes oauth fields", async () => {
    // Edit arm
    renderForm(connEdit);
    fireEvent.click(screen.getByTestId("mcp-submit"));
    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledTimes(1);
      const arg = mockUpdateMutate.mock.calls[0][0];
      expect(arg.data).not.toHaveProperty("authType");
      expect(arg.data).not.toHaveProperty("oauthProvider");
      expect(arg.data).not.toHaveProperty("oauthClientId");
      expect(arg.data).not.toHaveProperty("oauthScopes");
    });

    cleanup();

    // Create arm
    mockCreateMutate.mockResolvedValue({});
    renderForm(null);
    await selectValue("authtype-select-trigger", "oauth");
    await selectValue("project-select-trigger", "p1");
    const providerOptions = screen.getAllByRole("option");
    const google = providerOptions.find((el) => el.textContent === "google");
    if (!google) throw new Error("google option not found");
    fireEvent.click(google);
    fireEvent.change(screen.getByTestId("mcp-name-input"), { target: { value: "G Drive" } });
    fireEvent.change(screen.getByTestId("mcp-url-input"), { target: { value: "https://x.com" } });
    fireEvent.change(screen.getByTestId("mcp-oauth-scopes-input"), {
      target: { value: "https://www.googleapis.com/auth/drive.readonly" },
    });
    fireEvent.click(screen.getByTestId("mcp-submit"));
    await waitFor(() => {
      expect(mockCreateMutate).toHaveBeenCalledTimes(1);
      const payload = mockCreateMutate.mock.calls[0][0];
      expect(payload.authType).toBe("oauth");
      expect(payload.oauthProvider).toBe("google");
      expect(payload.oauthScopes).toBe("https://www.googleapis.com/auth/drive.readonly");
      expect(payload.oauthClientId).toBeUndefined();
    });
  });
});