// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * CatalogEntryFormDialog tests — Phase 197 plan 03 Task 2 (MCPO-03 D-06).
 *
 * Pins the create-only contract (UI-SPEC §5): open/render, authType flip
 * reveal/hide+clear (D-01 spurious-field pattern), oauth-without-provider
 * block, submit payload shape (no oauthProvider when authType none), the
 * shared createMcpCatalogEntrySchema resolver, cancel-no-mutation, and the
 * MarketplacePage Add server button wiring.
 *
 * Select mocks follow the McpConnectionForm.test.tsx Radix-flat-DOM pattern.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

// Radix Select mock (McpConnectionForm.test.tsx pattern): flat DOM with
// onValueChange plumbing — no portal/pointer-event gymnastics in jsdom.
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

const t = (key: string, opts?: Record<string, unknown>) => {
  if (!opts) return key;
  let out = key;
  for (const [k, v] of Object.entries(opts)) {
    out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
  }
  return out;
};
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Dialog mock: rendered only when open (Radix wiring simplified for jsdom).
jest.mock("@/components/ui/dialog", () => {
  const Dialog = ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null;
  const DialogContent = ({ children }: { children: ReactNode }) => <div data-testid="dialog-content">{children}</div>;
  const DialogHeader = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const DialogTitle = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  const DialogDescription = ({ children }: { children: ReactNode }) => <p>{children}</p>;
  const DialogFooter = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter };
});

const mockMutateAsync = jest.fn();
jest.mock("../queries/useMarketplace", () => ({
  useCreateCatalogEntry: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
  // MarketplacePage imports the real hooks — the page suite mocks its own.
  // Only re-export names the dialog (and page) actually consume at runtime.
  useMarketplaceCatalog: () => ({ data: [], isLoading: false, error: null }),
  useInstallMarketplaceEntry: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUninstallMarketplaceEntry: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteMarketplaceEntry: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
jest.mock("../lib/toast", () => ({
  showSuccess: (...args: unknown[]) => mockShowSuccess(...args),
  showError: (...args: unknown[]) => mockShowError(...args),
}));

import CatalogEntryFormDialog from "../components/CatalogEntryFormDialog";

const renderDialog = (open = true) => {
  const onOpenChange = jest.fn();
  render(<CatalogEntryFormDialog open={open} onOpenChange={onOpenChange} />);
  return { onOpenChange };
};

// Select helpers over the mocked Select (McpConnectionForm.test.tsx idiom):
// scope by the trigger's data-testid, click the option in that subtree.
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

function fillRequiredFields() {
  fireEvent.change(screen.getByTestId("catalog-name-input"), { target: { value: "My OAuth Server" } });
  fireEvent.change(screen.getByTestId("catalog-url-input"), { target: { value: "https://example.com/mcp/sse" } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMutateAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("CatalogEntryFormDialog — open/render (create-only)", () => {
  it("renders all fields with authType defaulting to none", () => {
    renderDialog();
    expect(screen.getByTestId("dialog")).toBeInTheDocument();
    expect(screen.getByText("marketplace.form.addTitle")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-name-input")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-url-input")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-transport-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-description-input")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-category-input")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-version-input")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-author-input")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-tier-trigger")).toBeInTheDocument();
    expect(screen.getByText("marketplace.form.authTypeLabel")).toBeInTheDocument();
    // Provider select hidden while authType=none
    expect(screen.queryByTestId("catalog-provider-trigger")).not.toBeInTheDocument();
  });

  it("closed dialog renders nothing", () => {
    renderDialog(false);
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
  });
});

// Phase 197 gap closure (G-197-2): the tier Select's key composition must
// transform the snake_case tier value into the camelCase translation-key
// suffix (verified_community → VerifiedCommunity). The key-passthrough i18n
// mock makes DOM-text assertions prove the exact t() key shape — the raw
// snake_case key must NEVER render.
describe("CatalogEntryFormDialog — verification tier key shape (G-197-2)", () => {
  it("renders camelCase tier keys and never the raw snake_case key", () => {
    renderDialog();
    expect(screen.getByText("marketplace.form.verificationTierVerifiedCommunity")).toBeInTheDocument();
    expect(screen.getByText("marketplace.form.verificationTierOfficial")).toBeInTheDocument();
    expect(screen.queryByText("marketplace.form.verificationTierVerified_community")).not.toBeInTheDocument();
  });
});

describe("CatalogEntryFormDialog — authType flip (D-01 spurious-field pattern)", () => {
  it("selecting oauth reveals the provider select; options are Google/Microsoft", async () => {
    renderDialog();
    await selectValue("catalog-authtype-trigger", "oauth");
    expect(screen.getByTestId("catalog-provider-trigger")).toBeInTheDocument();
    const root = screen.getByTestId("catalog-provider-trigger").closest("[data-testid='select-root']");
    const options = Array.from(root!.querySelectorAll("[role='option']")).map(
      (el) => el.getAttribute("data-value")
    );
    expect(options).toEqual(["google", "microsoft"]);
  });

  it("switching back to none hides AND clears the provider (no stale provider submitted)", async () => {
    renderDialog();
    await selectValue("catalog-authtype-trigger", "oauth");
    await selectValue("catalog-provider-trigger", "google");
    await selectValue("catalog-authtype-trigger", "none");
    // Provider select gone from the DOM.
    expect(screen.queryByTestId("catalog-provider-trigger")).not.toBeInTheDocument();

    // Submit with authType none — payload carries NO oauthProvider/authType.
    fillRequiredFields();
    fireEvent.click(screen.getByTestId("catalog-submit"));
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      const payload = mockMutateAsync.mock.calls[0][0];
      expect(payload).not.toHaveProperty("oauthProvider");
      expect(payload).not.toHaveProperty("authType");
 expect(payload.name).toBe("My OAuth Server");
      expect(payload.url).toBe("https://example.com/mcp/sse");
    });
  });
});

describe("CatalogEntryFormDialog — validation", () => {
  it("oauth without provider blocks client-side via the SHARED schema refine (root error)", async () => {
    renderDialog();
    await selectValue("catalog-authtype-trigger", "oauth");
    fillRequiredFields();
    fireEvent.click(screen.getByTestId("catalog-submit"));
    await waitFor(() => {
      expect(mockMutateAsync).not.toHaveBeenCalled();
      // The refine rides the imported createMcpCatalogEntrySchema (no client
      // re-declaration) — its message surfaces via the root-error line.
      expect(screen.getByRole("alert")).toHaveTextContent(
        "oauthProvider is required when authType is oauth"
      );
    });
  });

  it("invalid URL blocks via the shared schema resolver (zodResolver)", async () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("catalog-name-input"), { target: { value: "X" } });
    fireEvent.change(screen.getByTestId("catalog-url-input"), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByTestId("catalog-submit"));
    await waitFor(() => {
      expect(mockMutateAsync).not.toHaveBeenCalled();
      expect(screen.getByText("Invalid MCP connection URL")).toBeInTheDocument();
    });
  });

  it("empty name blocks via the shared schema (min(1) renders through FormMessage)", async () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("catalog-url-input"), { target: { value: "https://x.com" } });
    fireEvent.click(screen.getByTestId("catalog-submit"));
    await waitFor(() => {
      expect(mockMutateAsync).not.toHaveBeenCalled();
      expect(
        screen.getByText("Too small: expected string to have >=1 characters")
      ).toBeInTheDocument();
    });
  });
});

