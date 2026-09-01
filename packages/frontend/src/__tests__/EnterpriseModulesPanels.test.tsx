// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

/**
 * EnterpriseModulesPanels.test.tsx — Phase 147 (EPA-11) Plan 02.
 *
 * Covers the 3 remaining enterprise panels (SsoSettingsPanel, SettingsBackups,
 * and — per the appearance-gating decision — SettingsAppearance is NOT
 * wrapped, see SUMMARY) using the Plan 01 pattern: extract the conditional
 * ternary into a small test-only component and assert the three states.
 *
 * Cases:
 *   SSO installed:    enterpriseInstalled=true + tier="enterprise" + isAdmin
 *                     → <Suspense><SsoSettingsPanel/></Suspense>
 *   SSO not installed: enterpriseInstalled=false + isAdmin
 *                     → <UpgradePrompt feature="sso_enabled"
 *                        message="upgrade.pluginRequired" />
 *   SSO non-admin:    isAdmin=false → <Navigate to="/" />
 *   Backups installed: enterpriseInstalled=true + tier="enterprise"
 *                     + hasAny([...backup perms...])=true
 *                     → <Suspense><SettingsBackups/></Suspense>
 *   Backups not installed: enterpriseInstalled=false + perm=true
 *                     → <UpgradePrompt feature="backup_enabled"
 *                        message="upgrade.pluginRequired" />
 *   Backups no permission: hasAny([...])=false → renders nothing (SubSection
 *                     `show={false}` returns null — neither panel nor card)
 *
 * Modeled on `EnterpriseModules.test.tsx` (Plan 01). The lazy components are
 * mocked to synchronous divs (Pitfall 4: @swc/jest does NOT code-split).
 *
 * Appearance gating decision: `SettingsAppearance` is NOT wrapped in
 * React.lazy / enterprise gate in this plan — it carries community features
 * (theme, font scale, density) that must stay visible in a community build.
 * The white-label SECTION inside it is gated by the existing in-component
 * `useFeature("white_label")` check (the SECOND gate, D-08). No appearance
 * cases here — see SUMMARY for the decision rationale.
 */

// Mock i18next before any imports — App.test.tsx pattern.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock the lazy components to synchronous divs — Pitfall 4: @swc/jest does
// NOT code-split; the mock avoids async Suspense in Jest.
jest.mock("../components/SsoSettingsPanel", () => () => (
  <div data-testid="sso-panel">SSO</div>
));
jest.mock("../components/SettingsBackups", () => () => (
  <div data-testid="settings-backups">Backups</div>
));

import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, Suspense, lazy } from "react";
import { MemoryRouter, Navigate } from "react-router-dom";
import EnterpriseSpinner from "../components/EnterpriseSpinner";
import UpgradePrompt from "../components/UpgradePrompt";

// Lazy declarations at MODULE TOP — mirror App.tsx / SettingsPage.tsx (Pitfall 2).
const SsoSettingsPanel = lazy(() => import("../components/SsoSettingsPanel"));
const SettingsBackups = lazy(() => import("../components/SettingsBackups"));

// ─── SSO route element harness ─────────────────────────────────────────
// Mirrors the App.tsx /sso route element ternary (D-07, D-08, D-09). The
// outermost `isAdmin` gate STAYS — a non-admin is redirected, not shown an
// upgrade card. Then the `enterpriseInstalled && tier === "enterprise"`
// FIRST enterprise gate decides lazy load vs upgrade card. The existing
// `useFeature("sso_enabled")` check INSIDE SsoSettingsPanel is the SECOND
// gate (D-08) and is NOT exercised here (it's an in-component concern).

interface SsoRouteProps {
  enterpriseInstalled: boolean;
  tier: "community" | "enterprise";
  isAdmin: boolean;
}

function SsoRoute({ enterpriseInstalled, tier, isAdmin }: SsoRouteProps) {
  return isAdmin ? (
    enterpriseInstalled && tier === "enterprise" ? (
      <Suspense fallback={<EnterpriseSpinner />}>
        <SsoSettingsPanel />
      </Suspense>
    ) : (
      <UpgradePrompt
        feature="sso_enabled"
        message={!enterpriseInstalled ? "upgrade.pluginRequired" : undefined}
      />
    )
  ) : (
    <Navigate to="/" />
  );
}

