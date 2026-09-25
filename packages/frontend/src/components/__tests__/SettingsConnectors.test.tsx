// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 199 (199-02, ECCO-05) — SettingsConnectors component suite.
 * Mirrors the SettingsMcpConnections test patterns (jest.mock the hook
 * module, useMe mock, useQueryClient mock).
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SettingsConnectors, { PLATFORM_GLYPHS } from "../SettingsConnectors";
import { showSuccess } from "../../lib/toast";

const mockConnectors = [
  {
    id: "k1",
    platform: "telegram" as const,
    name: "Telegram Support",
    workspaceId: "w1",
    archiveId: null,
    botUsername: "support_bot",
    botDisplayName: "Support Bot",
    welcomeMessage: null,
    fallbackMessage: null,
    fallbackLocale: "en",
    isEnabled: true,
    pollMode: "polling" as const,
    rateLimitPerMinute: null,
    sessionLimitPerDay: null,
    healthStatus: "healthy" as const,
    lastWebhookAt: null,
    lastPollAt: "2026-09-23T09:00:00Z",
    lastError: null,
    hasBotToken: true,
    hasWebhookSecret: false,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "k2",
    platform: "discord" as const,
    name: "Discord Bot",
    workspaceId: "w1",
    archiveId: null,
    botUsername: null,
    botDisplayName: null,
    welcomeMessage: null,
    fallbackMessage: null,
    fallbackLocale: "en",
    isEnabled: false,
    pollMode: "polling" as const,
    rateLimitPerMinute: null,
    sessionLimitPerDay: null,
    healthStatus: "unknown" as const,
    lastWebhookAt: null,
    lastPollAt: null,
    lastError: null,
    hasBotToken: true,
    hasWebhookSecret: false,
    createdAt: "",
    updatedAt: "",
  },
];

const mockCreateConnector = jest.fn();
const mockToggleConnector = jest.fn();
const mockDeleteConnector = jest.fn();
const mockValidateConnectorToken = jest.fn();
const mockWebhookSetup = jest.fn();
const mockWebhookRemove = jest.fn();
const mockTestConnector = jest.fn();
const mockStartConnectorOauth = jest.fn();

// Phase 200 (D-05): the Connect-with-Slack visibility signal — reassignable
// per-test (configured / not-configured arms), mirroring the mockRows idiom.
let mockOauthProviders: { id: string; configured: boolean }[] = [];

// The hook-module mock: every hook the component consumes must be present
// (SettingsMcpConnections lesson — a missing export throws on every render).
// mockList is reassignable per-test so one-off row shapes (error rows,
// empty lists) don't need module surgery.
let mockPermissions: string[] = ["connector:view", "connector:manage"];
let mockRows: typeof mockConnectors = mockConnectors;
jest.mock("../../queries/useConnectors", () => ({
  useConnectors: () => ({ data: mockRows, isLoading: false }),
  useCreateConnector: () => ({ mutateAsync: mockCreateConnector }),
  useToggleConnector: () => ({ mutateAsync: mockToggleConnector }),
  useDeleteConnector: () => ({ mutateAsync: mockDeleteConnector }),
  useValidateConnectorToken: () => ({ mutateAsync: mockValidateConnectorToken }),
  useWebhookSetup: () => ({ mutateAsync: mockWebhookSetup }),
  useWebhookRemove: () => ({ mutateAsync: mockWebhookRemove }),
  useTestConnector: () => ({ mutateAsync: mockTestConnector }),
  useOauthProviders: () => ({ data: mockOauthProviders }),
  useStartConnectorOauth: () => ({ mutateAsync: mockStartConnectorOauth }),
}));

jest.mock("../../queries/useAuth", () => ({
  useMe: () => ({ data: { permissions: mockPermissions } }),
}));

jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: jest.fn(),
    }),
  };
});

