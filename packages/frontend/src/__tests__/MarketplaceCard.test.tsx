// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MarketplaceCard component tests — quick 260918-qts (D-1):
 * per-card delete affordance (non-installed dedicated dropdown + installed
 * second menu item), shared AlertDialog wiring, cancel safety.
 *
 * UI primitives are mocked deterministically (Radix dropdowns/alert-dialogs
 * are pointer-driven in jsdom); i18n is mocked with key passthrough +
 * interpolation (McpHelpPopover.test.tsx precedent).
 */
import "@testing-library/jest-dom";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import MarketplaceCard from "../components/MarketplaceCard";
import type { CatalogEntry } from "../queries/useMarketplace";

// jsdom shims (ModelPalette.test.tsx precedent)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {};
};
global.Element.prototype.scrollIntoView = jest.fn();

// i18n: interpolate {{name}} into the delete dialog keys so the title
// assertion can prove prop wiring.
const t = jest.fn((key: string, opts?: Record<string, unknown>) => {
  if (key === "marketplace.delete.title" && opts && typeof opts.name === "string") {
    return `Delete ${opts.name}?`;
  }
  return key;
});
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Controlled DropdownMenu: trigger always rendered, click opens the content
// (mirrors Radix wiring); content rendered only when open.
jest.mock("@/components/ui/dropdown-menu", () => {
  const React = require("react");
  const Ctx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {},
  });
  const DropdownMenu = ({ children }: { children: React.ReactNode }) => {
    const [open, setOpen] = React.useState(false);
    return (
      <Ctx.Provider value={{ open, setOpen }}>
        <div data-testid="dropdown" data-open={open ? "true" : "false"}>{children}</div>
      </Ctx.Provider>
    );
  };
  const DropdownMenuTrigger = ({ children }: { children: React.ReactElement }) => {
    const { setOpen } = React.useContext(Ctx);
    // Chain the child's real onClick (the card's stopPropagation) instead of
    // replacing it — mirroring Radix, which fires the user handler AND its
    // own open logic on the same event.
    return React.cloneElement(children, {
      onClick: (e?: { stopPropagation?: () => void }) => {
        (children.props as { onClick?: (ev?: unknown) => void }).onClick?.(e);
        setOpen(true);
      },
    });
  };
  const DropdownMenuContent = ({ children, onClick }: { children: React.ReactNode; onClick?: (e: { stopPropagation: () => void }) => void }) => {
    const { open } = React.useContext(Ctx);
    // onClick forwarded so the portal-bubbling regression (260919) is
    // testable: without stopPropagation inside the card, the item click
    // bubbles to the Card root and navigates.
    return open ? (
      <div data-testid="dropdown-content" onClick={onClick}>{children}</div>
    ) : null;
  };
  const DropdownMenuItem = ({
    children,
    onSelect,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: (e: { preventDefault: () => void }) => void;
    className?: string;
  }) => (
    <div
      data-testid="dropdown-item"
      className={className}
      onClick={() => onSelect?.({ preventDefault: () => {} })}
    >
      {children}
    </div>
  );
  return { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem };
});

