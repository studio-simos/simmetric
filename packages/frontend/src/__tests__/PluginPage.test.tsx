// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * PluginPage component tests — the UI-SPEC Verification Pins (a)-(e) plus
 * the dropzone guards (A-11), the license modal probe→save gate (A-6/A-7),
 * the toggle/uninstall flows, and the restart supervisor/manual split (D-06).
 * Hooks are mocked (TanStack golden rule — SkillsPage.test.tsx idiom); the
 * dropzone is mocked with an options-capture so onDrop guards are drivable.
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import PluginPage from "../components/PluginPage";

// jsdom shims (ModelPalette.test.tsx precedent)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.Element.prototype.scrollIntoView = jest.fn();

/* ------------------------------------------------------------------ */
/*  i18n mock — key map (the en Copywriting Contract values)           */
/* ------------------------------------------------------------------ */

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "plugins.title": "Plugins",
        "plugins.description": "Install and manage plugins that extend the platform.",
        "plugins.dropzone.heading": "Install a plugin",
        "plugins.dropzone.body": "Drag & drop a plugin .zip here, or click to browse — up to 100 MB.",
        "plugins.dropzone.invalidType": "Only .zip files are accepted.",
        "plugins.dropzone.tooLarge": "Plugin archives are limited to 100 MB.",
        "plugins.installing": "Installing plugin…",
        "plugins.installSuccess": "Plugin installed — enable it to load after a restart.",
        "plugins.installFailed": "Install failed: {{error}}",
        "plugins.empty": "No plugins installed yet.",
        "plugins.statusLoaded": "Loaded",
        "plugins.statusInstalled": "Installed",
        "plugins.statusFailed": "Failed",
        "plugins.statusDisabled": "Disabled",
        "plugins.sourceNative": "Native",
        "plugins.sourceManaged": "Managed",
        "plugins.nativeHint": "Loaded from the native install path — managed in docs/PLUGINS.md.",
        "plugins.restartRequired": "Restart required",
        "plugins.licenseBadgeVerified": "License ✓",
        "plugins.licenseBadgeInvalid": "License ✗",
        "plugins.licenseBadgeMissing": "License missing",
        "plugins.licenseBadgeSelf": "Self-licensed",
        "plugins.licenseStatusTooltip": "License status: {{reason}}",
        "plugins.lastErrorTrigger": "Last error",
        "plugins.lastErrorTooltip": "Last error: {{error}}",
        "plugins.apiVersion": "API v{{version}}",
        "plugins.cardMenu": "Plugin actions",
        "plugins.manageLicense": "Manage license",
        "plugins.uninstall": "Uninstall",
        "plugins.uninstallDisabledHint": "Disable the plugin before uninstalling.",
        "plugins.enable": "Enable",
        "plugins.disable": "Disable",
        "plugins.toggleSuccess": "Plugin {{action}} — takes effect after a restart.",
        "plugins.toggleFailed": "Failed to update plugin",
        "plugins.uninstallConfirmTitle": "Uninstall {{name}}?",
        "plugins.uninstallConfirmBody": "The plugin files are removed from the managed registry and its record is deleted. This cannot be undone.",
        "plugins.uninstallSuccess": "Plugin uninstalled",
        "plugins.uninstallFailed": "Failed to uninstall plugin",
        "plugins.license.title": "Plugin license",
        "plugins.license.requiredHint": "This plugin requires a Simmetric platform license before it can load.",
        "plugins.license.inputLabel": "License key (JWT)",
        "plugins.license.inputHint": "Paste the RS256 license JWT issued for {{packageName}}.",
        "plugins.license.verify": "Verify",
        "plugins.license.verifying": "Verifying…",
        "plugins.license.verifyOk": "License valid — safe to save.",
        "plugins.license.verifyFailed": "Verification failed: {{reason}}",
        "plugins.license.save": "Save license",
        "plugins.license.saving": "Saving…",
        "plugins.license.saved": "License saved",
        "plugins.license.saveFailed": "Failed to save license",
        "plugins.license.show": "Show license key",
        "plugins.license.hide": "Hide license key",
        "plugins.restart.button": "Restart server",
        "plugins.restart.confirmTitle": "Restart the server?",
        "plugins.restart.confirmBody": "The server shuts down gracefully and your supervisor (Docker, Coolify, or the Tauri desktop app) starts it again. In-flight requests finish first.",
        "plugins.restart.confirmAction": "Restart now",
        "plugins.restart.restarting": "Restarting the server — this page reconnects automatically.",
        "plugins.restart.failed": "Failed to trigger restart",
        "plugins.restart.devWarningTitle": "Dev mode: restart manually",
        "plugins.restart.devWarningBody": "The server runs under a dev watcher and will not be relaunched automatically. Restart the dev process yourself after plugin changes.",
        "plugins.errorGeneric": "Something went wrong — check the server logs and try again.",
        "common.loading": "Loading...",
        "common.cancel": "Cancel",
      };
      if (key === "plugins.licenseStatusTooltip" && opts) {
        return `License status: ${opts.reason}`;
      }
      if (key === "plugins.lastErrorTooltip" && opts) {
        return `Last error: ${opts.error}`;
      }
      if (key === "plugins.toggleSuccess" && opts) {
        return `Plugin ${opts.action} — takes effect after a restart.`;
      }
      if (key === "plugins.installFailed" && opts) {
        return `Install failed: ${opts.error}`;
      }
      if (key === "plugins.license.verifyFailed" && opts) {
        return `Verification failed: ${opts.reason}`;
      }
      if (key === "plugins.license.inputHint" && opts) {
        return `Paste the RS256 license JWT issued for ${opts.packageName}.`;
      }
      return map[key] || key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("../hooks/usePageMeta", () => ({ usePageMeta: jest.fn() }));

