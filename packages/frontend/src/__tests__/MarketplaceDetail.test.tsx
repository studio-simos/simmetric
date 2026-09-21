// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MarketplaceDetail component tests — quick 260919-l6s:
 * the installed arm renders a VISIBLE destructive Uninstall button (replacing
 * the hidden three-dots ghost icon) that opens the existing confirmation
 * dialog; the uninstall confirm calls useUninstallMarketplaceEntry with the
 * right entryId + workspaceId. Button-state per install status + uninstall
 * confirm wiring.
 *
 * Mock scaffolding follows MarketplaceCard.test.tsx's precedents:
 * key-passthrough i18n with {{name}} interpolation, functional ui-primitive
 * mocks (Radix dialog/alert-dialog are pointer-driven in jsdom).
 */
import "@testing-library/jest-dom";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import MarketplaceDetail from "../components/MarketplaceDetail";
import type { CatalogEntry } from "../queries/useMarketplace";

// jsdom shims (ModelPalette.test.tsx precedent)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {};
};
global.Element.prototype.scrollIntoView = jest.fn();

// i18n: key passthrough + {{name}} interpolation for the
// marketplace.toast / marketplace.delete keys.
const t = jest.fn((key: string, opts?: Record<string, unknown>) => {
  if (opts && typeof opts.name === "string") {
    return `${key}:${opts.name}`;
  }
  if (opts && typeof opts.author === "string") {
    return `${key}:${opts.author}`;
  }
  return key;
});
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// react-router-dom: useParams drives the entry fetch; Link → anchor passthrough.
jest.mock("react-router-dom", () => ({
  useParams: () => ({ entryId: "entry-1" }),
  useNavigate: () => jest.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => ({ currentWorkspaceId: "ws-1" }),
}));

// Mutations: uninstallMutateAsync is a jest.fn the tests assert on.
const uninstallMutateAsync = jest.fn();
jest.mock("../queries/useMarketplace", () => ({
  useMarketplaceCatalog: () => ({ data: [] }),
  useInstallMarketplaceEntry: () => ({ mutateAsync: jest.fn() }),
  useUninstallMarketplaceEntry: () => ({ mutateAsync: uninstallMutateAsync }),
}));

const testMutateAsync = jest.fn().mockResolvedValue({ success: false });
jest.mock("../queries/useMcpConnections", () => ({
  useMcpConnections: () => ({ data: [] }),
  useTestMcpConnection: () => ({ mutateAsync: testMutateAsync }),
}));

jest.mock("../utils/api", () => ({
  apiGet: jest.fn(),
}));

jest.mock("../utils/errorUtils", () => ({
  getErrorMessage: jest.fn((err: unknown, fallback = "An unexpected error occurred") => {
    const message = (err as { message?: string })?.message;
    return message ?? fallback;
  }),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
}));

jest.mock("../components/MarketplaceInstallDialog", () => {
  return function MarketplaceInstallDialog() {
    return null;
  };
});