// Controlled AlertDialog: rendered only when open; Cancel/Action click their
// on-click handlers so the dialog wiring is testable without Radix internals.
jest.mock("@/components/ui/alert-dialog", () => {
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
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button data-testid="alert-dialog-cancel" onClick={onClick}>
      {children}
    </button>
  );
  const AlertDialogAction = ({
    children,
    onClick,
    className,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: (e: { stopPropagation: () => void }) => void;
    className?: string;
    "data-testid"?: string;
  }) => (
    <button className={className} onClick={(e) => onClick?.(e)} {...rest}>
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

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

function renderCard(overrides: Partial<CatalogEntry> = {}, onDelete = jest.fn()) {
  const props = {
    entry: { ...baseEntry, ...overrides },
    currentWorkspaceId: "ws-1",
    onInstall: jest.fn(),
    onUninstall: jest.fn(),
    onNavigate: jest.fn(),
    onDelete,
  };
  renderWithProviders(<MarketplaceCard {...props} />);
  return { props };
}

describe("MarketplaceCard — delete affordance (quick 260918-qts)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("non-installed card renders the delete trigger and confirm calls onDelete with entry.id", async () => {
    const { props } = renderCard({ isInstalled: false });

    // Dedicated three-dots trigger with Delete aria-label on non-installed cards
    const trigger = screen.getByRole("button", { name: `Delete ${baseEntry.name}` });
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByTestId("dropdown-content")).toBeInTheDocument();

    // Open the dialog from the menu item and confirm
    fireEvent.click(screen.getByText("marketplace.delete.confirm"));
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    expect(screen.getByText("Delete Example MCP Server?")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("marketplace-delete-confirm"));
    await waitFor(() => {
      expect(props.onDelete).toHaveBeenCalledWith("entry-1");
    });
  });

  it("installed card's dropdown carries ONLY the Delete item (Uninstall moved to a visible button); Delete opens the dialog", async () => {
    const { props } = renderCard({ isInstalled: true });

    // quick 260919-l6s: the installed card's three-dots trigger is now
    // Delete-labeled (mirroring the non-installed arm) and the dropdown
    // carries only the Delete item — the visible Uninstall button replaced
    // the Uninstall menu item.
    const trigger = screen.getByRole("button", { name: `Delete ${baseEntry.name}` });
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);
    const items = screen.getAllByTestId("dropdown-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("marketplace.delete.confirm");

    fireEvent.click(items[0]);
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("marketplace-delete-confirm"));
    await waitFor(() => {
      expect(props.onDelete).toHaveBeenCalledWith("entry-1");
    });
  });

  it("dialog cancel closes without calling onDelete", async () => {
    const { props } = renderCard({ isInstalled: false });

    fireEvent.click(screen.getByRole("button", { name: `Delete ${baseEntry.name}` }));
    fireEvent.click(screen.getByText("marketplace.delete.confirm"));
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("alert-dialog-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument();
    });
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  // 260919 propagation regression: Radix portals dropdown/dialog content to
  // document.body but React events bubble through the React tree — up to the
  // Card root's onNavigate onClick. The content wrappers must stop
  // propagation or the Delete item click navigated to the detail page and
  // unmounted the dialog mid-interaction (delete never ran).
  it("delete item click does NOT bubble to the Card root onNavigate (installed arm)", async () => {
    const { props } = renderCard({ isInstalled: true });

    fireEvent.click(screen.getByRole("button", { name: `Delete ${baseEntry.name}` }));
    fireEvent.click(screen.getByTestId("dropdown-content"));
    fireEvent.click(screen.getByTestId("dropdown-item"));

    // Dialog opens INSTEAD of the card navigating away.
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("delete item click does NOT bubble to the Card root onNavigate (non-installed arm)", async () => {
    const { props } = renderCard({ isInstalled: false });

    fireEvent.click(screen.getByRole("button", { name: `Delete ${baseEntry.name}` }));
    fireEvent.click(screen.getByTestId("dropdown-content"));
    fireEvent.click(screen.getByTestId("dropdown-item"));

    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("confirm-delete click inside the dialog does NOT bubble to onNavigate", async () => {
    const { props } = renderCard({ isInstalled: false });

    fireEvent.click(screen.getByRole("button", { name: `Delete ${baseEntry.name}` }));
    fireEvent.click(screen.getByTestId("dropdown-content"));
    fireEvent.click(screen.getByTestId("dropdown-item"));
    fireEvent.click(screen.getByTestId("marketplace-delete-confirm"));

    await waitFor(() => {
      expect(props.onDelete).toHaveBeenCalledWith("entry-1");
    });
    expect(props.onNavigate).not.toHaveBeenCalled();
  });
});

// quick 260919-l6s: Uninstall becomes a visible, clearly-labeled destructive
// button on installed cards (previously hidden behind a three-dots menu) —
// opening the EXISTING confirmation dialog; confirming calls onUninstall.
describe("MarketplaceCard — visible Uninstall button on installed cards (quick 260919-l6s)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("installed card renders a visible Uninstall button (and NOT the install label)", () => {
    renderCard({ isInstalled: true });

    const uninstallBtn = screen.getByRole("button", { name: "marketplace.install.uninstall" });
    expect(uninstallBtn).toBeInTheDocument();
    // The install label must not render on installed cards.
    expect(screen.queryByText("marketplace.install.button")).not.toBeInTheDocument();
  });

  it("non-installed card does NOT render the Uninstall button", () => {
    renderCard({ isInstalled: false });

    expect(screen.queryByRole("button", { name: "marketplace.install.uninstall" })).not.toBeInTheDocument();
    expect(screen.getByText("marketplace.install.button")).toBeInTheDocument();
  });

  it("clicking the visible Uninstall button opens the uninstall AlertDialog (never calls onUninstall directly)", async () => {
    const { props } = renderCard({ isInstalled: true });

    fireEvent.click(screen.getByRole("button", { name: "marketplace.install.uninstall" }));

    // Confirmation dialog opens — destructive action stays guarded (T-L6S-01).
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    // The uninstall dialog's title carries the common.uninstall key + entry name.
    expect(screen.getByRole("heading", { name: /common\.uninstall/ })).toBeInTheDocument();
    expect(props.onUninstall).not.toHaveBeenCalled();
  });

  it("uninstall dialog confirm calls onUninstall with entry.id and closes", async () => {
    const { props } = renderCard({ isInstalled: true });

    fireEvent.click(screen.getByRole("button", { name: "marketplace.install.uninstall" }));
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();

    // The destructive action inside the uninstall dialog (not the delete
    // dialog's marketplace-delete-confirm testid).
    fireEvent.click(screen.getByRole("button", { name: "common.uninstall" }));

    await waitFor(() => {
      expect(props.onUninstall).toHaveBeenCalledWith("entry-1");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument();
    });
  });

  it("uninstall dialog cancel closes without calling onUninstall", async () => {
    const { props } = renderCard({ isInstalled: true });

    fireEvent.click(screen.getByRole("button", { name: "marketplace.install.uninstall" }));
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("alert-dialog-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument();
    });
    expect(props.onUninstall).not.toHaveBeenCalled();
  });

  it("visible Uninstall button click does NOT bubble to the Card root onNavigate", () => {
    const { props } = renderCard({ isInstalled: true });

    fireEvent.click(screen.getByRole("button", { name: "marketplace.install.uninstall" }));

    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    expect(props.onNavigate).not.toHaveBeenCalled();
  });
});

describe("MarketplaceCard — existing structure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders card with name and description", () => {
    renderCard();
    expect(screen.getByText("Example MCP Server")).toBeInTheDocument();
    expect(screen.getByText("An example MCP server")).toBeInTheDocument();
  });

  it("shows Install button when not installed", () => {
    renderCard({ isInstalled: false });
    expect(screen.getByText("marketplace.install.button")).toBeInTheDocument();
  });
});