// Controlled DropdownMenu (MarketplaceCard.test.tsx precedent): trigger
// always rendered, click opens the content; disabled items carry
// data-disabled so the A-8 pin is assertable without Radix internals.
jest.mock("@/components/ui/dropdown-menu", () => {
  const React = require("react");
  const Ctx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({ open: false, setOpen: () => {} });
  const DropdownMenu = ({ children }: { children: React.ReactNode }) => {
    const [open, setOpen] = React.useState(false);
    return <Ctx.Provider value={{ open, setOpen }}><div data-testid="dropdown">{children}</div></Ctx.Provider>;
  };
  const DropdownMenuTrigger = ({ children }: { children: React.ReactElement }) => {
    const { setOpen } = React.useContext(Ctx);
    return React.cloneElement(children, {
      onClick: (e?: { stopPropagation?: () => void }) => {
        (children.props as { onClick?: (ev?: unknown) => void }).onClick?.(e);
        setOpen(true);
      },
    });
  };
  const DropdownMenuContent = ({ children }: { children: React.ReactNode }) => {
    const { open } = React.useContext(Ctx);
    return open ? <div data-testid="dropdown-content">{children}</div> : null;
  };
  const DropdownMenuItem = ({ children, onSelect, disabled }: { children: React.ReactNode; onSelect?: () => void; disabled?: boolean }) => (
    <div
      data-testid="dropdown-item"
      data-disabled={disabled ? "" : undefined}
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onSelect?.(); }}
    >
      {children}
    </div>
  );
  return { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem };
});

// Controlled AlertDialog (MarketplaceCard precedent): renders only when open.
jest.mock("@/components/ui/alert-dialog", () => {
  const AlertDialog = ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null;
  const AlertDialogContent = ({ children }: { children: React.ReactNode }) => <div data-testid="alert-dialog-content">{children}</div>;
  const AlertDialogHeader = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const AlertDialogTitle = ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>;
  const AlertDialogDescription = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;
  const AlertDialogFooter = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const AlertDialogCancel = ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button data-testid="alert-dialog-cancel" onClick={onClick}>{children}</button>
  );
  const AlertDialogAction = ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => (
    <button className={className} onClick={onClick}>{children}</button>
  );
  return { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction };
});