// Functional ui-primitive mocks (card-test precedent):
// button forwards onClick/disabled; alert-dialog renders only when open with
// clickable Cancel/Action; breadcrumb/card/skeleton as plain divs.
jest.mock("@/components/ui/button", () => {
  const React = require("react");
  const Button = ({
    children,
    onClick,
    disabled,
    variant,
    size,
    className,
    title,
  }: {
    children?: React.ReactNode;
    onClick?: (e?: React.MouseEvent) => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    title?: string;
  }) => (
    <button
      data-variant={variant}
      data-size={size}
      className={className}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
  return { Button };
});

jest.mock("@/components/ui/alert-dialog", () => {
  const React = require("react");
  const AlertDialog = ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null;
  const AlertDialogContent = ({ children, onClick }: { children: React.ReactNode; onClick?: (e: { stopPropagation: () => void }) => void }) => (
    <div data-testid="alert-dialog-content" onClick={onClick}>{children}</div>
  );
  const AlertDialogHeader = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const AlertDialogTitle = ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>;
  const AlertDialogDescription = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;
  const AlertDialogFooter = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const AlertDialogCancel = ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button data-testid="alert-dialog-cancel" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
  const AlertDialogAction = ({
    children,
    onClick,
    className,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: (e?: React.MouseEvent) => void;
    className?: string;
    disabled?: boolean;
  }) => (
    <button data-testid="alert-dialog-action" className={className} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
  return {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogCancel,
    AlertDialogAction,
  };
});

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

jest.mock("@/components/ui/breadcrumb", () => ({
  Breadcrumb: ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>,
  BreadcrumbList: ({ children }: { children: React.ReactNode }) => <ol>{children}</ol>,
  BreadcrumbItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  BreadcrumbLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  BreadcrumbSeparator: () => <span>/</span>,
  BreadcrumbPage: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

jest.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

const baseEntry: CatalogEntry = {
  id: "entry-1",
  name: "Example MCP Server",
  url: "http://localhost:3001/mcp/sse",
  transportType: "sse",
  headers: "{}",
  description: "An example MCP server",
  category: "utilities",
  version: "1.0.0",
  author: "Test Author",
  verified: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  isInstalled: false,
};

async function renderDetail(isInstalled: boolean) {
  const { apiGet } = await import("../utils/api");
  (apiGet as jest.Mock).mockResolvedValue({ ...baseEntry, isInstalled });
  renderWithProviders(<MarketplaceDetail />);
  // apiGet is async — wait for the entry to render (act-safe). The name
  // appears in BOTH the breadcrumb page label and the h1 — pin the h1.
  await waitFor(() => {
    expect(screen.getByRole("heading", { level: 1, name: "Example MCP Server" })).toBeInTheDocument();
  });
}

describe("MarketplaceDetail — button state + uninstall wiring (quick 260919-l6s)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    uninstallMutateAsync.mockResolvedValue(undefined);
    testMutateAsync.mockResolvedValue({ success: false });
  });

  it("renders the detail page with a visible Uninstall button when installed", async () => {
    await renderDetail(true);

    // Entry metadata renders (h1 — the breadcrumb page label also carries the name).
    expect(screen.getByRole("heading", { level: 1, name: "Example MCP Server" })).toBeInTheDocument();
    // The installed indicator + visible Uninstall button.
    expect(screen.getByText("marketplace.card.installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "marketplace.install.uninstall" })).toBeInTheDocument();
    // The install label must NOT render on the installed arm.
    expect(screen.queryByText("marketplace.detail.install")).not.toBeInTheDocument();
  });

  it("shows the Install button (and no Uninstall button) when not installed", async () => {
    await renderDetail(false);

    expect(screen.getByText("marketplace.detail.install")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "marketplace.install.uninstall" })).not.toBeInTheDocument();
  });

  it("clicking the visible Uninstall button opens the confirmation dialog", async () => {
    await renderDetail(true);

    fireEvent.click(screen.getByRole("button", { name: "marketplace.install.uninstall" }));

    // Dialog opens with the uninstall title + entry name; the mutation is NOT
    // called until confirm (single click never uninstalls — T-L6S-01).
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /common\.uninstall Example MCP Server\?/ })).toBeInTheDocument();
    expect(uninstallMutateAsync).not.toHaveBeenCalled();
  });

  it("confirming the dialog calls the uninstall mutation with the right entry + workspace", async () => {
    await renderDetail(true);

    fireEvent.click(screen.getByRole("button", { name: "marketplace.install.uninstall" }));
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("alert-dialog-action"));

    await waitFor(() => {
      expect(uninstallMutateAsync).toHaveBeenCalledWith({ entryId: "entry-1", workspaceId: "ws-1" });
    });
  });

  it("cancel closes the dialog without calling the uninstall mutation", async () => {
    await renderDetail(true);

    fireEvent.click(screen.getByRole("button", { name: "marketplace.install.uninstall" }));
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("alert-dialog-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument();
    });
    expect(uninstallMutateAsync).not.toHaveBeenCalled();
  });
});

describe("MarketplaceDetail — deferred", () => {
  // kept as a stub: jsdom health-badge rendering coverage is deferred.
  it.todo("should show health status badge");
});