jest.mock("../../utils/api", () => ({
  apiGet: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Redirect seam stub (jsdom window.location is non-configurable — 196-03
// lesson; the OAuth Connect click routes full-page navigation through it).
const mockAssignRedirect = jest.fn();
jest.mock("../../lib/redirect", () => ({
  assignRedirect: (...args: unknown[]) => mockAssignRedirect(...args),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && Object.keys(opts).length > 0) {
        return `${key}:${Object.entries(opts)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(",")}`;
      }
      return key;
    },
  }),
}));

// Controlled DropdownMenu (the MarketplaceCard.test precedent — Radix
// dropdown content is portal-rendered and needs the pointer capture
// sequence jsdom can't simulate; a controlled mirror keeps the wiring
// assertions real: trigger renders, click opens, item click fires).
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
    return React.cloneElement(children, {
      onClick: () => setOpen(true),
    });
  };
  const DropdownMenuContent = ({ children }: { children: React.ReactNode }) => {
    const { open } = React.useContext(Ctx);
    return open ? <div data-testid="dropdown-content">{children}</div> : null;
  };
  const DropdownMenuItem = ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => (
    <button type="button" className={className} onClick={onClick}>{children}</button>
  );
  return { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem };
});

function setPermissions(perms: string[]) {
  mockPermissions = perms;
}

function setRows(rows: typeof mockConnectors) {
  mockRows = rows;
}

function setOauthProviders(providers: { id: string; configured: boolean }[]) {
  mockOauthProviders = providers;
}

/** Open the create dialog and select a platform (radix combobox idiom —
 * the existing submit-test pattern). The dialog title reuses the
 * createButton label, so the header CTA is targeted via its button role.
 * Radix marks the app root aria-hidden while the dialog is open, so the
 * dialog must be opened at most ONCE per render — subsequent platform
 * switches go through the open dialog's combobox. */
async function openCreateAndPickPlatform(platformKey: "telegram" | "discord" | "slack" | "whatsapp") {
  const headerCta = screen.getAllByRole("button", { name: "settings.connectors.createButton" })[0];
  if (headerCta) {
    fireEvent.click(headerCta);
  }
  fireEvent.click(screen.getAllByRole("combobox")[0]!);
  const options = await screen.findAllByText(`settings.connectors.platform.${platformKey}`);
  fireEvent.click(options[options.length - 1]!);
}