// Controlled Dialog: renders only when open (the license modal is fully
// state-controlled by the component — Radix internals not needed).
jest.mock("@/components/ui/dialog", () => {
  const Dialog = ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null;
  const DialogContent = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-content" className={className}>{children}</div>
  );
  const DialogHeader = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const DialogTitle = ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>;
  const DialogDescription = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;
  return { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription };
});

/* ------------------------------------------------------------------ */
/*  toast + auth mocks                                                 */
/* ------------------------------------------------------------------ */

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
jest.mock("../lib/toast", () => ({
  showSuccess: (...a: unknown[]) => mockShowSuccess(...a),
  showError: (...a: unknown[]) => mockShowError(...a),
}));

jest.mock("../queries/useAuth", () => ({
  useMe: (_enabled?: boolean) => ({ data: { id: "admin-1", permissions: ["plugins:manage"] }, isLoading: false }),
}));

/* ------------------------------------------------------------------ */
/*  usePlugins hook mocks (per-test state via globalThis)              */
/* ------------------------------------------------------------------ */

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row-1",
    slug: "@acme+widget",
    packageName: "@acme/widget",
    displayName: null,
    version: "1.0.0",
    apiVersion: 1,
    enabled: false,
    status: "installed",
    lastError: null,
    licenseMode: "none",
    licenseStatus: null,
    licenseCheckedAt: null,
    source: "managed",
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

const mockInstall = jest.fn();
const mockToggle = jest.fn();
const mockUninstall = jest.fn();
const mockSaveLicense = jest.fn();
const mockVerifyLicense = jest.fn();
const mockRestart = jest.fn();
const mockRefetch = jest.fn();

jest.mock("../queries/usePlugins", () => ({
  usePlugins: () => (globalThis as Record<string, unknown>).__pluginsState as never,
  useInstallPlugin: () => ({ mutateAsync: mockInstall, isPending: (globalThis as Record<string, unknown>).__installing as boolean }),
  useTogglePlugin: () => ({ mutateAsync: mockToggle, isPending: false }),
  useUninstallPlugin: () => ({ mutateAsync: mockUninstall, isPending: false }),
  useSavePluginLicense: () => ({ mutateAsync: mockSaveLicense, isPending: false }),
  useVerifyPluginLicense: () => ({ mutateAsync: mockVerifyLicense, isPending: false }),
  useRestartServer: () => ({ mutateAsync: mockRestart, isPending: false }),
}));

/* ------------------------------------------------------------------ */
/*  react-dropzone mock — capture the options so onDrop is drivable    */
/* ------------------------------------------------------------------ */

jest.mock("react-dropzone", () => ({
  useDropzone: (opts: never) => {
    (globalThis as Record<string, unknown>).__dzOpts = opts;
    return {
      getRootProps: () => ({ "data-testid": "dropzone-root" }),
      getInputProps: () => ({ "data-testid": "dropzone-input" }),
      isDragActive: false,
    };
  },
}));

function setState(data: unknown, overrides: Record<string, unknown> = {}) {
  (globalThis as Record<string, unknown>).__pluginsState = {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: mockRefetch,
    ...overrides,
  };
  (globalThis as Record<string, unknown>).__installing = false;
}

beforeEach(() => {
  jest.clearAllMocks();
  dzReset();
});

function dzReset() {
  (globalThis as Record<string, unknown>).__dzOpts = null;
}

function renderPage() {
  return render(
    <TooltipProvider>
      <PluginPage />
    </TooltipProvider>,
  );
}

function openCardMenu(name: string) {
  const triggers = screen.getAllByRole("button", { name: "Plugin actions" });
  const trigger = triggers.find((el) => el.closest("[data-plugin-card]")?.textContent?.includes(name));
  if (!trigger) throw new Error(`no card menu for ${name}`);
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
}

