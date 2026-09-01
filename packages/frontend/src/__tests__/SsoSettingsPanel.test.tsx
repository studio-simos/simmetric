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
      });
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
});