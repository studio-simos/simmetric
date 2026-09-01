// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * CitationPanel archive provenance badge tests (Phase 80 D-14).
 *
 * Covers the "Archivio" badge rendering:
 * - badge renders when source.source === "archive"
 * - badge absent when source is undefined
 * - badge absent when source === "workspace"
 * - badge uses bg-primary/15 subtle tint (UI-SPEC Color reserved-for item 2)
 *
 * Mocks react-i18next so `t(key)` returns the key verbatim — the badge text
 * equals `chat.archive.badge`, which lets us assert on the key without locale
 * drift. RTL + jest-environment-jsdom (mirrors App.test.tsx pattern).
 */
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => false,
}));

import { render, screen, fireEvent } from "@testing-library/react";
import CitationPanel from "../components/CitationPanel";
import type { SourceCitation } from "../hooks/useChat";

function renderPanel(sources: SourceCitation[]) {
  return render(<CitationPanel sources={sources} onClose={() => {}} />);
}

const ARCHIVE_CITATION: SourceCitation = {
  documentId: "doc-1",
  documentName: "Archive Doc",
  score: 0.9,
  source: "archive",
};

const WORKSPACE_CITATION: SourceCitation = {
  documentId: "doc-2",
  documentName: "Workspace Doc",
  score: 0.8,
  source: "workspace",
};

const UNDEFINED_SOURCE_CITATION: SourceCitation = {
  documentId: "doc-3",
  documentName: "Legacy Doc",
  score: 0.7,
};

const CITATION_WITH_CHUNK: SourceCitation = {
  documentId: "doc-4",
  documentName: "Doc with text",
  score: 0.85,
  chunkText: "This is the relevant chunk of text that should be visible when the panel opens.",
};

describe("CitationPanel", () => {
  it("auto-expands the first citation so chunkText is visible on open", () => {
    renderPanel([CITATION_WITH_CHUNK]);
    // The first citation should be auto-expanded (expandedIndex=0)
    expect(screen.getByText("This is the relevant chunk of text that should be visible when the panel opens.")).toBeInTheDocument();
  });

  it("toggles expansion when the citation header is clicked", () => {
    renderPanel([CITATION_WITH_CHUNK, CITATION_WITH_CHUNK]);
    // First is auto-expanded
    expect(screen.getByText("This is the relevant chunk of text that should be visible when the panel opens.")).toBeInTheDocument();
    // Click the first citation header to collapse it
    const buttons = screen.getAllByRole("button");
    const headerButton = buttons.find((b) => b.className.includes("w-full text-left"));
    fireEvent.click(headerButton!);
    // Now the chunkText should be hidden
    expect(screen.queryByText("This is the relevant chunk of text that should be visible when the panel opens.")).not.toBeInTheDocument();
  });
});

describe("CitationPanel archive badge", () => {
  it("renders Archivio badge when source.source === 'archive'", () => {
    renderPanel([ARCHIVE_CITATION]);
    expect(screen.getByText("chat.archive.badge")).toBeInTheDocument();
  });

  it("does NOT render badge when source is undefined", () => {
    renderPanel([UNDEFINED_SOURCE_CITATION]);
    expect(screen.queryByText("chat.archive.badge")).not.toBeInTheDocument();
  });

  it("does NOT render badge when source === 'workspace'", () => {
    renderPanel([WORKSPACE_CITATION]);
    expect(screen.queryByText("chat.archive.badge")).not.toBeInTheDocument();
  });

  it("badge has bg-primary/15 class (subtle tint, not solid)", () => {
    renderPanel([ARCHIVE_CITATION]);
    const badge = screen.getByText("chat.archive.badge");
    expect(badge.className).toContain("bg-primary/15");
  });
});