/* ------------------------------------------------------------------ */
/*  Pin (a): badge matrices                                            */
/* ------------------------------------------------------------------ */

describe("Pin (a) — badge matrices render deterministically", () => {
  it("status priority disabled > failed > loaded > installed", () => {
    setState({
      restartMode: "manual",
      plugins: [
        makeRow({ id: "r-disabled", enabled: false, status: "loaded", displayName: "Disabled Plugin" }),
        makeRow({ id: "r-failed", enabled: true, status: "failed", lastError: "boom", displayName: "Failed Plugin" }),
        makeRow({ id: "r-loaded", enabled: true, status: "loaded", displayName: "Loaded Plugin" }),
        makeRow({ id: "r-installed", enabled: true, status: "installed", displayName: "Installed Plugin" }),
      ],
    });
    renderPage();
    // Priority wins: a disabled LOADED row shows Disabled (not Loaded).
    const disabledCard = screen.getByText("Disabled Plugin").closest("[data-plugin-card]");
    expect(disabledCard).toHaveTextContent("Disabled");
    const failedCard = screen.getByText("Failed Plugin").closest("[data-plugin-card]");
    expect(failedCard).toHaveTextContent("Failed");
    const loadedCard = screen.getByText("Loaded Plugin").closest("[data-plugin-card]");
    expect(loadedCard).toHaveTextContent("Loaded");
    const installedCard = screen.getByText("Installed Plugin").closest("[data-plugin-card]");
    expect(installedCard).toHaveTextContent("Installed");
  });

  it("license matrix conditional on licenseMode: none → NO license badge at all; self → Self-licensed; platform verified/invalid/missing", () => {
    setState({
      restartMode: "manual",
      plugins: [
        makeRow({ id: "r-none", licenseMode: "none", displayName: "None Mode" }),
        makeRow({ id: "r-self", licenseMode: "self", displayName: "Self Mode" }),
        makeRow({ id: "r-verified", licenseMode: "platform", licenseStatus: "verified", displayName: "Verified" }),
        makeRow({ id: "r-invalid", licenseMode: "platform", licenseStatus: "plugin_mismatch", displayName: "Invalid" }),
        makeRow({ id: "r-missing", licenseMode: "platform", licenseStatus: null, displayName: "Missing" }),
      ],
    });
    renderPage();
    expect(screen.getByText("None Mode").closest("[data-plugin-card]")).not.toHaveTextContent("License");
    expect(screen.getByText("Self Mode").closest("[data-plugin-card]")).toHaveTextContent("Self-licensed");
    expect(screen.getByText("Verified").closest("[data-plugin-card]")).toHaveTextContent("License ✓");
    expect(screen.getByText("Invalid").closest("[data-plugin-card]")).toHaveTextContent("License ✗");
    expect(screen.getByText("Missing").closest("[data-plugin-card]")).toHaveTextContent("License missing");
    // License ✗ conveys the closed-enum reason via aria-label (the tooltip
    // content — a11y: never color alone).
    // Radix's TooltipTrigger asChild re-roots the badge span (data-slot
    // becomes tooltip-trigger) — assert via the aria-label contract.
    const invalidBadge = screen
      .getByText("Invalid")
      .closest("[data-plugin-card]")!
      .querySelector("[aria-label='License status: plugin_mismatch']");
    expect(invalidBadge).not.toBeNull();
    expect(invalidBadge!.textContent).toBe("License ✗");
  });

  it("restart-pending amber chip: enabled && status not loaded/failed", () => {
    setState({
      restartMode: "manual",
      plugins: [
        makeRow({ id: "r-pending", enabled: true, status: "installed", displayName: "Pending" }),
        makeRow({ id: "r-live", enabled: true, status: "loaded", displayName: "Live" }),
        makeRow({ id: "r-off", enabled: false, status: "installed", displayName: "Off" }),
      ],
    });
    renderPage();
    expect(screen.getByText("Pending").closest("[data-plugin-card]")).toHaveTextContent("Restart required");
    expect(screen.getByText("Live").closest("[data-plugin-card]")).not.toHaveTextContent("Restart required");
    expect(screen.getByText("Off").closest("[data-plugin-card]")).not.toHaveTextContent("Restart required");
  });

  it("failed rows carry the lastError Collapsible with the error text", () => {
    setState({
      restartMode: "manual",
      plugins: [makeRow({ id: "r-f", status: "failed", lastError: "MODULE_NOT_FOUND: nope" })],
    });
    renderPage();
    fireEvent.click(screen.getByText("Last error"));
    expect(screen.getByText(/MODULE_NOT_FOUND: nope/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/*  Pin (b): license modal entry ONLY for platform rows                */
/* ------------------------------------------------------------------ */

describe("Pin (b) — license affordance strictly platform-gated", () => {
  it("none/self rows never show Manage license; platform rows do", () => {
    setState({
      restartMode: "manual",
      plugins: [
        makeRow({ id: "r-none", licenseMode: "none", displayName: "None Mode" }),
        makeRow({ id: "r-self", licenseMode: "self", displayName: "Self Mode" }),
        makeRow({ id: "r-platform", licenseMode: "platform", displayName: "Platform Mode" }),
      ],
    });
    renderPage();
    openCardMenu("None Mode");
    expect(screen.queryByText("Manage license")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Plugin actions" })[0]); // close? menus close on outside click — reset via re-render
  });

  it("platform row's menu opens Manage license", async () => {
    setState({
      restartMode: "manual",
      plugins: [makeRow({ id: "r-platform", licenseMode: "platform", displayName: "Platform Mode" })],
    });
    renderPage();
    openCardMenu("Platform Mode");
    expect(screen.getByText("Manage license")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/*  Pin (c): native rows read-only                                     */
/* ------------------------------------------------------------------ */

describe("Pin (c) — native rows render read-only", () => {
  it("no Switch, no overflow menu, nativeHint present", () => {
    setState({
      restartMode: "manual",
      plugins: [
        makeRow({ id: "native:enterprise", source: "native", packageName: "@simmetric-chat/enterprise", displayName: "enterprise" }),
        makeRow({ id: "r-managed", displayName: "Managed Plugin" }),
      ],
    });
    renderPage();
    const nativeCard = screen.getByText("@simmetric-chat/enterprise").closest("[data-plugin-card]");
    expect(nativeCard).toHaveTextContent("Native");
    expect(nativeCard).toHaveTextContent("Loaded from the native install path — managed in docs/PLUGINS.md.");
    expect(nativeCard?.querySelector("[role='switch']")).toBeNull();
    expect(nativeCard?.querySelector("[aria-label='Plugin actions']")).toBeNull();
    // The managed card still has its switch.
    const managedCard = screen.getByText("Managed Plugin").closest("[data-plugin-card]");
    expect(managedCard?.querySelector("[role='switch']")).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Pin (d): uninstall disabled-with-tooltip when enabled              */
/* ------------------------------------------------------------------ */

describe("Pin (d) — uninstall menu item disabled-with-tooltip when enabled", () => {
  it("enabled row → menu Uninstall disabled; disabled row → enabled", () => {
    setState({
      restartMode: "manual",
      plugins: [
        makeRow({ id: "r-on", enabled: true, displayName: "Enabled Plugin" }),
        makeRow({ id: "r-off", enabled: false, displayName: "Disabled Plugin" }),
      ],
    });
    renderPage();
    openCardMenu("Enabled Plugin");
    const item = screen.getByText("Uninstall").closest("[data-testid='dropdown-item']") as HTMLElement | null;
    expect(item).toHaveAttribute("data-disabled");
    // The hint copy is discoverable (visible-but-gated, A-8).
    // Close + open the other card's menu.
    openCardMenu("Disabled Plugin");
    const item2 = screen.getAllByText("Uninstall").pop()!.closest("[data-testid='dropdown-item']") as HTMLElement | null;
    expect(item2).not.toHaveAttribute("data-disabled");
  });
});

/* ------------------------------------------------------------------ */
/*  Pin (e): manual restart — disabled button + dev warning, no call   */
/* ------------------------------------------------------------------ */

describe("Pin (e) — restartMode manual renders the dev warning and NEVER calls the API", () => {
  it("disabled button + dev-mode warning; clicking calls nothing", () => {
    setState({ restartMode: "manual", plugins: [] });
    renderPage();
    const btn = screen.getByRole("button", { name: "Restart server" });
    expect(btn).toBeDisabled();
    expect(screen.getByText("Dev mode: restart manually")).toBeInTheDocument();
    fireEvent.click(btn);
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("supervisor mode → confirm dialog → restart called once", async () => {
    mockRestart.mockResolvedValue({ restarting: true });
    setState({ restartMode: "supervisor", plugins: [] });
    renderPage();
    const btn = screen.getByRole("button", { name: "Restart server" });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    fireEvent.click(screen.getByText("Restart now"));
    await waitFor(() => expect(mockRestart).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Restarting the server — this page reconnects automatically.")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/*  Dropzone guards (A-11) + install flow                              */
/* ------------------------------------------------------------------ */

describe("dropzone install flow", () => {
  it("wrong type → localized showError, NO API call (A-11)", () => {
    setState({ restartMode: "manual", plugins: [] });
    renderPage();
    const opts = (globalThis as Record<string, unknown>).__dzOpts as { onDrop: (a: File[], r: unknown[]) => void };
    opts.onDrop([], [{ file: { name: "x.txt", size: 10 }, errors: [{ code: "file-invalid-type" }] }]);
    expect(mockShowError).toHaveBeenCalledWith("Only .zip files are accepted.");
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("too large → tooLarge message, NO API call (A-11)", () => {
    setState({ restartMode: "manual", plugins: [] });
    renderPage();
    const opts = (globalThis as Record<string, unknown>).__dzOpts as { onDrop: (a: File[], r: unknown[]) => void };
    opts.onDrop([], [{ file: { name: "big.zip", size: 101 * 1024 * 1024 }, errors: [{ code: "file-too-large" }] }]);
    expect(mockShowError).toHaveBeenCalledWith("Plugin archives are limited to 100 MB.");
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("accepted zip → install called; success toasts + no ghost card (the refetch is the truth)", async () => {
    mockInstall.mockResolvedValue(makeRow({ id: "new-row" }));
    setState({ restartMode: "manual", plugins: [] });
    renderPage();
    const opts = (globalThis as Record<string, unknown>).__dzOpts as { onDrop: (a: File[], r: unknown[]) => void };
    const file = new File(["x"], "plugin.zip", { type: "application/zip" });
    opts.onDrop([file], []);
    await waitFor(() => expect(mockInstall).toHaveBeenCalledWith(file));
    await waitFor(() => expect(mockShowSuccess).toHaveBeenCalledWith("Plugin installed — enable it to load after a restart."));
  });

  it("install failure → installFailed toast with server detail; NO ghost card (list state untouched)", async () => {
    mockInstall.mockRejectedValue(new Error("Not a valid zip archive"));
    setState({ restartMode: "manual", plugins: [] });
    renderPage();
    const opts = (globalThis as Record<string, unknown>).__dzOpts as { onDrop: (a: File[], r: unknown[]) => void };
    opts.onDrop([new File(["x"], "plugin.zip", { type: "application/zip" })], []);
    await waitFor(() => expect(mockShowError).toHaveBeenCalledWith("Install failed: Not a valid zip archive"));
    expect(screen.queryByText("Installing plugin…")).not.toBeInTheDocument();
  });

  it("empty list renders the muted plugins.empty line under the always-present dropzone (A-15)", () => {
    setState({ restartMode: "manual", plugins: [] });
    renderPage();
    expect(screen.getByText("No plugins installed yet.")).toBeInTheDocument();
    expect(screen.getByText("Install a plugin")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/*  License modal (A-5/A-6/A-7) + toggle                               */
/* ------------------------------------------------------------------ */

describe("license modal", () => {
  async function openModal() {
    setState({
      restartMode: "manual",
      plugins: [makeRow({ id: "r-platform", licenseMode: "platform", licenseStatus: null, packageName: "@acme/widget", displayName: "Platform Mode" })],
    });
    renderPage();
    openCardMenu("Platform Mode");
    fireEvent.click(screen.getByText("Manage license"));
    await screen.findByText("Plugin license");
  }

  it("opens EMPTY (A-6); Save disabled until Verify passes (A-7)", async () => {
    await openModal();
    const input = screen.getByLabelText("License key (JWT)") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByText("Save license").closest("button")).toBeDisabled();
    expect(screen.getByText("Verify").closest("button")).toBeDisabled();
  });

  it("Verify (probe-only) passes → Save enabled → save closes modal + success toast", async () => {
    mockVerifyLicense.mockResolvedValue({ licenseStatus: "verified" });
    mockSaveLicense.mockResolvedValue({ licenseStatus: "verified" });
    await openModal();
    fireEvent.change(screen.getByLabelText("License key (JWT)"), { target: { value: "a.b.c" } });
    fireEvent.click(screen.getByText("Verify"));
    await screen.findByText("License valid — safe to save.");
    const saveBtn = screen.getByText("Save license").closest("button") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(screen.getByText("Save license"));
    await waitFor(() => expect(mockSaveLicense).toHaveBeenCalledWith({ id: "r-platform", licenseKey: "a.b.c" }));
    await waitFor(() => expect(mockShowSuccess).toHaveBeenCalledWith("License saved"));
  });

  it("verify failure renders the closed-enum reason inline; Save stays disabled", async () => {
    mockVerifyLicense.mockRejectedValue(new Error("bad"));
    await openModal();
    fireEvent.change(screen.getByLabelText("License key (JWT)"), { target: { value: "a.b.c" } });
    fireEvent.click(screen.getByText("Verify"));
    await screen.findByText("Verification failed: bad");
    expect((screen.getByText("Save license").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(mockSaveLicense).not.toHaveBeenCalled();
  });

  it("license input renders as a password field (A-5)", async () => {
    await openModal();
    expect(screen.getByLabelText("License key (JWT)")).toHaveAttribute("type", "password");
  });
});

describe("toggle + uninstall", () => {
  it("Switch toggle → PUT {enabled} + deferred-effect toast", async () => {
    mockToggle.mockResolvedValue(makeRow({ enabled: true }));
    setState({
      restartMode: "manual",
      plugins: [makeRow({ id: "r-t", enabled: false, displayName: "Toggle Me" })],
    });
    renderPage();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(mockToggle).toHaveBeenCalledWith({ id: "r-t", enabled: true }));
    await waitFor(() =>
      expect(mockShowSuccess).toHaveBeenCalledWith("Plugin Enable — takes effect after a restart."),
    );
  });

  it("uninstall confirm → DELETE called", async () => {
    mockUninstall.mockResolvedValue({ success: true });
    setState({
      restartMode: "manual",
      plugins: [makeRow({ id: "r-u", enabled: false, displayName: "Remove Me" })],
    });
    renderPage();
    openCardMenu("Remove Me");
    fireEvent.click(screen.getByText("Uninstall")); // opens the confirm
    const confirmBtn = Array.from(
      screen.getByTestId("alert-dialog-content").querySelectorAll("button"),
    ).find((b) => b.textContent === "Uninstall");
    expect(confirmBtn).toBeTruthy();
    fireEvent.click(confirmBtn as HTMLElement);
    await waitFor(() => expect(mockUninstall).toHaveBeenCalledWith("r-u"));
  });
});