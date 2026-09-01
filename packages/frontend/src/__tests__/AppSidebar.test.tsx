// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppSidebar — uploads menu section visibility tests (Phase 71-03 Task 1).
 *
 * Verifies the uploads SidebarItem is rendered when "uploads" is in
 * menuSections (user role has document:write, SC-1 visibility) and is NOT
 * rendered when "uploads" is absent.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";

// ── Helpers ──────────────────────────────────────────────────────

function renderSidebar(menuSections: string[]) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AppSidebar
        appName="Simmetric Chat"
        primaryColor="#4c6ef5"
        isEnterprise={false}
        isAdmin={false}
        menuSections={menuSections}
        currentWorkspaceId={null}
        selectedProjectId=""
        setSelectedProjectId={jest.fn()}
        selectedWorkspaceId=""
        setSelectedWorkspaceId={jest.fn()}
        setWorkspaceId={jest.fn()}
        t={(key: string) => key}
        sidebarOpen
        setSidebarOpen={jest.fn()}
        projects={[]}
        workspaces={[]}
      />
    </MemoryRouter>
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe("AppSidebar uploads menu section", () => {
  it("renders the uploads item when 'uploads' is in menuSections", () => {
    renderSidebar([
      "dashboard",
      "chat",
      "documents",
      "knowledgeBase",
      "workspaces",
      "widget",
      "uploads",
    ]);
    expect(screen.getByText("sidebar.uploads")).toBeInTheDocument();
  });

  it("does NOT render the uploads item when 'uploads' is absent", () => {
    renderSidebar([
      "dashboard",
      "chat",
      "documents",
      "knowledgeBase",
      "workspaces",
      "widget",
    ]);
    expect(screen.queryByText("sidebar.uploads")).not.toBeInTheDocument();
  });
});