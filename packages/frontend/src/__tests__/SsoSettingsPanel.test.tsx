// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";

jest.mock("../utils/api", () => ({
  apiGet: jest.fn(),
  apiPut: jest.fn(),
  apiFetch: jest.fn(),
  apiPost: jest.fn(),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockUseFeature = jest.fn();
jest.mock("../hooks/useFeature", () => ({
  useFeature: (flag: string) => mockUseFeature(flag),
}));

jest.mock("@/hooks/usePageMeta", () => ({
  usePageMeta: jest.fn(),
}));

const mockSettingsHelpers = {
  getValue: jest.fn((key: string) => {
    if (key === "SERVER_URL") return "http://localhost:3000";
    if (key === "SCIM_BEARER_TOKEN") return "";
    return "";
  }),
  isReadOnly: jest.fn(() => false),
};

jest.mock("../queries/useSettings", () => ({
  useSettingsHelpers: () => mockSettingsHelpers,
  useUpdateSettings: () => ({
    mutateAsync: jest.fn().mockResolvedValue({ updated: [], rejected: [] }),
    isPending: false,
    reset: jest.fn(),
  }),
}));

import { apiGet, apiPut } from "../utils/api";
import SsoSettingsPanel from "../components/SsoSettingsPanel";

const mockApiGet = apiGet as jest.MockedFunction<typeof apiGet>;
const mockApiPut = apiPut as jest.MockedFunction<typeof apiPut>;
const MOCK_SSO_CONFIG = {
  id: "test-id",
  enabled: true,
  provider: "oidc",
  clientId: "test-client-id",
  discoveryUrl: "https://accounts.example.com/.well-known/openid-configuration",
  entryPoint: null,
  cert: null,
  entityId: null,
  redirectUri: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  clientSecretConfigured: false,
};

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

function renderWithClient(ui: ReactNode) {
  const client = makeClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("SsoSettingsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFeature.mockReturnValue(true);
    mockApiGet.mockResolvedValue(MOCK_SSO_CONFIG);
  });

  it("renders OIDC fields by default", async () => {
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText("sso.title")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration")).toBeInTheDocument();
    });

    expect(screen.getByText("sso.clientId")).toBeInTheDocument();
    expect(screen.getByText("sso.clientSecret")).toBeInTheDocument();
  });

  it("toggles to SAML fields when provider changed", async () => {
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText("sso.title")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("SAML 2.0"));

    expect(screen.getByText("sso.entryPoint")).toBeInTheDocument();
    expect(screen.getByText("sso.certificate")).toBeInTheDocument();
    expect(screen.getByText("sso.entityId")).toBeInTheDocument();
    expect(screen.queryByText("sso.discoveryUrl")).not.toBeInTheDocument();
  });

  it("shows UpgradePrompt when sso feature is disabled", async () => {
    mockUseFeature.mockReturnValue(false);

    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText("sso.title")).toBeInTheDocument();
      expect(screen.getByText("upgrade.cta")).toBeInTheDocument();
    });
  });

  it("calls save mutation on save button click", async () => {
    mockApiPut.mockResolvedValue(MOCK_SSO_CONFIG);
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("test-client-id")).toBeInTheDocument();
    });

    const saveButtons = screen.getAllByText("common.save");
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      // Phase 193 (D-03/D-19) — the single Save now carries the additive
      // ldap fields AND commits the staged map rows via the bulk PUT
      // (config + rows in ONE save; the map PUT is the D-19 contract).
      expect(mockApiPut).toHaveBeenCalledWith("/sso/config", {
        provider: "oidc",
        enabled: true,
        clientId: "test-client-id",
        clientSecret: null,
        discoveryUrl: "https://accounts.example.com/.well-known/openid-configuration",
        entryPoint: null,
        cert: null,
        entityId: null,
        redirectUri: null,
        ldapUrl: null,
        ldapBindDn: null,
        // CR-04 (193-REVIEW): the write-only bind password is OMITTED from
        // the payload when the admin did not type one — sending null WIPED
        // the stored ciphertext on every unrelated SSO save (the server
        // treats a defined key as authoritative; undefined = unchanged).
        ldapSearchBase: null,
        ldapSearchFilter: null,
        ldapGroupSearchBase: null,
        ldapGroupSearchFilter: null,
        ldapUseTls: true,
        ldapAcceptCert: null,
        ldapFallbackToLocal: true,
      });
      // WR-08 (193-REVIEW): the map PUT is GATED on the ldap arm — an
      // oidc/saml save NEVER commits the staged rows (the PUT is a
      // full-list replace; committing from an unrelated provider save
      // bulk-deleted every LdapGroupRoleMap row). The rows hydrate from
      // GET /sso/ldap/map — assert it was READ, but never PUT.
      expect(mockApiGet).toHaveBeenCalledWith("/sso/ldap/map");
      expect(mockApiPut).not.toHaveBeenCalledWith("/sso/ldap/map", expect.anything());
    });
  });

  it("WR-08 — an ldap-arm save COMMITS the staged map rows once hydrated", async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/sso/config") {
        return Promise.resolve({
          ...MOCK_SSO_CONFIG,
          provider: "ldap",
          ldapUrl: "ldap://dc.example.com:389",
        });
      }
      if (url === "/sso/ldap/map") {
        return Promise.resolve({
          mappings: [{ ldapGroupDn: "cn=devs,ou=groups,dc=x", roleId: "role-dev-1" }],
        });
      }
      if (url === "/roles") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockApiPut.mockResolvedValue({
      ...MOCK_SSO_CONFIG,
      provider: "ldap",
    });
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    // provider hydrates to "ldap" — the LDAP section renders without a
    // radio click (D-17 single-active-provider).
    await waitFor(() => screen.getByText("settings.sso.ldap.url"));
    // Hydration guard: the rows land via GET /sso/ldap/map (asserted below
    // via the PUT payload — the DOM row inputs share an aria-label with the
    // add-row draft input, making getByLabelText ambiguous).
    expect(mockApiGet).toHaveBeenCalledWith("/sso/ldap/map");

    const saveButtons = screen.getAllByText("common.save");
    fireEvent.click(saveButtons[0]);
    await waitFor(() => {
      // WR-08 CONTRACT: the ldap-arm save COMMITS the hydrated staged rows
      // through the bulk full-list replace.
      expect(mockApiPut).toHaveBeenCalledWith("/sso/ldap/map", {
        mappings: [{ ldapGroupDn: "cn=devs,ou=groups,dc=x", roleId: "role-dev-1" }],
      });
    });
  });

  it("CR-04 — typing a NEW bind password sends it; the field stays omitted when unmodified (never wipes the stored ciphertext)", async () => {
    // LDAP-configured row: the ciphertext EXISTS server-side (the
    // `ldapBindPasswordConfigured` boolean) — an unrelated save must not
    // alter it.
    mockApiPut.mockResolvedValue({
      ...MOCK_SSO_CONFIG,
      provider: "ldap",
      ldapUrl: "ldap://dc.example.com:389",
      ldapBindPasswordConfigured: true,
    });
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/sso/config") {
        return Promise.resolve({
          ...MOCK_SSO_CONFIG,
          provider: "ldap",
          ldapUrl: "ldap://dc.example.com:389",
          ldapBindPasswordConfigured: true,
        });
      }
      if (url === "/sso/ldap/map") return Promise.resolve({ mappings: [] });
      if (url === "/roles") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    // provider hydrates to "ldap" from the mocked config row — the LDAP
    // section renders WITHOUT a radio click (and the OIDC discovery field
    // never renders, D-17 single-active-provider), so the OIDC-field wait
    // the sibling tests use would time out here.
    await waitFor(() => screen.getByText("settings.sso.ldap.url"));

    // (1) Save with the field UNMODIFIED (blank — never hydrated): the key
    // is OMITTED entirely, so the server keeps the stored ciphertext.
    const saveButtons1 = screen.getAllByText("common.save");
    fireEvent.click(saveButtons1[0]);
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith(
        "/sso/config",
        expect.objectContaining({ provider: "ldap" }),
      );
    });
    const unmodifiedPayload = mockApiPut.mock.calls.find(
      (c) => c[0] === "/sso/config",
    )?.[1] as Record<string, unknown>;
    expect("ldapBindPassword" in unmodifiedPayload).toBe(false);
  });

  it("CR-04 (typed arm) — a NEWLY typed bind password IS sent as plaintext in the save payload", async () => {
    // No stored ciphertext (configured: false) — the field is editable
    // (a configured ciphertext renders the env-carrier read-only posture,
    // T-193-15/D-05: value "••••", disabled).
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/sso/config") {
        return Promise.resolve({
          ...MOCK_SSO_CONFIG,
          provider: "ldap",
          ldapUrl: "ldap://dc.example.com:389",
          ldapBindPasswordConfigured: false,
        });
      }
      if (url === "/sso/ldap/map") return Promise.resolve({ mappings: [] });
      if (url === "/roles") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockApiPut.mockResolvedValue({
      ...MOCK_SSO_CONFIG,
      provider: "ldap",
      ldapBindPasswordConfigured: true,
    });

    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    await waitFor(() => screen.getByText("settings.sso.ldap.url"));

    const bindInput = screen.getByPlaceholderText("sso.clientSecretPlaceholder");
    fireEvent.change(bindInput, { target: { value: "brand-new-secret" } });
    // The FIRST save button is the config form's (the SCIM section renders
    // its own later — that arm routes through useUpdateSettings, not
    // apiPut).
    const saveButtons2 = screen.getAllByText("common.save");
    fireEvent.click(saveButtons2[0]);
    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith(
        "/sso/config",
        expect.objectContaining({ ldapBindPassword: "brand-new-secret" }),
      );
    });
  });

  it("renders SCIM section with bearer token input and endpoint", async () => {
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText("sso.scimTitle")).toBeInTheDocument();
    });

    expect(screen.getByText("sso.scimBearerToken")).toBeInTheDocument();
    expect(screen.getByText("sso.scimEndpoint")).toBeInTheDocument();
    expect(screen.getByText("sso.scimTestConnection")).toBeInTheDocument();
  });

  // ─── Phase 193 (LDAP tab, 193-04 Task 2) ─────────────────────

  it("renders the third LDAP radio and selects it", async () => {
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText("sso.title")).toBeInTheDocument();
    });
    // Hydration race guard: the ssoConfig effect resets provider when the
    // query lands — click only AFTER hydration is observable.
    await waitFor(() => {
      expect(screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration")).toBeInTheDocument();
    });

    const ldapRadio = screen.getByRole("radio", { name: "LDAP" });
    expect(ldapRadio).toBeInTheDocument();
    fireEvent.click(ldapRadio);

    // The conditional LDAP config section renders (its URL field is the
    // first settings.sso.ldap field); SAML/OIDC sections are HIDDEN (D-17).
    await waitFor(() => {
      expect(screen.getByText("settings.sso.ldap.url")).toBeInTheDocument();
    });
    expect(screen.queryByText("sso.discoveryUrl")).not.toBeInTheDocument();
    expect(screen.queryByText("sso.entryPoint")).not.toBeInTheDocument();
  });

  it("renders LDAP config fields with the defaults as placeholders", async () => {
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    await waitFor(() =>
      screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration"),
    );
    fireEvent.click(screen.getByRole("radio", { name: "LDAP" }));

    await waitFor(() => screen.getByText("settings.sso.ldap.url"));

    // Defaults as placeholders (UI-SPEC populated-empty state).
    expect(screen.getByPlaceholderText("ldaps://ad.example.com:636")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("(uid={{username}})")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("(member={{dn}})")).toBeInTheDocument();
    // Bind password is type=password, write-only (T-193-15: never echoes
    // ciphertext — hydration leaves it blank).
    const bindPw = screen.getByPlaceholderText("sso.clientSecretPlaceholder");
    expect(bindw(bindPw)).toBe("password");
  });

  it("DISABLES the TLS switch when the URL starts with ldaps:// (D-06)", async () => {
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    await waitFor(() =>
      screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration"),
    );
    fireEvent.click(screen.getByRole("radio", { name: "LDAP" }));

    await waitFor(() => screen.getByText("settings.sso.ldap.url"));
    const urlInput = screen.getByPlaceholderText("ldaps://ad.example.com:636");
    fireEvent.change(urlInput, { target: { value: "ldaps://ad.example.com:636" } });

    const tlsSwitch = screen.getByRole("switch", { name: "settings.sso.ldap.useTls" });
    expect(tlsSwitch).toBeDisabled();

    // Non-ldaps URL → the switch re-enables.
    fireEvent.change(urlInput, { target: { value: "ldap://ad.example.com:389" } });
    expect(screen.getByRole("switch", { name: "settings.sso.ldap.useTls" })).toBeEnabled();
  });

  it("renders the empty-state mapping editor with the inline Add button", async () => {
    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    await waitFor(() =>
      screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration"),
    );
    fireEvent.click(screen.getByRole("radio", { name: "LDAP" }));

    await waitFor(() => {
      expect(screen.getByText("settings.sso.ldap.mapEmptyTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("settings.sso.ldap.mapEmptyBody")).toBeInTheDocument();
  });

  it("renders the admin-role amber warning for a staged admin row (D-10)", async () => {
    // The panel hydrates the staged list from GET /sso/ldap/map.
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/sso/config") {
        return Promise.resolve(MOCK_SSO_CONFIG);
      }
      if (url === "/sso/ldap/map") {
        return Promise.resolve({
          mappings: [{ ldapGroupDn: "cn=admins,ou=groups,dc=x", roleId: "role-admin-1" }],
        });
      }
      if (url === "/roles") {
        return Promise.resolve([
          { id: "role-admin-1", name: "admin" },
          { id: "role-user-1", name: "user" },
        ]);
      }
      return Promise.resolve([]);
    });

    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    // Hydration race guard (provider resets when the config query lands).
    await waitFor(() =>
      screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration"),
    );
    fireEvent.click(screen.getByRole("radio", { name: "LDAP" }));

    await waitFor(() => {
      expect(screen.getByText("settings.sso.ldap.mapAdminWarning")).toBeInTheDocument();
    });
  });

  it("renders the 4-row diagnostics checklist with Check/X per mock result", async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/sso/config") return Promise.resolve(MOCK_SSO_CONFIG);
      return Promise.resolve([]);
    });
    const { apiFetch: mockApiFetchDirect } = require("../utils/api");
    mockApiFetchDirect.mockResolvedValueOnce({
      reachable: true,
      bindOk: true,
      userFound: false,
      groupsFound: false,
    });

    renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    await waitFor(() =>
      screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration"),
    );
    fireEvent.click(screen.getByRole("radio", { name: "LDAP" }));

    const testButtons = screen.getAllByText("sso.testConnection");
    fireEvent.click(testButtons[testButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText("settings.sso.ldap.diag.reachable")).toBeInTheDocument();
    });
    expect(screen.getByText("settings.sso.ldap.diag.bindOk")).toBeInTheDocument();
    expect(screen.getByText("settings.sso.ldap.diag.userFound")).toBeInTheDocument();
    expect(screen.getByText("settings.sso.ldap.diag.groupsFound")).toBeInTheDocument();
  });

  it("does NOT render raw server error text in any output (T-193-12)", async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/sso/config") return Promise.resolve(MOCK_SSO_CONFIG);
      return Promise.resolve([]);
    });
    // apiFetch rejects with a hostile raw-LDAP-error string — the render
    // must never show it (the diagnostics render stage NAMES only).
    const { apiFetch: mockApiFetchDirect2 } = require("../utils/api");
    mockApiFetchDirect2.mockRejectedValueOnce(
      new Error("Invalid DN syntax: cn=x,ldap_error 0x59 some_server_detail"),
    );

    const { container } = renderWithClient(<SsoSettingsPanel />);

    await waitFor(() => screen.getByText("sso.title"));
    await waitFor(() =>
      screen.getByDisplayValue("https://accounts.example.com/.well-known/openid-configuration"),
    );
    fireEvent.click(screen.getByRole("radio", { name: "LDAP" }));

    const testButtons = screen.getAllByText("sso.testConnection");
    fireEvent.click(testButtons[testButtons.length - 1]);

    // A THROWN call renders the overall testFailed banner arm — stage
    // NAMES only; the 4-row checklist needs a typed result (never a raw
    // string), so no diag rows render on this arm either.
    await waitFor(() => {
      expect(screen.getByText("settings.sso.ldap.testFailed")).toBeInTheDocument();
    });
    // The hostile detail string must not appear anywhere in the render.
    expect(screen.queryByText(/some_server_detail/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("0x59");
  });
});

function bindw(el: HTMLElement) {
  return el.getAttribute("type") ?? "";
}