describe("CatalogEntryFormDialog — submit payload (create-only)", () => {
  it("successful oauth submit calls the create mutation with the expected payload + closes", async () => {
    const { onOpenChange } = renderDialog();
    await selectValue("catalog-authtype-trigger", "oauth");
    await selectValue("catalog-provider-trigger", "microsoft");
    fillRequiredFields();
    fireEvent.change(screen.getByTestId("catalog-description-input"), { target: { value: "  A desc  " } });
    fireEvent.click(screen.getByTestId("catalog-submit"));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      const payload = mockMutateAsync.mock.calls[0][0];
      expect(payload.authType).toBe("oauth");
      expect(payload.oauthProvider).toBe("microsoft");
      expect(payload.name).toBe("My OAuth Server");
      expect(payload.url).toBe("https://example.com/mcp/sse");
      // Trimmed optional fields ride the payload; empty ones are omitted.
      expect(payload.description).toBe("A desc");
      expect(payload).not.toHaveProperty("category");
    });
    await waitFor(() => {
      expect(mockShowSuccess).toHaveBeenCalledWith(t("marketplace.toast.created", { name: "My OAuth Server" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("none-authType submit payload contains NO oauthProvider/authType", async () => {
    renderDialog();
    fillRequiredFields();
    fireEvent.click(screen.getByTestId("catalog-submit"));
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      const payload = mockMutateAsync.mock.calls[0][0];
      expect(payload).not.toHaveProperty("oauthProvider");
      expect(payload).not.toHaveProperty("authType");
 expect(payload.transportType).toBe("sse");
    });
  });
});

describe("CatalogEntryFormDialog — cancel", () => {
  it("cancel closes without mutating", async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByTestId("catalog-cancel"));
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});