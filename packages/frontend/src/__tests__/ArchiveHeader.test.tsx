// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveHeader component smoke tests
 *
 * Verifies the standalone header renders archive name, action buttons,
 * and breadcrumb navigation correctly.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("react-router-dom", () => ({
  ...jest.requireActual("react-router-dom"),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ArchiveHeader from "../components/ArchiveHeader";
import type { Archive } from "../queries/useArchives";

// ── Mock data ────────────────────────────────────────────────────

function mockArchive(): Archive {
  return {
    id: "test-archive-id",
    slug: "test-archive",
    name: "Test Archive",
    description: "A test archive",
    createdBy: "admin",
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function renderHeader(archive: Archive = mockArchive()) {
  return render(
    <MemoryRouter>
      <ArchiveHeader
        archive={archive}
        onNewPage={jest.fn()}
        onExport={jest.fn()}
        onDelete={jest.fn()}
      />
    </MemoryRouter>
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe("ArchiveHeader", () => {
  it("renders archive name", () => {
    renderHeader();
    // Archive name appears in both breadcrumb (BreadcrumbPage) and CardTitle
    const elements = screen.getAllByText("Test Archive");
    expect(elements.length).toBeGreaterThanOrEqual(2);
  });

  it("renders action buttons", () => {
    renderHeader();
    expect(screen.getByText("archives.newPage")).toBeInTheDocument();
    expect(screen.getByText("export.buttonLabel")).toBeInTheDocument();
    // Delete button uses Trash2 icon with title attribute
    expect(screen.getByTitle("archives.deleteArchive")).toBeInTheDocument();
  });

  it("renders breadcrumb", () => {
    renderHeader();
    expect(screen.getByText("breadcrumb.home")).toBeInTheDocument();
    expect(screen.getByText("breadcrumb.archives")).toBeInTheDocument();
  });
});