// ─── Backups sub-section harness ───────────────────────────────────────
// Mirrors the SettingsPage.tsx backups SubSection ternary. The outermost
// `show={hasAny([...])}` permission gate STAYS — a user without backup
// permissions sees neither the panel nor the upgrade card (the SubSection
// returns null). Then the FIRST enterprise gate decides lazy load vs card.
// The existing `useFeature("backup_enabled")` checks INSIDE SettingsBackups
// (and its children) are the SECOND gate (D-08) and are NOT exercised here.

interface BackupsSectionProps {
  enterpriseInstalled: boolean;
  tier: "community" | "enterprise";
  hasBackupPermission: boolean;
}

function BackupsSection({
  enterpriseInstalled,
  tier,
  hasBackupPermission,
}: BackupsSectionProps) {
  // The SubSection `show` prop gate — returns null when the user has no
  // backup permissions (the sub-section is hidden entirely).
  if (!hasBackupPermission) return null;
  return enterpriseInstalled && tier === "enterprise" ? (
    <Suspense fallback={<EnterpriseSpinner />}>
      <SettingsBackups />
    </Suspense>
  ) : (
    <UpgradePrompt
      feature="backup_enabled"
      message={!enterpriseInstalled ? "upgrade.pluginRequired" : undefined}
    />
  );
}

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── SSO cases (3) ─────────────────────────────────────────────────────

describe("/sso route element (Plan 02 — SSO)", () => {
  it("installed: enterpriseInstalled=true + tier=enterprise + isAdmin → renders lazy SsoSettingsPanel", async () => {
    renderWithProviders(
      <SsoRoute enterpriseInstalled={true} tier="enterprise" isAdmin={true} />,
    );
    expect(await screen.findByTestId("sso-panel")).toBeInTheDocument();
  });

  it("not installed: enterpriseInstalled=false + isAdmin → renders UpgradePrompt with upgrade.pluginRequired", async () => {
    renderWithProviders(
      <SsoRoute enterpriseInstalled={false} tier="community" isAdmin={true} />,
    );
    expect(await screen.findByText("upgrade.pluginRequired")).toBeInTheDocument();
    // The upgrade card targets the SSO feature flag.
    expect(screen.getByText("upgrade.title")).toBeInTheDocument();
  });

  it("non-admin: isAdmin=false → redirects (Navigate to /, no SSO panel, no upgrade card)", () => {
    renderWithProviders(
      <SsoRoute enterpriseInstalled={true} tier="enterprise" isAdmin={false} />,
    );
    // Non-admin → <Navigate to="/" />: neither the panel nor the upgrade
    // card text is rendered.
    expect(screen.queryByTestId("sso-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("upgrade.pluginRequired")).not.toBeInTheDocument();
    expect(screen.queryByText("upgrade.title")).not.toBeInTheDocument();
  });
});

// ─── Backups cases (3) ─────────────────────────────────────────────────

describe("settings backups sub-section (Plan 02 — Backups)", () => {
  it("installed: enterpriseInstalled=true + tier=enterprise + hasBackupPermission=true → renders lazy SettingsBackups", async () => {
    renderWithProviders(
      <BackupsSection
        enterpriseInstalled={true}
        tier="enterprise"
        hasBackupPermission={true}
      />,
    );
    expect(await screen.findByTestId("settings-backups")).toBeInTheDocument();
  });

  it("not installed: enterpriseInstalled=false + hasBackupPermission=true → renders UpgradePrompt with upgrade.pluginRequired", async () => {
    renderWithProviders(
      <BackupsSection
        enterpriseInstalled={false}
        tier="community"
        hasBackupPermission={true}
      />,
    );
    expect(await screen.findByText("upgrade.pluginRequired")).toBeInTheDocument();
    expect(screen.getByText("upgrade.title")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-backups")).not.toBeInTheDocument();
  });

  it("no permission: hasBackupPermission=false → sub-section hidden (no panel, no upgrade card)", () => {
    renderWithProviders(
      <BackupsSection
        enterpriseInstalled={true}
        tier="enterprise"
        hasBackupPermission={false}
      />,
    );
    // The `show={false}` SubSection gate hides everything — neither the
    // panel nor the upgrade card text is in the DOM.
    expect(screen.queryByTestId("settings-backups")).not.toBeInTheDocument();
    expect(screen.queryByText("upgrade.pluginRequired")).not.toBeInTheDocument();
    expect(screen.queryByText("upgrade.title")).not.toBeInTheDocument();
  });
});