describe("SettingsConnectors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setPermissions(["connector:view", "connector:manage"]);
    setRows(mockConnectors);
    setOauthProviders([]);
  });

  it("renders connector cards with platform name, health badge, and bot username", () => {
    render(<SettingsConnectors />);
    expect(screen.getByText("Telegram Support")).toBeInTheDocument();
    expect(screen.getByText("Discord Bot")).toBeInTheDocument();
    // Health badges — healthy (telegram row) + disabled-wins priority
    // (discord row: isSupported false → Disabled wins over unknown).
    expect(screen.getByText("settings.connectors.statusHealthy")).toBeInTheDocument();
    expect(screen.getByText("settings.connectors.statusDisabled")).toBeInTheDocument();
    // Bot username meta row (the @handle).
    expect(screen.getByText(/@support_bot/i)).toBeInTheDocument();
    // Health badge text renders exactly ONE badge per row: no second
    // "Unknown" badge anywhere (A-12 one-slot doctrine).
    expect(screen.queryByText("settings.connectors.statusUnknown")).not.toBeInTheDocument();
  });

  it("renders the empty state when the list is empty", () => {
    setRows([]);
    render(<SettingsConnectors />);
    expect(screen.getByText("settings.connectors.noConnectors")).toBeInTheDocument();
    expect(screen.getByText("settings.connectors.noConnectorsBody")).toBeInTheDocument();
    // The empty-state CTA (plus the header CTA render the same label).
    expect(screen.getAllByText("settings.connectors.createButton").length).toBeGreaterThanOrEqual(1);
    // No card rows rendered.
    expect(screen.queryByText("Telegram Support")).not.toBeInTheDocument();
  });

  it("renders NO action affordances for a view-only admin (hidden, not disabled)", () => {
    setPermissions(["connector:view"]);
    render(<SettingsConnectors />);
    // Cards + badges + meta still render (view-only admins see cards).
    expect(screen.getByText("Telegram Support")).toBeInTheDocument();
    expect(screen.getByText("settings.connectors.statusHealthy")).toBeInTheDocument();
    // The Add Connector CTA is ABSENT (hidden-not-disabled semantics pinned
    // by absence, not aria-disabled) — no header CTA, no empty-state CTA,
    // no dialog.
    expect(screen.queryByText("settings.connectors.createButton")).not.toBeInTheDocument();
    // No switches, no overflow-menu triggers, no test action.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "settings.connectors.cardMenu" })).not.toBeInTheDocument();
    expect(screen.queryByText("settings.connectors.test")).not.toBeInTheDocument();
  });

  it("renders action affordances for a manage-permission admin", () => {
    render(<SettingsConnectors />);
    // Header CTA only (cards are populated — the empty state is absent).
    expect(screen.getAllByText("settings.connectors.createButton")).toHaveLength(1);
    // Two switches (one per card) + the test action (one per card).
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(screen.getAllByText("settings.connectors.test").length).toBeGreaterThanOrEqual(1);
  });

  it("renders pollMode badge + webhook actions ONLY on the telegram row", () => {
    render(<SettingsConnectors />);
    // The telegram row carries the polling badge; the discord row renders
    // NO pollMode badge and no webhook actions (D-06). Exactly ONE pollMode
    // badge exists (telegram) — the disabled discord row renders none.
    expect(screen.getAllByText("settings.connectors.modePolling")).toHaveLength(1);
    expect(screen.getAllByText("settings.connectors.webhookSetup")).toHaveLength(1);
  });

  it("renders the error health badge with destructive tint + aria semantics for the error row", () => {
    const errorRow = {
      ...mockConnectors[0],
      id: "k3",
      name: "Broken Bot",
      isEnabled: true,
      healthStatus: "error" as const,
      lastError: "gateway 4004",
    };
    setRows([errorRow]);
    render(<SettingsConnectors />);
    expect(screen.getByText("Broken Bot")).toBeInTheDocument();
    const badge = screen.getByText("settings.connectors.statusError");
    expect(badge).toBeInTheDocument();
    // One badge per row (A-12): no second status badge anywhere.
    expect(screen.getAllByText("settings.connectors.statusError")).toHaveLength(1);
    // The destructive tint idiom (color pair verified in SettingsMcpConnections).
    expect(badge.className).toContain("destructive");
    // The badge conveys state through text + aria-label (never color alone).
    expect(
      screen.getByLabelText("settings.connectors.statusError")
    ).toBeInTheDocument();
  });

  it("glyph map pins platform → lucide icon components", () => {
    expect(PLATFORM_GLYPHS.telegram).toBeDefined();
    expect(PLATFORM_GLYPHS.discord).toBeDefined();
    expect(PLATFORM_GLYPHS.slack).toBeDefined();
    expect(PLATFORM_GLYPHS.whatsapp).toBeDefined();
  });

  it("calls the toggle mutation when a card Switch is toggled", async () => {
    mockToggleConnector.mockResolvedValue({});
    render(<SettingsConnectors />);
    const switches = screen.getAllByRole("switch");
    const first = switches[0];
    if (first) fireEvent.click(first);
    await waitFor(() => {
      expect(mockToggleConnector).toHaveBeenCalledWith(
        expect.objectContaining({ id: "k1", isEnabled: false })
      );
    });
    await waitFor(() => {
      expect(showSuccess).toHaveBeenCalledWith(
        expect.stringContaining("settings.connectors.toggleSuccess")
      );
    });
  });

  it("shows the delete confirm dialog and calls the delete mutation on confirm", async () => {
    mockDeleteConnector.mockResolvedValue({});
    render(<SettingsConnectors />);
    // Open the overflow menu on the first card.
    const menus = screen.getAllByRole("button", { name: "settings.connectors.cardMenu" });
    const firstMenu = menus[0];
    if (firstMenu) fireEvent.click(firstMenu);
    const deleteItem = await screen.findByText("common.delete");
    fireEvent.click(deleteItem);
    // The AlertDialog confirm carries common.delete as well.
    const confirm = await screen.findByRole("button", { name: /common\.delete/i });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(mockDeleteConnector).toHaveBeenCalledWith("k1");
    });
    expect(showSuccess).toHaveBeenCalledWith("settings.connectors.deleteSuccess");
  });

  it("submits the create dialog with the form values and shows the success toast", async () => {
    mockCreateConnector.mockResolvedValue({});
    const { apiGet } = jest.requireMock("../../utils/api") as {
      apiGet: jest.Mock;
    };
    apiGet.mockImplementation((path: string) => {
      if (path === "/workspaces") return Promise.resolve([{ id: "w1", name: "Main" }]);
      return Promise.resolve([]);
    });

    render(<SettingsConnectors />);
    fireEvent.click(screen.getByText("settings.connectors.createButton"));

    // Platform select — radix renders a combobox trigger; pick telegram.
    fireEvent.click(screen.getAllByRole("combobox")[0]!);
    const telegramOption = await screen.findByText("settings.connectors.platform.telegram");
    fireEvent.click(telegramOption);

    const nameInput = screen.getByLabelText("settings.connectors.nameLabel");
    fireEvent.change(nameInput, { target: { value: "Support Bot" } });
    const tokenInput = screen.getByLabelText("settings.connectors.tokenLabel");
    fireEvent.change(tokenInput, { target: { value: "123:ABC" } });

    // Workspace select.
    fireEvent.click(screen.getAllByRole("combobox")[1]);
    const workspaceOption = await screen.findByText("Main");
    fireEvent.click(workspaceOption);

    fireEvent.click(screen.getByText("settings.connectors.createSubmit"));

    await waitFor(() => {
      expect(mockCreateConnector).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: "telegram",
          name: "Support Bot",
          botToken: "123:ABC",
        })
      );
    });
    await waitFor(() => {
      expect(showSuccess).toHaveBeenCalledWith("settings.connectors.createSuccess");
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Phase 200 (ECCO-06) — unlock + conditional fields + OAuth arm      */
  /* ------------------------------------------------------------------ */

  it("renders slack and whatsapp SelectItems enabled (no disabled attr, no coming-soon hint)", async () => {
    render(<SettingsConnectors />);
    await openCreateAndPickPlatform("telegram");
    // Re-open the platform dropdown to inspect the option list.
    fireEvent.click(screen.getAllByRole("combobox")[0]!);
    const slackOption = await screen.findByText("settings.connectors.platform.slack");
    const whatsappOption = await screen.findByText("settings.connectors.platform.whatsapp");
    expect(slackOption).not.toHaveAttribute("aria-disabled", "true");
    expect(whatsappOption).not.toHaveAttribute("aria-disabled", "true");
    // The coming-soon hint stopped firing for the unlocked platforms.
    expect(screen.queryByText("settings.connectors.platformComingSoon")).not.toBeInTheDocument();
  });

  it("renders the conditional-field matrix: slack → signing secret, whatsapp → 4 fields in order, telegram → none", async () => {
    render(<SettingsConnectors />);
    // ONE dialog session: the platform switch drives the conditional block
    // inside the open dialog (Radix marks the app root aria-hidden while a
    // dialog is open — re-opening from the header CTA is unreachable).
    await openCreateAndPickPlatform("telegram");

    // telegram → none (byte-identical to 199).
    expect(screen.queryByLabelText("settings.connectors.signingSecretLabel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("settings.connectors.phoneNumberIdLabel")).not.toBeInTheDocument();

    // slack → 1 password field (switch through the open dialog's combobox).
    fireEvent.click(screen.getAllByRole("combobox")[0]!);
    fireEvent.click((await screen.findAllByText("settings.connectors.platform.slack")).slice(-1)[0]!);
    const signingSecret = screen.getByLabelText("settings.connectors.signingSecretLabel");
    expect(signingSecret).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText("settings.connectors.phoneNumberIdLabel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("settings.connectors.appSecretLabel")).not.toBeInTheDocument();

    // whatsapp → Phone Number ID → App Secret → Verify Token → WBA ID in
    // order (document order via compareDocumentPosition on the labeled
    // inputs).
    fireEvent.click(screen.getAllByRole("combobox")[0]!);
    fireEvent.click((await screen.findAllByText("settings.connectors.platform.whatsapp")).slice(-1)[0]!);
    const phoneId = screen.getByLabelText("settings.connectors.phoneNumberIdLabel");
    const appSecret = screen.getByLabelText("settings.connectors.appSecretLabel");
    const verifyToken = screen.getByLabelText("settings.connectors.verifyTokenLabel");
    const wbaId = screen.getByLabelText("settings.connectors.wbaIdLabel");
    expect(phoneId).toHaveAttribute("type", "text");
    expect(appSecret).toHaveAttribute("type", "password");
    expect(verifyToken).toHaveAttribute("type", "password");
    expect(wbaId).toHaveAttribute("type", "text");
    // DOCUMENT_POSITION_FOLLOWING = the reference node precedes the given
    // node in document order (phoneId before appSecret, etc.).
    expect(phoneId.compareDocumentPosition(appSecret) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(appSecret.compareDocumentPosition(verifyToken) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(verifyToken.compareDocumentPosition(wbaId) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Selecting whatsapp hides slack's field (no orphan values).
    expect(screen.queryByLabelText("settings.connectors.signingSecretLabel")).not.toBeInTheDocument();
  });

  it("disables the whatsapp Validate button until platform + token + required fields are non-empty (A-7)", async () => {
    mockValidateConnectorToken.mockResolvedValue({ valid: true, botUsername: "wa" });
    render(<SettingsConnectors />);
    await openCreateAndPickPlatform("whatsapp");

    const validateButton = screen.getByRole("button", { name: "settings.connectors.validate" });
    // token non-empty only → still disabled (the probe needs the Phone
    // Number ID + app secret + verify token).
    const tokenInput = screen.getByLabelText("settings.connectors.tokenLabel");
    fireEvent.change(tokenInput, { target: { value: "wa-token" } });
    expect(validateButton).toBeDisabled();
    expect(mockValidateConnectorToken).not.toHaveBeenCalled();

    // Filling the required fields enables it.
    fireEvent.change(screen.getByLabelText("settings.connectors.phoneNumberIdLabel"), { target: { value: "PNID1" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.appSecretLabel"), { target: { value: "SEC1" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.verifyTokenLabel"), { target: { value: "VT1" } });
    expect(validateButton).toBeEnabled();

    fireEvent.click(validateButton);
    await waitFor(() => {
      expect(mockValidateConnectorToken).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: "whatsapp",
          botToken: "wa-token",
          phoneNumberId: "PNID1",
          appSecret: "SEC1",
          verifyToken: "VT1",
        })
      );
    });
  });

  it("keeps the telegram Validate condition platform+token-only (unchanged 199 behavior)", async () => {
    mockValidateConnectorToken.mockResolvedValue({ valid: true, botUsername: "tg" });
    render(<SettingsConnectors />);
    await openCreateAndPickPlatform("telegram");
    fireEvent.change(screen.getByLabelText("settings.connectors.tokenLabel"), { target: { value: "tg-token" } });
    const validateButton = screen.getByRole("button", { name: "settings.connectors.validate" });
    expect(validateButton).toBeEnabled();
    fireEvent.click(validateButton);
    await waitFor(() => {
      expect(mockValidateConnectorToken).toHaveBeenCalledWith(
        expect.objectContaining({ platform: "telegram", botToken: "tg-token" })
      );
    });
  });

  it("renders Connect with Slack ONLY when platform===slack AND the providers query reports configured", async () => {
    const { unmount: unmount1 } = render(<SettingsConnectors />);

    // Unconfigured: the button never renders — the static token+signing-
    // secret form is the whole slack path (D-05 fallback).
    await openCreateAndPickPlatform("slack");
    expect(screen.queryByText("settings.connectors.connectWithSlack")).not.toBeInTheDocument();
    unmount1();

    // Configured: the outline button renders next to the static fields.
    setOauthProviders([{ id: "slack", configured: true }]);
    const { unmount: unmount2 } = render(<SettingsConnectors />);
    await openCreateAndPickPlatform("slack");
    expect(screen.getByText("settings.connectors.connectWithSlack")).toBeInTheDocument();
    // Static fields coexist (A-6).
    expect(screen.getByLabelText("settings.connectors.signingSecretLabel")).toBeInTheDocument();
    expect(screen.getByLabelText("settings.connectors.tokenLabel")).toBeInTheDocument();
    unmount2();

    // A configured google does NOT light the slack arm.
    setOauthProviders([{ id: "google", configured: true }]);
    render(<SettingsConnectors />);
    await openCreateAndPickPlatform("slack");
    expect(screen.queryByText("settings.connectors.connectWithSlack")).not.toBeInTheDocument();
  });

  it("create-then-connect: the armed Connect click creates the connector then redirects via the seam", async () => {
    mockCreateConnector.mockResolvedValue({ id: "new-connector-id" });
    mockStartConnectorOauth.mockResolvedValue({ authorizeUrl: "https://slack.com/oauth/authorize?x=1" });
    setOauthProviders([{ id: "slack", configured: true }]);

    const { apiGet } = jest.requireMock("../../utils/api") as {
      apiGet: jest.Mock;
    };
    apiGet.mockImplementation((path: string) => {
      if (path === "/workspaces") return Promise.resolve([{ id: "w1", name: "Main" }]);
      return Promise.resolve([]);
    });

    render(<SettingsConnectors />);
    await openCreateAndPickPlatform("slack");
    fireEvent.click(screen.getByText("settings.connectors.connectWithSlack"));

    const nameInput = screen.getByLabelText("settings.connectors.nameLabel");
    fireEvent.change(nameInput, { target: { value: "Slack Bot" } });
    const tokenInput = screen.getByLabelText("settings.connectors.tokenLabel");
    fireEvent.change(tokenInput, { target: { value: "xoxb-placeholder" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.signingSecretLabel"), { target: { value: "SIG1" } });

    fireEvent.click(screen.getAllByRole("combobox")[1]);
    const workspaceOption = await screen.findByText("Main");
    fireEvent.click(workspaceOption);

    fireEvent.click(screen.getByText("settings.connectors.createSubmit"));

    // CREATE first — the connector row must exist before oauth/start can
    // mint its connector-audience state.
    await waitFor(() => {
      expect(mockCreateConnector).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: "slack",
          name: "Slack Bot",
          botToken: "xoxb-placeholder",
          signingSecret: "SIG1",
        })
      );
    });
    await waitFor(() => {
      expect(mockStartConnectorOauth).toHaveBeenCalledWith("new-connector-id");
    });
    // Full-page redirect via the lib/redirect seam — never a popup.
    await waitFor(() => {
      expect(mockAssignRedirect).toHaveBeenCalledWith("https://slack.com/oauth/authorize?x=1");
    });
    expect(mockAssignRedirect).toHaveBeenCalledTimes(1);
  });

  it("keeps the signing secret REQUIRED at create even when the Connect arm is used (A-11)", async () => {
    mockCreateConnector.mockResolvedValue({ id: "nc" });
    setOauthProviders([{ id: "slack", configured: true }]);
    const { apiGet } = jest.requireMock("../../utils/api") as { apiGet: jest.Mock };
    apiGet.mockImplementation((path: string) =>
      path === "/workspaces" ? Promise.resolve([{ id: "w1", name: "Main" }]) : Promise.resolve([])
    );

    render(<SettingsConnectors />);
    await openCreateAndPickPlatform("slack");
    fireEvent.click(screen.getByText("settings.connectors.connectWithSlack"));
    fireEvent.change(screen.getByLabelText("settings.connectors.nameLabel"), { target: { value: "S" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.tokenLabel"), { target: { value: "tok" } });
    fireEvent.click(screen.getAllByRole("combobox")[1]);
    fireEvent.click(await screen.findByText("Main"));
    fireEvent.click(screen.getByText("settings.connectors.createSubmit"));

    // Inline required error — no submission happened (the OAuth response
    // carries NO signing secret; the field stays required).
    expect(await screen.findByText("settings.connectors.errorSigningSecretRequired")).toBeInTheDocument();
    expect(mockCreateConnector).not.toHaveBeenCalled();
  });

  it("submits the whatsapp create payload with the platform config fields and shows required errors when empty", async () => {
    mockCreateConnector.mockResolvedValue({});
    const { apiGet } = jest.requireMock("../../utils/api") as { apiGet: jest.Mock };
    apiGet.mockImplementation((path: string) =>
      path === "/workspaces" ? Promise.resolve([{ id: "w1", name: "Main" }]) : Promise.resolve([])
    );

    render(<SettingsConnectors />);
    await openCreateAndPickPlatform("whatsapp");
    fireEvent.change(screen.getByLabelText("settings.connectors.nameLabel"), { target: { value: "WA Bot" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.tokenLabel"), { target: { value: "wa-token" } });

    // Required inline errors mirror the error*Required pattern.
    fireEvent.click(screen.getAllByRole("combobox")[1]);
    fireEvent.click(await screen.findByText("Main"));
    fireEvent.click(screen.getByText("settings.connectors.createSubmit"));
    expect(await screen.findByText("settings.connectors.errorPhoneNumberIdRequired")).toBeInTheDocument();
    expect(screen.getByText("settings.connectors.errorAppSecretRequired")).toBeInTheDocument();
    expect(screen.getByText("settings.connectors.errorVerifyTokenRequired")).toBeInTheDocument();
    expect(mockCreateConnector).not.toHaveBeenCalled();

    // Filling them submits the full config payload.
    fireEvent.change(screen.getByLabelText("settings.connectors.phoneNumberIdLabel"), { target: { value: "PNID1" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.appSecretLabel"), { target: { value: "SEC1" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.verifyTokenLabel"), { target: { value: "VT1" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.wbaIdLabel"), { target: { value: "WBA1" } });
    fireEvent.click(screen.getByText("settings.connectors.createSubmit"));
    await waitFor(() => {
      expect(mockCreateConnector).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: "whatsapp",
          name: "WA Bot",
          phoneNumberId: "PNID1",
          appSecret: "SEC1",
          verifyToken: "VT1",
          whatsappBusinessAccountId: "WBA1",
        })
      );
    });
  });

  it("keeps the telegram create payload byte-identical to 199 (no config fields)", async () => {
    mockCreateConnector.mockResolvedValue({});
    const { apiGet } = jest.requireMock("../../utils/api") as { apiGet: jest.Mock };
    apiGet.mockImplementation((path: string) =>
      path === "/workspaces" ? Promise.resolve([{ id: "w1", name: "Main" }]) : Promise.resolve([])
    );

    render(<SettingsConnectors />);
    await openCreateAndPickPlatform("telegram");
    fireEvent.change(screen.getByLabelText("settings.connectors.nameLabel"), { target: { value: "T" } });
    fireEvent.change(screen.getByLabelText("settings.connectors.tokenLabel"), { target: { value: "tok" } });
    fireEvent.click(screen.getAllByRole("combobox")[1]);
    fireEvent.click(await screen.findByText("Main"));
    fireEvent.click(screen.getByText("settings.connectors.createSubmit"));
    await waitFor(() => {
      const arg = mockCreateConnector.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg).toMatchObject({ platform: "telegram", botToken: "tok" });
      expect(arg.signingSecret).toBeUndefined();
      expect(arg.phoneNumberId).toBeUndefined();
      expect(arg.appSecret).toBeUndefined();
      expect(arg.verifyToken).toBeUndefined();
      expect(arg.whatsappBusinessAccountId).toBeUndefined();
    });
  });
});